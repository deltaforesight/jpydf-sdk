import type { Address, Hex, PublicClient } from "viem";

export type JpydfDeploymentScope = "mainnet-canary" | "mainnet-staging" | "production";

declare const verifiedDeploymentBrand: unique symbol;

export type JpydfBranchDeployment = {
  readonly activePool: Address;
  readonly branchId: number;
  readonly borrowerOperations: Address;
  readonly collSymbol: string;
  readonly collateralVault: Address;
  readonly collateralYieldZapper: Address;
  readonly dToken: Address;
  readonly dTokenDecimals: 18;
  readonly jpyUsdRateProvider: Address;
  readonly priceFeed: Address;
  readonly sortedTroves: Address;
  readonly stabilityPool: Address;
  readonly troveManager: Address;
  readonly underlyingToken: Address;
};

export type JpydfProtocolConstants = {
  readonly ethGasCompensationRaw: bigint;
  readonly maxAnnualInterestRateRaw: bigint;
  readonly minAnnualInterestRateRaw: bigint;
  readonly minDebtRaw: bigint;
  readonly stabilityPoolYieldShareRaw: bigint;
};

export type JpydfDeployment = {
  readonly [verifiedDeploymentBrand]: true;
  readonly branches: readonly JpydfBranchDeployment[];
  readonly chainId: 1;
  readonly deploymentClassification: string;
  readonly deploymentId: string;
  readonly deploymentProfile: string;
  readonly deploymentScope: JpydfDeploymentScope;
  readonly hintHelpers: Address;
  readonly jpydfToken: Address;
  readonly liquidationCandidateGetter: Address;
  readonly manifestSha256: string;
  readonly protocolConstants: JpydfProtocolConstants;
};

export type JpydfPoolKey = {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
};

// The verified JPYdf/USDC Uniswap v4 market of the production descriptor.
export type JpydfProductionMarket = {
  readonly poolId: Hex;
  readonly poolKey: JpydfPoolKey;
  readonly quoter: Address;
  readonly stateView: Address;
  readonly usdc: Address;
};

export type JpydfClientOptions = {
  publicClient: PublicClient;
  deployment: JpydfDeployment;
  scope: JpydfDeploymentScope;
};

export type PreparedTransaction = {
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
};

export type PreparedIntent =
  | {
    operationId: "earn.deposit";
    amountSemantics: "exact";
    branchId: number;
    amountRaw: bigint;
    claim: boolean;
  }
  | {
    operationId: "earn.withdraw";
    amountSemantics: "maximum";
    branchId: number;
    amountRaw: bigint;
    claim: boolean;
  }
  | {
    operationId: "earn.claim" | "earn.compound";
    branchId: number;
  };

export type PreparedOperationId = PreparedIntent["operationId"];

export type PreparedActionReference = {
  readonly actor: Address;
  readonly chainId: 1;
  readonly deploymentId: string;
  readonly deploymentScope: JpydfDeploymentScope;
  readonly manifestSha256: string;
  readonly intent: PreparedIntent;
};

type PreparedActionBase = {
  readonly operationId: PreparedOperationId;
  readonly actor: Address;
  readonly chainId: 1;
  readonly deploymentId: string;
  readonly deploymentScope: JpydfDeploymentScope;
  readonly manifestSha256: string;
  readonly observedAtBlock: bigint;
  readonly observedAtBlockHash: Hex;
  readonly validUntilBlock: bigint;
  readonly intent: PreparedIntent;
};

export type SimulatedAction = PreparedActionBase & {
  readonly status: "simulated";
  readonly requiresRevalidation: true;
  readonly reference: PreparedActionReference;
};

export type ReadyAction = PreparedActionBase & {
  readonly status: "ready-for-signature";
  readonly requiresRevalidation: false;
  readonly transaction: PreparedTransaction;
};

export type PreparedAction = SimulatedAction | ReadyAction;

export type JpydfProtocolSnapshot = {
  chainId: 1;
  deploymentId: string;
  deploymentScope: JpydfDeploymentScope;
  manifestSha256: string;
  observedAtBlock: bigint;
  observedAtBlockHash: Hex;
  branches: readonly JpydfBranchDeployment[];
};

export type JpydfAccountPool = {
  branchId: number;
  collSymbol: string;
  compoundedDeposit: bigint;
  hasRecordedDeposit: boolean;
  rewards: {
    jpydf: bigint;
    collateral: bigint;
  };
};

export type JpydfAccountSnapshot = Omit<JpydfProtocolSnapshot, "branches"> & {
  account: Address;
  jpydfBalance: bigint;
  pools: JpydfAccountPool[];
};

export type JpydfMarketSnapshot = Omit<JpydfProtocolSnapshot, "branches"> & {
  branchId: number;
  collSymbol: string;
  protocolPriceRaw: bigint;
  averageBorrowRateRaw: bigint | null;
  stabilityPoolAprRaw: bigint | null;
  stabilityPoolYieldShareRaw: bigint;
  aggregateRecordedDebtRaw: bigint;
  aggregateWeightedDebtRaw: bigint;
  totalBranchCollateralRaw: bigint;
  totalBranchDebtRaw: bigint;
  stabilityPoolDepositsRaw: bigint;
  stabilityPoolCoverageRaw: bigint | null;
  totalCollateralRatioRaw: bigint | null;
  minimumCollateralRatioRaw: bigint;
  criticalCollateralRatioRaw: bigint;
  shutdownCollateralRatioRaw: bigint;
  oracleStatus: "frozen" | "live";
  jpyFrozenSince: bigint;
  jpyUsdOracleUpdatedAt: bigint;
  vaultBackingRatioRaw: bigint;
  shutdown: boolean;
  vaultPaused: {
    claim: boolean;
    deposit: boolean;
    redeem: boolean;
  };
};

export type JpydfLiquidationCandidate = {
  troveId: bigint;
  icrRaw: bigint;
  entireDebtRaw: bigint;
  entireCollateralRaw: bigint;
};

export type JpydfLiquidationPage = Omit<JpydfProtocolSnapshot, "branches"> & {
  branchId: number;
  collSymbol: string;
  protocolPriceRaw: bigint;
  minimumCollateralRatioRaw: bigint;
  oracleStatus: "live";
  startId: bigint;
  nextCursor: bigint;
  maxIterations: number;
  includedLastZombie: boolean;
  requiresExecutionRevalidation: true;
  candidates: readonly JpydfLiquidationCandidate[];
};
