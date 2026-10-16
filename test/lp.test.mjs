import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnits, formatUnits } from "viem";
import { simulateLp, createJpydfLpSimulationModel } from "../dist/lp.js";
import { makePlan, scenario } from "../dist/generated/lp-simulation.js";
const input = { budgetJpy: "100000", fxJpyPerUsd: "150", spotJpydfPerUsdc: "150", lowerJpydfPerUsdc: "142.5", upperJpydfPerUsdc: "157.5", futureFxJpyPerUsd: "150", futureJpydfJpy: "1" };
test("shared integer math bounds capital and compares the same basket", () => {
  for (const budgetJpy of ["1", "100000", "1000000000000"]) {
    const result = simulateLp({ ...input, budgetJpy });
    const plan = makePlan({ budget: budgetJpy, fx: "150", spot: "150", lower: "142.5", upper: "157.5" });
    assert.equal(result.initial.usdc.baseUnits, plan.usdcRaw.toString());
    assert.equal(result.initial.jpydf.decimal, formatUnits(plan.jpydfRaw, 18));
    assert.equal(result.future.lpValueJpy, scenario(plan, 150, 1).value);
    const invested = parseUnits(result.initial.investedJpy, 18);
    assert.ok(invested <= parseUnits(budgetJpy, 18));
    assert.equal(invested + parseUnits(result.initial.unusedBudgetJpy, 18), parseUnits(budgetJpy, 18));
    assert.ok(Math.abs(result.future.pnlVsInvestedJpy) < .001);
    assert.ok(result.initial.effectiveRange.lowerJpydfPerUsdc <= 142.5);
    assert.ok(result.initial.effectiveRange.upperJpydfPerUsdc >= 157.5);
  }
});
test("range exits and depegs underperform holding; fee break-even fills the gap", () => {
  for (const change of [{ futureFxJpyPerUsd: "120" }, { futureFxJpyPerUsd: "160" }, { futureJpydfJpy: "0.95" }, { futureFxJpyPerUsd: "153" }]) {
    const { future } = simulateLp({ ...input, ...change });
    assert.ok(future.deltaVsHoldingJpy <= .001);
    assert.ok(Math.abs(future.lpValueJpy + future.feeBreakEvenJpy - future.holdingInitialBasketJpy) < .001);
    if (change.futureFxJpyPerUsd === "120") assert.equal(future.jpydf, 0);
    if (change.futureFxJpyPerUsd === "160" || change.futureJpydfJpy) assert.equal(future.usdc, 0);
    for (const value of Object.values(future)) if (typeof value === "number") assert.ok(Number.isFinite(value));
  }
});
test("strict schemas reject missing, unknown, numeric, malformed and unbounded inputs", async () => {
  const model = createJpydfLpSimulationModel();
  const schema = model.operationCatalog[0].inputSchema;
  assert.equal(model.operationCatalog[0].kind, "simulation");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required.length, 7);
  for (const field of schema.required) {
    for (const bad of [undefined, 1, "0", "0.000000", "-1", "1e3", " 1", "1.0000001", "9".repeat(100), "Infinity"]) {
      const invalid = { ...input, [field]: bad };
      assert.throws(() => simulateLp(invalid), { code: "INVALID_INPUT" });
      const response = await model.invoke({ operation: "lp.simulate", input: invalid });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "INVALID_INPUT");
      assert.equal(response.error.retryable, false);
      if (typeof bad === "string") assert.equal(new RegExp(schema.properties[field].pattern).test(bad), false);
    }
  }
  for (const invalid of [{ ...input, ticks: [] }, { ...input, lowerJpydfPerUsdc: "160" }, { ...input, futureJpydfJpy: "0.000001" }, { ...input, futureJpydfJpy: "10.000001" }, { ...input, budgetJpy: "1000000000000.000001" }]) assert.throws(() => simulateLp(invalid), { code: "INVALID_INPUT" });
  for (const request of [[], null, { operation: "lp.other", input }, { operation: "lp.simulate", input, batch: [] }]) assert.equal((await model.invoke(request)).ok, false);
});
test("frozen model returns JSON-safe offline results without execution parameters", async () => {
  const model = createJpydfLpSimulationModel();
  assert.ok(Object.isFrozen(model));
  assert.ok(Object.isFrozen(model.operationCatalog));
  const response = await model.invoke({ operation: "lp.simulate", input });
  assert.equal(response.ok, true);
  assert.equal(response.operationId, "lp.simulate");
  assert.equal(response.data.simulationOnly, true);
  assert.equal(response.data.liveData, false);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), response);
  function check(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!["tickLower", "tickUpper", "liquidity", "calldata", "address", "addresses"].includes(key));
      check(child);
    }
  }
  check(response);
});
