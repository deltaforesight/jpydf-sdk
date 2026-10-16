import {
  type Address,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  isAddress,
  keccak256,
  type PublicClient,
  zeroAddress,
} from "viem";

import { JpydfSdkError } from "./errors.js";
import { sha256Text } from "./deployment.js";
import type { JpydfDeployment } from "./types.js";

export const MAINNET_CANARY_UNIV4_ROUTE_IDENTITY = Object.freeze(
  {
    routeSha256: "426d6f80633bfd75073269ebe312fb82c76db47cb4abb1ff1c158bf8cd1fc7ed",
    poolId: "0x7215ba7b5b7a06ed9b5e58770d9f83b55ff5467b088ed0f2a5ee05a6d36e21b1" as Hex,
    fee: 500,
    tickSpacing: 10,
  } as const,
);

export type MainnetCanaryUniV4Route = {
  readonly schemaVersion: 1;
  readonly classification: "MAINNET_CANARY_UNIV4_MANUAL_WALLET_SMOKE_ROUTE";
  readonly chainId: 1;
  readonly deploymentId: "jpydf-mainnet-persistent-canary-v2-2026-08";
  readonly manifestSha256: "c534e0b2af71ec9300d65a4d3862d82883bcffe1f6c03ce6d69244072a3baddf";
  readonly poolKey: {
    readonly currency0: Address;
    readonly currency1: Address;
    readonly fee: 500;
    readonly tickSpacing: 10;
    readonly hooks: Address;
    readonly poolId: Hex;
  };
  readonly quoter: Address;
  readonly universalRouter: Address;
  readonly permit2: Address;
};

const verifiedRoutes = new WeakSet<MainnetCanaryUniV4Route>();

const MIN_SMOKE_AMOUNT = 10n ** 17n;
const MAX_SMOKE_AMOUNT = 10n ** 18n;
const MAX_DEADLINE_SECONDS = 600n;
const SLIPPAGE_BPS = 10n;
const BPS = 10_000n;
const V4_SWAP_COMMAND = "0x10" as Hex;
const V4_ACTIONS = "0x060c0f" as Hex;

const poolKeyAbi = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;
const exactInputSingleAbi = [{
  type: "tuple",
  components: [
    { name: "poolKey", type: "tuple", components: poolKeyAbi },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ],
}] as const;
const permit2Abi = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "token", type: "address" },
    { name: "spender", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
  ],
  outputs: [],
}, {
  type: "function",
  name: "allowance",
  stateMutability: "view",
  inputs: [
    { name: "owner", type: "address" },
    { name: "token", type: "address" },
    { name: "spender", type: "address" },
  ],
  outputs: [
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
}] as const;
const quoterAbi = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "view",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: poolKeyAbi },
      { name: "zeroForOne", type: "bool" },
      { name: "exactAmount", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  }],
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "gasEstimate", type: "uint256" },
  ],
}] as const;
const universalRouterAbi = [{
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [
    { name: "commands", type: "bytes" },
    { name: "inputs", type: "bytes[]" },
    { name: "deadline", type: "uint256" },
  ],
  outputs: [],
}] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function routeAddress(value: unknown, label: string, allowZero = false): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be a valid address`);
  }
  const result = getAddress(value);
  if (!allowZero && result === zeroAddress) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must not be zero`);
  }
  return result;
}

function routeValue<T>(actual: unknown, expected: T, label: string): T {
  if (actual !== expected) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", `${label} does not match the pinned UniV4 route`);
  }
  return expected;
}

export async function loadMainnetCanaryUniV4Route(input: { routeJson: string }): Promise<MainnetCanaryUniV4Route> {
  if (typeof input?.routeJson !== "string" || input.routeJson.length === 0) {
    throw new JpydfSdkError("INVALID_INPUT", "routeJson must be a non-empty string");
  }
  if (await sha256Text(input.routeJson) !== MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.routeSha256) {
    throw new JpydfSdkError("MANIFEST_MISMATCH", "UniV4 route SHA-256 does not match the package-pinned route");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.routeJson);
  } catch (cause) {
    throw new JpydfSdkError("INVALID_INPUT", "routeJson must contain valid JSON", { cause });
  }
  const route = record(parsed, "route");
  const sourcePoolKey = record(route.poolKey, "route.poolKey");
  const poolKey = Object.freeze({
    currency0: routeAddress(sourcePoolKey.currency0, "route.poolKey.currency0"),
    currency1: routeAddress(sourcePoolKey.currency1, "route.poolKey.currency1"),
    fee: routeValue(sourcePoolKey.fee, MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.fee, "route.poolKey.fee"),
    tickSpacing: routeValue(
      sourcePoolKey.tickSpacing,
      MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.tickSpacing,
      "route.poolKey.tickSpacing",
    ),
    hooks: routeAddress(sourcePoolKey.hooks, "route.poolKey.hooks", true),
    poolId: routeValue(
      typeof sourcePoolKey.poolId === "string" ? sourcePoolKey.poolId.toLowerCase() : sourcePoolKey.poolId,
      MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.poolId,
      "route.poolKey.poolId",
    ),
  });
  if (poolKey.hooks !== zeroAddress || BigInt(poolKey.currency0) >= BigInt(poolKey.currency1)) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "UniV4 route must be no-hook and address-sorted");
  }
  const derivedPoolId = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  ));
  if (derivedPoolId !== poolKey.poolId) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "UniV4 route PoolKey does not derive the pinned pool ID");
  }
  const result = Object.freeze({
    schemaVersion: routeValue(route.schemaVersion, 1, "route.schemaVersion"),
    classification: routeValue(
      route.classification,
      "MAINNET_CANARY_UNIV4_MANUAL_WALLET_SMOKE_ROUTE",
      "route.classification",
    ),
    chainId: routeValue(route.chainId, 1, "route.chainId"),
    deploymentId: routeValue(
      route.deploymentId,
      "jpydf-mainnet-persistent-canary-v2-2026-08",
      "route.deploymentId",
    ),
    manifestSha256: routeValue(
      route.manifestSha256,
      "c534e0b2af71ec9300d65a4d3862d82883bcffe1f6c03ce6d69244072a3baddf",
      "route.manifestSha256",
    ),
    poolKey,
    quoter: routeAddress(route.quoter, "route.quoter"),
    universalRouter: routeAddress(route.universalRouter, "route.universalRouter"),
    permit2: routeAddress(route.permit2, "route.permit2"),
  });
  verifiedRoutes.add(result);
  return result;
}

export type MainnetCanaryUniV4SmokePackage = {
  readonly classification: "MAINNET_CANARY_UNIV4_WALLET_SMOKE_UNSIGNED";
  readonly mainnetBroadcastAuthorized: false;
  readonly account: Address;
  readonly observedAtBlock: bigint;
  readonly observedAtBlockHash: Hex;
  readonly deadline: bigint;
  readonly routeSha256: typeof MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.routeSha256;
  readonly poolKey: MainnetCanaryUniV4Route["poolKey"];
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly amountOutMinimum: bigint;
  readonly quoterGasEstimate: bigint;
  readonly maximumFeePerGasWei: 4_000_000_000n;
  readonly maximumTotalGasWei: 1_560_000_000_000_000n;
  readonly transactions: readonly [
    {
      readonly label: "test-df approve Permit2";
      readonly to: Address;
      readonly value: 0n;
      readonly gasLimit: 80_000n;
      readonly data: Hex;
    },
    {
      readonly label: "Permit2 approve Universal Router";
      readonly to: Address;
      readonly value: 0n;
      readonly gasLimit: 80_000n;
      readonly data: Hex;
    },
    {
      readonly label: "sell test-df through fixed UniV4 pool";
      readonly to: Address;
      readonly value: 0n;
      readonly gasLimit: 230_000n;
      readonly data: Hex;
    },
  ];
};

function poolKey(route: MainnetCanaryUniV4Route) {
  return route.poolKey;
}

function assertFixedDeployment(deployment: JpydfDeployment, route: MainnetCanaryUniV4Route): void {
  if (!verifiedRoutes.has(route)) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "UniV4 route must come from loadMainnetCanaryUniV4Route");
  }
  if (
    deployment.deploymentId !== route.deploymentId
    || deployment.manifestSha256 !== route.manifestSha256
    || deployment.jpydfToken !== route.poolKey.currency0
    || deployment.branches.find(({ branchId }) => branchId === 1)?.underlyingToken.toLowerCase()
      !== route.poolKey.currency1.toLowerCase()
  ) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "Deployment does not match the retained test-df/USDC pool");
  }
}

function buildSwapCalldata(
  route: MainnetCanaryUniV4Route,
  amountIn: bigint,
  amountOutMinimum: bigint,
  deadline: bigint,
): Hex {
  const key = poolKey(route);
  const actionParams = [
    encodeAbiParameters(exactInputSingleAbi, [{
      poolKey: key,
      zeroForOne: true,
      amountIn,
      amountOutMinimum,
      hookData: "0x",
    }]),
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [key.currency0, amountIn],
    ),
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [key.currency1, amountOutMinimum],
    ),
  ];
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [
      V4_SWAP_COMMAND,
      [encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [V4_ACTIONS, actionParams])],
      deadline,
    ],
  });
}

export function decodeMainnetCanaryUniV4Swap(route: MainnetCanaryUniV4Route, data: Hex) {
  if (!verifiedRoutes.has(route)) throw new Error("UniV4 route is not package-verified");
  const decoded = decodeFunctionData({ abi: universalRouterAbi, data });
  if (decoded.functionName !== "execute") throw new Error("calldata is not Universal Router execute");
  const [commands, inputs, deadline] = decoded.args;
  if (commands !== V4_SWAP_COMMAND || inputs.length !== 1) throw new Error("calldata is not a single V4 swap command");
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]!);
  if (actions !== V4_ACTIONS || params.length !== 3) {
    throw new Error("calldata does not use the exact-input fixed-pool action set");
  }
  const [swap] = decodeAbiParameters(exactInputSingleAbi, params[0]!);
  const expected = poolKey(route);
  if (
    swap.poolKey.currency0 !== expected.currency0
    || swap.poolKey.currency1 !== expected.currency1
    || swap.poolKey.fee !== expected.fee
    || swap.poolKey.tickSpacing !== expected.tickSpacing
    || swap.poolKey.hooks !== expected.hooks
    || !swap.zeroForOne
    || swap.hookData !== "0x"
  ) {
    throw new Error("calldata PoolKey or direction does not match the retained test-df/USDC pool");
  }
  return {
    deadline,
    poolId: route.poolKey.poolId,
    poolKey: expected,
    amountIn: swap.amountIn,
    amountOutMinimum: swap.amountOutMinimum,
  } as const;
}

export async function prepareMainnetCanaryUniV4WalletSmoke(
  publicClient: PublicClient,
  deployment: JpydfDeployment,
  input: { account: Address; amountIn: bigint; deadline: bigint; route: MainnetCanaryUniV4Route },
): Promise<MainnetCanaryUniV4SmokePackage> {
  assertFixedDeployment(deployment, input.route);
  if (!isAddress(input.account) || getAddress(input.account) === zeroAddress) {
    throw new JpydfSdkError("INVALID_INPUT", "Wallet smoke account must be a nonzero address");
  }
  const account = getAddress(input.account);
  if (input.amountIn < MIN_SMOKE_AMOUNT || input.amountIn > MAX_SMOKE_AMOUNT) {
    throw new JpydfSdkError("POLICY_VIOLATION", "Wallet smoke amount must be between 0.1 and 1 test-df");
  }
  const [chainId, block] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlock({ blockTag: "latest" }),
  ]);
  if (chainId !== 1) throw new JpydfSdkError("WRONG_CHAIN", `Connected chain ${chainId} is not Ethereum mainnet`);
  if (block.number === null || block.hash === null) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "The latest block is incomplete");
  }
  if (input.deadline <= block.timestamp || input.deadline > block.timestamp + MAX_DEADLINE_SECONDS) {
    throw new JpydfSdkError("POLICY_VIOLATION", "Wallet smoke deadline must be within 10 minutes of the quote block");
  }
  const key = poolKey(input.route);
  const [[quotedAmountOut, quoterGasEstimate], balance, erc20Allowance, permit2Allowance] = await Promise.all([
    publicClient.readContract({
      address: input.route.quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne: true, exactAmount: input.amountIn, hookData: "0x" }],
      blockNumber: block.number,
    }),
    publicClient.readContract({
      address: key.currency0,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
      blockNumber: block.number,
    }),
    publicClient.readContract({
      address: key.currency0,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, input.route.permit2],
      blockNumber: block.number,
    }),
    publicClient.readContract({
      address: input.route.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [account, key.currency0, input.route.universalRouter],
      blockNumber: block.number,
    }),
  ]);
  const canonical = await publicClient.getBlock({ blockNumber: block.number });
  if (canonical.hash === null || canonical.hash !== block.hash) {
    throw new JpydfSdkError("STALE_BLOCK", "The UniV4 quote block was reorganized; prepare it again", {
      retryAfterMs: 1_000,
    });
  }
  if (balance < input.amountIn) {
    throw new JpydfSdkError("POLICY_VIOLATION", "Wallet does not hold the quoted test-df input amount");
  }
  if (erc20Allowance !== 0n || permit2Allowance[0] !== 0n) {
    throw new JpydfSdkError("POLICY_VIOLATION", "Wallet smoke requires zero pre-existing Permit2 allowances");
  }
  const amountOutMinimum = quotedAmountOut * (BPS - SLIPPAGE_BPS) / BPS;
  if (quotedAmountOut <= 0n || amountOutMinimum <= 0n) {
    throw new JpydfSdkError("SIMULATION_REVERTED", "The retained UniV4 pool returned an empty quote");
  }
  const swapData = buildSwapCalldata(input.route, input.amountIn, amountOutMinimum, input.deadline);
  decodeMainnetCanaryUniV4Swap(input.route, swapData);
  return {
    classification: "MAINNET_CANARY_UNIV4_WALLET_SMOKE_UNSIGNED",
    mainnetBroadcastAuthorized: false,
    account,
    observedAtBlock: block.number,
    observedAtBlockHash: block.hash,
    deadline: input.deadline,
    routeSha256: MAINNET_CANARY_UNIV4_ROUTE_IDENTITY.routeSha256,
    poolKey: input.route.poolKey,
    amountIn: input.amountIn,
    quotedAmountOut,
    amountOutMinimum,
    quoterGasEstimate,
    maximumFeePerGasWei: 4_000_000_000n,
    maximumTotalGasWei: 1_560_000_000_000_000n,
    transactions: [
      {
        label: "test-df approve Permit2",
        to: key.currency0,
        value: 0n,
        gasLimit: 80_000n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [input.route.permit2, input.amountIn],
        }),
      },
      {
        label: "Permit2 approve Universal Router",
        to: input.route.permit2,
        value: 0n,
        gasLimit: 80_000n,
        data: encodeFunctionData({
          abi: permit2Abi,
          functionName: "approve",
          args: [
            key.currency0,
            input.route.universalRouter,
            input.amountIn,
            Number(input.deadline),
          ],
        }),
      },
      {
        label: "sell test-df through fixed UniV4 pool",
        to: input.route.universalRouter,
        value: 0n,
        gasLimit: 230_000n,
        data: swapData,
      },
    ],
  };
}
