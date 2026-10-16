// Generated from frontend/df-shared/uniV4PositionMath.ts; do not edit.
const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const Q96 = 1n << 96n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function sqrtPriceX96AtTick(tick: number): bigint {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("tick is outside Uniswap bounds");
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 1n) === 0n
    ? 0x100000000000000000000000000000000n
    : 0xfffcb933bd6fad37aa2d162d1a594001n;
  const factors = [
    0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn,
    0xffe5caca7e10e4e61c3624eaa0941cd0n, 0xffcb9843d60f6159c9db58835c926644n,
    0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n,
    0xf987a7253ac413176f2b074cf7815e54n, 0xf3392b0822b70005940c7a398e4b70f3n,
    0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n,
    0x31be135f97d08fd981231505542fcfa6n, 0x9aa508b5b7a84e1c677de54f3e99bc9n,
    0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
    0x48a170391f7dc42444e8fa2n,
  ];
  for (let index = 0; index < factors.length; index += 1) {
    if ((absTick & (1n << BigInt(index + 1))) !== 0n) ratio = ratio * factors[index]! >> 128n;
  }
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + ((ratio & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
}

function amount0(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return ((liquidity << 96n) * (sqrtB - sqrtA) / sqrtB) / sqrtA;
}

function amount1(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return liquidity * (sqrtB - sqrtA) / Q96;
}

function amount0Up(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return ceilDiv(ceilDiv((liquidity << 96n) * (sqrtB - sqrtA), sqrtB), sqrtA);
}

function amount1Up(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return ceilDiv(liquidity * (sqrtB - sqrtA), Q96);
}

export function positionPrincipalDeltaAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidityDelta: bigint,
): { currency0Raw: bigint; currency1Raw: bigint } {
  const sign = liquidityDelta < 0n ? -1n : 1n;
  const liquidity = liquidityDelta < 0n ? -liquidityDelta : liquidityDelta;
  const lower = sqrtPriceX96AtTick(tickLower);
  const upper = sqrtPriceX96AtTick(tickUpper);
  const amounts = sqrtPriceX96 <= lower
    ? { currency0Raw: liquidityDelta > 0n ? amount0Up(lower, upper, liquidity) : amount0(lower, upper, liquidity), currency1Raw: 0n }
    : sqrtPriceX96 < upper
    ? {
      currency0Raw: liquidityDelta > 0n ? amount0Up(sqrtPriceX96, upper, liquidity) : amount0(sqrtPriceX96, upper, liquidity),
      currency1Raw: liquidityDelta > 0n ? amount1Up(lower, sqrtPriceX96, liquidity) : amount1(lower, sqrtPriceX96, liquidity),
    }
    : { currency0Raw: 0n, currency1Raw: liquidityDelta > 0n ? amount1Up(lower, upper, liquidity) : amount1(lower, upper, liquidity) };
  return { currency0Raw: amounts.currency0Raw * sign, currency1Raw: amounts.currency1Raw * sign };
}

export function positionPrincipalAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { currency0Raw: bigint; currency1Raw: bigint } {
  if (liquidity < 0n) throw new Error("position liquidity must be unsigned");
  const lower = sqrtPriceX96AtTick(tickLower);
  const upper = sqrtPriceX96AtTick(tickUpper);
  if (sqrtPriceX96 <= lower) return { currency0Raw: amount0(lower, upper, liquidity), currency1Raw: 0n };
  if (sqrtPriceX96 < upper) return {
    currency0Raw: amount0(sqrtPriceX96, upper, liquidity),
    currency1Raw: amount1(lower, sqrtPriceX96, liquidity),
  };
  return { currency0Raw: 0n, currency1Raw: amount1(lower, upper, liquidity) };
}
