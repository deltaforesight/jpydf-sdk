import type { PublicClient } from "viem";

import { productionMarketOf } from "./deployment.js";
import { JpydfSdkError } from "./errors.js";
import type { JpydfDeployment, JpydfPoolKey } from "./types.js";

const poolKeyAbi = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;
const stateViewAbi = [{
  type: "function", name: "getSlot0", stateMutability: "view",
  inputs: [{ name: "poolId", type: "bytes32" }],
  outputs: [
    { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
    { name: "protocolFee", type: "uint24" }, { name: "lpFee", type: "uint24" },
  ],
}, {
  type: "function", name: "getLiquidity", stateMutability: "view",
  inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ name: "liquidity", type: "uint128" }],
}] as const;
const quoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{
    name: "params", type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: poolKeyAbi },
      { name: "zeroForOne", type: "bool" },
      { name: "exactAmount", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

const UINT128_LIMIT = 1n << 128n;
const Q192 = 1n << 192n;

export type JpydfMarketToken = "JPYdf" | "USDC";

export type JpydfUsdcPoolState = {
  readonly observedAtBlock: bigint;
  readonly poolId: `0x${string}`;
  readonly poolKey: JpydfPoolKey;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly lpFee: number;
  readonly liquidity: bigint;
  /** JPYdf per USDC from the pool price, 18 decimals. This is the JPYdf market price, not the ¥1 reference or the oracle price. */
  readonly jpydfPerUsdcRaw: bigint;
};

export type JpydfUsdcQuote = {
  readonly observedAtBlock: bigint;
  readonly poolId: `0x${string}`;
  readonly tokenIn: JpydfMarketToken;
  readonly tokenOut: JpydfMarketToken;
  readonly amountInRaw: bigint;
  /** Quoted output including the pool fee and price impact at observedAtBlock. Not a guaranteed execution price. */
  readonly amountOutRaw: bigint;
  readonly gasEstimate: bigint;
};

async function pinnedBlock(publicClient: PublicClient): Promise<bigint> {
  const [chainId, blockNumber] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
  if (chainId !== 1) throw new JpydfSdkError("WRONG_CHAIN", `Connected chain ${chainId} does not match deployment chain 1`);
  return blockNumber;
}

/** Reads the JPYdf/USDC Uniswap v4 pool of the verified production deployment at one block. */
export async function getJpydfUsdcPool(input: { publicClient: PublicClient; deployment: JpydfDeployment }): Promise<JpydfUsdcPoolState> {
  const market = productionMarketOf(input.deployment);
  const blockNumber = await pinnedBlock(input.publicClient);
  const [[sqrtPriceX96, tick, , lpFee], liquidity] = await Promise.all([
    input.publicClient.readContract({ address: market.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [market.poolId], blockNumber }),
    input.publicClient.readContract({ address: market.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [market.poolId], blockNumber }),
  ]);
  if (sqrtPriceX96 === 0n) throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "The JPYdf/USDC pool is not initialized");
  // Raw pool price is currency1 per currency0 in base units; scale to whole JPYdf per whole USDC.
  const raw = sqrtPriceX96 * sqrtPriceX96;
  const usdcIsCurrency0 = market.poolKey.currency0 === market.usdc;
  const jpydfPerUsdcRaw = usdcIsCurrency0 ? raw * 10n ** 6n / Q192 : Q192 * 10n ** 6n / raw;
  return Object.freeze({
    observedAtBlock: blockNumber, poolId: market.poolId, poolKey: market.poolKey,
    sqrtPriceX96, tick, lpFee, liquidity, jpydfPerUsdcRaw,
  });
}

/** Quotes an exact-input JPYdf/USDC swap. Read-only: it returns no calldata and never signs or broadcasts. */
export async function quoteJpydfUsdc(input: {
  publicClient: PublicClient;
  deployment: JpydfDeployment;
  tokenIn: JpydfMarketToken;
  amountInRaw: bigint;
}): Promise<JpydfUsdcQuote> {
  const market = productionMarketOf(input.deployment);
  if (input.tokenIn !== "JPYdf" && input.tokenIn !== "USDC") throw new JpydfSdkError("INVALID_INPUT", "tokenIn must be JPYdf or USDC");
  if (typeof input.amountInRaw !== "bigint" || input.amountInRaw <= 0n || input.amountInRaw >= UINT128_LIMIT) {
    throw new JpydfSdkError("INVALID_INPUT", "amountInRaw must be a positive uint128");
  }
  const inAddress = input.tokenIn === "USDC" ? market.usdc : input.deployment.jpydfToken;
  const zeroForOne = market.poolKey.currency0 === inAddress;
  const blockNumber = await pinnedBlock(input.publicClient);
  let result;
  try {
    result = await input.publicClient.simulateContract({
      address: market.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: market.poolKey, zeroForOne, exactAmount: input.amountInRaw, hookData: "0x" }],
      blockNumber,
    });
  } catch (cause) {
    throw new JpydfSdkError("SIMULATION_REVERTED", "The JPYdf/USDC quote reverted; the pool may lack liquidity for this amount", { cause });
  }
  const [amountOutRaw, gasEstimate] = result.result;
  return Object.freeze({
    observedAtBlock: blockNumber, poolId: market.poolId, tokenIn: input.tokenIn,
    tokenOut: input.tokenIn === "USDC" ? "JPYdf" : "USDC", amountInRaw: input.amountInRaw, amountOutRaw, gasEstimate,
  });
}
