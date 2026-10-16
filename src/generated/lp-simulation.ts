// Generated from frontend/df-shared/lp-simulation.ts; do not edit.
import { formatUnits, parseUnits } from "viem";
import { positionPrincipalAmounts, positionPrincipalDeltaAmounts, sqrtPriceX96AtTick } from "./uniV4PositionMath.js";

export type Inputs = {
  budget: string;
  fx: string;
  spot: string;
  lower: string;
  upper: string;
};

const Q192 = 1n << 192n;
const MAX_LIQUIDITY = (1n << 127n) - 1n;
const SIX = 1_000_000n;

export function decimal(value: string, label: string, max = 1_000_000): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || Number(value) <= 0 || Number(value) > max) {
    throw new Error(`${label}は0より大きく${max.toLocaleString("ja-JP")}以下、小数6桁以内で入力してください。`);
  }
  return Number(value);
}

function sqrt(value: bigint): bigint {
  let result = value;
  let next = (result + 1n) / 2n;
  while (next < result) {
    result = next;
    next = (result + value / result) / 2n;
  }
  return result;
}

// Model orientation: token0 = USDC (6 decimals), token1 = JPYdf (18).
// These ticks are for simulation, never calldata: real addresses determine token ordering.
function sqrtPrice(quote: string): bigint {
  return sqrt(parseUnits(quote, 6) * SIX * Q192);
}

function quoteAtTick(tick: number): number {
  const price = sqrtPriceX96AtTick(tick);
  return Number(price * price) / Number(Q192) / 1e12;
}

function roundedTick(quote: string, roundUp: boolean): number {
  const price = sqrtPrice(quote);
  let tick = Math.floor(Math.log(Number(quote) * 1e12) / Math.log(1.0001) / 10) * 10;
  // Integer comparisons decide the boundary; the logarithm is only a starting estimate.
  while (sqrtPriceX96AtTick(tick) > price) tick -= 10;
  while (sqrtPriceX96AtTick(tick + 10) <= price) tick += 10;
  return roundUp && sqrtPriceX96AtTick(tick) < price ? tick + 10 : tick;
}

function tokenAmounts(raw: { currency0Raw: bigint; currency1Raw: bigint }) {
  return { usdc: Number(formatUnits(raw.currency0Raw, 6)), jpydf: Number(formatUnits(raw.currency1Raw, 18)) };
}

export function makePlan(input: Inputs) {
  const budget = decimal(input.budget, "予算", 1_000_000_000_000);
  const fx = decimal(input.fx, "為替");
  const spot = decimal(input.spot, "交換比率");
  const lower = decimal(input.lower, "レンジ下限");
  const upper = decimal(input.upper, "レンジ上限");
  if (lower >= upper) throw new Error("レンジ上限は下限より大きくしてください。");
  const tickLower = roundedTick(input.lower, false);
  const tickUpper = roundedTick(input.upper, true);
  const price = sqrtPrice(input.spot);
  const budgetRaw = parseUnits(input.budget, 18);
  const fxRaw = parseUnits(input.fx, 6);
  const spotRaw = parseUnits(input.spot, 6);
  const deposit = (liquidity: bigint) => positionPrincipalDeltaAmounts(price, tickLower, tickUpper, liquidity);
  const cost = (liquidity: bigint) => {
    const amounts = deposit(liquidity);
    // Mark JPYdf at the entered market price fx / spot, USDC at fx (assumes USDC = USD 1).
    return amounts.currency0Raw * fxRaw * SIX + (amounts.currency1Raw * fxRaw + spotRaw - 1n) / spotRaw;
  };
  let low = 0n;
  let high = MAX_LIQUIDITY;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (cost(mid) <= budgetRaw) low = mid;
    else high = mid - 1n;
  }
  if (low === 0n) throw new Error("この予算では流動性を作れません。金額かレンジを変更してください。");
  const raw = deposit(low);
  const tokens = tokenAmounts(raw);
  return {
    input: { ...input },
    budget,
    fx,
    spot,
    tickLower,
    tickUpper,
    liquidity: low,
    lower: quoteAtTick(tickLower),
    upper: quoteAtTick(tickUpper),
    ...tokens,
    usdcRaw: raw.currency0Raw,
    jpydfRaw: raw.currency1Raw,
    usedBudget: Number(formatUnits(cost(low), 18)),
    usedBudgetRaw: cost(low),
    impliedJpydfJpy: fx / spot,
  };
}

export type Plan = ReturnType<typeof makePlan>;

export function scenario(plan: Plan, futureFx: number, futureJpydf: number) {
  decimal(String(futureFx), "将来の為替");
  decimal(String(futureJpydf), "将来のJPYdf価格", 10);
  const quote = Math.round(futureFx * 1e6) / Math.round(futureJpydf * 1e6);
  if (quote < 0.000001 || quote > 1_000_000) throw new Error("シナリオの交換比率が試算範囲外です。");
  const price = sqrtPrice(quote.toFixed(6));
  const tokens = tokenAmounts(positionPrincipalAmounts(price, plan.tickLower, plan.tickUpper, plan.liquidity));
  const value = tokens.usdc * futureFx + tokens.jpydf * futureJpydf;
  const hold = plan.usdc * futureFx + plan.jpydf * futureJpydf;
  const inRange = price >= sqrtPriceX96AtTick(plan.tickLower) && price < sqrtPriceX96AtTick(plan.tickUpper);
  const difference = value - hold;
  return {
    ...tokens,
    quote,
    value,
    hold,
    difference,
    differencePercent: hold > 0 ? difference / hold * 100 : 0,
    breakEvenFees: Math.max(0, -difference),
    pnl: value - plan.usedBudget,
    pnlPercent: (value - plan.usedBudget) / plan.usedBudget * 100,
    inRange,
  };
}
