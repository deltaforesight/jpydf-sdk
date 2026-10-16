import { formatUnits, parseUnits } from "viem";
import { makePlan, scenario } from "./generated/lp-simulation.js";
import { JpydfSdkError } from "./errors.js";

export type JpydfLpSimulationInput = {
  budgetJpy: string;
  fxJpyPerUsd: string;
  spotJpydfPerUsdc: string;
  lowerJpydfPerUsdc: string;
  upperJpydfPerUsdc: string;
  futureFxJpyPerUsd: string;
  futureJpydfJpy: string;
};

const limits = {
  budgetJpy: 1_000_000_000_000,
  fxJpyPerUsd: 1_000_000,
  spotJpydfPerUsdc: 1_000_000,
  lowerJpydfPerUsdc: 1_000_000,
  upperJpydfPerUsdc: 1_000_000,
  futureFxJpyPerUsd: 1_000_000,
  futureJpydfJpy: 10,
} as const;
const properties = Object.fromEntries(Object.entries(limits).map(([key, max]) => {
  const digits = String(max).length - 2;
  return [key, Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: String(max).length + 7,
    pattern: `^(?!0(?:\\.0{1,6})?$)(?:(?:0|[1-9][0-9]{0,${digits}})(?:\\.[0-9]{1,6})?|${max}(?:\\.0{1,6})?)$`,
    description: `Positive decimal, at most ${max}, with at most six fractional digits.`,
  })];
}));
const inputSchema = Object.freeze({
  type: "object", additionalProperties: false,
  required: Object.freeze(Object.keys(limits)), properties: Object.freeze(properties),
});

function validate(input: unknown): asserts input is JpydfLpSimulationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new JpydfSdkError("INVALID_INPUT", "Expected one LP simulation input object.");
  }
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !Object.hasOwn(limits, key))) {
    throw new JpydfSdkError("INVALID_INPUT", "Unknown LP simulation input field.");
  }
  for (const [key, schema] of Object.entries(properties)) {
    const value = fields[key];
    if (!Object.hasOwn(fields, key) || typeof value !== "string" || value.length > schema.maxLength || !new RegExp(schema.pattern).test(value)) {
      throw new JpydfSdkError("INVALID_INPUT", `Invalid positive decimal input: ${key}.`);
    }
  }
  if (Number(fields.lowerJpydfPerUsdc) >= Number(fields.upperJpydfPerUsdc)) {
    throw new JpydfSdkError("INVALID_INPUT", "Upper range must exceed lower range.");
  }
  const quote = Math.round(Number(fields.futureFxJpyPerUsd) * 1e6) / Math.round(Number(fields.futureJpydfJpy) * 1e6);
  if (quote < 0.000001 || quote > 1_000_000) {
    throw new JpydfSdkError("INVALID_INPUT", "Future exchange ratio is outside the supported range.");
  }
}

export function simulateLp(input: JpydfLpSimulationInput) {
  validate(input);
  let plan;
  try {
    plan = makePlan({ budget: input.budgetJpy, fx: input.fxJpyPerUsd, spot: input.spotJpydfPerUsdc,
      lower: input.lowerJpydfPerUsdc, upper: input.upperJpydfPerUsdc });
  } catch {
    throw new JpydfSdkError("INVALID_INPUT", "The supplied budget and range cannot create a simulated position.");
  }
  const future = scenario(plan, Number(input.futureFxJpyPerUsd), Number(input.futureJpydfJpy));
  if (Object.values(future).some((value) => typeof value === "number" && !Number.isFinite(value))) {
    throw new Error("Non-finite simulation result");
  }
  return {
    simulationOnly: true as const,
    liveData: false as const,
    inputs: { ...input },
    assumptions: {
      prices: "user-entered" as const, usdcUsd: "1", modelTokenOrder: ["USDC", "JPYdf"] as const,
      tokenDecimals: { USDC: 6, JPYdf: 18 }, tickSpacing: 10,
      excluded: ["fees", "rewards", "gas", "rebalancing"] as const,
    },
    units: { money: "JPY", exchangeRatio: "JPYdf/USDC", tokenAmounts: "token", baseUnits: "integer strings" } as const,
    initial: {
      usdc: { baseUnits: plan.usdcRaw.toString(), decimal: formatUnits(plan.usdcRaw, 6) },
      jpydf: { baseUnits: plan.jpydfRaw.toString(), decimal: formatUnits(plan.jpydfRaw, 18) },
      investedJpy: formatUnits(plan.usedBudgetRaw, 18),
      unusedBudgetJpy: formatUnits(parseUnits(input.budgetJpy, 18) - plan.usedBudgetRaw, 18),
      effectiveRange: { lowerJpydfPerUsdc: plan.lower, upperJpydfPerUsdc: plan.upper },
    },
    future: {
      estimates: true as const, moneyUnit: "JPY" as const,
      usdc: future.usdc, jpydf: future.jpydf, jpydfPerUsdc: future.quote, inRange: future.inRange,
      lpValueJpy: future.value, holdingInitialBasketJpy: future.hold,
      deltaVsHoldingJpy: future.difference, deltaVsHoldingPercent: future.differencePercent,
      pnlVsInvestedJpy: future.pnl, pnlVsInvestedPercent: future.pnlPercent,
      feeBreakEvenJpy: future.breakEvenFees,
    },
  };
}
export type JpydfLpSimulationOutput = ReturnType<typeof simulateLp>;
export type JpydfLpSimulationResponse =
  | { ok: true; operationId: "lp.simulate"; data: JpydfLpSimulationOutput }
  | { ok: false; operationId: "lp.simulate" | "unknown"; error: { code: string; message: string; retryable: false } };

export function createJpydfLpSimulationModel() {
  return Object.freeze({
    operationCatalog: Object.freeze([Object.freeze({
      id: "lp.simulate" as const, kind: "simulation" as const,
      description: "Offline LP simulation using supplied prices; excludes fees, rewards, gas and rebalancing.", inputSchema,
    })]),
    async invoke(request: unknown): Promise<JpydfLpSimulationResponse> {
      let operationId: "lp.simulate" | "unknown" = "unknown";
      try {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          throw new JpydfSdkError("INVALID_INPUT", "Expected a simulation request.");
        }
        const fields = request as Record<string, unknown>;
        if (fields.operation === "lp.simulate") operationId = "lp.simulate";
        if (operationId === "unknown" || Object.keys(fields).some((key) => key !== "operation" && key !== "input")) {
          throw new JpydfSdkError("INVALID_INPUT", "Unsupported simulation request.");
        }
        validate(fields.input);
        return { ok: true, operationId, data: simulateLp(fields.input) };
      } catch (error) {
        return { ok: false, operationId, error: {
          code: error instanceof JpydfSdkError ? error.code : "SIMULATION_FAILED",
          message: error instanceof JpydfSdkError ? error.message : "LP simulation failed.", retryable: false,
        } };
      }
    },
  });
}
