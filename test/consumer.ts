import {
  createJpydfClient,
  type JpydfDeployment,
  type MainnetCanaryUniV4Route,
  type ReadyAction,
  type SimulatedAction,
} from "@jpydf/sdk";
import {
  createJpydfMainnetCanaryAgentClient,
  type JpydfAgentResponse,
  type JpydfDeadlinePublicClient,
} from "@jpydf/sdk/agent";
import { type Address, createWalletClient, custom, type EIP1193Provider, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

declare const account: Address;
declare const deployment: JpydfDeployment;
declare const publicClient: PublicClient;
declare const rpcClient: JpydfDeadlinePublicClient;
declare const walletProvider: EIP1193Provider;
declare const univ4Route: MainnetCanaryUniV4Route;

const client = createJpydfClient({ publicClient, deployment, scope: "mainnet-canary" });

async function manualUniV4Smoke() {
  const prepared = await client.prepareUniV4WalletSmoke({
    account,
    amountIn: 10n ** 18n,
    deadline: 1_800_000_000n,
    route: univ4Route,
  });
  void prepared.transactions;
  // @ts-expect-error Manual smoke preparation never authorizes broadcast.
  prepared.mainnetBroadcastAuthorized = true;
}

async function humanFlow(): Promise<ReadyAction> {
  const market = await client.getMarket({ branchId: 1 });
  void market.averageBorrowRateRaw;
  const liquidationPage = await client.scanLiquidationCandidates({
    branchId: 1,
    includeLastZombie: true,
    maxIterations: 32,
    startId: 0n,
  });
  void liquidationPage.requiresExecutionRevalidation;
  const preview: SimulatedAction = await client.prepareEarnDeposit({
    account,
    amountRaw: 1_000n * 10n ** 18n,
    branchId: 1,
    claim: true,
  });
  // @ts-expect-error A preview must never expose sendable calldata.
  void preview.transaction;
  const ready = await client.prepareForSignature(preview.reference);
  const walletClient = createWalletClient({ chain: mainnet, transport: custom(walletProvider) });
  await walletClient.sendTransaction({ ...ready.transaction, chain: mainnet });
  return ready;
}

const agent = createJpydfMainnetCanaryAgentClient({
  publicClient: rpcClient,
  deployment,
  scope: "mainnet-canary",
  account,
});

createJpydfMainnetCanaryAgentClient({
  publicClient: rpcClient,
  deployment,
  scope: "mainnet-canary",
  account,
  // @ts-expect-error Finalization authorization must be synchronous.
  authorizeFinalization: async () => true,
});

async function agentFlow(): Promise<JpydfAgentResponse> {
  await agent.model.invoke({ operation: "integration.get", input: {} });
  const market = await agent.model.invoke({ operation: "market.get", input: { branchId: 1 } });
  if (market.ok) void market.data.averageBorrowRateRaw;
  // @ts-expect-error market.get accepts only branchId.
  await agent.model.invoke({ operation: "market.get", input: { amountRaw: "1" } });
  const liquidation = await agent.model.invoke({
    operation: "liquidation.scan",
    input: { branchId: 1, maxIterations: 32, startId: "0" },
  });
  if (liquidation.ok) void liquidation.data.requiresExecutionRevalidation;
  const read = await agent.model.invoke({ operation: "account.get", input: {} });
  if (!read.ok && read.error.retryable) void read.error.retryAfterMs;
  // @ts-expect-error Finalization is not present on the model capability.
  await agent.model.finalize("x");
  return read;
}

async function hostFlow(): Promise<JpydfAgentResponse> {
  return agent.host.finalize("approved-revalidation-id");
}

void humanFlow;
void manualUniV4Smoke;
void agentFlow;
void hostFlow;

// Offline simulation is available in browsers; the model adapter stays on /agent.
const { simulateLp } = await import("@jpydf/sdk");
const { createJpydfLpSimulationModel, createJpydfMainnetStagingAgentClient } = await import("@jpydf/sdk/agent");
const simulated = simulateLp({ budgetJpy: "100000", fxJpyPerUsd: "150", spotJpydfPerUsdc: "150",
  lowerJpydfPerUsdc: "140", upperJpydfPerUsdc: "160", futureFxJpyPerUsd: "150", futureJpydfJpy: "1" });
const exactAmount: string = simulated.initial.jpydf.baseUnits;
void exactAmount;
void createJpydfLpSimulationModel().operationCatalog;
const staging = createJpydfMainnetStagingAgentClient({ deployment, publicClient: rpcClient, scope: "mainnet-staging", account });
// @ts-expect-error staging exposes no host finalization capability.
void staging.host;
