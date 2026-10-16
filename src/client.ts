import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  isAddress,
  zeroAddress,
} from "viem";

import { assertVerifiedDeployment } from "./deployment.js";
import { JpydfSdkError } from "./errors.js";
import {
  ActivePoolAbi,
  AggregatorV3Abi,
  BorrowerOperationsAbi,
  CollateralVaultAbi,
  DFPriceFeedBaseAbi,
  LiquidationCandidateGetterAbi,
  JpyUsdRateProviderAbi,
  PriceFeedProxyAbi,
  StabilityPoolAbi,
  TroveManagerAbi,
} from "./generated/abis.js";
import {
  type MainnetCanaryUniV4Route,
  prepareMainnetCanaryUniV4WalletSmoke,
} from "./mainnet-canary-univ4.js";
import type {
  JpydfAccountSnapshot,
  JpydfBranchDeployment,
  JpydfClientOptions,
  JpydfLiquidationPage,
  JpydfMarketSnapshot,
  JpydfProtocolSnapshot,
  PreparedActionReference,
  PreparedIntent,
  PreparedTransaction,
  ReadyAction,
  SimulatedAction,
} from "./types.js";

const WAD = 10n ** 18n;
const UINT256_LIMIT = 2n ** 256n;
const MAX_LIQUIDATION_SCAN_ITERATIONS = 128;

export const MAINNET_CANARY_SDK_CAPABILITIES = Object.freeze({
  borrow: Object.freeze({ marketRead: true, transactionPreparation: false } as const),
  lend: Object.freeze({ canonicalFeature: "earn", transactionPreparation: true } as const),
  earn: Object.freeze({ marketRead: true, transactionPreparation: true } as const),
  swap: Object.freeze({ available: false, reason: "UNWIRED_AUDIT_SCOPE" } as const),
  uniswapV4WalletSmoke: Object.freeze({ quote: true, unsignedCalldata: true, broadcast: false } as const),
  liquidation: Object.freeze({ candidateScan: true, execution: "external-liquidator-bot" } as const),
  rates: Object.freeze({ marketRead: true } as const),
} as const);

export const MAINNET_STAGING_SDK_CAPABILITIES = Object.freeze({
  ...MAINNET_CANARY_SDK_CAPABILITIES,
  lend: Object.freeze({ canonicalFeature: "earn", transactionPreparation: false } as const),
  earn: Object.freeze({ marketRead: true, transactionPreparation: false } as const),
  uniswapV4WalletSmoke: Object.freeze({ quote: false, unsignedCalldata: false, broadcast: false } as const),
});

type PreparedActionInternal = Omit<ReadyAction, "requiresRevalidation" | "status"> & {
  reference: PreparedActionReference;
};

function requirePositive(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value <= 0n || value >= UINT256_LIMIT) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be a positive uint256`);
  }
}

function requireUint256(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value >= UINT256_LIMIT) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be a uint256`);
  }
}

function requireBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be a boolean`);
  }
}

function requireAddress(value: string, label: string): Address {
  if (!isAddress(value)) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be a valid address`);
  }
  const address = getAddress(value);
  if (address === zeroAddress) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must not be the zero address`);
  }
  return address;
}

function simulationFailure(revert: ContractFunctionRevertedError, label: string) {
  const reason = revert.reason ?? "";
  if (
    reason.includes("Withdrawal must wait after deposit")
    || reason.includes("Coll gain claim must wait after deposit")
  ) {
    return {
      code: "NEXT_BLOCK_REQUIRED" as const,
      message: "This action must be prepared again after the next block",
      retryAfterMs: 1_000,
    };
  }
  if (reason.includes("User must have a non-zero deposit")) {
    return { code: "SIMULATION_REVERTED" as const, message: "An existing Stability Pool deposit is required" };
  }
  if (reason.includes("User must have no deposit")) {
    return {
      code: "SIMULATION_REVERTED" as const,
      message: "This reward path requires no recorded Stability Pool deposit",
    };
  }
  if (reason.includes("Amount must be non-zero")) {
    return { code: "SIMULATION_REVERTED" as const, message: "The transaction amount must be greater than zero" };
  }
  if (reason.includes("Withdrawal must leave totalJpydfDeposits")) {
    return {
      code: "SIMULATION_REVERTED" as const,
      message: "This withdrawal would violate the Stability Pool minimum deposit",
    };
  }
  return { code: "SIMULATION_REVERTED" as const, message: `${label} simulation reverted` };
}

export function createJpydfClient(options: JpydfClientOptions) {
  const { deployment, publicClient, scope } = options;
  if (scope !== "mainnet-canary" && scope !== "mainnet-staging") {
    throw new JpydfSdkError("TEST_ONLY_SCOPE_REQUIRED", "scope must name a supported test deployment");
  }
  assertVerifiedDeployment(deployment);
  if (scope !== deployment.deploymentScope) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "scope does not match the verified deployment");
  }
  const capabilities = scope === "mainnet-canary"
    ? MAINNET_CANARY_SDK_CAPABILITIES : MAINNET_STAGING_SDK_CAPABILITIES;
  function assertPreparationAllowed(): void {
    if (scope !== "mainnet-canary") {
      throw new JpydfSdkError("POLICY_VIOLATION", "Transaction preparation is unavailable for mainnet-staging");
    }
  }

  function branch(branchId: number): JpydfBranchDeployment {
    if (!Number.isSafeInteger(branchId) || branchId < 0) {
      throw new JpydfSdkError("UNKNOWN_BRANCH", `Unknown branch ${branchId}`);
    }
    const result = deployment.branches.find((candidate) => candidate.branchId === branchId);
    if (!result) {
      throw new JpydfSdkError("UNKNOWN_BRANCH", `Unknown branch ${branchId}`);
    }
    return result;
  }

  async function context() {
    const [chainId, block] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest" }),
    ]);
    if (chainId !== deployment.chainId) {
      throw new JpydfSdkError(
        "WRONG_CHAIN",
        `Connected chain ${chainId} does not match deployment chain ${deployment.chainId}`,
      );
    }
    if (block.number === null || block.hash === null) {
      throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "The latest block is incomplete");
    }
    return {
      observedAtBlock: block.number,
      observedAtBlockHash: block.hash,
      observedAtTimestamp: block.timestamp,
    };
  }

  async function assertCanonicalBlock(observedAtBlock: bigint, observedAtBlockHash: Hex): Promise<void> {
    const canonicalBlock = await publicClient.getBlock({ blockNumber: observedAtBlock });
    if (canonicalBlock.hash === null || canonicalBlock.hash !== observedAtBlockHash) {
      throw new JpydfSdkError(
        "STALE_BLOCK",
        "The observed block is no longer canonical; read the state again",
        { retryAfterMs: 1_000 },
      );
    }
  }

  async function protocolPrice(
    selected: JpydfBranchDeployment,
    observedAtBlock: bigint,
  ): Promise<bigint> {
    const { result } = await publicClient.simulateContract({
      address: selected.priceFeed,
      abi: PriceFeedProxyAbi,
      blockNumber: observedAtBlock,
      functionName: "fetchPrice",
      args: [],
    });
    const [priceRaw, oracleFailed] = result;
    if (oracleFailed || priceRaw === 0n || priceRaw === UINT256_LIMIT - 1n) {
      throw new JpydfSdkError(
        "ORACLE_UNAVAILABLE",
        `Branch ${selected.branchId} protocol price is unavailable`,
        { retryAfterMs: 12_000 },
      );
    }
    return priceRaw;
  }

  async function jpyOracleHealth(
    selected: JpydfBranchDeployment,
    observedAtBlock: bigint,
    observedAtTimestamp: bigint,
  ) {
    try {
      const activeSource = await publicClient.readContract({
        address: selected.priceFeed,
        abi: PriceFeedProxyAbi,
        functionName: "source",
        blockNumber: observedAtBlock,
      });
      const [activeJpyProvider, priceSource] = await Promise.all([
        publicClient.readContract({
          address: activeSource,
          abi: DFPriceFeedBaseAbi,
          functionName: "jpyUsdRateProvider",
          blockNumber: observedAtBlock,
        }),
        publicClient.readContract({
          address: activeSource,
          abi: DFPriceFeedBaseAbi,
          functionName: "priceSource",
          blockNumber: observedAtBlock,
        }),
      ]);
      if (
        activeJpyProvider.toLowerCase() !== selected.jpyUsdRateProvider.toLowerCase()
        || priceSource !== 0
      ) {
        throw new JpydfSdkError(
          "ORACLE_UNAVAILABLE",
          `Branch ${selected.branchId} active price source is not the pinned live source`,
          { retryAfterMs: 12_000 },
        );
      }
      const [jpyFrozenSince, jpyUsdOracle, stalenessThreshold] = await Promise.all([
        publicClient.readContract({
          address: activeJpyProvider,
          abi: JpyUsdRateProviderAbi,
          functionName: "jpyFrozenSince",
          blockNumber: observedAtBlock,
        }),
        publicClient.readContract({
          address: activeJpyProvider,
          abi: JpyUsdRateProviderAbi,
          functionName: "jpyUsdOracle",
          blockNumber: observedAtBlock,
        }),
        publicClient.readContract({
          address: activeJpyProvider,
          abi: JpyUsdRateProviderAbi,
          functionName: "stalenessThreshold",
          blockNumber: observedAtBlock,
        }),
      ]);
      const [roundId, answer, , updatedAt, answeredInRound] = await publicClient.readContract({
        address: jpyUsdOracle,
        abi: AggregatorV3Abi,
        functionName: "latestRoundData",
        blockNumber: observedAtBlock,
      });
      const sourceIsLive = roundId !== 0n
        && answeredInRound >= roundId
        && answer > 0n
        && updatedAt !== 0n
        && updatedAt <= observedAtTimestamp
        && observedAtTimestamp - updatedAt < stalenessThreshold;
      return {
        jpyFrozenSince,
        jpyUsdOracleUpdatedAt: updatedAt,
        status: jpyFrozenSince === 0n && sourceIsLive ? "live" as const : "frozen" as const,
      };
    } catch (cause) {
      if (cause instanceof JpydfSdkError) throw cause;
      throw new JpydfSdkError(
        "ORACLE_UNAVAILABLE",
        `Branch ${selected.branchId} active JPY/USD source could not be verified`,
        { cause, retryAfterMs: 12_000 },
      );
    }
  }

  async function getMarket(input: { branchId: number }): Promise<JpydfMarketSnapshot> {
    const selected = branch(input.branchId);
    const { observedAtBlock, observedAtBlockHash, observedAtTimestamp } = await context();
    const oracle = await jpyOracleHealth(selected, observedAtBlock, observedAtTimestamp);
    const [
      protocolPriceRaw,
      aggregateRecordedDebtRaw,
      aggregateWeightedDebtRaw,
      totalBranchCollateralRaw,
      totalBranchDebtRaw,
      minimumCollateralRatioRaw,
      criticalCollateralRatioRaw,
      shutdownCollateralRatioRaw,
      shutdownTime,
      stabilityPoolDepositsRaw,
      vaultBackingRatioRaw,
      pausedClaim,
      pausedDeposit,
      pausedRedeem,
    ] = await Promise.all([
      protocolPrice(selected, observedAtBlock),
      publicClient.readContract({
        address: selected.activePool,
        abi: ActivePoolAbi,
        functionName: "aggRecordedDebt",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.activePool,
        abi: ActivePoolAbi,
        functionName: "aggWeightedDebtSum",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.troveManager,
        abi: TroveManagerAbi,
        functionName: "getEntireBranchColl",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.troveManager,
        abi: TroveManagerAbi,
        functionName: "getEntireBranchDebt",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.borrowerOperations,
        abi: BorrowerOperationsAbi,
        functionName: "MCR",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.borrowerOperations,
        abi: BorrowerOperationsAbi,
        functionName: "CCR",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.borrowerOperations,
        abi: BorrowerOperationsAbi,
        functionName: "SCR",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.troveManager,
        abi: TroveManagerAbi,
        functionName: "shutdownTime",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.stabilityPool,
        abi: StabilityPoolAbi,
        functionName: "getTotalJpydfDeposits",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.collateralVault,
        abi: CollateralVaultAbi,
        functionName: "backingRatio",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.collateralVault,
        abi: CollateralVaultAbi,
        functionName: "pausedClaim",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.collateralVault,
        abi: CollateralVaultAbi,
        functionName: "pausedDeposit",
        blockNumber: observedAtBlock,
      }),
      publicClient.readContract({
        address: selected.collateralVault,
        abi: CollateralVaultAbi,
        functionName: "pausedRedeem",
        blockNumber: observedAtBlock,
      }),
    ]);
    await assertCanonicalBlock(observedAtBlock, observedAtBlockHash);
    const stabilityPoolYieldShareRaw = deployment.protocolConstants.stabilityPoolYieldShareRaw;
    return {
      chainId: deployment.chainId,
      deploymentId: deployment.deploymentId,
      deploymentScope: deployment.deploymentScope,
      manifestSha256: deployment.manifestSha256,
      observedAtBlock,
      observedAtBlockHash,
      branchId: selected.branchId,
      collSymbol: selected.collSymbol,
      protocolPriceRaw,
      averageBorrowRateRaw: aggregateRecordedDebtRaw === 0n
        ? null
        : aggregateWeightedDebtRaw / aggregateRecordedDebtRaw,
      stabilityPoolAprRaw: stabilityPoolDepositsRaw === 0n
        ? null
        : shutdownTime !== 0n
        ? 0n
        : aggregateWeightedDebtRaw * stabilityPoolYieldShareRaw / WAD / stabilityPoolDepositsRaw,
      stabilityPoolYieldShareRaw,
      aggregateRecordedDebtRaw,
      aggregateWeightedDebtRaw,
      totalBranchCollateralRaw,
      totalBranchDebtRaw,
      stabilityPoolDepositsRaw,
      stabilityPoolCoverageRaw: totalBranchDebtRaw === 0n
        ? null
        : stabilityPoolDepositsRaw * WAD / totalBranchDebtRaw,
      totalCollateralRatioRaw: totalBranchDebtRaw === 0n
        ? null
        : totalBranchCollateralRaw * protocolPriceRaw / totalBranchDebtRaw,
      minimumCollateralRatioRaw,
      criticalCollateralRatioRaw,
      shutdownCollateralRatioRaw,
      oracleStatus: oracle.status,
      jpyFrozenSince: oracle.jpyFrozenSince,
      jpyUsdOracleUpdatedAt: oracle.jpyUsdOracleUpdatedAt,
      vaultBackingRatioRaw,
      shutdown: shutdownTime !== 0n,
      vaultPaused: {
        claim: pausedClaim,
        deposit: pausedDeposit,
        redeem: pausedRedeem,
      },
    };
  }

  async function scanLiquidationCandidates(input: {
    branchId: number;
    includeLastZombie: boolean;
    maxIterations: number;
    startId: bigint;
  }): Promise<JpydfLiquidationPage> {
    requireUint256(input.startId, "startId");
    requireBoolean(input.includeLastZombie, "includeLastZombie");
    if (
      !Number.isSafeInteger(input.maxIterations)
      || input.maxIterations < 1
      || input.maxIterations > MAX_LIQUIDATION_SCAN_ITERATIONS
    ) {
      throw new JpydfSdkError(
        "INVALID_INPUT",
        `maxIterations must be between 1 and ${MAX_LIQUIDATION_SCAN_ITERATIONS}`,
      );
    }
    const selected = branch(input.branchId);
    const { observedAtBlock, observedAtBlockHash, observedAtTimestamp } = await context();
    const oracle = await jpyOracleHealth(selected, observedAtBlock, observedAtTimestamp);
    if (oracle.status !== "live") {
      throw new JpydfSdkError(
        "ORACLE_UNAVAILABLE",
        `Branch ${selected.branchId} JPY/USD oracle is frozen or stale`,
        { retryAfterMs: 12_000 },
      );
    }
    const [protocolPriceRaw, minimumCollateralRatioRaw] = await Promise.all([
      protocolPrice(selected, observedAtBlock),
      publicClient.readContract({
        address: selected.borrowerOperations,
        abi: BorrowerOperationsAbi,
        functionName: "MCR",
        blockNumber: observedAtBlock,
      }),
    ]);
    const [candidates, nextCursor, includedLastZombie] = await publicClient.readContract({
      address: deployment.liquidationCandidateGetter,
      abi: LiquidationCandidateGetterAbi,
      functionName: "getLiquidationCandidatesWithLastZombie",
      args: [
        BigInt(selected.branchId),
        input.startId,
        BigInt(input.maxIterations),
        protocolPriceRaw,
        minimumCollateralRatioRaw,
        input.includeLastZombie,
      ],
      blockNumber: observedAtBlock,
    });
    await assertCanonicalBlock(observedAtBlock, observedAtBlockHash);
    return {
      chainId: deployment.chainId,
      deploymentId: deployment.deploymentId,
      deploymentScope: deployment.deploymentScope,
      manifestSha256: deployment.manifestSha256,
      observedAtBlock,
      observedAtBlockHash,
      branchId: selected.branchId,
      collSymbol: selected.collSymbol,
      protocolPriceRaw,
      minimumCollateralRatioRaw,
      oracleStatus: "live",
      startId: input.startId,
      nextCursor,
      maxIterations: input.maxIterations,
      includedLastZombie,
      requiresExecutionRevalidation: true,
      candidates: [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
        .map((candidate) => ({
          troveId: candidate.id,
          icrRaw: candidate.ICR,
          entireDebtRaw: candidate.entireDebt,
          entireCollateralRaw: candidate.entireColl,
        })),
    };
  }

  function action(
    intent: PreparedIntent,
    actor: Address,
    observedAtBlock: bigint,
    observedAtBlockHash: Hex,
    transaction: PreparedTransaction,
  ): PreparedActionInternal {
    const frozenIntent = Object.freeze(intent);
    return {
      operationId: intent.operationId,
      actor,
      chainId: deployment.chainId,
      deploymentId: deployment.deploymentId,
      deploymentScope: deployment.deploymentScope,
      manifestSha256: deployment.manifestSha256,
      observedAtBlock,
      observedAtBlockHash,
      validUntilBlock: observedAtBlock + 2n,
      intent: frozenIntent,
      reference: Object.freeze({
        actor,
        chainId: deployment.chainId,
        deploymentId: deployment.deploymentId,
        deploymentScope: deployment.deploymentScope,
        manifestSha256: deployment.manifestSha256,
        intent: frozenIntent,
      }),
      transaction,
    };
  }

  function simulated(prepared: PreparedActionInternal): SimulatedAction {
    const { transaction: _, ...safe } = prepared;
    return Object.freeze({ ...safe, status: "simulated", requiresRevalidation: true });
  }

  function ready(prepared: PreparedActionInternal): ReadyAction {
    const { reference: _, ...safe } = prepared;
    return Object.freeze({ ...safe, status: "ready-for-signature", requiresRevalidation: false });
  }

  async function getBranches(): Promise<JpydfProtocolSnapshot> {
    const { observedAtBlock, observedAtBlockHash } = await context();
    return {
      chainId: deployment.chainId,
      deploymentId: deployment.deploymentId,
      deploymentScope: deployment.deploymentScope,
      manifestSha256: deployment.manifestSha256,
      observedAtBlock,
      observedAtBlockHash,
      branches: deployment.branches,
    };
  }

  async function getAccount(accountInput: Address): Promise<JpydfAccountSnapshot> {
    const account = requireAddress(accountInput, "account");
    const { observedAtBlock, observedAtBlockHash } = await context();
    const [jpydfBalance, pools] = await Promise.all([
      publicClient.readContract({
        address: deployment.jpydfToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
        blockNumber: observedAtBlock,
      }),
      Promise.all(deployment.branches.map(async (selected) => {
        const [deposit, collateralGain, stashedCollateral, yieldGain, recordedDeposit] = await Promise.all([
          publicClient.readContract({
            address: selected.stabilityPool,
            abi: StabilityPoolAbi,
            functionName: "getCompoundedJpydfDeposit",
            args: [account],
            blockNumber: observedAtBlock,
          }),
          publicClient.readContract({
            address: selected.stabilityPool,
            abi: StabilityPoolAbi,
            functionName: "getDepositorCollGain",
            args: [account],
            blockNumber: observedAtBlock,
          }),
          publicClient.readContract({
            address: selected.stabilityPool,
            abi: StabilityPoolAbi,
            functionName: "stashedColl",
            args: [account],
            blockNumber: observedAtBlock,
          }),
          publicClient.readContract({
            address: selected.stabilityPool,
            abi: StabilityPoolAbi,
            functionName: "getDepositorYieldGainWithPending",
            args: [account],
            blockNumber: observedAtBlock,
          }),
          publicClient.readContract({
            address: selected.stabilityPool,
            abi: StabilityPoolAbi,
            functionName: "deposits",
            args: [account],
            blockNumber: observedAtBlock,
          }),
        ]);
        return {
          branchId: selected.branchId,
          collSymbol: selected.collSymbol,
          compoundedDeposit: deposit,
          hasRecordedDeposit: recordedDeposit > 0n,
          rewards: {
            jpydf: yieldGain,
            collateral: collateralGain + stashedCollateral,
          },
        };
      })),
    ]);
    await assertCanonicalBlock(observedAtBlock, observedAtBlockHash);
    return {
      chainId: deployment.chainId,
      deploymentId: deployment.deploymentId,
      deploymentScope: deployment.deploymentScope,
      manifestSha256: deployment.manifestSha256,
      observedAtBlock,
      observedAtBlockHash,
      account,
      jpydfBalance,
      pools,
    };
  }

  async function simulateAction(
    intent: PreparedIntent,
    account: Address,
    observedAtBlock: bigint,
    observedAtBlockHash: Hex,
    selected: JpydfBranchDeployment,
    functionName: "claimAllCollGains" | "provideToSP" | "withdrawFromSP",
    args: readonly [] | readonly [bigint, boolean],
    label: string,
  ): Promise<PreparedActionInternal> {
    try {
      await publicClient.simulateContract({
        account,
        address: selected.stabilityPool,
        abi: StabilityPoolAbi,
        blockNumber: observedAtBlock,
        functionName,
        args,
      });
    } catch (error) {
      if (error instanceof BaseError) {
        const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
        if (revert instanceof ContractFunctionRevertedError) {
          const failure = simulationFailure(revert, label);
          throw new JpydfSdkError(failure.code, failure.message, {
            cause: error,
            ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
          });
        }
      }
      throw error;
    }
    await assertCanonicalBlock(observedAtBlock, observedAtBlockHash);
    return action(intent, account, observedAtBlock, observedAtBlockHash, {
      account,
      to: selected.stabilityPool,
      data: encodeFunctionData({ abi: StabilityPoolAbi, functionName, args }),
      value: 0n,
    });
  }

  async function prepareEarnDepositAction(input: {
    account: Address;
    amountRaw: bigint;
    branchId: number;
    claim: boolean;
  }): Promise<PreparedActionInternal> {
    assertPreparationAllowed();
    requirePositive(input.amountRaw, "amountRaw");
    requireBoolean(input.claim, "claim");
    const account = requireAddress(input.account, "account");
    const selected = branch(input.branchId);
    const { observedAtBlock, observedAtBlockHash } = await context();
    return simulateAction(
      {
        operationId: "earn.deposit",
        amountSemantics: "exact",
        branchId: selected.branchId,
        amountRaw: input.amountRaw,
        claim: input.claim,
      },
      account,
      observedAtBlock,
      observedAtBlockHash,
      selected,
      "provideToSP",
      [input.amountRaw, input.claim],
      "Stability Pool deposit",
    );
  }

  async function prepareEarnWithdrawAction(input: {
    account: Address;
    amountRaw: bigint;
    branchId: number;
    claim: boolean;
  }): Promise<PreparedActionInternal> {
    assertPreparationAllowed();
    requirePositive(input.amountRaw, "amountRaw");
    requireBoolean(input.claim, "claim");
    const account = requireAddress(input.account, "account");
    const selected = branch(input.branchId);
    const { observedAtBlock, observedAtBlockHash } = await context();
    const deposit = await publicClient.readContract({
      address: selected.stabilityPool,
      abi: StabilityPoolAbi,
      functionName: "getCompoundedJpydfDeposit",
      args: [account],
      blockNumber: observedAtBlock,
    });
    if (input.amountRaw > deposit) {
      throw new JpydfSdkError("INVALID_INPUT", "amountRaw exceeds the current Stability Pool deposit");
    }
    const claim = input.amountRaw === deposit ? true : input.claim;
    return simulateAction(
      {
        operationId: "earn.withdraw",
        amountSemantics: "maximum",
        branchId: selected.branchId,
        amountRaw: input.amountRaw,
        claim,
      },
      account,
      observedAtBlock,
      observedAtBlockHash,
      selected,
      "withdrawFromSP",
      [input.amountRaw, claim],
      "Stability Pool withdrawal",
    );
  }

  async function prepareEarnRewardsAction(
    input: { account: Address; branchId: number },
    compound: boolean,
  ): Promise<PreparedActionInternal> {
    assertPreparationAllowed();
    const account = requireAddress(input.account, "account");
    const selected = branch(input.branchId);
    const { observedAtBlock, observedAtBlockHash } = await context();
    const recordedDeposit = await publicClient.readContract({
      address: selected.stabilityPool,
      abi: StabilityPoolAbi,
      functionName: "deposits",
      args: [account],
      blockNumber: observedAtBlock,
    });
    if (!compound && recordedDeposit === 0n) {
      return simulateAction(
        { operationId: "earn.claim", branchId: selected.branchId },
        account,
        observedAtBlock,
        observedAtBlockHash,
        selected,
        "claimAllCollGains",
        [],
        "Stability Pool reward claim",
      );
    }
    return simulateAction(
      { operationId: compound ? "earn.compound" : "earn.claim", branchId: selected.branchId },
      account,
      observedAtBlock,
      observedAtBlockHash,
      selected,
      "withdrawFromSP",
      [0n, !compound],
      compound ? "Stability Pool reward compound" : "Stability Pool reward claim",
    );
  }

  const prepareEarnDeposit = async (input: {
    account: Address;
    amountRaw: bigint;
    branchId: number;
    claim: boolean;
  }): Promise<SimulatedAction> => simulated(await prepareEarnDepositAction(input));

  const prepareEarnWithdraw = async (input: {
    account: Address;
    amountRaw: bigint;
    branchId: number;
    claim: boolean;
  }): Promise<SimulatedAction> => simulated(await prepareEarnWithdrawAction(input));

  const prepareEarnClaim = async (input: {
    account: Address;
    branchId: number;
  }): Promise<SimulatedAction> => simulated(await prepareEarnRewardsAction(input, false));

  const prepareEarnCompound = async (input: {
    account: Address;
    branchId: number;
  }): Promise<SimulatedAction> => simulated(await prepareEarnRewardsAction(input, true));

  async function prepareForSignature(reference: PreparedActionReference): Promise<ReadyAction> {
    assertPreparationAllowed();
    if (
      !reference || typeof reference !== "object" || !reference.intent
      || typeof reference.intent !== "object" || typeof reference.intent.operationId !== "string"
    ) {
      throw new JpydfSdkError("INVALID_INPUT", "Prepared action reference is invalid");
    }
    if (
      reference.chainId !== deployment.chainId
      || reference.deploymentId !== deployment.deploymentId
      || reference.deploymentScope !== deployment.deploymentScope
      || reference.manifestSha256 !== deployment.manifestSha256
    ) {
      throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "Prepared action deployment does not match the client");
    }
    const actor = requireAddress(reference.actor, "actor");
    const intent = reference.intent;
    let refreshed: PreparedActionInternal;
    switch (intent.operationId) {
      case "earn.deposit":
        if (intent.amountSemantics !== "exact") {
          throw new JpydfSdkError("INVALID_INPUT", "Deposit amount semantics must be exact");
        }
        refreshed = await prepareEarnDepositAction({
          account: actor,
          branchId: intent.branchId,
          amountRaw: intent.amountRaw,
          claim: intent.claim,
        });
        break;
      case "earn.withdraw":
        if (intent.amountSemantics !== "maximum") {
          throw new JpydfSdkError("INVALID_INPUT", "Withdrawal amount semantics must be maximum");
        }
        refreshed = await prepareEarnWithdrawAction({
          account: actor,
          branchId: intent.branchId,
          amountRaw: intent.amountRaw,
          claim: intent.claim,
        });
        break;
      case "earn.claim":
        refreshed = await prepareEarnRewardsAction({ account: actor, branchId: intent.branchId }, false);
        break;
      case "earn.compound":
        refreshed = await prepareEarnRewardsAction({ account: actor, branchId: intent.branchId }, true);
        break;
      default:
        throw new JpydfSdkError("INVALID_INPUT", "Unknown prepared action intent");
    }
    if (
      intent.operationId === "earn.withdraw"
      && refreshed.intent.operationId === "earn.withdraw"
      && refreshed.intent.claim !== intent.claim
    ) {
      throw new JpydfSdkError(
        "ACTION_EXPIRED",
        "The withdrawal reward mode changed during revalidation; prepare and approve it again",
        { retryAfterMs: 1_000 },
      );
    }
    const latest = await context();
    if (latest.observedAtBlock > refreshed.validUntilBlock) {
      throw new JpydfSdkError(
        "ACTION_EXPIRED",
        "The simulated action expired before wallet handoff; prepare it again",
        { retryAfterMs: 1_000 },
      );
    }
    return ready(refreshed);
  }

  return {
    capabilities,
    deployment,
    getAccount,
    getBranches,
    getMarket,
    prepareEarnClaim,
    prepareEarnCompound,
    prepareEarnDeposit,
    prepareEarnWithdraw,
    prepareForSignature,
    prepareUniV4WalletSmoke: (
      input: { account: Address; amountIn: bigint; deadline: bigint; route: MainnetCanaryUniV4Route },
    ) => {
      assertPreparationAllowed();
      return prepareMainnetCanaryUniV4WalletSmoke(publicClient, deployment, input);
    },
    scanLiquidationCandidates,
  };
}
