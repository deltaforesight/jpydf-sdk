import { type Address, BaseError, getAddress, isAddress, type PublicClient, zeroAddress } from "viem";

import { createJpydfClient } from "./client.js";
import { getJpydfUsdcPool, quoteJpydfUsdc, type JpydfMarketToken, type JpydfUsdcPoolState, type JpydfUsdcQuote } from "./production-market.js";
import { JpydfSdkError, type JpydfSdkErrorCode } from "./errors.js";
import {
  assertJpydfDeadlinePublicClient,
  getJpydfRpcHealth,
  type JpydfDeadlinePublicClient,
  JpydfRpcOverloadedError,
} from "./rpc.js";
import type {
  JpydfAccountSnapshot,
  JpydfDeployment,
  JpydfDeploymentScope,
  JpydfLiquidationPage,
  JpydfMarketSnapshot,
  JpydfProtocolSnapshot,
  PreparedActionReference,
  PreparedIntent,
  ReadyAction,
  SimulatedAction,
} from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const emptyInputSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
} as const);
const branchInputSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: { branchId: { type: "integer", minimum: 0, maximum: 1 } },
  required: ["branchId"],
} as const);
const amountInputSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    amountRaw: {
      type: "string",
      pattern: "^[1-9][0-9]{0,77}$",
      description: "18-decimal JPYdf base-unit integer string; 1 JPYdf = 1000000000000000000",
    },
    branchId: { type: "integer", minimum: 0, maximum: 1 },
    claim: {
      type: "boolean",
      description: "true pays accrued rewards to the account; false compounds them. Full withdrawal is normalized to true and requires approval.",
    },
  },
  required: ["amountRaw", "branchId", "claim"],
} as const);
const liquidationInputSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    branchId: { type: "integer", minimum: 0, maximum: 1 },
    maxIterations: { type: "integer", minimum: 1, maximum: 128 },
    startId: { type: "string", pattern: "^[0-9]{1,78}$" },
  },
  required: ["branchId", "maxIterations", "startId"],
} as const);

const quoteInputSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    tokenIn: { type: "string", enum: ["USDC", "JPYdf"] },
    amountRaw: {
      type: "string",
      pattern: "^[1-9][0-9]{0,38}$",
      description: "Base-unit integer string of tokenIn: USDC has 6 decimals, JPYdf has 18",
    },
  },
  required: ["tokenIn", "amountRaw"],
} as const);

const AGENT_OPERATION_CATALOG = deepFreeze([
  {
    id: "integration.get",
    kind: "read",
    description: "Read supported and deliberately disabled deployment capabilities",
    inputSchema: emptyInputSchema,
  },
  {
    id: "protocol.get",
    kind: "read",
    description: "Read public test-deployment branch bindings",
    inputSchema: emptyInputSchema,
  },
  {
    id: "account.get",
    kind: "read",
    description: "Read the test token and Stability Pool positions",
    inputSchema: emptyInputSchema,
  },
  {
    id: "market.get",
    kind: "read",
    description: "Read fixed-block borrow, earn, vault, oracle, and risk rates",
    inputSchema: branchInputSchema,
  },
  {
    id: "jpydfUsdc.pool",
    kind: "read",
    description: "Production only: read the JPYdf/USDC Uniswap v4 pool state; the pool price is the JPYdf market price, not the ¥1 reference",
    inputSchema: emptyInputSchema,
  },
  {
    id: "jpydfUsdc.quote",
    kind: "read",
    description: "Production only: quote an exact-input JPYdf/USDC swap (fee and price impact included); returns no calldata",
    inputSchema: quoteInputSchema,
  },
  {
    id: "liquidation.scan",
    kind: "read",
    description: "Read a bounded liquidation candidate page; execution requires bot revalidation",
    inputSchema: liquidationInputSchema,
  },
  {
    id: "earn.deposit",
    kind: "prepare",
    asset: "test-df",
    decimals: 18,
    description: "Simulate and prepare an SP deposit",
    inputSchema: amountInputSchema,
  },
  {
    id: "earn.withdraw",
    kind: "prepare",
    asset: "test-df",
    decimals: 18,
    description: "Simulate and prepare an SP withdrawal",
    inputSchema: amountInputSchema,
  },
  {
    id: "earn.claim",
    kind: "prepare",
    description: "Simulate and prepare a reward claim",
    inputSchema: branchInputSchema,
  },
  {
    id: "earn.compound",
    kind: "prepare",
    description: "Simulate and prepare reward compounding",
    inputSchema: branchInputSchema,
  },
] as const);

export type JpydfAgentOperationId = typeof AGENT_OPERATION_CATALOG[number]["id"];
export type JpydfAgentWriteOperation = Extract<
  typeof AGENT_OPERATION_CATALOG[number],
  { kind: "prepare" }
>["id"];
export type JpydfAgentRewardMode = "claim" | "compound";

export type JpydfAgentRequest =
  | { operation: "integration.get" | "protocol.get" | "account.get"; input: Record<string, never> }
  | { operation: "market.get"; input: { branchId: number } }
  | { operation: "jpydfUsdc.pool"; input: Record<string, never> }
  | { operation: "jpydfUsdc.quote"; input: { tokenIn: JpydfMarketToken; amountRaw: string } }
  | {
    operation: "liquidation.scan";
    input: { branchId: number; maxIterations: number; startId: string };
  }
  | {
    operation: "earn.deposit" | "earn.withdraw";
    input: { amountRaw: string; branchId: number; claim: boolean };
  }
  | { operation: "earn.claim" | "earn.compound"; input: { branchId: number } };

export type JpydfAgentWriteAdmission = {
  allowedOperations: readonly JpydfAgentWriteOperation[];
  allowedBranchIds: readonly number[];
  allowedRewardModes?: readonly JpydfAgentRewardMode[];
  expiresAtMs: number;
  maxAmountRaw?: bigint;
  maxPendingAmountRaw?: bigint;
};

export type JpydfAgentFinalizationAuthorization = {
  readonly actor: Address;
  readonly reference: PreparedActionReference;
  readonly revalidationId: string;
};

type Jsonified<T> = T extends bigint ? string
  : T extends readonly (infer Item)[] ? Jsonified<Item>[]
  : T extends object ? { [Key in keyof T]: Jsonified<T[Key]> }
  : T;

type AgentPreparedAction = Omit<SimulatedAction, "reference"> & { revalidationId: string };
type AgentIntegrationSnapshot = {
  capabilities: ReturnType<typeof createJpydfClient>["capabilities"];
  protocolConstants: JpydfDeployment["protocolConstants"];
};
export type JpydfAgentDataByOperation = {
  "integration.get": Jsonified<AgentIntegrationSnapshot>;
  "protocol.get": Jsonified<JpydfProtocolSnapshot>;
  "account.get": Jsonified<JpydfAccountSnapshot>;
  "market.get": Jsonified<JpydfMarketSnapshot>;
  "jpydfUsdc.pool": Jsonified<JpydfUsdcPoolState>;
  "jpydfUsdc.quote": Jsonified<JpydfUsdcQuote>;
  "liquidation.scan": Jsonified<JpydfLiquidationPage>;
  "earn.deposit": Jsonified<AgentPreparedAction>;
  "earn.withdraw": Jsonified<AgentPreparedAction>;
  "earn.claim": Jsonified<AgentPreparedAction>;
  "earn.compound": Jsonified<AgentPreparedAction>;
  "transaction.finalize": Jsonified<ReadyAction>;
};
type AgentResponseOperationId = keyof JpydfAgentDataByOperation;
type AgentIdentity = {
  schemaVersion: "1";
  environment: JpydfDeploymentScope;
  testOnly: boolean;
  chainId: 1;
  deploymentClassification: string;
  deploymentId: string;
  manifestSha256: string;
  actor: Address;
};

export type JpydfAgentSuccess<
  Operation extends AgentResponseOperationId = AgentResponseOperationId,
> = Operation extends AgentResponseOperationId ? AgentIdentity & {
    ok: true;
    operationId: Operation;
    data: JpydfAgentDataByOperation[Operation];
  } : never;

export type JpydfAgentFailure = AgentIdentity & {
  ok: false;
  operationId: AgentResponseOperationId | "unknown";
  error: {
    code: JpydfSdkErrorCode | "RPC_ERROR";
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
};

export type JpydfAgentResponse<
  Operation extends AgentResponseOperationId = AgentResponseOperationId,
> = JpydfAgentFailure | JpydfAgentSuccess<Operation>;
type InternalAgentResponse = JpydfAgentFailure | (AgentIdentity & {
  ok: true;
  operationId: AgentResponseOperationId;
  data: JpydfAgentDataByOperation[AgentResponseOperationId];
});

const PENDING_LIMIT = 32;
const PENDING_TTL_MS = 5 * 60 * 1_000;
const amountOperations = new Set<JpydfAgentWriteOperation>(["earn.deposit", "earn.withdraw"]);

function account(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new JpydfSdkError("INVALID_INPUT", "account must be a valid address");
  }
  const result = getAddress(value);
  if (result === zeroAddress) {
    throw new JpydfSdkError("INVALID_INPUT", "account must not be the zero address");
  }
  return result;
}

function rawAmount(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 78 || !/^[1-9][0-9]*$/.test(value)) {
    throw new JpydfSdkError("INVALID_INPUT", "amountRaw must be a base-10 uint256 string");
  }
  const amount = BigInt(value);
  if (amount >= 2n ** 256n) {
    throw new JpydfSdkError("INVALID_INPUT", "amountRaw must be a base-10 uint256 string");
  }
  return amount;
}

function rawUint256(value: unknown, label: string): bigint {
  if (typeof value !== "string" || value.length > 78 || !/^[0-9]+$/.test(value)) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be a base-10 uint256 string`);
  }
  const parsed = BigInt(value);
  if (parsed >= 2n ** 256n) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be a base-10 uint256 string`);
  }
  return parsed;
}

function branchId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new JpydfSdkError("INVALID_INPUT", "branchId must be a non-negative integer");
  }
  return value as number;
}

function exactKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be an object`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} contains unknown field ${unexpected[0]}`);
  }
}

function toAgentJson<T>(value: T): Jsonified<T> {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
}

function writeAdmission(value: JpydfAgentWriteAdmission | undefined) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value.allowedOperations) || !Array.isArray(value.allowedBranchIds)) {
    throw new JpydfSdkError("INVALID_INPUT", "writeAdmission allowlists must be arrays");
  }
  if (!Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= Date.now()) {
    throw new JpydfSdkError("INVALID_INPUT", "writeAdmission.expiresAtMs must be a future timestamp");
  }
  if (value.allowedOperations.length === 0 || value.allowedBranchIds.length === 0) {
    throw new JpydfSdkError("INVALID_INPUT", "writeAdmission allowlists must not be empty");
  }
  const operations = new Set(value.allowedOperations);
  if (
    operations.size !== value.allowedOperations.length
    || [...operations].some((operation) =>
      !AGENT_OPERATION_CATALOG.some(
        ({ id, kind }) => id === operation && kind === "prepare",
      )
    )
  ) {
    throw new JpydfSdkError("INVALID_INPUT", "writeAdmission contains an invalid operation");
  }
  const branches = new Set(value.allowedBranchIds);
  if (
    branches.size !== value.allowedBranchIds.length
    || [...branches].some((id) => !Number.isSafeInteger(id) || id < 0)
  ) {
    throw new JpydfSdkError("INVALID_INPUT", "writeAdmission contains an invalid branchId");
  }
  const permitsAmount = [...operations].some((operation) => amountOperations.has(operation));
  const allowedRewardModes = value.allowedRewardModes;
  if (allowedRewardModes !== undefined && !Array.isArray(allowedRewardModes)) {
    throw new JpydfSdkError("INVALID_INPUT", "writeAdmission reward modes must be an array");
  }
  const rewardModes = allowedRewardModes === undefined
    ? undefined
    : new Set(allowedRewardModes);
  if (
    rewardModes !== undefined
    && (
      rewardModes.size !== allowedRewardModes!.length
      || [...rewardModes].some((mode) => mode !== "claim" && mode !== "compound")
    )
  ) {
    throw new JpydfSdkError("INVALID_INPUT", "writeAdmission contains an invalid reward mode");
  }
  if (
    permitsAmount && (
      typeof value.maxAmountRaw !== "bigint" || value.maxAmountRaw <= 0n
      || typeof value.maxPendingAmountRaw !== "bigint" || value.maxPendingAmountRaw < value.maxAmountRaw
      || rewardModes === undefined || rewardModes.size === 0
    )
  ) {
    throw new JpydfSdkError(
      "INVALID_INPUT",
      "amount operations require reward modes and positive maxAmountRaw and maxPendingAmountRaw limits",
    );
  }
  return Object.freeze({
    allowedBranchIds: branches,
    allowedOperations: operations,
    allowedRewardModes: rewardModes,
    expiresAtMs: value.expiresAtMs,
    maxAmountRaw: value.maxAmountRaw,
    maxPendingAmountRaw: value.maxPendingAmountRaw,
  });
}

function intentAmount(intent: PreparedIntent): bigint | undefined {
  return "amountRaw" in intent ? intent.amountRaw : undefined;
}

function intentRewardMode(intent: PreparedIntent): JpydfAgentRewardMode | undefined {
  return "claim" in intent ? intent.claim ? "claim" : "compound" : undefined;
}

type AgentClientOptions = {
  publicClient: JpydfDeadlinePublicClient;
  deployment: JpydfDeployment;
  scope: JpydfDeploymentScope;
  account: Address;
  authorizeFinalization?: (
    authorization: JpydfAgentFinalizationAuthorization,
  ) => boolean;
  writeAdmission?: JpydfAgentWriteAdmission;
};

export function createJpydfMainnetCanaryAgentClient(options: AgentClientOptions & { scope: "mainnet-canary" }) {
  if (options.scope !== "mainnet-canary") throw new JpydfSdkError("TEST_ONLY_SCOPE_REQUIRED", "Canary scope required");
  return createAgentClient(options);
}

export function createJpydfMainnetStagingAgentClient(
  options: Omit<AgentClientOptions, "scope" | "writeAdmission" | "authorizeFinalization"> & { scope: "mainnet-staging" },
) {
  if (options.scope !== "mainnet-staging") throw new JpydfSdkError("TEST_ONLY_SCOPE_REQUIRED", "Staging scope required");
  const { host: _, ...readOnly } = createAgentClient(options);
  return Object.freeze(readOnly);
}

// Production agent sessions are read-only (SDK-FR-007): no write admission or host finalization.
export function createJpydfProductionAgentClient(
  options: Omit<AgentClientOptions, "scope" | "writeAdmission" | "authorizeFinalization"> & { scope: "production" },
) {
  if (options.scope !== "production") throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "Production scope required");
  const { host: _, ...readOnly } = createAgentClient(options);
  return Object.freeze(readOnly);
}

function createAgentClient(options: AgentClientOptions) {
  if ((options.scope === "mainnet-staging" || options.scope === "production")
    && (options.writeAdmission !== undefined || options.authorizeFinalization !== undefined)) {
    throw new JpydfSdkError("POLICY_VIOLATION", `${options.scope} agent sessions are read-only`);
  }
  options = Object.freeze({ ...options });
  assertJpydfDeadlinePublicClient(options.publicClient);
  const actor = account(options.account);
  const admission = writeAdmission(options.writeAdmission);
  if (admission && typeof options.authorizeFinalization !== "function") {
    throw new JpydfSdkError(
      "INVALID_INPUT",
      "writeAdmission requires an authorizeFinalization callback",
    );
  }
  if (
    admission && [...admission.allowedBranchIds].some(
      (branchId) => !options.deployment.branches.some((branch) => branch.branchId === branchId),
    )
  ) {
    throw new JpydfSdkError("INVALID_INPUT", "writeAdmission contains an unavailable branchId");
  }
  const client = createJpydfClient({
    publicClient: options.publicClient,
    deployment: options.deployment,
    scope: options.scope,
  });
  const identity = Object.freeze(
    {
      environment: options.deployment.deploymentScope,
      testOnly: options.deployment.deploymentScope !== "production",
      chainId: options.deployment.chainId,
      deploymentClassification: options.deployment.deploymentClassification,
      deploymentId: options.deployment.deploymentId,
      manifestSha256: options.deployment.manifestSha256,
      actor,
    } as const,
  );
  const marketAvailable = options.deployment.deploymentScope === "production";
  const operationCatalog = Object.freeze(AGENT_OPERATION_CATALOG.filter(({ id, kind }) => (
    (marketAvailable || !id.startsWith("jpydfUsdc.")) && (
    kind === "read" || admission?.allowedOperations.has(id as JpydfAgentWriteOperation))
  )));
  // ponytail: process-local with a short TTL; use signed persistent intents if restart survival is required.
  const references = new Map<string, {
    amountRaw: bigint;
    expiresAt: number;
    reference: PreparedActionReference;
  }>();
  const inFlight = new Set<string>();
  let authorizationCallbackValid = true;
  let pendingAmountRaw = 0n;

  function releaseReference(id: string): void {
    const saved = references.get(id);
    if (!saved || !references.delete(id)) return;
    pendingAmountRaw -= saved.amountRaw;
  }

  function pruneExpired(now = Date.now()): void {
    for (const [id, saved] of references) {
      if (saved.expiresAt <= now && !inFlight.has(id)) releaseReference(id);
    }
  }

  function assertPendingCapacity(): void {
    pruneExpired();
    if (references.size < PENDING_LIMIT) return;
    const retryAfterMs = Math.max(
      1_000,
      Math.min(...[...references.values()].map(({ expiresAt }) => expiresAt - Date.now())),
    );
    throw new JpydfSdkError("RATE_LIMITED", "Too many pending agent actions", { retryAfterMs });
  }

  function assertWriteAllowed(
    operation: JpydfAgentWriteOperation,
    selectedBranchId: number,
    amountRaw: bigint | undefined,
    rewardMode: JpydfAgentRewardMode | undefined,
    mode: "check" | "reserve" | "revalidate",
  ): void {
    if (!admission) throw new JpydfSdkError("POLICY_VIOLATION", "Agent writes are disabled");
    if (Date.now() >= admission.expiresAtMs) {
      throw new JpydfSdkError("POLICY_VIOLATION", "Agent write admission expired");
    }
    if (!admission.allowedOperations.has(operation) || !admission.allowedBranchIds.has(selectedBranchId)) {
      throw new JpydfSdkError("POLICY_VIOLATION", "Agent operation is outside the host write admission");
    }
    if (amountRaw !== undefined) {
      if (!rewardMode || !admission.allowedRewardModes?.has(rewardMode)) {
        throw new JpydfSdkError("POLICY_VIOLATION", "Agent reward handling is outside the host write admission");
      }
      if (admission.maxAmountRaw === undefined || amountRaw > admission.maxAmountRaw) {
        throw new JpydfSdkError("POLICY_VIOLATION", "Agent amount exceeds the per-action limit");
      }
      if (
        mode !== "revalidate"
        && (
          admission.maxPendingAmountRaw === undefined
          || pendingAmountRaw + amountRaw > admission.maxPendingAmountRaw
        )
      ) {
        throw new JpydfSdkError("POLICY_VIOLATION", "Agent amount exceeds the pending intent limit");
      }
      if (mode === "reserve") pendingAmountRaw += amountRaw;
    }
  }

  function saveReference(prepared: SimulatedAction) {
    assertPendingCapacity();
    const revalidationId = globalThis.crypto.randomUUID();
    assertWriteAllowed(
      prepared.intent.operationId,
      prepared.intent.branchId,
      intentAmount(prepared.intent),
      intentRewardMode(prepared.intent),
      "reserve",
    );
    references.set(revalidationId, {
      amountRaw: intentAmount(prepared.intent) ?? 0n,
      expiresAt: Date.now() + PENDING_TTL_MS,
      reference: prepared.reference,
    });
    const { reference: _, ...safe } = prepared;
    return { ...safe, revalidationId };
  }

  async function response(
    operationId: AgentResponseOperationId | "unknown" | (() => AgentResponseOperationId | "unknown"),
    operation: () => Promise<unknown>,
  ): Promise<InternalAgentResponse> {
    try {
      const data = await operation();
      const resolvedOperationId = typeof operationId === "function" ? operationId() : operationId;
      if (resolvedOperationId === "unknown") {
        throw new JpydfSdkError("INVALID_INPUT", "Unknown agent operation");
      }
      return {
        schemaVersion: "1",
        ...identity,
        ok: true,
        operationId: resolvedOperationId,
        data: toAgentJson(data) as JpydfAgentDataByOperation[AgentResponseOperationId],
      };
    } catch (error) {
      const overload = error instanceof JpydfRpcOverloadedError
        ? error
        : error instanceof BaseError
        ? error.walk((cause) => cause instanceof JpydfRpcOverloadedError)
        : undefined;
      const normalizedError = overload instanceof JpydfRpcOverloadedError
        ? new JpydfSdkError("RATE_LIMITED", overload.message, { retryAfterMs: overload.retryAfterMs })
        : error;
      const known = normalizedError instanceof JpydfSdkError;
      const retryable = known
        ? normalizedError.code === "NEXT_BLOCK_REQUIRED"
          || normalizedError.code === "ORACLE_UNAVAILABLE"
          || normalizedError.code === "RATE_LIMITED"
          || normalizedError.code === "STALE_BLOCK"
        : true;
      const retryAfterMs = known
        ? normalizedError.retryAfterMs ?? 1_000
        : Math.max(1_000, getJpydfRpcHealth(options.publicClient).nextRecoveryProbeInMs);
      return {
        schemaVersion: "1",
        ...identity,
        ok: false,
        operationId: typeof operationId === "function" ? operationId() : operationId,
        error: {
          code: known ? normalizedError.code : "RPC_ERROR",
          message: known ? normalizedError.message : "The RPC operation could not be completed",
          retryable,
          ...(retryable ? { retryAfterMs } : {}),
        },
      };
    }
  }

  async function invoke<Operation extends JpydfAgentOperationId>(
    request: JpydfAgentRequest & { operation: Operation },
  ): Promise<JpydfAgentResponse<Operation>> {
    let operationId: AgentResponseOperationId | "unknown" = "unknown";
    return response(() => operationId, async () => {
      pruneExpired();
      exactKeys(request, ["operation", "input"], "request");
      if (
        typeof request.operation !== "string"
        || !AGENT_OPERATION_CATALOG.some(({ id }) => id === request.operation)
      ) {
        throw new JpydfSdkError("INVALID_INPUT", "Unknown agent operation");
      }
      operationId = request.operation as JpydfAgentOperationId;
      const allowedInputKeys = operationId === "integration.get"
        || operationId === "protocol.get"
        || operationId === "account.get"
        || operationId === "jpydfUsdc.pool"
        ? []
        : operationId === "jpydfUsdc.quote"
        ? ["tokenIn", "amountRaw"]
        : operationId === "market.get"
        ? ["branchId"]
        : operationId === "liquidation.scan"
        ? ["branchId", "maxIterations", "startId"]
        : operationId === "earn.deposit" || operationId === "earn.withdraw"
        ? ["amountRaw", "branchId", "claim"]
        : ["branchId"];
      exactKeys(request.input, allowedInputKeys, "input");
      const requestInput = request.input as Record<string, unknown>;

      switch (operationId) {
        case "integration.get":
          return {
            capabilities: client.capabilities,
            protocolConstants: options.deployment.protocolConstants,
          };
        case "protocol.get":
          return client.getBranches();
        case "account.get":
          return client.getAccount(actor);
        case "market.get":
          return client.getMarket({ branchId: branchId(requestInput.branchId) });
        case "jpydfUsdc.pool":
          return getJpydfUsdcPool({ publicClient: options.publicClient as PublicClient, deployment: options.deployment });
        case "jpydfUsdc.quote": {
          const tokenIn = requestInput.tokenIn;
          if (tokenIn !== "USDC" && tokenIn !== "JPYdf") throw new JpydfSdkError("INVALID_INPUT", "tokenIn must be USDC or JPYdf");
          if (typeof requestInput.amountRaw !== "string" || !/^[1-9][0-9]{0,38}$/.test(requestInput.amountRaw)) {
            throw new JpydfSdkError("INVALID_INPUT", "amountRaw must be a positive base-unit integer string");
          }
          return quoteJpydfUsdc({ publicClient: options.publicClient as PublicClient, deployment: options.deployment, tokenIn, amountInRaw: BigInt(requestInput.amountRaw) });
        }
        case "liquidation.scan": {
          if (
            !Number.isSafeInteger(requestInput.maxIterations)
            || (requestInput.maxIterations as number) < 1
            || (requestInput.maxIterations as number) > 128
          ) {
            throw new JpydfSdkError("INVALID_INPUT", "maxIterations must be between 1 and 128");
          }
          return client.scanLiquidationCandidates({
            branchId: branchId(requestInput.branchId),
            includeLastZombie: true,
            maxIterations: requestInput.maxIterations as number,
            startId: rawUint256(requestInput.startId, "startId"),
          });
        }
        case "earn.deposit":
        case "earn.withdraw": {
          assertPendingCapacity();
          if (typeof requestInput.claim !== "boolean") {
            throw new JpydfSdkError("INVALID_INPUT", "claim must be a boolean");
          }
          const amountRaw = rawAmount(requestInput.amountRaw);
          const selectedBranchId = branchId(requestInput.branchId);
          const rewardMode = requestInput.claim ? "claim" : "compound";
          assertWriteAllowed(operationId, selectedBranchId, amountRaw, rewardMode, "check");
          const input = {
            account: actor,
            amountRaw,
            branchId: selectedBranchId,
            claim: requestInput.claim,
          };
          const prepared = operationId === "earn.deposit"
            ? await client.prepareEarnDeposit(input)
            : await client.prepareEarnWithdraw(input);
          return saveReference(prepared);
        }
        case "earn.claim":
        case "earn.compound": {
          assertPendingCapacity();
          const selectedBranchId = branchId(requestInput.branchId);
          assertWriteAllowed(operationId, selectedBranchId, undefined, undefined, "check");
          const input = { account: actor, branchId: selectedBranchId };
          const prepared = operationId === "earn.claim"
            ? await client.prepareEarnClaim(input)
            : await client.prepareEarnCompound(input);
          return saveReference(prepared);
        }
      }
    }) as Promise<JpydfAgentResponse<Operation>>;
  }

  async function finalize(revalidationId: string): Promise<JpydfAgentResponse<"transaction.finalize">> {
    return response("transaction.finalize", async () => {
      pruneExpired();
      if (typeof revalidationId !== "string" || revalidationId.length === 0 || revalidationId.length > 64) {
        throw new JpydfSdkError("INVALID_INPUT", "revalidationId must be a non-empty string");
      }
      const saved = references.get(revalidationId);
      if (!saved || inFlight.has(revalidationId)) {
        throw new JpydfSdkError("ACTION_EXPIRED", "Unknown, expired, or in-flight revalidationId");
      }
      if (!authorizationCallbackValid) {
        releaseReference(revalidationId);
        throw new JpydfSdkError(
          "POLICY_VIOLATION",
          "authorizeFinalization is disabled for this agent session",
        );
      }
      assertWriteAllowed(
        saved.reference.intent.operationId,
        saved.reference.intent.branchId,
        intentAmount(saved.reference.intent),
        intentRewardMode(saved.reference.intent),
        "revalidate",
      );
      inFlight.add(revalidationId);
      try {
        authorizationCallbackValid = false;
        let authorized: unknown;
        try {
          authorized = options.authorizeFinalization?.(Object.freeze({
            actor,
            reference: saved.reference,
            revalidationId,
          }));
        } catch (error) {
          authorizationCallbackValid = true;
          throw error;
        }
        if (typeof authorized !== "boolean") {
          releaseReference(revalidationId);
          void Promise.resolve(authorized).catch(() => undefined);
          throw new JpydfSdkError(
            "POLICY_VIOLATION",
            "authorizeFinalization must return a boolean synchronously",
          );
        }
        authorizationCallbackValid = true;
        if (authorized !== true) {
          throw new JpydfSdkError("POLICY_VIOLATION", "Agent finalization was not authorized by the host");
        }
        assertWriteAllowed(
          saved.reference.intent.operationId,
          saved.reference.intent.branchId,
          intentAmount(saved.reference.intent),
          intentRewardMode(saved.reference.intent),
          "revalidate",
        );
        const finalized = await client.prepareForSignature(saved.reference);
        if (Date.now() >= saved.expiresAt) {
          releaseReference(revalidationId);
          throw new JpydfSdkError("ACTION_EXPIRED", "The revalidationId expired during finalization");
        }
        assertWriteAllowed(
          finalized.intent.operationId,
          finalized.intent.branchId,
          intentAmount(finalized.intent),
          intentRewardMode(finalized.intent),
          "revalidate",
        );
        releaseReference(revalidationId);
        return finalized;
      } finally {
        inFlight.delete(revalidationId);
      }
    }) as Promise<JpydfAgentResponse<"transaction.finalize">>;
  }

  return {
    environment: identity.environment,
    testOnly: identity.testOnly,
    model: Object.freeze({ operationCatalog, invoke }),
    host: Object.freeze({ finalize }),
  };
}

export {
  createJpydfMainnetRpcClient,
  getJpydfRpcHealth,
  JPYDF_RPC_DEFAULT_MAX_RESPONSE_BYTES,
  JPYDF_RPC_DEFAULT_RECOVERY_COOLDOWN_MS,
  JPYDF_RPC_DEFAULT_TIMEOUT_MS,
  JPYDF_RPC_PHYSICAL_LIMIT,
  JPYDF_RPC_REGULAR_LIMIT,
  JpydfRpcOverloadedError,
  JpydfRpcTimeoutError,
} from "./rpc.js";
export type { JpydfDeadlinePublicClient, JpydfRpcHealth } from "./rpc.js";

export { createJpydfLpSimulationModel } from "./lp.js";
