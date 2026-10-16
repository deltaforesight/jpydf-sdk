import { Buffer } from "node:buffer";
import type { ClientRequest, IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";

import { BaseError, createPublicClient, custom, type EIP1193Parameters, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

export const JPYDF_RPC_REGULAR_LIMIT = 15;
export const JPYDF_RPC_PHYSICAL_LIMIT = JPYDF_RPC_REGULAR_LIMIT + 2;
const JPYDF_RPC_RECOVERY_LIMIT = JPYDF_RPC_PHYSICAL_LIMIT - JPYDF_RPC_REGULAR_LIMIT;
export const JPYDF_RPC_DEFAULT_TIMEOUT_MS = 10_000;
export const JPYDF_RPC_DEFAULT_RECOVERY_COOLDOWN_MS = 5_000;
export const JPYDF_RPC_DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

declare const deadlinePublicClientBrand: unique symbol;
export type JpydfDeadlinePublicClient = PublicClient & {
  readonly [deadlinePublicClientBrand]: true;
};

type ActiveRequest = {
  deadlineAt: number;
  recoveryProbe: boolean;
  startedAt: number;
  timedOut: boolean;
};

type RpcState = {
  active: Map<number, ActiveRequest>;
  cooldownMs: number;
  health: (now?: number) => JpydfRpcHealth;
  recoveryEligibleAt: number;
  recoveryRequired: boolean;
  stuckProbeObserved: boolean;
  timeoutMs: number;
};

type RuntimeAdmission = {
  active: Map<number, ActiveRequest>;
  nextId: number;
};

export type JpydfRpcHealth = {
  activeCount: number;
  circuitState: "closed" | "open" | "half-open";
  configuredLimit: number;
  nextRecoveryProbeInMs: number;
  oldestOutstandingAgeMs: number;
  recoveryProbeActive: boolean;
  regularActiveCount: number;
  regularLimit: number;
  stuckProbeActive: boolean;
};

const states = new WeakMap<object, RpcState>();
const runtimeAdmissionKey = Symbol.for("@jpydf/sdk.rpc-runtime-admission.v1");
const runtimeAdmission = (() => {
  const existing = Reflect.get(globalThis, runtimeAdmissionKey) as RuntimeAdmission | undefined;
  if (existing) return existing;
  const created: RuntimeAdmission = { active: new Map(), nextId: 1 };
  Object.defineProperty(globalThis, runtimeAdmissionKey, { value: created });
  return created;
})();

export class JpydfRpcTimeoutError extends BaseError {
  constructor(timeoutMs: number) {
    super(`JPYdf RPC request timed out after ${timeoutMs}ms`, { name: "JpydfRpcTimeoutError" });
  }
}

export class JpydfRpcOverloadedError extends BaseError {
  readonly retryAfterMs: number;

  constructor(health: JpydfRpcHealth) {
    const retryAfterMs = Math.max(1, health.nextRecoveryProbeInMs || 1_000);
    super("JPYdf RPC capacity is exhausted", { name: "JpydfRpcOverloadedError" });
    this.retryAfterMs = retryAfterMs;
  }
}

class JpydfRpcDependencyError extends BaseError {
  constructor() {
    super("JPYdf RPC dependency failed", { name: "JpydfRpcDependencyError" });
  }
}

class JpydfRpcRateLimitError extends BaseError {
  constructor() {
    super("JPYdf RPC dependency is rate limited", { name: "JpydfRpcRateLimitError" });
  }
}

class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: { code?: unknown; data?: unknown; message?: unknown }) {
    super(typeof error.message === "string" ? error.message : "JSON-RPC request failed");
    this.name = "JsonRpcResponseError";
    this.code = typeof error.code === "number" ? error.code : -32603;
    this.data = error.data;
  }
}

type JsonRpcPayload = {
  error?: { code: number; data?: unknown; message: string };
  result?: unknown;
};

type HttpsRequestFactory = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

type PhysicalRpcRequest = {
  abort: (reason: Error) => void;
  promise: Promise<JsonRpcPayload>;
};

function jsonRpcPayload(responseBody: string, expectedId: number): JsonRpcPayload {
  let value: unknown;
  try {
    value = JSON.parse(responseBody);
  } catch {
    throw new JpydfRpcDependencyError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JpydfRpcDependencyError();
  }
  const payload = value as Record<string, unknown>;
  const hasResult = Object.hasOwn(payload, "result");
  const hasError = Object.hasOwn(payload, "error");
  if (payload.jsonrpc !== "2.0" || payload.id !== expectedId || hasResult === hasError) {
    throw new JpydfRpcDependencyError();
  }
  if (hasError) {
    const error = payload.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) {
      throw new JpydfRpcDependencyError();
    }
    const candidate = error as Record<string, unknown>;
    if (!Number.isInteger(candidate.code) || typeof candidate.message !== "string") {
      throw new JpydfRpcDependencyError();
    }
  }
  return payload as JsonRpcPayload;
}

function hasRevertData(data: unknown): boolean {
  const isRevertData = (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value);
  if (isRevertData(data)) return true;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  const nested = record.originalError;
  return isRevertData(record.data)
    || Boolean(nested && typeof nested === "object" && isRevertData((nested as Record<string, unknown>).data));
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function dependencyError(error: unknown): Error {
  return error instanceof JpydfRpcDependencyError || error instanceof JpydfRpcRateLimitError
    ? error
    : new JpydfRpcDependencyError();
}

function physicalRpcRequest(
  requestHttps: HttpsRequestFactory,
  url: URL,
  body: string,
  expectedId: number,
  maxBytes: number,
): PhysicalRpcRequest {
  let request: ClientRequest | undefined;
  let abortReason: Error | undefined;
  let failure: Error | undefined;
  let settled = false;
  let resolveRequest!: (payload: JsonRpcPayload) => void;
  let rejectRequest!: (error: Error) => void;
  const promise = new Promise<JsonRpcPayload>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const finish = (result: JsonRpcPayload | Error): void => {
    if (settled) return;
    settled = true;
    if (result instanceof Error) rejectRequest(result);
    else resolveRequest(result);
  };

  try {
    request = requestHttps(
      url,
      {
        headers: {
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      (response) => {
        response.once("error", (error) => {
          failure = dependencyError(error);
          request?.destroy(failure);
        });
        const rawContentLength = response.headers["content-length"];
        const contentLength = Number(Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          failure = new JpydfRpcDependencyError();
          response.destroy(failure);
          request?.destroy(failure);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (failure) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > maxBytes) {
            failure = new JpydfRpcDependencyError();
            response.destroy(failure);
            request?.destroy(failure);
            return;
          }
          chunks.push(bytes);
        });
        response.once("end", () => {
          if (failure) return;
          if (response.statusCode === 429) {
            finish(new JpydfRpcRateLimitError());
            return;
          }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            finish(new JpydfRpcDependencyError());
            return;
          }
          try {
            finish(jsonRpcPayload(Buffer.concat(chunks, size).toString("utf8"), expectedId));
          } catch (error) {
            finish(dependencyError(error));
          }
        });
      },
    );
    request.once("error", (error) => {
      failure = abortReason ?? dependencyError(error);
    });
    request.once("close", () => {
      if (!settled) finish(failure ?? new JpydfRpcDependencyError());
    });
    request.end(body);
  } catch (error) {
    finish(dependencyError(error));
  }

  return {
    abort(reason) {
      abortReason = reason;
      request?.destroy(reason);
    },
    promise,
  };
}

function health(state: RpcState, now = Date.now()): JpydfRpcHealth {
  const localActive = [...state.active.values()];
  const runtimeActive = [...runtimeAdmission.active.values()];
  const regular = runtimeActive.filter((request) => !request.recoveryProbe);
  const recoveryProbe = localActive.find((request) => request.recoveryProbe && !request.timedOut);
  return {
    activeCount: runtimeActive.length,
    circuitState: recoveryProbe ? "half-open" : state.recoveryRequired ? "open" : "closed",
    configuredLimit: JPYDF_RPC_PHYSICAL_LIMIT,
    nextRecoveryProbeInMs: state.recoveryRequired
      ? Math.max(0, state.recoveryEligibleAt - now)
      : 0,
    oldestOutstandingAgeMs: runtimeActive.length === 0
      ? 0
      : Math.max(0, now - Math.min(...runtimeActive.map((request) => request.startedAt))),
    recoveryProbeActive: recoveryProbe !== undefined,
    regularActiveCount: regular.length,
    regularLimit: JPYDF_RPC_REGULAR_LIMIT,
    stuckProbeActive: localActive.some((request) => request.recoveryProbe && request.timedOut)
      || state.stuckProbeObserved
      || (recoveryProbe !== undefined && now >= recoveryProbe.deadlineAt),
  };
}

function openCircuit(state: RpcState, stuckProbe = false): void {
  state.recoveryRequired = true;
  state.recoveryEligibleAt = Date.now() + state.cooldownMs;
  if (stuckProbe) state.stuckProbeObserved = true;
}

function completeRecovery(state: RpcState): void {
  state.stuckProbeObserved = false;
  const regularCapacityExhausted = [...runtimeAdmission.active.values()]
    .filter((request) => !request.recoveryProbe).length >= JPYDF_RPC_REGULAR_LIMIT;
  state.recoveryRequired = regularCapacityExhausted;
  state.recoveryEligibleAt = 0;
}

export function createJpydfMainnetRpcClient(options: {
  maxResponseBytes?: number;
  rpcUrl: string;
  recoveryCooldownMs?: number;
  timeoutMs?: number;
}): JpydfDeadlinePublicClient {
  let url: URL;
  try {
    url = new URL(options.rpcUrl);
  } catch {
    throw new Error("rpcUrl must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("rpcUrl must be HTTPS and must not contain URL credentials or a fragment");
  }
  const requestHttps = https.request.bind(https) as HttpsRequestFactory;
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? JPYDF_RPC_DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
    5_000_000,
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? JPYDF_RPC_DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    60_000,
  );
  const cooldownMs = positiveInteger(
    options.recoveryCooldownMs ?? JPYDF_RPC_DEFAULT_RECOVERY_COOLDOWN_MS,
    "recoveryCooldownMs",
    300_000,
  );
  const state: RpcState = {
    active: new Map(),
    cooldownMs,
    health: (now) => health(state, now),
    recoveryEligibleAt: 0,
    recoveryRequired: false,
    stuckProbeObserved: false,
    timeoutMs,
  };
  let jsonRpcId = 1;

  const provider = {
    async request({ method, params }: EIP1193Parameters): Promise<unknown> {
      const currentHealth = state.health();
      const recoveryCapacityExhausted = [...runtimeAdmission.active.values()]
        .filter((request) => request.recoveryProbe).length >= JPYDF_RPC_RECOVERY_LIMIT;
      const recoveryProbe = currentHealth.circuitState === "open"
        && currentHealth.nextRecoveryProbeInMs === 0
        && !currentHealth.recoveryProbeActive
        && !recoveryCapacityExhausted
        && currentHealth.activeCount < currentHealth.configuredLimit;
      const regularCapacityExhausted = currentHealth.regularActiveCount >= currentHealth.regularLimit
        || currentHealth.activeCount >= currentHealth.configuredLimit;
      if (
        currentHealth.circuitState === "half-open"
        || (currentHealth.circuitState === "open" && !recoveryProbe)
        || (currentHealth.circuitState === "closed" && regularCapacityExhausted)
      ) {
        throw new JpydfRpcOverloadedError(currentHealth);
      }

      const requestId = runtimeAdmission.nextId++;
      const startedAt = Date.now();
      const activeRequest = {
        deadlineAt: startedAt + timeoutMs,
        recoveryProbe,
        startedAt,
        timedOut: false,
      };
      state.active.set(requestId, activeRequest);
      runtimeAdmission.active.set(requestId, activeRequest);
      const rpcRequestId = jsonRpcId++;
      let body: string;
      try {
        body = JSON.stringify({ jsonrpc: "2.0", id: rpcRequestId, method, params });
      } catch (error) {
        state.active.delete(requestId);
        runtimeAdmission.active.delete(requestId);
        throw error;
      }
      const timeoutError = new JpydfRpcTimeoutError(timeoutMs);
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const physical = physicalRpcRequest(requestHttps, url, body, rpcRequestId, maxResponseBytes);
      const physicalRequest = physical.promise;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          const request = state.active.get(requestId);
          if (request) request.timedOut = true;
          openCircuit(state, recoveryProbe);
          physical.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });
      void physicalRequest.finally(() => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        state.active.delete(requestId);
        runtimeAdmission.active.delete(requestId);
      }).catch(() => undefined);

      let payload: JsonRpcPayload;
      try {
        payload = await Promise.race([physicalRequest, deadline]);
      } catch (error) {
        if (timedOut) throw timeoutError;
        if (error instanceof JpydfRpcRateLimitError) {
          openCircuit(state);
          throw new JpydfRpcOverloadedError(state.health());
        }
        if (error instanceof JpydfRpcDependencyError) openCircuit(state);
        throw error;
      }
      if (payload.error) {
        const callMethod = method === "eth_call" || method === "eth_estimateGas";
        const applicationRevert = callMethod && (
          payload.error.code === 3
          || (payload.error.code === -32603 && hasRevertData(payload.error.data))
        );
        if (payload.error.code === -32005) {
          openCircuit(state);
          throw new JpydfRpcOverloadedError(state.health());
        }
        if (
          payload.error.code === -32002
          || (payload.error.code === -32603 && !applicationRevert)
        ) {
          openCircuit(state);
          throw new JpydfRpcDependencyError();
        }
        if (recoveryProbe) {
          if (applicationRevert) completeRecovery(state);
          else openCircuit(state);
        }
        throw new JsonRpcResponseError(payload.error);
      }
      if (recoveryProbe) completeRecovery(state);
      return payload.result;
    },
  };

  const client = createPublicClient({
    chain: mainnet,
    transport: custom(provider, { name: "JPYdf deadline RPC", retryCount: 0 }),
  }) as unknown as JpydfDeadlinePublicClient;
  states.set(client, state);
  return client;
}

export function assertJpydfDeadlinePublicClient(
  publicClient: PublicClient,
): asserts publicClient is JpydfDeadlinePublicClient {
  if (!states.has(publicClient)) {
    throw new Error("agent publicClient must come from createJpydfMainnetRpcClient");
  }
}

export function getJpydfRpcHealth(publicClient: JpydfDeadlinePublicClient): JpydfRpcHealth {
  const state = states.get(publicClient);
  if (!state) throw new Error("unknown JPYdf deadline RPC client");
  return state.health();
}
