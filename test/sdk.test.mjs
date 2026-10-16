import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { Readable } from "node:stream";
import test, { mock } from "node:test";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  toFunctionSelector,
} from "viem";

import {
  createJpydfMainnetCanaryAgentClient,
  createJpydfMainnetStagingAgentClient,
  createJpydfMainnetRpcClient,
  getJpydfRpcHealth,
  JPYDF_RPC_PHYSICAL_LIMIT,
  JPYDF_RPC_REGULAR_LIMIT,
} from "../dist/agent.js";
import {
  createJpydfClient,
  decodeMainnetCanaryUniV4Swap,
  JpydfSdkError,
  loadMainnetCanaryDeployment,
  loadMainnetStagingDeployment,
  loadMainnetCanaryUniV4Route,
  MAINNET_CANARY_IDENTITY,
  MAINNET_STAGING_IDENTITY,
  MAINNET_CANARY_UNIV4_ROUTE_IDENTITY,
} from "../dist/index.js";
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
} from "../dist/generated/abis.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const WAD = 10n ** 18n;
const MAINNET_CANARY_JPYDF = "0x12159af7d983d1c7878143202a3a26d3bd2851d6";
const MAINNET_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ROUTE_JSON = `${JSON.stringify({
  schemaVersion: 1,
  classification: "MAINNET_CANARY_UNIV4_MANUAL_WALLET_SMOKE_ROUTE",
  chainId: 1,
  deploymentId: "jpydf-mainnet-persistent-canary-v2-2026-08",
  manifestSha256: MAINNET_CANARY_IDENTITY.manifestSha256,
  poolKey: {
    currency0: MAINNET_CANARY_JPYDF,
    currency1: MAINNET_USDC,
    fee: 500,
    tickSpacing: 10,
    hooks: ZERO,
    poolId: MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.poolId,
  },
  quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
  universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
})}\n`;
const address = (value) => `0x${value.toString(16).padStart(40, "0")}`;

function captureHttpsRequest(fetchRpc) {
  const requestMock = mock.method(https, "request", (url, options, onResponse) => {
    const request = new EventEmitter();
    let controller;
    request.destroyed = false;
    request.end = (body) => {
      controller = new AbortController();
      void Promise.resolve(fetchRpc(url, {
        body: Buffer.isBuffer(body) ? body.toString("utf8") : String(body),
        headers: options.headers,
        method: options.method,
        signal: controller.signal,
      })).then(async (response) => {
        if (request.destroyed) return;
        const stream = Readable.from([Buffer.from(await response.arrayBuffer())]);
        stream.headers = Object.fromEntries(response.headers);
        stream.statusCode = response.status;
        onResponse(stream);
      }, (error) => {
        if (request.destroyed) return;
        request.emit("error", error);
        request.emit("close");
      });
    };
    request.destroy = (reason = new Error("destroyed")) => {
      if (request.destroyed) return request;
      request.destroyed = true;
      controller?.abort(reason);
      queueMicrotask(() => {
        request.emit("error", reason);
        request.emit("close");
      });
      return request;
    };
    return request;
  });
  return () => requestMock.mock.restore();
}

const branches = Array.from({ length: 8 }, (_, branchId) => ({
  activePool: address(400 + branchId),
  borrowerOperations: address(500 + branchId),
  collSymbol: ["dwstETH", "dUSDC", "dETH", "dUSD-A", "dBTC", "dUSD-B", "dJPY", "dJGB"][branchId],
  collToken: address(100 + branchId),
  priceFeed: address(600 + branchId),
  sortedTroves: address(700 + branchId),
  stabilityPool: address(200 + branchId),
  troveManager: address(800 + branchId),
}));
const dfYield = Array.from({ length: 8 }, (_, branchId) => ({
  collateralVault: address(900 + branchId),
  collateralYieldZapper: address(1_000 + branchId),
  dToken: branches[branchId].collToken,
  jpyUsdRateProvider: address(1_100 + branchId),
  underlying: branchId === 1 ? MAINNET_USDC : branchId === 0 ? address(300) : ZERO,
}));
const CANARY_MANIFEST = {
  chainId: 1,
  deploymentClassification: "TEST_ONLY_NOT_FOR_PRODUCTION",
  deploymentProfile: "mainnet-persistent-canary-v2-min-debt-1000",
  deploymentId: "jpydf-mainnet-persistent-canary-v2-2026-08",
  deploymentMode: "complete",
  create2Salt: "0x6ea17b1accc940857615c85844fca690284fa6cb6a90f3a9812845d3fbc77aaf",
  deployer: address(1),
  bridgeAdmin: address(2),
  hintHelpers: address(4),
  jpydfToken: MAINNET_CANARY_JPYDF,
  liquidationCandidateGetter: address(5),
  launchEvidence: { uniswapV4RouteStatus: "unwired-audit-scope" },
  constants: {
    ETH_GAS_COMPENSATION: "37500000000000000",
    MAX_ANNUAL_INTEREST_RATE: "2500000000000000000",
    MIN_DEBT: "1000000000000000000000",
    MIN_ANNUAL_INTEREST_RATE: "5000000000000000",
    SP_YIELD_SPLIT: "750000000000000000",
  },
  branches,
  dfYield,
};

async function loadFixture(manifest = CANARY_MANIFEST, identity = MAINNET_CANARY_IDENTITY, loader = loadMainnetCanaryDeployment) {
  const manifestJson = JSON.stringify(manifest);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      subtle: {
        async digest() {
          return Uint8Array.from(Buffer.from(identity.manifestSha256, "hex")).buffer;
        },
      },
    },
  });
  try {
    return await loader({ manifestJson });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
}

const STAGING_MANIFEST = {
  ...CANARY_MANIFEST,
  deploymentProfile: MAINNET_STAGING_IDENTITY.deploymentProfile,
  deploymentId: MAINNET_STAGING_IDENTITY.deploymentId,
  deploymentMode: MAINNET_STAGING_IDENTITY.deploymentMode,
  create2Salt: MAINNET_STAGING_IDENTITY.create2Salt,
  constants: { ...CANARY_MANIFEST.constants, MIN_DEBT: MAINNET_STAGING_IDENTITY.minDebt },
};
const loadStagingFixture = (manifest = STAGING_MANIFEST) =>
  loadFixture(manifest, MAINNET_STAGING_IDENTITY, loadMainnetStagingDeployment);
const stagingDeployment = await loadStagingFixture();

const deployment = await loadFixture();
const univ4Route = await loadMainnetCanaryUniV4Route({ routeJson: ROUTE_JSON });

function mockPublicClient({
  activeJpyProvider,
  aggregateRecordedDebtRaw = 1_000n * WAD,
  aggregateWeightedDebtRaw = 50n * WAD * WAD,
  branchDebtRaw = 1_000n * WAD,
  chainId = deployment.chainId,
  compoundedDeposit = 20n,
  jpyFrozenSince = 0n,
  jpyOracleUpdatedAt = 900n,
  liquidationCandidates = [{ id: 42n, ICR: WAD, entireDebt: 1_200n * WAD, entireColl: 6n * WAD }],
  oracleFailed = false,
  priceRaw = 200n * WAD,
  priceSource = 0,
  quoteAmountOut = 6_272n,
  jpydfBalance = 100n,
  erc20Allowance = 0n,
  permit2Allowance = 0n,
  recordedDeposit = 7n,
  shutdownTime = 0n,
  stabilityPoolDepositsRaw = 500n * WAD,
} = {}) {
  const reads = [];
  const simulations = [];
  const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let canonicalHash = blockHash;
  let currentCompoundedDeposit = compoundedDeposit;
  let latestBlockNumber = 123n;
  let advanceAfterSimulation = 0n;
  let nextSimulationError;
  let reorgAfterRead = false;
  return {
    reads,
    simulations,
    setCanonicalHash(value) {
      canonicalHash = value;
    },
    setCompoundedDeposit(value) {
      currentCompoundedDeposit = value;
    },
    advanceAfterNextSimulation(value) {
      advanceAfterSimulation = value;
    },
    failNextSimulation(error) {
      nextSimulationError = error;
    },
    reorgAfterNextRead() {
      reorgAfterRead = true;
    },
    async getChainId() {
      return chainId;
    },
    async getBlock(request = {}) {
      return {
        number: request.blockNumber ?? latestBlockNumber,
        hash: request.blockNumber === undefined ? blockHash : canonicalHash,
        timestamp: 1_000n,
      };
    },
    async readContract(request) {
      reads.push(request);
      if (reorgAfterRead) {
        reorgAfterRead = false;
        canonicalHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      }
      switch (request.functionName) {
        case "balanceOf":
          return jpydfBalance;
        case "allowance":
          return request.address.toLowerCase() === univ4Route.permit2.toLowerCase()
            ? [permit2Allowance, 0, 0]
            : erc20Allowance;
        case "getCompoundedJpydfDeposit":
          return currentCompoundedDeposit;
        case "getDepositorCollGain":
          return 3n;
        case "stashedColl":
          return 4n;
        case "getDepositorYieldGainWithPending":
          return 5n;
        case "deposits":
          return recordedDeposit;
        case "aggRecordedDebt":
          return aggregateRecordedDebtRaw;
        case "aggWeightedDebtSum":
          return aggregateWeightedDebtRaw;
        case "getEntireBranchColl":
          return 10n * WAD;
        case "getEntireBranchDebt":
          return branchDebtRaw;
        case "MCR":
          return 11n * WAD / 10n;
        case "CCR":
          return 15n * WAD / 10n;
        case "SCR":
          return 105n * WAD / 100n;
        case "shutdownTime":
          return shutdownTime;
        case "getTotalJpydfDeposits":
          return stabilityPoolDepositsRaw;
        case "backingRatio":
          return 102n * WAD / 100n;
        case "pausedClaim":
        case "pausedDeposit":
        case "pausedRedeem":
          return false;
        case "jpyFrozenSince":
          return jpyFrozenSince;
        case "source": {
          const branchId = deployment.branches.findIndex(({ priceFeed }) => priceFeed === request.address);
          return address(1_300 + branchId);
        }
        case "jpyUsdRateProvider": {
          const branchId = deployment.branches.findIndex((_, index) => address(1_300 + index) === request.address);
          return activeJpyProvider ?? deployment.branches[branchId].jpyUsdRateProvider;
        }
        case "priceSource":
          return priceSource;
        case "jpyUsdOracle":
          return address(1_200);
        case "stalenessThreshold":
          return 200n;
        case "latestRoundData":
          return [10n, 150_000_000n, 0n, jpyOracleUpdatedAt, 10n];
        case "quoteExactInputSingle":
          return [quoteAmountOut, 59_418n];
        case "getLiquidationCandidatesWithLastZombie":
          return [liquidationCandidates, 41n, true];
        default:
          throw new Error(`Unexpected read ${request.functionName}`);
      }
    },
    async simulateContract(request) {
      if (nextSimulationError) {
        const error = nextSimulationError;
        nextSimulationError = undefined;
        throw error;
      }
      simulations.push(request);
      latestBlockNumber += advanceAfterSimulation;
      advanceAfterSimulation = 0n;
      if (request.functionName === "fetchPrice") {
        return { result: [priceRaw, oracleFailed], request };
      }
      return { request };
    },
  };
}

function sdk(publicClient = mockPublicClient()) {
  return createJpydfClient({ publicClient, deployment, scope: "mainnet-canary" });
}

const SELECTORS = {
  balanceOf: toFunctionSelector("balanceOf(address)"),
  claimAllCollGains: toFunctionSelector("claimAllCollGains()"),
  deposits: toFunctionSelector("deposits(address)"),
  getCompoundedJpydfDeposit: toFunctionSelector("getCompoundedJpydfDeposit(address)"),
  getDepositorCollGain: toFunctionSelector("getDepositorCollGain(address)"),
  getDepositorYieldGainWithPending: toFunctionSelector("getDepositorYieldGainWithPending(address)"),
  provideToSP: toFunctionSelector("provideToSP(uint256,bool)"),
  stashedColl: toFunctionSelector("stashedColl(address)"),
  withdrawFromSP: toFunctionSelector("withdrawFromSP(uint256,bool)"),
  aggRecordedDebt: toFunctionSelector("aggRecordedDebt()"),
  aggWeightedDebtSum: toFunctionSelector("aggWeightedDebtSum()"),
  backingRatio: toFunctionSelector("backingRatio()"),
  CCR: toFunctionSelector("CCR()"),
  fetchPrice: toFunctionSelector("fetchPrice()"),
  getEntireBranchColl: toFunctionSelector("getEntireBranchColl()"),
  getEntireBranchDebt: toFunctionSelector("getEntireBranchDebt()"),
  getLiquidationCandidatesWithLastZombie: toFunctionSelector(
    "getLiquidationCandidatesWithLastZombie(uint256,uint256,uint256,uint256,uint256,bool)",
  ),
  getTotalJpydfDeposits: toFunctionSelector("getTotalJpydfDeposits()"),
  jpyFrozenSince: toFunctionSelector("jpyFrozenSince()"),
  jpyUsdRateProvider: toFunctionSelector("jpyUsdRateProvider()"),
  jpyUsdOracle: toFunctionSelector("jpyUsdOracle()"),
  latestRoundData: toFunctionSelector("latestRoundData()"),
  MCR: toFunctionSelector("MCR()"),
  SCR: toFunctionSelector("SCR()"),
  pausedClaim: toFunctionSelector("pausedClaim()"),
  pausedDeposit: toFunctionSelector("pausedDeposit()"),
  pausedRedeem: toFunctionSelector("pausedRedeem()"),
  priceSource: toFunctionSelector("priceSource()"),
  shutdownTime: toFunctionSelector("shutdownTime()"),
  stalenessThreshold: toFunctionSelector("stalenessThreshold()"),
  source: toFunctionSelector("source()"),
};
const WRITE_SELECTORS = new Set([
  SELECTORS.claimAllCollGains,
  SELECTORS.provideToSP,
  SELECTORS.withdrawFromSP,
]);
const ERROR_ABI = [{
  type: "error",
  name: "Error",
  inputs: [{ name: "message", type: "string" }],
}];
const uintResult = (value) => encodeAbiParameters([{ type: "uint256" }], [value]);

function createAgentRpcHarness() {
  const state = {
    afterNextSimulation: undefined,
    nextSimulationReason: undefined,
    oracleFailed: false,
  };
  const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const fetchRpc = async (_url, init) => {
    const request = JSON.parse(init.body);
    let result;
    if (request.method === "eth_chainId") {
      result = "0x1";
    } else if (request.method === "eth_getBlockByNumber") {
      result = { hash: blockHash, number: "0x7b", timestamp: "0x3e8", transactions: [] };
    } else if (request.method === "eth_call") {
      const selector = request.params[0].data.slice(0, 10);
      if (WRITE_SELECTORS.has(selector) && state.nextSimulationReason !== undefined) {
        const reason = state.nextSimulationReason;
        state.nextSimulationReason = undefined;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: 3,
              message: "execution reverted",
              ...(reason === "execution reverted"
                ? {}
                : { data: encodeErrorResult({ abi: ERROR_ABI, errorName: "Error", args: [reason] }) }),
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (WRITE_SELECTORS.has(selector) && state.afterNextSimulation) {
        const callback = state.afterNextSimulation;
        state.afterNextSimulation = undefined;
        callback();
      }
      result = selector === SELECTORS.balanceOf
        ? uintResult(100n)
        : selector === SELECTORS.getCompoundedJpydfDeposit
        ? uintResult(20n)
        : selector === SELECTORS.getDepositorCollGain
        ? uintResult(3n)
        : selector === SELECTORS.stashedColl
        ? uintResult(4n)
        : selector === SELECTORS.getDepositorYieldGainWithPending
        ? uintResult(5n)
        : selector === SELECTORS.deposits
        ? uintResult(7n)
        : selector === SELECTORS.aggRecordedDebt
        ? encodeFunctionResult({ abi: ActivePoolAbi, functionName: "aggRecordedDebt", result: 1_000n * WAD })
        : selector === SELECTORS.aggWeightedDebtSum
        ? encodeFunctionResult({ abi: ActivePoolAbi, functionName: "aggWeightedDebtSum", result: 50n * WAD * WAD })
        : selector === SELECTORS.fetchPrice
        ? encodeFunctionResult({
          abi: PriceFeedProxyAbi,
          functionName: "fetchPrice",
          result: [200n * WAD, state.oracleFailed],
        })
        : selector === SELECTORS.getEntireBranchColl
        ? encodeFunctionResult({ abi: TroveManagerAbi, functionName: "getEntireBranchColl", result: 10n * WAD })
        : selector === SELECTORS.getEntireBranchDebt
        ? encodeFunctionResult({ abi: TroveManagerAbi, functionName: "getEntireBranchDebt", result: 1_000n * WAD })
        : selector === SELECTORS.MCR
        ? encodeFunctionResult({ abi: BorrowerOperationsAbi, functionName: "MCR", result: 11n * WAD / 10n })
        : selector === SELECTORS.CCR
        ? encodeFunctionResult({ abi: BorrowerOperationsAbi, functionName: "CCR", result: 15n * WAD / 10n })
        : selector === SELECTORS.SCR
        ? encodeFunctionResult({ abi: BorrowerOperationsAbi, functionName: "SCR", result: 105n * WAD / 100n })
        : selector === SELECTORS.shutdownTime
        ? encodeFunctionResult({ abi: TroveManagerAbi, functionName: "shutdownTime", result: 0n })
        : selector === SELECTORS.getTotalJpydfDeposits
        ? encodeFunctionResult({ abi: StabilityPoolAbi, functionName: "getTotalJpydfDeposits", result: 500n * WAD })
        : selector === SELECTORS.jpyFrozenSince
        ? encodeFunctionResult({ abi: JpyUsdRateProviderAbi, functionName: "jpyFrozenSince", result: 0n })
        : selector === SELECTORS.source
        ? encodeFunctionResult({ abi: PriceFeedProxyAbi, functionName: "source", result: address(1_300) })
        : selector === SELECTORS.jpyUsdRateProvider
        ? encodeFunctionResult({
          abi: DFPriceFeedBaseAbi,
          functionName: "jpyUsdRateProvider",
          result: deployment.branches[0].jpyUsdRateProvider,
        })
        : selector === SELECTORS.priceSource
        ? encodeFunctionResult({ abi: DFPriceFeedBaseAbi, functionName: "priceSource", result: 0 })
        : selector === SELECTORS.jpyUsdOracle
        ? encodeFunctionResult({ abi: JpyUsdRateProviderAbi, functionName: "jpyUsdOracle", result: address(1_200) })
        : selector === SELECTORS.stalenessThreshold
        ? encodeFunctionResult({ abi: JpyUsdRateProviderAbi, functionName: "stalenessThreshold", result: 200n })
        : selector === SELECTORS.latestRoundData
        ? encodeFunctionResult({
          abi: AggregatorV3Abi,
          functionName: "latestRoundData",
          result: [10n, 150_000_000n, 0n, 900n, 10n],
        })
        : selector === SELECTORS.backingRatio
        ? encodeFunctionResult({ abi: CollateralVaultAbi, functionName: "backingRatio", result: 102n * WAD / 100n })
        : selector === SELECTORS.pausedClaim
        ? encodeFunctionResult({ abi: CollateralVaultAbi, functionName: "pausedClaim", result: false })
        : selector === SELECTORS.pausedDeposit
        ? encodeFunctionResult({ abi: CollateralVaultAbi, functionName: "pausedDeposit", result: false })
        : selector === SELECTORS.pausedRedeem
        ? encodeFunctionResult({ abi: CollateralVaultAbi, functionName: "pausedRedeem", result: false })
        : selector === SELECTORS.getLiquidationCandidatesWithLastZombie
        ? encodeFunctionResult({
          abi: LiquidationCandidateGetterAbi,
          functionName: "getLiquidationCandidatesWithLastZombie",
          result: [[{ id: 42n, ICR: WAD, entireDebt: 1_200n * WAD, entireColl: 6n * WAD }], 41n, true],
        })
        : "0x";
    } else {
      throw new Error(`Unexpected RPC method ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const restoreHttpsRequest = captureHttpsRequest(fetchRpc);
  let publicClient;
  try {
    publicClient = createJpydfMainnetRpcClient({
      rpcUrl: "https://rpc.example",
      recoveryCooldownMs: 5,
      timeoutMs: 100,
    });
  } finally {
    restoreHttpsRequest();
  }
  return {
    afterNextSimulation(callback) {
      state.afterNextSimulation = callback;
    },
    failNextSimulation(reason = "execution reverted") {
      state.nextSimulationReason = reason;
    },
    setOracleFailed(value) {
      state.oracleFailed = value;
    },
    publicClient,
  };
}

function agent(harness = createAgentRpcHarness()) {
  return {
    harness,
    sdkAgent: createJpydfMainnetCanaryAgentClient({
      publicClient: harness.publicClient,
      deployment,
      scope: "mainnet-canary",
      account: ACCOUNT,
      authorizeFinalization: () => true,
      writeAdmission: {
        allowedOperations: ["earn.deposit", "earn.withdraw", "earn.claim", "earn.compound"],
        allowedBranchIds: [0, 1],
        expiresAtMs: Date.now() + 60_000,
        allowedRewardModes: ["claim", "compound"],
        maxAmountRaw: 1_000n,
        maxPendingAmountRaw: 10_000n,
      },
    }),
  };
}

function agentFromRpc(publicClient) {
  return createJpydfMainnetCanaryAgentClient({
    publicClient,
    deployment,
    scope: "mainnet-canary",
    account: ACCOUNT,
  });
}

function createFaultRpcHarness({ maxResponseBytes = 1_000_000, recoveryCooldownMs = 10, timeoutMs = 20 } = {}) {
  let mode = "healthy";
  let abortsObserved = 0;
  let requestsObserved = 0;
  let deferred = [];
  const response = (request) =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: "0x1",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  const fetchRpc = async (_url, init) => {
    requestsObserved++;
    const request = JSON.parse(init.body);
    if (mode === "healthy") return response(request);
    if (mode === "error") return new Response("unavailable", { status: 503 });
    if (mode === "http-rate-limit") return new Response("limited", { status: 429 });
    if (mode === "rpc-error") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: "internal error" },
      }));
    }
    if (mode === "rpc-revert") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, data: "0x08c379a0", message: "execution reverted" },
      }));
    }
    if (mode === "rate-limit") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32005, message: "limit exceeded" },
      }));
    }
    if (mode === "resource-unavailable") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32002, message: "resource unavailable" },
      }));
    }
    if (mode === "revert") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: 3, message: "execution reverted" },
      }));
    }
    if (mode === "mismatched-id") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id + 1, result: "0x1" }));
    }
    if (mode === "empty") return new Response("{}");
    if (mode === "null") return new Response("null");
    if (mode === "oversized-header") return new Response("small", { headers: { "Content-Length": String(maxResponseBytes + 1) } });
    if (mode === "oversized") return new Response("x".repeat(maxResponseBytes + 1));
    if (mode === "never") {
      return new Promise(() => {
        init.signal.addEventListener("abort", () => abortsObserved++, { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        abortsObserved++;
        reject(init.signal.reason ?? new Error("aborted"));
      };
      init.signal.addEventListener("abort", abort, { once: true });
      deferred.push(() => {
        init.signal.removeEventListener("abort", abort);
        resolve(response(request));
      });
    });
  };
  const restoreHttpsRequest = captureHttpsRequest(fetchRpc);
  let publicClient;
  try {
    publicClient = createJpydfMainnetRpcClient({
      maxResponseBytes,
      rpcUrl: "https://rpc.example",
      recoveryCooldownMs,
      timeoutMs,
    });
  } finally {
    restoreHttpsRequest();
  }
  return {
    get abortsObserved() {
      return abortsObserved;
    },
    get requestsObserved() {
      return requestsObserved;
    },
    publicClient,
    releaseAll() {
      const releases = deferred;
      deferred = [];
      for (const release of releases) release();
    },
    setMode(value) {
      mode = value;
    },
  };
}

function createStubbornRpcHarness({ recoveryCooldownMs = 5, timeoutMs = 10 } = {}) {
  let mode = "stuck";
  let activePhysical = 0;
  let maxPhysical = 0;
  const stuckRequests = new Set();
  const requestMock = mock.method(https, "request", (_url, _options, onResponse) => {
    const request = new EventEmitter();
    let physicallySettled = false;
    let stuck = false;
    activePhysical++;
    maxPhysical = Math.max(maxPhysical, activePhysical);
    const settlePhysical = () => {
      if (physicallySettled) return;
      physicallySettled = true;
      activePhysical--;
      stuckRequests.delete(request);
    };
    request.destroyed = false;
    request.once("close", settlePhysical);
    request.end = (body) => {
      stuck = mode === "stuck";
      if (stuck) {
        stuckRequests.add(request);
        return;
      }
      const rpc = JSON.parse(String(body));
      const response = Readable.from([
        Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: "0x1" })),
      ]);
      response.headers = { "content-type": "application/json" };
      response.statusCode = 200;
      response.once("end", settlePhysical);
      queueMicrotask(() => onResponse(response));
    };
    request.destroy = () => {
      request.destroyed = true;
      if (!stuck) queueMicrotask(() => request.emit("close"));
      return request;
    };
    return request;
  });
  let publicClient;
  try {
    publicClient = createJpydfMainnetRpcClient({
      rpcUrl: "https://rpc.example",
      recoveryCooldownMs,
      timeoutMs,
    });
  } finally {
    requestMock.mock.restore();
  }
  return {
    get activePhysical() {
      return activePhysical;
    },
    get maxPhysical() {
      return maxPhysical;
    },
    publicClient,
    settleStuck() {
      for (const request of stuckRequests) request.emit("close");
    },
    setMode(value) {
      mode = value;
    },
  };
}

test("loads only the package-pinned mainnet-canary manifest", async () => {
  assert.equal(deployment.chainId, 1);
  assert.equal(deployment.deploymentScope, "mainnet-canary");
  assert.deepEqual(deployment.branches.map(({ branchId }) => branchId), [0, 1]);
  assert.ok(Object.isFrozen(deployment));
  assert.ok(Object.isFrozen(deployment.branches));

  const manifestJson = JSON.stringify(CANARY_MANIFEST);
  await assert.rejects(
    loadMainnetCanaryDeployment({ manifestJson }),
    (error) => error instanceof JpydfSdkError && error.code === "MANIFEST_MISMATCH",
  );
  await assert.rejects(
    loadFixture({ ...CANARY_MANIFEST, deploymentId: "jpydf-mainnet-test-only-min-debt-1000-2026-08" }),
    (error) => error instanceof JpydfSdkError && error.code === "UNSUPPORTED_DEPLOYMENT",
  );
  await assert.rejects(
    loadFixture({ ...CANARY_MANIFEST, launchEvidence: { uniswapV4RouteStatus: "live" } }),
    (error) => error instanceof JpydfSdkError && error.code === "UNSUPPORTED_DEPLOYMENT",
  );
  const missingActivePool = structuredClone(CANARY_MANIFEST);
  delete missingActivePool.branches[0].activePool;
  await assert.rejects(
    loadFixture(missingActivePool),
    (error) => error instanceof JpydfSdkError && error.code === "INVALID_INPUT",
  );
});

test("requires the exact scope and a loader-verified deployment", () => {
  assert.throws(
    () => createJpydfClient({ publicClient: mockPublicClient(), deployment, scope: "production" }),
    (error) => error instanceof JpydfSdkError && error.code === "TEST_ONLY_SCOPE_REQUIRED",
  );
  assert.throws(
    () =>
      createJpydfClient({
        publicClient: mockPublicClient(),
        deployment: { ...deployment },
        scope: "mainnet-canary",
      }),
    (error) => error instanceof JpydfSdkError && error.code === "UNSUPPORTED_DEPLOYMENT",
  );
  assert.throws(
    () => agentFromRpc(mockPublicClient()),
    /must come from createJpydfMainnetRpcClient/,
  );
});

test("staging has an independent test-only pin and rejects canary metadata and forged scope", async () => {
  assert.equal(stagingDeployment.deploymentScope, "mainnet-staging");
  assert.equal(stagingDeployment.deploymentClassification, "TEST_ONLY_NOT_FOR_PRODUCTION");
  assert.equal(stagingDeployment.protocolConstants.minDebtRaw, 100_000n * WAD);
  assert.equal(deployment.protocolConstants.minDebtRaw, 1_000n * WAD);
  assert.notEqual(stagingDeployment.manifestSha256, deployment.manifestSha256);
  assert.ok(Object.isFrozen(stagingDeployment));
  assert.ok(Object.isFrozen(stagingDeployment.branches[0]));
  const unsupported = (error) => error instanceof JpydfSdkError && error.code === "UNSUPPORTED_DEPLOYMENT";
  // Fixture digests are stubbed only to exercise structural verification after the byte pin.
  for (const field of ["deploymentId", "deploymentProfile", "deploymentMode", "create2Salt"]) {
    await assert.rejects(loadStagingFixture({ ...STAGING_MANIFEST, [field]: CANARY_MANIFEST[field] }), unsupported);
  }
  await assert.rejects(loadStagingFixture({ ...STAGING_MANIFEST, constants: CANARY_MANIFEST.constants }), unsupported);
  await assert.rejects(loadFixture(STAGING_MANIFEST), unsupported);
  await assert.rejects(loadStagingFixture(CANARY_MANIFEST), unsupported);
  await assert.rejects(
    loadMainnetStagingDeployment({ manifestJson: JSON.stringify(STAGING_MANIFEST) }),
    (error) => error.code === "MANIFEST_MISMATCH",
  );
  for (const [candidate, scope] of [
    [deployment, "mainnet-staging"],
    [stagingDeployment, "mainnet-canary"],
    [{ ...stagingDeployment }, "mainnet-staging"],
    [{ ...deployment, deploymentScope: "mainnet-staging" }, "mainnet-staging"],
  ]) {
    assert.throws(() => createJpydfClient({ publicClient: mockPublicClient(), deployment: candidate, scope }), unsupported);
  }
});

test("staging root reads retain staging identity and every preparation path rejects before RPC", async () => {
  const publicClient = mockPublicClient();
  const client = createJpydfClient({ publicClient, deployment: stagingDeployment, scope: "mainnet-staging" });
  assert.equal(client.capabilities.earn.transactionPreparation, false);
  assert.equal(client.capabilities.lend.transactionPreparation, false);
  assert.equal(client.capabilities.uniswapV4WalletSmoke.quote, false);
  assert.equal(client.capabilities.uniswapV4WalletSmoke.unsignedCalldata, false);
  const input = { account: ACCOUNT, branchId: 0, amountRaw: WAD, claim: true };
  for (const invoke of [
    () => client.prepareEarnDeposit(input),
    () => client.prepareEarnWithdraw(input),
    () => client.prepareEarnClaim(input),
    () => client.prepareEarnCompound(input),
    () => client.prepareForSignature({}),
    () => client.prepareUniV4WalletSmoke({ account: ACCOUNT, amountIn: WAD, deadline: 1_500n, route: univ4Route }),
  ]) {
    await assert.rejects(async () => invoke(), (error) => error.code === "POLICY_VIOLATION");
  }
  assert.deepEqual(publicClient.reads, []);
  assert.deepEqual(publicClient.simulations, []);
  const protocol = await client.getBranches();
  assert.equal(protocol.deploymentId, MAINNET_STAGING_IDENTITY.deploymentId);
  assert.equal(protocol.deploymentScope, "mainnet-staging");
  assert.equal(protocol.manifestSha256, MAINNET_STAGING_IDENTITY.manifestSha256);
  const market = await client.getMarket({ branchId: 0 });
  assert.equal(market.deploymentScope, "mainnet-staging");
  assert.equal(market.manifestSha256, MAINNET_STAGING_IDENTITY.manifestSha256);
  assert.equal(sdk().capabilities.earn.transactionPreparation, true);
  assert.equal(sdk().capabilities.uniswapV4WalletSmoke.unsignedCalldata, true);
});

test("staging agent exposes only reads and cannot acquire canary host authority", async () => {
  const options = {
    publicClient: createAgentRpcHarness().publicClient,
    deployment: stagingDeployment,
    scope: "mainnet-staging",
    account: ACCOUNT,
  };
  const session = createJpydfMainnetStagingAgentClient(options);
  assert.equal(Object.hasOwn(session, "host"), false);
  assert.equal(session.testOnly, true);
  assert.ok(session.model.operationCatalog.every(({ kind }) => kind === "read"));
  const result = await session.model.invoke({ operation: "integration.get", input: {} });
  assert.equal(result.ok, true);
  assert.equal(result.environment, "mainnet-staging");
  assert.equal(result.deploymentId, MAINNET_STAGING_IDENTITY.deploymentId);
  assert.equal(result.data.protocolConstants.minDebtRaw, String(100_000n * WAD));
  assert.equal(result.data.capabilities.earn.transactionPreparation, false);
  for (const operation of ["earn.deposit", "earn.withdraw", "earn.claim", "earn.compound"]) {
    const input = operation === "earn.claim" || operation === "earn.compound"
      ? { branchId: 0 } : { branchId: 0, amountRaw: "1", claim: true };
    const denied = await session.model.invoke({ operation, input });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "POLICY_VIOLATION");
  }
  for (const authority of [{ writeAdmission: {} }, { authorizeFinalization: () => true }]) {
    assert.throws(() => createJpydfMainnetStagingAgentClient({ ...options, ...authority }), (error) => error.code === "POLICY_VIOLATION");
  }
  assert.throws(() => createJpydfMainnetCanaryAgentClient(options), (error) => error.code === "TEST_ONLY_SCOPE_REQUIRED");
  assert.throws(() => createJpydfMainnetCanaryAgentClient({ ...options, scope: "mainnet-canary" }), (error) => error.code === "UNSUPPORTED_DEPLOYMENT");
  assert.throws(() => createJpydfMainnetStagingAgentClient({ ...options, deployment }), (error) => error.code === "UNSUPPORTED_DEPLOYMENT");
});

test("loads only the package-pinned UniV4 route artifact", async () => {
  assert.equal(univ4Route.poolKey.poolId, MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.poolId);
  assert.equal(Object.isFrozen(univ4Route), true);
  assert.equal(Object.isFrozen(univ4Route.poolKey), true);
  await assert.rejects(
    loadMainnetCanaryUniV4Route({ routeJson: ROUTE_JSON.trimEnd() }),
    (error) => error instanceof JpydfSdkError && error.code === "MANIFEST_MISMATCH",
  );
  await assert.rejects(
    loadMainnetCanaryUniV4Route({ routeJson: `${ROUTE_JSON} ` }),
    (error) => error instanceof JpydfSdkError && error.code === "MANIFEST_MISMATCH",
  );
});

test("prepares and decodes only the retained UniV4 wallet-smoke route", async () => {
  const publicClient = mockPublicClient({ jpydfBalance: 2n * WAD });
  const prepared = await sdk(publicClient).prepareUniV4WalletSmoke({
    account: ACCOUNT,
    amountIn: WAD,
    deadline: 1_500n,
    route: univ4Route,
  });

  assert.equal(prepared.mainnetBroadcastAuthorized, false);
  assert.equal(prepared.account, ACCOUNT);
  assert.equal(prepared.poolKey.poolId, MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.poolId);
  assert.equal(prepared.quotedAmountOut, 6_272n);
  assert.equal(prepared.amountOutMinimum, 6_265n);
  assert.equal(prepared.maximumTotalGasWei, 1_560_000_000_000_000n);
  assert.deepEqual(prepared.transactions.map(({ label, gasLimit }) => ({ label, gasLimit })), [
    { label: "test-df approve Permit2", gasLimit: 80_000n },
    { label: "Permit2 approve Universal Router", gasLimit: 80_000n },
    { label: "sell test-df through fixed UniV4 pool", gasLimit: 230_000n },
  ]);
  const decoded = decodeMainnetCanaryUniV4Swap(univ4Route, prepared.transactions[2].data);
  assert.equal(decoded.poolId, MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.poolId);
  assert.equal(decoded.amountIn, WAD);
  assert.equal(decoded.amountOutMinimum, 6_265n);
  assert.equal(decoded.deadline, 1_500n);
  const quoteRead = publicClient.reads.find(({ functionName }) => functionName === "quoteExactInputSingle");
  assert.equal(quoteRead.blockNumber, prepared.observedAtBlock);
  assert.equal(quoteRead.args[0].poolKey.fee, 500);
  assert.equal(quoteRead.args[0].zeroForOne, true);
});

test("wallet-smoke quote fails closed on amount, deadline, chain, and reorg drift", async () => {
  await assert.rejects(
    sdk().prepareUniV4WalletSmoke({
      account: ACCOUNT,
      amountIn: WAD + 1n,
      deadline: 1_500n,
      route: univ4Route,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "POLICY_VIOLATION",
  );
  await assert.rejects(
    sdk().prepareUniV4WalletSmoke({ account: ACCOUNT, amountIn: WAD, deadline: 1_601n, route: univ4Route }),
    (error) => error instanceof JpydfSdkError && error.code === "POLICY_VIOLATION",
  );
  await assert.rejects(
    sdk(mockPublicClient({ chainId: 11_155_111 })).prepareUniV4WalletSmoke({
      account: ACCOUNT,
      amountIn: WAD,
      deadline: 1_500n,
      route: univ4Route,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "WRONG_CHAIN",
  );
  const reorged = mockPublicClient();
  reorged.reorgAfterNextRead();
  await assert.rejects(
    sdk(reorged).prepareUniV4WalletSmoke({
      account: ACCOUNT,
      amountIn: WAD,
      deadline: 1_500n,
      route: univ4Route,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "STALE_BLOCK",
  );
  await assert.rejects(
    sdk(mockPublicClient({ jpydfBalance: 2n * WAD, permit2Allowance: 1n })).prepareUniV4WalletSmoke({
      account: ACCOUNT,
      amountIn: WAD,
      deadline: 1_500n,
      route: univ4Route,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "POLICY_VIOLATION",
  );
});

test("deadline RPC bounds physical work and recovers through half-open probes", async () => {
  const rpc = createFaultRpcHarness();
  rpc.setMode("never");
  const neverSettling = rpc.publicClient.request({ method: "eth_chainId" });
  rpc.setMode("healthy");
  const sustainedHealthy = rpc.publicClient.request({ method: "eth_chainId" });
  assert.equal(await sustainedHealthy, "0x1");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 1);
  await assert.rejects(
    neverSettling,
    (error) => error.name === "JpydfRpcTimeoutError",
  );
  assert.equal(rpc.abortsObserved, 1);
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "open");
  await assert.rejects(
    rpc.publicClient.request({ method: "eth_chainId" }),
    (error) => error.name === "JpydfRpcOverloadedError",
  );

  await new Promise((resolve) => setTimeout(resolve, 12));
  const recovery = rpc.publicClient.request({ method: "eth_chainId" });
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "half-open");
  assert.equal(await recovery, "0x1");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "closed");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
  assert.deepEqual(
    await Promise.all(Array.from(
      { length: 4 },
      () => rpc.publicClient.request({ method: "eth_chainId" }),
    )),
    Array(4).fill("0x1"),
  );

  rpc.setMode("error");
  await assert.rejects(rpc.publicClient.request({ method: "eth_chainId" }));
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "open");
  await new Promise((resolve) => setTimeout(resolve, 12));
  rpc.setMode("never");
  const stuckProbe = rpc.publicClient.request({ method: "eth_chainId" });
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "half-open");
  await assert.rejects(stuckProbe, (error) => error.name === "JpydfRpcTimeoutError");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "open");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).recoveryProbeActive, false);
  assert.equal(getJpydfRpcHealth(rpc.publicClient).stuckProbeActive, true);
  await new Promise((resolve) => setTimeout(resolve, 12));
  rpc.setMode("healthy");
  assert.equal(await rpc.publicClient.request({ method: "eth_chainId" }), "0x1");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "closed");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).stuckProbeActive, false);
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
});

test("deadline RPC rejects oversized declared bodies and recovers without crashing", async () => {
  const rpc = createFaultRpcHarness({ maxResponseBytes: 64 });
  rpc.setMode("oversized-header");
  await assert.rejects(rpc.publicClient.request({ method: "eth_chainId" }));
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "open");
  rpc.setMode("healthy");
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(await rpc.publicClient.request({ method: "eth_chainId" }), "0x1");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "closed");
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () =>
    rpc.publicClient.request({ method: "eth_chainId" }))), Array(4).fill("0x1"));
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
});

test("deadline RPC rejects above the physical limit while concurrent traffic settles", async () => {
  const rpc = createFaultRpcHarness({ timeoutMs: 100 });
  rpc.setMode("deferred");
  const requests = Array.from(
    { length: JPYDF_RPC_REGULAR_LIMIT },
    () => rpc.publicClient.request({ method: "eth_chainId" }),
  );
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, JPYDF_RPC_REGULAR_LIMIT);
  assert.equal(getJpydfRpcHealth(rpc.publicClient).configuredLimit, JPYDF_RPC_PHYSICAL_LIMIT);
  await assert.rejects(
    rpc.publicClient.request({ method: "eth_chainId" }),
    (error) => error.name === "JpydfRpcOverloadedError",
  );
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(getJpydfRpcHealth(rpc.publicClient).oldestOutstandingAgeMs > 0);
  rpc.releaseAll();
  assert.deepEqual(await Promise.all(requests), Array(JPYDF_RPC_REGULAR_LIMIT).fill("0x1"));
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
});

test("deadline RPC enforces the runtime limit across clients and recovers", async () => {
  const first = createFaultRpcHarness({ recoveryCooldownMs: 5, timeoutMs: 20 });
  const second = createFaultRpcHarness({ recoveryCooldownMs: 5, timeoutMs: 20 });
  const third = createFaultRpcHarness({ recoveryCooldownMs: 5, timeoutMs: 20 });
  first.setMode("never");
  second.setMode("never");
  third.setMode("never");
  const firstRequests = Array.from(
    { length: 5 },
    () => first.publicClient.request({ method: "eth_chainId" }),
  );
  const secondRequests = Array.from(
    { length: 5 },
    () => second.publicClient.request({ method: "eth_chainId" }),
  );
  const thirdRequests = Array.from(
    { length: 5 },
    () => third.publicClient.request({ method: "eth_chainId" }),
  );

  assert.equal(getJpydfRpcHealth(first.publicClient).activeCount, JPYDF_RPC_REGULAR_LIMIT);
  assert.equal(getJpydfRpcHealth(second.publicClient).regularActiveCount, JPYDF_RPC_REGULAR_LIMIT);
  await assert.rejects(
    second.publicClient.request({ method: "eth_chainId" }),
    (error) => error.name === "JpydfRpcOverloadedError",
  );

  const outcomes = await Promise.allSettled([...firstRequests, ...secondRequests, ...thirdRequests]);
  assert.ok(outcomes.every(({ status }) => status === "rejected"));
  assert.equal(first.abortsObserved, 5);
  assert.equal(second.abortsObserved, 5);
  assert.equal(third.abortsObserved, 5);
  assert.equal(getJpydfRpcHealth(first.publicClient).activeCount, 0);
  assert.equal(getJpydfRpcHealth(second.publicClient).activeCount, 0);

  await new Promise((resolve) => setTimeout(resolve, 7));
  first.setMode("healthy");
  second.setMode("healthy");
  third.setMode("healthy");
  const recoveryProbes = [
    first.publicClient.request({ method: "eth_chainId" }),
    second.publicClient.request({ method: "eth_chainId" }),
  ];
  await assert.rejects(
    third.publicClient.request({ method: "eth_chainId" }),
    (error) => error.name === "JpydfRpcOverloadedError",
  );
  assert.deepEqual(
    await Promise.all(recoveryProbes),
    ["0x1", "0x1"],
  );
  assert.equal(await third.publicClient.request({ method: "eth_chainId" }), "0x1");
  assert.equal(getJpydfRpcHealth(first.publicClient).circuitState, "closed");
  assert.equal(getJpydfRpcHealth(second.publicClient).circuitState, "closed");
  assert.equal(getJpydfRpcHealth(third.publicClient).circuitState, "closed");
  assert.deepEqual(
    await Promise.all([
      first.publicClient.request({ method: "eth_chainId" }),
      second.publicClient.request({ method: "eth_chainId" }),
      first.publicClient.request({ method: "eth_chainId" }),
      second.publicClient.request({ method: "eth_chainId" }),
    ]),
    ["0x1", "0x1", "0x1", "0x1"],
  );
  assert.equal(getJpydfRpcHealth(first.publicClient).activeCount, 0);
});

test("deadline RPC physically terminates regular work and repeated stuck recovery probes", async () => {
  const rpc = createFaultRpcHarness({ recoveryCooldownMs: 5, timeoutMs: 10 });
  rpc.setMode("never");
  const stuck = Array.from(
    { length: JPYDF_RPC_REGULAR_LIMIT },
    () => rpc.publicClient.request({ method: "eth_chainId" }),
  );
  const outcomes = await Promise.allSettled(stuck);
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
  let health = getJpydfRpcHealth(rpc.publicClient);
  assert.equal(health.activeCount, 0);
  assert.equal(health.regularActiveCount, 0);
  assert.equal(health.circuitState, "open");

  for (let probe = 0; probe < 2; probe++) {
    await new Promise((resolve) => setTimeout(resolve, 7));
    await assert.rejects(
      rpc.publicClient.request({ method: "eth_chainId" }),
      (error) => error.name === "JpydfRpcTimeoutError",
    );
    health = getJpydfRpcHealth(rpc.publicClient);
    assert.equal(health.activeCount, 0);
    assert.equal(health.circuitState, "open");
    assert.equal(health.stuckProbeActive, true);
  }

  await new Promise((resolve) => setTimeout(resolve, 7));
  rpc.setMode("healthy");
  assert.equal(await rpc.publicClient.request({ method: "eth_chainId" }), "0x1");
  health = getJpydfRpcHealth(rpc.publicClient);
  assert.equal(health.circuitState, "closed");
  assert.deepEqual(
    await Promise.all([
      rpc.publicClient.request({ method: "eth_chainId" }),
      rpc.publicClient.request({ method: "eth_chainId" }),
    ]),
    ["0x1", "0x1"],
  );
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
  assert.equal(getJpydfRpcHealth(rpc.publicClient).stuckProbeActive, false);
});

test("deadline RPC keeps serving bounded recovery traffic until stuck regular work settles", async () => {
  const rpc = createStubbornRpcHarness();
  const stuck = Array.from(
    { length: JPYDF_RPC_REGULAR_LIMIT },
    () => rpc.publicClient.request({ method: "eth_chainId" }),
  );
  const timedOut = await Promise.allSettled(stuck);
  assert.ok(timedOut.every(
    (outcome) => outcome.status === "rejected" && outcome.reason.name === "JpydfRpcTimeoutError",
  ));
  let health = getJpydfRpcHealth(rpc.publicClient);
  assert.equal(health.activeCount, JPYDF_RPC_REGULAR_LIMIT);
  assert.equal(rpc.activePhysical, JPYDF_RPC_REGULAR_LIMIT);
  assert.equal(health.circuitState, "open");

  await new Promise((resolve) => setTimeout(resolve, 7));
  rpc.setMode("healthy");
  for (let wave = 0; wave < 4; wave++) {
    const traffic = await Promise.allSettled(Array.from(
      { length: 8 },
      () => rpc.publicClient.request({ method: "eth_chainId" }),
    ));
    assert.equal(traffic.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value === "0x1",
    ).length, 1);
    assert.ok(traffic.slice(1).every(
      (outcome) => outcome.status === "rejected" && outcome.reason.name === "JpydfRpcOverloadedError",
    ));
    health = getJpydfRpcHealth(rpc.publicClient);
    assert.equal(health.circuitState, "open");
    assert.equal(health.regularActiveCount, JPYDF_RPC_REGULAR_LIMIT);
    assert.equal(rpc.activePhysical, JPYDF_RPC_REGULAR_LIMIT);
    assert.ok(rpc.maxPhysical <= JPYDF_RPC_PHYSICAL_LIMIT);
  }

  rpc.settleStuck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
  assert.equal(rpc.activePhysical, 0);
  assert.equal(await rpc.publicClient.request({ method: "eth_chainId" }), "0x1");
  assert.equal(getJpydfRpcHealth(rpc.publicClient).circuitState, "closed");
  assert.deepEqual(
    await Promise.all(Array.from(
      { length: 4 },
      () => rpc.publicClient.request({ method: "eth_chainId" }),
    )),
    Array(4).fill("0x1"),
  );
  assert.ok(rpc.maxPhysical <= JPYDF_RPC_PHYSICAL_LIMIT);
});

test("deadline RPC rejects invalid recovery envelopes and provider rate limits", async () => {
  for (const mode of ["rpc-error", "mismatched-id", "empty", "null"]) {
    const rpc = createFaultRpcHarness();
    rpc.setMode("deferred");
    await assert.rejects(
      rpc.publicClient.request({ method: "eth_chainId" }),
      (error) => error.name === "JpydfRpcTimeoutError",
    );
    assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
    await new Promise((resolve) => setTimeout(resolve, 12));
    rpc.setMode(mode);
    await assert.rejects(rpc.publicClient.request({ method: "eth_chainId" }));
    const health = getJpydfRpcHealth(rpc.publicClient);
    assert.equal(health.activeCount, 0);
    assert.equal(health.circuitState, "open");
    assert.ok(health.nextRecoveryProbeInMs > 0);
  }

  const internalError = createFaultRpcHarness();
  internalError.setMode("rpc-error");
  await assert.rejects(internalError.publicClient.request({ method: "eth_chainId" }));
  assert.equal(getJpydfRpcHealth(internalError.publicClient).circuitState, "open");

  const callInternalError = createFaultRpcHarness();
  callInternalError.setMode("rpc-error");
  await assert.rejects(callInternalError.publicClient.request({ method: "eth_call", params: [] }));
  assert.equal(getJpydfRpcHealth(callInternalError.publicClient).circuitState, "open");

  const encodedRevert = createFaultRpcHarness();
  encodedRevert.setMode("rpc-revert");
  await assert.rejects(encodedRevert.publicClient.request({ method: "eth_call", params: [] }));
  assert.equal(getJpydfRpcHealth(encodedRevert.publicClient).circuitState, "closed");

  const applicationRevert = createFaultRpcHarness();
  applicationRevert.setMode("error");
  await assert.rejects(applicationRevert.publicClient.request({ method: "eth_chainId" }));
  await new Promise((resolve) => setTimeout(resolve, 12));
  applicationRevert.setMode("revert");
  await assert.rejects(applicationRevert.publicClient.request({ method: "eth_call", params: [] }));
  assert.equal(getJpydfRpcHealth(applicationRevert.publicClient).circuitState, "closed");

  for (const mode of ["http-rate-limit", "rate-limit", "resource-unavailable"]) {
    const limited = createFaultRpcHarness();
    limited.setMode(mode);
    await assert.rejects(limited.publicClient.request({ method: "eth_chainId" }));
    assert.equal(getJpydfRpcHealth(limited.publicClient).circuitState, "open");
  }

  const oversized = createFaultRpcHarness({ maxResponseBytes: 64 });
  oversized.setMode("oversized");
  await assert.rejects(oversized.publicClient.request({ method: "eth_chainId" }));
  assert.equal(getJpydfRpcHealth(oversized.publicClient).circuitState, "open");

  const agentRateLimit = createFaultRpcHarness();
  agentRateLimit.setMode("rate-limit");
  const limitedAgent = await agentFromRpc(agentRateLimit.publicClient).model.invoke({
    operation: "protocol.get",
    input: {},
  });
  assert.equal(limitedAgent.error.code, "RATE_LIMITED");
  assert.equal(limitedAgent.error.retryable, true);
  assert.ok(limitedAgent.error.retryAfterMs > 0);
});

test("deadline RPC does not leak capacity when request serialization fails", async () => {
  const rpc = createFaultRpcHarness();
  await assert.rejects(
    rpc.publicClient.request({ method: "eth_test", params: [1n] }),
  );
  const cyclic = [];
  cyclic.push(cyclic);
  await assert.rejects(
    rpc.publicClient.request({ method: "eth_test", params: cyclic }),
  );
  assert.equal(getJpydfRpcHealth(rpc.publicClient).activeCount, 0);
  assert.equal(await rpc.publicClient.request({ method: "eth_chainId" }), "0x1");
});

test("deadline RPC reserves normal and recovery capacity before request serialization", async () => {
  const recursiveParam = (rpcs, requests, remaining, index = 0) => ({
    toJSON() {
      if (remaining > 0) {
        const rpc = rpcs[index % rpcs.length];
        requests.push(rpc.publicClient.request({
          method: "eth_test",
          params: [recursiveParam(rpcs, requests, remaining - 1, index + 1)],
        }));
      }
      return {};
    },
  });
  const depth = JPYDF_RPC_PHYSICAL_LIMIT * 4;

  const normal = createFaultRpcHarness();
  normal.setMode("never");
  const normalRequests = [];
  normalRequests.push(normal.publicClient.request({
    method: "eth_test",
    params: [recursiveParam([normal], normalRequests, depth - 1)],
  }));
  await Promise.resolve();
  let health = getJpydfRpcHealth(normal.publicClient);
  assert.equal(health.activeCount, JPYDF_RPC_REGULAR_LIMIT);
  assert.ok(health.activeCount <= health.configuredLimit);
  assert.equal(normal.requestsObserved, JPYDF_RPC_REGULAR_LIMIT);
  await Promise.allSettled(normalRequests);

  const recovering = Array.from(
    { length: 3 },
    () => createFaultRpcHarness({ recoveryCooldownMs: 5 }),
  );
  for (const rpc of recovering) rpc.setMode("error");
  await Promise.all(recovering.map(
    (rpc) => assert.rejects(rpc.publicClient.request({ method: "eth_chainId" })),
  ));
  await new Promise((resolve) => setTimeout(resolve, 7));
  for (const rpc of recovering) rpc.setMode("never");
  const recoveryRequests = [];
  recoveryRequests.push(recovering[0].publicClient.request({
    method: "eth_test",
    params: [recursiveParam(recovering, recoveryRequests, depth - 1, 1)],
  }));
  await Promise.resolve();
  health = getJpydfRpcHealth(recovering[0].publicClient);
  assert.equal(health.activeCount, JPYDF_RPC_PHYSICAL_LIMIT - JPYDF_RPC_REGULAR_LIMIT);
  assert.equal(health.recoveryProbeActive, true);
  assert.ok(health.activeCount <= JPYDF_RPC_PHYSICAL_LIMIT - JPYDF_RPC_REGULAR_LIMIT);
  assert.equal(recovering.reduce((count, rpc) => count + rpc.requestsObserved, 0), 5);
  await Promise.allSettled(recoveryRequests);
});

test("reads only active pools at one observed block", async () => {
  const publicClient = mockPublicClient();
  const position = await sdk(publicClient).getAccount(ACCOUNT);

  assert.equal(position.observedAtBlock, 123n);
  assert.equal(position.manifestSha256, deployment.manifestSha256);
  assert.equal(position.jpydfBalance, 100n);
  assert.deepEqual(position.pools.map(({ branchId }) => branchId), [0, 1]);
  assert.deepEqual(position.pools[0], {
    branchId: 0,
    collSymbol: "dwstETH",
    compoundedDeposit: 20n,
    hasRecordedDeposit: true,
    rewards: { jpydf: 5n, collateral: 7n },
  });
  assert.ok(publicClient.reads.every((read) => read.blockNumber === 123n));
});

test("rejects an account snapshot if the observed block is reorged", async () => {
  const publicClient = mockPublicClient();
  publicClient.reorgAfterNextRead();
  await assert.rejects(
    sdk(publicClient).getAccount(ACCOUNT),
    (error) => error instanceof JpydfSdkError && error.code === "STALE_BLOCK",
  );
});

test("reads borrow, earn, and risk rates from one block", async () => {
  const publicClient = mockPublicClient();
  const market = await sdk(publicClient).getMarket({ branchId: 0 });

  assert.equal(market.observedAtBlock, 123n);
  assert.equal(market.protocolPriceRaw, 200n * WAD);
  assert.equal(market.averageBorrowRateRaw, 5n * WAD / 100n);
  assert.equal(market.stabilityPoolAprRaw, 75n * WAD / 1_000n);
  assert.equal(market.stabilityPoolCoverageRaw, WAD / 2n);
  assert.equal(market.totalCollateralRatioRaw, 2n * WAD);
  assert.equal(market.minimumCollateralRatioRaw, 11n * WAD / 10n);
  assert.equal(market.criticalCollateralRatioRaw, 15n * WAD / 10n);
  assert.equal(market.shutdownCollateralRatioRaw, 105n * WAD / 100n);
  assert.equal(market.oracleStatus, "live");
  assert.equal(market.jpyUsdOracleUpdatedAt, 900n);
  assert.deepEqual(market.vaultPaused, { claim: false, deposit: false, redeem: false });
  assert.ok(publicClient.reads.every((read) => read.blockNumber === 123n));
  assert.equal(publicClient.simulations[0].blockNumber, 123n);
  assert.equal(
    publicClient.reads.find(({ functionName }) => functionName === "MCR").address,
    deployment.branches[0].borrowerOperations,
  );
});

test("returns null instead of inventing rates for empty debt and earn pools", async () => {
  const market = await sdk(mockPublicClient({
    aggregateRecordedDebtRaw: 0n,
    aggregateWeightedDebtRaw: 0n,
    branchDebtRaw: 0n,
    stabilityPoolDepositsRaw: 0n,
  })).getMarket({ branchId: 0 });
  assert.equal(market.averageBorrowRateRaw, null);
  assert.equal(market.stabilityPoolAprRaw, null);
  assert.equal(market.stabilityPoolCoverageRaw, null);
  assert.equal(market.totalCollateralRatioRaw, null);
});

test("returns zero Stability Pool APR after branch shutdown", async () => {
  const market = await sdk(mockPublicClient({ shutdownTime: 999n })).getMarket({ branchId: 0 });
  assert.equal(market.shutdown, true);
  assert.equal(market.stabilityPoolAprRaw, 0n);
});

test("reports JPY soft-freeze and blocks liquidation scans even before freeze state is persisted", async () => {
  const frozen = mockPublicClient({ jpyFrozenSince: 950n });
  assert.equal((await sdk(frozen).getMarket({ branchId: 0 })).oracleStatus, "frozen");
  await assert.rejects(
    sdk(frozen).scanLiquidationCandidates({
      branchId: 0,
      includeLastZombie: true,
      maxIterations: 32,
      startId: 0n,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "ORACLE_UNAVAILABLE",
  );

  const staleBeforePoll = mockPublicClient({ jpyFrozenSince: 0n, jpyOracleUpdatedAt: 800n });
  assert.equal((await sdk(staleBeforePoll).getMarket({ branchId: 0 })).oracleStatus, "frozen");
  await assert.rejects(
    sdk(staleBeforePoll).scanLiquidationCandidates({
      branchId: 0,
      includeLastZombie: false,
      maxIterations: 1,
      startId: 0n,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "ORACLE_UNAVAILABLE",
  );
});

test("fails closed if the active price source no longer uses the pinned JPY provider", async () => {
  await assert.rejects(
    sdk(mockPublicClient({ activeJpyProvider: address(9_999) })).getMarket({ branchId: 0 }),
    (error) => error instanceof JpydfSdkError && error.code === "ORACLE_UNAVAILABLE",
  );
  await assert.rejects(
    sdk(mockPublicClient({ priceSource: 2 })).scanLiquidationCandidates({
      branchId: 0,
      includeLastZombie: true,
      maxIterations: 1,
      startId: 0n,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "ORACLE_UNAVAILABLE",
  );
});

test("rejects market and liquidation reads if the observed block is reorged", async () => {
  for (const operation of ["market", "liquidation"]) {
    const publicClient = mockPublicClient();
    publicClient.reorgAfterNextRead();
    const request = operation === "market"
      ? sdk(publicClient).getMarket({ branchId: 0 })
      : sdk(publicClient).scanLiquidationCandidates({
        branchId: 0,
        includeLastZombie: true,
        maxIterations: 32,
        startId: 0n,
      });
    await assert.rejects(
      request,
      (error) => error instanceof JpydfSdkError && error.code === "STALE_BLOCK",
    );
  }
});

test("fails closed when the protocol oracle is unavailable", async () => {
  await assert.rejects(
    sdk(mockPublicClient({ oracleFailed: true })).getMarket({ branchId: 0 }),
    (error) => error instanceof JpydfSdkError
      && error.code === "ORACLE_UNAVAILABLE"
      && error.retryAfterMs === 12_000,
  );
  await assert.rejects(
    sdk(mockPublicClient({ priceRaw: 2n ** 256n - 1n })).getMarket({ branchId: 0 }),
    (error) => error instanceof JpydfSdkError && error.code === "ORACLE_UNAVAILABLE",
  );
});

test("bounds liquidation scans and marks candidates for execution revalidation", async () => {
  const duplicate = { id: 42n, ICR: WAD, entireDebt: 1_200n * WAD, entireColl: 6n * WAD };
  const publicClient = mockPublicClient({ liquidationCandidates: [duplicate, duplicate] });
  const page = await sdk(publicClient).scanLiquidationCandidates({
    branchId: 0,
    includeLastZombie: true,
    maxIterations: 32,
    startId: 0n,
  });

  assert.equal(page.nextCursor, 41n);
  assert.equal(page.requiresExecutionRevalidation, true);
  assert.deepEqual(page.candidates, [{
    troveId: 42n,
    icrRaw: WAD,
    entireDebtRaw: 1_200n * WAD,
    entireCollateralRaw: 6n * WAD,
  }]);
  const scan = publicClient.reads.find(({ functionName }) => (
    functionName === "getLiquidationCandidatesWithLastZombie"
  ));
  assert.deepEqual(scan.args, [0n, 0n, 32n, 200n * WAD, 11n * WAD / 10n, true]);
  assert.ok(publicClient.reads.every((read) => read.blockNumber === 123n));

  await assert.rejects(
    sdk(publicClient).scanLiquidationCandidates({
      branchId: 0,
      includeLastZombie: false,
      maxIterations: 129,
      startId: 0n,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    sdk(publicClient).scanLiquidationCandidates({
      branchId: 0,
      includeLastZombie: false,
      maxIterations: 1,
      startId: 2n ** 256n,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "INVALID_INPUT",
  );
});

test("prepares a canonical, short-lived SP deposit without an approval", async () => {
  const publicClient = mockPublicClient();
  const prepared = await sdk(publicClient).prepareEarnDeposit({
    account: ACCOUNT,
    branchId: 1,
    amountRaw: 12n,
    claim: true,
  });

  assert.equal(prepared.status, "simulated");
  assert.equal(prepared.actor, ACCOUNT);
  assert.equal(prepared.validUntilBlock, 125n);
  assert.equal("transaction" in prepared, false);
  assert.equal(prepared.reference.actor, ACCOUNT);
  assert.equal(prepared.intent.amountSemantics, "exact");
  assert.deepEqual(publicClient.simulations[0].args, [12n, true]);
  assert.ok(!publicClient.reads.some((read) => read.functionName === "allowance"));
});

test("rejects a reorged simulation block", async () => {
  const publicClient = mockPublicClient();
  publicClient.setCanonicalHash("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  await assert.rejects(
    sdk(publicClient).prepareEarnDeposit({ account: ACCOUNT, branchId: 0, amountRaw: 12n, claim: true }),
    (error) => error instanceof JpydfSdkError && error.code === "STALE_BLOCK",
  );
});

test("selects the safe claim call from the recorded deposit", async () => {
  const withoutDeposit = mockPublicClient({ recordedDeposit: 0n });
  await sdk(withoutDeposit).prepareEarnClaim({ account: ACCOUNT, branchId: 0 });
  assert.equal(withoutDeposit.simulations[0].functionName, "claimAllCollGains");

  const withDeposit = mockPublicClient({ recordedDeposit: 7n });
  await sdk(withDeposit).prepareEarnClaim({ account: ACCOUNT, branchId: 0 });
  assert.equal(withDeposit.simulations[0].functionName, "withdrawFromSP");
  assert.deepEqual(withDeposit.simulations[0].args, [0n, true]);

  await sdk(withDeposit).prepareEarnCompound({ account: ACCOUNT, branchId: 0 });
  assert.deepEqual(withDeposit.simulations[1].args, [0n, false]);
});

test("marks withdrawals as maximum amounts and forces rewards on full exit", async () => {
  const publicClient = mockPublicClient();
  await assert.rejects(
    sdk(publicClient).prepareEarnWithdraw({ account: ACCOUNT, branchId: 0, amountRaw: 21n, claim: true }),
    (error) => error instanceof JpydfSdkError && error.code === "INVALID_INPUT",
  );
  await sdk(publicClient).prepareEarnWithdraw({
    account: ACCOUNT,
    branchId: 0,
    amountRaw: 20n,
    claim: false,
  });
  assert.deepEqual(publicClient.simulations[0].args, [20n, true]);
  assert.equal(publicClient.simulations[0].account, ACCOUNT);
  await sdk(publicClient).prepareEarnWithdraw({
    account: ACCOUNT,
    branchId: 0,
    amountRaw: 19n,
    claim: false,
  });
  assert.deepEqual(publicClient.simulations[1].args, [19n, false]);
  assert.equal(publicClient.simulations.length, 2);
});

test("maps same-block Stability Pool guards to a retryable next-block error", async () => {
  const publicClient = mockPublicClient();
  publicClient.failNextSimulation(new BaseError("simulation failed", {
    cause: new ContractFunctionRevertedError({
      abi: [],
      functionName: "withdrawFromSP",
      message: "StabilityPool: Withdrawal must wait after deposit",
    }),
  }));
  await assert.rejects(
    sdk(publicClient).prepareEarnWithdraw({ account: ACCOUNT, branchId: 0, amountRaw: 1n, claim: true }),
    (error) => error instanceof JpydfSdkError
      && error.code === "NEXT_BLOCK_REQUIRED"
      && error.retryAfterMs === 1_000,
  );
});

test("only exposes a fresh transaction after finalization", async () => {
  const publicClient = mockPublicClient();
  const client = sdk(publicClient);
  const prepared = await client.prepareEarnDeposit({
    account: ACCOUNT,
    branchId: 0,
    amountRaw: 12n,
    claim: true,
  });
  const ready = await client.prepareForSignature(prepared.reference);

  assert.equal(ready.status, "ready-for-signature");
  assert.equal(ready.requiresRevalidation, false);
  assert.equal(ready.transaction.to, deployment.branches[0].stabilityPool);
  assert.equal(ready.transaction.account, ACCOUNT);
  await assert.rejects(
    client.prepareForSignature({
      ...prepared.reference,
      intent: { ...prepared.reference.intent, amountSemantics: "maximum" },
    }),
    (error) => error instanceof JpydfSdkError && error.code === "INVALID_INPUT",
  );

  const withdrawal = await client.prepareEarnWithdraw({
    account: ACCOUNT,
    branchId: 0,
    amountRaw: 20n,
    claim: true,
  });
  assert.equal(withdrawal.intent.amountSemantics, "maximum");
  publicClient.setCompoundedDeposit(19n);
  await assert.rejects(
    client.prepareForSignature(withdrawal.reference),
    (error) => error instanceof JpydfSdkError && error.code === "INVALID_INPUT",
  );
});

test("requires fresh approval when a partial withdrawal becomes a full exit", async () => {
  const publicClient = mockPublicClient();
  const client = sdk(publicClient);
  const withdrawal = await client.prepareEarnWithdraw({
    account: ACCOUNT,
    branchId: 0,
    amountRaw: 19n,
    claim: false,
  });
  publicClient.setCompoundedDeposit(19n);

  await assert.rejects(
    client.prepareForSignature(withdrawal.reference),
    (error) => error instanceof JpydfSdkError && error.code === "ACTION_EXPIRED",
  );
});

test("rejects a finalized action that expires during simulation", async () => {
  const publicClient = mockPublicClient();
  const client = sdk(publicClient);
  const prepared = await client.prepareEarnDeposit({
    account: ACCOUNT,
    branchId: 0,
    amountRaw: 12n,
    claim: true,
  });
  publicClient.advanceAfterNextSimulation(3n);
  await assert.rejects(
    client.prepareForSignature(prepared.reference),
    (error) => error instanceof JpydfSdkError && error.code === "ACTION_EXPIRED",
  );
});

test("agent is read-only by default and exposes machine-readable schemas", async () => {
  const harness = createAgentRpcHarness();
  const readOnly = agentFromRpc(harness.publicClient);
  assert.deepEqual(readOnly.model.operationCatalog.map(({ id }) => id), [
    "integration.get",
    "protocol.get",
    "account.get",
    "market.get",
    "liquidation.scan",
  ]);
  assert.ok(readOnly.model.operationCatalog.every(({ inputSchema }) => inputSchema.additionalProperties === false));
  const capabilities = await readOnly.model.invoke({ operation: "integration.get", input: {} });
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.data.capabilities.lend.canonicalFeature, "earn");
  assert.equal(capabilities.data.capabilities.swap.available, false);
  assert.equal(capabilities.data.capabilities.liquidation.execution, "external-liquidator-bot");
  assert.equal(capabilities.data.protocolConstants.minDebtRaw, "1000000000000000000000");
  assert.equal(
    (await readOnly.model.invoke({
      operation: "liquidation.scan",
      input: { branchId: 0, maxIterations: 129, startId: "0" },
    })).error.code,
    "INVALID_INPUT",
  );
  const denied = await readOnly.model.invoke({
    operation: "earn.deposit",
    input: { amountRaw: "1", branchId: 0, claim: true },
  });
  assert.equal(denied.error.code, "POLICY_VIOLATION");

  const restricted = createJpydfMainnetCanaryAgentClient({
    publicClient: harness.publicClient,
    deployment,
    scope: "mainnet-canary",
    account: ACCOUNT,
    authorizeFinalization: () => true,
    writeAdmission: {
      allowedOperations: ["earn.deposit"],
      allowedBranchIds: [0],
      allowedRewardModes: ["compound"],
      expiresAtMs: Date.now() + 60_000,
      maxAmountRaw: 10n,
      maxPendingAmountRaw: 15n,
    },
  });
  assert.deepEqual(restricted.model.operationCatalog.map(({ id }) => id), [
    "integration.get",
    "protocol.get",
    "account.get",
    "market.get",
    "liquidation.scan",
    "earn.deposit",
  ]);
  assert.deepEqual(
    restricted.model.operationCatalog.find(({ id }) => id === "earn.deposit").inputSchema.required,
    ["amountRaw", "branchId", "claim"],
  );
  const depositSchema = restricted.model.operationCatalog.find(({ id }) => id === "earn.deposit").inputSchema;
  assert.match(depositSchema.properties.amountRaw.description, /18-decimal JPYdf base-unit/);
  assert.match(depositSchema.properties.claim.description, /Full withdrawal.*requires approval/);
  assert.equal(
    (await restricted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "11", branchId: 0, claim: false },
    })).error.code,
    "POLICY_VIOLATION",
  );
  assert.equal(
    (await restricted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "1", branchId: 1, claim: false },
    })).error.code,
    "POLICY_VIOLATION",
  );
  assert.equal(
    (await restricted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "1", branchId: 0, claim: true },
    })).error.code,
    "POLICY_VIOLATION",
  );
  assert.equal(
    (await restricted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "1", branchId: 0 },
    })).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await restricted.model.invoke({
      operation: "earn.claim",
      input: { branchId: 0 },
    })).error.code,
    "POLICY_VIOLATION",
  );
  assert.equal(
    (await restricted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "10", branchId: 0, claim: false },
    })).ok,
    true,
  );
  assert.equal(
    (await restricted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "6", branchId: 0, claim: false },
    })).error.code,
    "POLICY_VIOLATION",
  );
});

test("agent metadata is immutable across sessions", async () => {
  const harness = createAgentRpcHarness();
  const first = agentFromRpc(harness.publicClient);
  const second = agentFromRpc(harness.publicClient);
  const capabilities = sdk().capabilities;
  const market = first.model.operationCatalog.find(({ id }) => id === "market.get");

  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.isFrozen(capabilities.swap), true);
  assert.equal(Object.isFrozen(first.model.operationCatalog), true);
  assert.equal(Object.isFrozen(market), true);
  assert.equal(Object.isFrozen(market.inputSchema), true);
  assert.equal(Object.isFrozen(market.inputSchema.properties), true);
  assert.throws(() => { capabilities.swap.available = true; }, TypeError);
  assert.throws(() => { market.id = "poisoned.market"; }, TypeError);

  const response = await second.model.invoke({ operation: "integration.get", input: {} });
  assert.equal(response.data.capabilities.swap.available, false);
  assert.ok(second.model.operationCatalog.some(({ id }) => id === "market.get"));
});

test("agent requires durable host authorization before finalization", async () => {
  const harness = createAgentRpcHarness();
  const writeAdmission = {
    allowedOperations: ["earn.deposit"],
    allowedBranchIds: [0],
    allowedRewardModes: ["compound"],
    expiresAtMs: Date.now() + 60_000,
    maxAmountRaw: 10n,
    maxPendingAmountRaw: 10n,
  };
  assert.throws(
    () => createJpydfMainnetCanaryAgentClient({
      publicClient: harness.publicClient,
      deployment,
      scope: "mainnet-canary",
      account: ACCOUNT,
      writeAdmission,
    }),
    (error) => error instanceof JpydfSdkError && error.code === "INVALID_INPUT",
  );

  let authorization;
  const options = {
    publicClient: harness.publicClient,
    deployment,
    scope: "mainnet-canary",
    account: ACCOUNT,
    authorizeFinalization(request) {
      authorization = request;
      return false;
    },
    writeAdmission,
  };
  const denied = createJpydfMainnetCanaryAgentClient(options);
  options.authorizeFinalization = () => true;
  options.deployment = {
    ...deployment,
    protocolConstants: { ...deployment.protocolConstants, minDebtRaw: 1n },
  };
  const integration = await denied.model.invoke({ operation: "integration.get", input: {} });
  assert.equal(integration.data.protocolConstants.minDebtRaw, "1000000000000000000000");
  const prepared = await denied.model.invoke({
    operation: "earn.deposit",
    input: { amountRaw: "10", branchId: 0, claim: false },
  });
  const finalized = await denied.host.finalize(prepared.data.revalidationId);
  assert.equal(finalized.error.code, "POLICY_VIOLATION");
  assert.equal(authorization.actor, ACCOUNT);
  assert.equal(authorization.revalidationId, prepared.data.revalidationId);
  assert.equal(authorization.reference.intent.operationId, "earn.deposit");
  assert.equal(Object.isFrozen(authorization), true);
});

test("agent rejects async authorization results without pinning pending capacity", async () => {
  const harness = createAgentRpcHarness();
  let authorizationCalls = 0;
  const never = new Promise(() => {});
  const sdkAgent = createJpydfMainnetCanaryAgentClient({
    publicClient: harness.publicClient,
    deployment,
    scope: "mainnet-canary",
    account: ACCOUNT,
    authorizeFinalization: () => {
      authorizationCalls++;
      return never;
    },
    writeAdmission: {
      allowedOperations: ["earn.claim"],
      allowedBranchIds: [0],
      expiresAtMs: Date.now() + 60_000,
    },
  });
  const revalidationIds = [];
  for (let index = 0; index < 32; index++) {
    const prepared = await sdkAgent.model.invoke({ operation: "earn.claim", input: { branchId: 0 } });
    assert.equal(prepared.ok, true);
    revalidationIds.push(prepared.data.revalidationId);
  }

  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("authorization result remained in flight")), 250);
  });
  let rejected;
  try {
    rejected = await Promise.race([
      Promise.all(revalidationIds.map((id) => sdkAgent.host.finalize(id))),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  assert.equal(authorizationCalls, 1);
  assert.ok(rejected.every(({ error }) => error.code === "POLICY_VIOLATION" && !error.retryable));

  const replays = await Promise.all(revalidationIds.map((id) => sdkAgent.host.finalize(id)));
  assert.ok(replays.every(({ error }) => error.code === "ACTION_EXPIRED"));
  assert.equal(authorizationCalls, 1);

  const replacement = await sdkAgent.model.invoke({ operation: "earn.claim", input: { branchId: 0 } });
  assert.equal(replacement.ok, true);
  const disabled = await sdkAgent.host.finalize(replacement.data.revalidationId);
  assert.equal(disabled.error.code, "POLICY_VIOLATION");
  assert.equal(authorizationCalls, 1);
  assert.equal((await sdkAgent.model.invoke({ operation: "earn.claim", input: { branchId: 0 } })).ok, true);
});

test("agent keeps authorization exceptions fail closed without disabling retries", async () => {
  const harness = createAgentRpcHarness();
  let authorizationFails = true;
  const sdkAgent = createJpydfMainnetCanaryAgentClient({
    publicClient: harness.publicClient,
    deployment,
    scope: "mainnet-canary",
    account: ACCOUNT,
    authorizeFinalization: () => {
      if (authorizationFails) throw new Error("authorization unavailable");
      return true;
    },
    writeAdmission: {
      allowedOperations: ["earn.claim"],
      allowedBranchIds: [0],
      expiresAtMs: Date.now() + 60_000,
    },
  });
  const prepared = await sdkAgent.model.invoke({ operation: "earn.claim", input: { branchId: 0 } });
  const failed = await sdkAgent.host.finalize(prepared.data.revalidationId);
  assert.equal(failed.error.code, "RPC_ERROR");
  assert.equal(failed.error.retryable, true);

  authorizationFails = false;
  assert.equal((await sdkAgent.host.finalize(prepared.data.revalidationId)).ok, true);
});

test("agent rechecks forced reward claiming against the host admission", async () => {
  const harness = createAgentRpcHarness();
  const compoundOnly = createJpydfMainnetCanaryAgentClient({
    publicClient: harness.publicClient,
    deployment,
    scope: "mainnet-canary",
    account: ACCOUNT,
    authorizeFinalization: () => true,
    writeAdmission: {
      allowedOperations: ["earn.withdraw"],
      allowedBranchIds: [0],
      allowedRewardModes: ["compound"],
      expiresAtMs: Date.now() + 60_000,
      maxAmountRaw: 20n,
      maxPendingAmountRaw: 20n,
    },
  });
  const response = await compoundOnly.model.invoke({
    operation: "earn.withdraw",
    input: { amountRaw: "20", branchId: 0, claim: false },
  });
  assert.equal(response.error.code, "POLICY_VIOLATION");
});

test("agent decodes fixed-block market and liquidation RPC results", async () => {
  const harness = createAgentRpcHarness();
  const readOnly = agentFromRpc(harness.publicClient);
  const market = await readOnly.model.invoke({ operation: "market.get", input: { branchId: 0 } });
  assert.equal(market.ok, true);
  assert.equal(market.data.protocolPriceRaw, (200n * WAD).toString());
  assert.equal(market.data.averageBorrowRateRaw, (5n * WAD / 100n).toString());
  assert.equal(market.data.stabilityPoolAprRaw, (75n * WAD / 1_000n).toString());

  const liquidation = await readOnly.model.invoke({
    operation: "liquidation.scan",
    input: { branchId: 0, maxIterations: 32, startId: "0" },
  });
  assert.equal(liquidation.ok, true);
  assert.equal(liquidation.data.requiresExecutionRevalidation, true);
  assert.equal(liquidation.data.candidates[0].troveId, "42");

  harness.setOracleFailed(true);
  const unavailable = await readOnly.model.invoke({ operation: "market.get", input: { branchId: 0 } });
  assert.equal(unavailable.error.code, "ORACLE_UNAVAILABLE");
  assert.equal(unavailable.error.retryable, true);
  assert.equal(unavailable.error.retryAfterMs, 12_000);
});

test("MCP exposes SDK read schemas and results while refusing write authority", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createReadOnlyMcpServer } = await import("../examples/mcp-server.mjs");
  // Deliberately pass a write-enabled model: the adapter still exposes reads only.
  const { harness, sdkAgent } = agent();
  const calls = [];
  let throwUnexpected = false;
  const server = createReadOnlyMcpServer({
    operationCatalog: sdkAgent.model.operationCatalog,
    invoke(request) {
      calls.push(request);
      if (throwUnexpected) throw new Error("secret-rpc-credential");
      return sdkAgent.model.invoke(request);
    },
  });
  const client = new Client({ name: "jpydf-integration-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.match(client.getInstructions(), /TEST_ONLY_NOT_FOR_PRODUCTION/);
    const { tools } = await client.listTools();
    const reads = sdkAgent.model.operationCatalog.filter(({ kind }) => kind === "read");
    assert.deepEqual(tools.map(({ name }) => name), reads.map(({ id }) => id));
    for (const [index, tool] of tools.entries()) {
      assert.deepEqual(tool.inputSchema, reads[index].inputSchema);
      assert.equal(tool.annotations.readOnlyHint, true);
    }
    for (const { id } of reads) {
      const input = id === "market.get" ? { branchId: 0 }
        : id === "liquidation.scan" ? { branchId: 0, maxIterations: 32, startId: "0" } : {};
      const response = await client.callTool({ name: id, arguments: input });
      const expected = await sdkAgent.model.invoke({ operation: id, input });
      assert.equal(response.isError, false);
      assert.deepEqual(response.structuredContent, expected);
      assert.deepEqual(JSON.parse(response.content[0].text), expected);
      assert.equal(expected.testOnly, true);
      assert.equal(expected.actor, ACCOUNT);
      assert.equal(expected.ok, true);
    }
    for (const [input, code] of [
      [{ branchId: 9 }, "UNKNOWN_BRANCH"],
      [{ branchId: 0, rpcUrl: "attacker-controlled" }, "INVALID_INPUT"],
    ]) {
      const response = await client.callTool({ name: "market.get", arguments: input });
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent.error.code, code);
    }
    const beforeDenied = calls.length;
    for (const name of ["earn.deposit", "transaction.finalize", "liquidation.execute", "lp.place"]) {
      await assert.rejects(client.callTool({ name, arguments: {} }), /Unknown read-only tool/);
    }
    assert.equal(calls.length, beforeDenied);
    harness.setOracleFailed(true);
    const failed = await client.callTool({ name: "market.get", arguments: { branchId: 0 } });
    assert.equal(calls.length, beforeDenied + 1);
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.structuredContent.error, {
      code: "ORACLE_UNAVAILABLE",
      message: failed.structuredContent.error.message,
      retryable: true,
      retryAfterMs: 12_000,
    });
    throwUnexpected = true;
    await assert.rejects(client.callTool({ name: "integration.get", arguments: {} }), (error) => {
      assert.match(error.message, /JPYdf read failed/);
      assert.doesNotMatch(error.message, /secret-rpc-credential/);
      return true;
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("agent rechecks host admission expiry before finalization", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const harness = createAgentRpcHarness();
    const expiring = createJpydfMainnetCanaryAgentClient({
      publicClient: harness.publicClient,
      deployment,
      scope: "mainnet-canary",
      account: ACCOUNT,
      authorizeFinalization: () => true,
      writeAdmission: {
        allowedOperations: ["earn.deposit"],
        allowedBranchIds: [0],
        allowedRewardModes: ["claim"],
        expiresAtMs: now + 100,
        maxAmountRaw: 10n,
        maxPendingAmountRaw: 10n,
      },
    });
    const prepared = await expiring.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "10", branchId: 0, claim: true },
    });
    now += 101;
    const expired = await expiring.host.finalize(prepared.data.revalidationId);
    assert.equal(expired.error.code, "POLICY_VIOLATION");
  } finally {
    Date.now = originalNow;
  }
});

test("agent rechecks host admission expiry after finalization RPC work", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const harness = createAgentRpcHarness();
    const expiring = createJpydfMainnetCanaryAgentClient({
      publicClient: harness.publicClient,
      deployment,
      scope: "mainnet-canary",
      account: ACCOUNT,
      authorizeFinalization: () => true,
      writeAdmission: {
        allowedOperations: ["earn.deposit"],
        allowedBranchIds: [0],
        allowedRewardModes: ["claim"],
        expiresAtMs: now + 100,
        maxAmountRaw: 10n,
        maxPendingAmountRaw: 10n,
      },
    });
    const prepared = await expiring.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "10", branchId: 0, claim: true },
    });
    harness.afterNextSimulation(() => now += 101);
    const expired = await expiring.host.finalize(prepared.data.revalidationId);
    assert.equal(expired.error.code, "POLICY_VIOLATION");
  } finally {
    Date.now = originalNow;
  }
});

test("agent binds the actor and rejects model-controlled transaction fields", async () => {
  const { harness, sdkAgent } = agent();
  const response = await sdkAgent.model.invoke({
    operation: "earn.deposit",
    input: { amountRaw: "12", branchId: 0, claim: true },
  });

  assert.equal(response.ok, true);
  assert.equal(response.environment, "mainnet-canary");
  assert.equal(response.testOnly, true);
  assert.equal(response.actor, ACCOUNT);
  assert.equal(response.data.validUntilBlock, "125");
  assert.equal("reference" in response.data, false);
  assert.equal("transaction" in response.data, false);
  assert.doesNotThrow(() => JSON.stringify(response));

  assert.equal("finalize" in sdkAgent.model, false);
  assert.equal("invoke" in sdkAgent.host, false);
  assert.ok(!sdkAgent.model.operationCatalog.some(({ id }) => id === "transaction.finalize"));
  const revalidated = await sdkAgent.host.finalize(response.data.revalidationId);
  assert.equal(revalidated.ok, true);
  assert.equal(revalidated.data.status, "ready-for-signature");
  assert.equal(revalidated.data.transaction.account, ACCOUNT);

  const forged = await sdkAgent.model.invoke({
    operation: "earn.deposit",
    input: { account: address(999), amountRaw: "12", branchId: 0, claim: true, to: address(998) },
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, "INVALID_INPUT");
  assert.equal(forged.error.retryable, false);

  const retryPrepared = await sdkAgent.model.invoke({
    operation: "earn.deposit",
    input: { amountRaw: "14", branchId: 0, claim: true },
  });
  harness.failNextSimulation();
  const failed = await sdkAgent.host.finalize(retryPrepared.data.revalidationId);
  assert.equal(failed.error.code, "SIMULATION_REVERTED");
  assert.equal(failed.error.retryable, false);
  const retried = await sdkAgent.host.finalize(retryPrepared.data.revalidationId);
  assert.equal(retried.ok, true);

  harness.failNextSimulation("StabilityPool: Coll gain claim must wait after deposit");
  const nextBlock = await sdkAgent.model.invoke({
    operation: "earn.deposit",
    input: { amountRaw: "1", branchId: 0, claim: true },
  });
  assert.equal(nextBlock.error.code, "NEXT_BLOCK_REQUIRED");
  assert.equal(nextBlock.error.retryable, true);
  assert.equal(nextBlock.error.retryAfterMs, 1_000);

  const overflow = await sdkAgent.model.invoke({
    operation: "earn.deposit",
    input: { amountRaw: (2n ** 256n).toString(), branchId: 0, claim: true },
  });
  assert.equal(overflow.error.code, "INVALID_INPUT");
});

test("agent rejects concurrent replay and bounds pending intents", async () => {
  const { sdkAgent } = agent();
  const prepared = await sdkAgent.model.invoke({
    operation: "earn.deposit",
    input: { amountRaw: "12", branchId: 0, claim: true },
  });
  const concurrent = await Promise.all([
    sdkAgent.host.finalize(prepared.data.revalidationId),
    sdkAgent.host.finalize(prepared.data.revalidationId),
  ]);
  assert.equal(concurrent.filter(({ ok }) => ok).length, 1);

  const { sdkAgent: bounded } = agent();
  for (let index = 0; index < 32; index++) {
    const result = await bounded.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: String(index + 1), branchId: 0, claim: true },
    });
    assert.equal(result.ok, true);
  }
  const limited = await bounded.model.invoke({
    operation: "earn.deposit",
    input: { amountRaw: "33", branchId: 0, claim: true },
  });
  assert.equal(limited.error.code, "RATE_LIMITED");
  assert.equal(limited.error.retryable, true);
  assert.ok(limited.error.retryAfterMs >= 1_000);
});

test("agent releases pending amount after finalization and intent expiry", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const harness = createAgentRpcHarness();
    const budgeted = createJpydfMainnetCanaryAgentClient({
      publicClient: harness.publicClient,
      deployment,
      scope: "mainnet-canary",
      account: ACCOUNT,
      authorizeFinalization: () => true,
      writeAdmission: {
        allowedOperations: ["earn.deposit"],
        allowedBranchIds: [0],
        allowedRewardModes: ["compound"],
        expiresAtMs: now + 20 * 60_000,
        maxAmountRaw: 10n,
        maxPendingAmountRaw: 10n,
      },
    });
    const first = await budgeted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "10", branchId: 0, claim: false },
    });
    assert.equal((await budgeted.host.finalize(first.data.revalidationId)).ok, true);

    const pending = await budgeted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "10", branchId: 0, claim: false },
    });
    assert.equal(pending.ok, true);
    assert.equal((await budgeted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "1", branchId: 0, claim: false },
    })).error.code, "POLICY_VIOLATION");

    now += 5 * 60_000 + 1;
    assert.equal((await budgeted.model.invoke({
      operation: "earn.deposit",
      input: { amountRaw: "10", branchId: 0, claim: false },
    })).ok, true);
  } finally {
    Date.now = originalNow;
  }
});

test("rejects a client connected to a non-mainnet chain", async () => {
  await assert.rejects(
    sdk(mockPublicClient({ chainId: 11155111 })).getBranches(),
    (error) => error instanceof JpydfSdkError && error.code === "WRONG_CHAIN",
  );
});
