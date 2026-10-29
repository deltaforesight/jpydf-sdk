import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createJpydfProductionAgentClient } from "../dist/agent.js";
import { createJpydfClient, getJpydfUsdcPool, loadMainnetStagingDeployment, loadProductionDeployment, quoteJpydfUsdc } from "../dist/index.js";

const descriptorJson = readFileSync(new URL("../descriptors/jpydf-production.json", import.meta.url), "utf8");

function fakeClient({ sqrtPriceX96 = 995296651386861809224766511815918038n, quote = [157_000n * 10n ** 18n, 120_000n], calls = [] } = {}) {
  return {
    calls,
    getChainId: async () => 1,
    getBlockNumber: async () => 100n,
    readContract: async (call) => {
      calls.push(call);
      if (call.functionName === "getSlot0") return [sqrtPriceX96, 326940, 0, 500];
      if (call.functionName === "getLiquidity") return 131036533088133481713n;
      throw new Error(`unexpected ${call.functionName}`);
    },
    simulateContract: async (call) => { calls.push(call); return { result: quote }; },
  };
}

test("production deployment loads only from the exact pinned descriptor bytes", async () => {
  const deployment = await loadProductionDeployment({ descriptorJson });
  assert.equal(deployment.deploymentScope, "production");
  assert.deepEqual(deployment.branches.map((b) => b.collSymbol), ["dwstETH", "dUSDC"]);
  await assert.rejects(loadProductionDeployment({ descriptorJson: descriptorJson + " " }), { code: "MANIFEST_MISMATCH" });
});

test("production client is read-only and quote-only", async () => {
  const deployment = await loadProductionDeployment({ descriptorJson });
  const client = createJpydfClient({ publicClient: fakeClient(), deployment, scope: "production" });
  assert.deepEqual(client.capabilities.swap, { available: "quote-only", reason: "NO_TRANSACTION_PREPARATION" });
  assert.equal(client.capabilities.earn.transactionPreparation, false);
  await assert.rejects(
    client.prepareEarnDeposit({ account: "0x0000000000000000000000000000000000000001", branchId: 1, amountRaw: 1n }),
    { code: "POLICY_VIOLATION" },
  );
  assert.throws(() => createJpydfClient({ publicClient: fakeClient(), deployment, scope: "mainnet-staging" }), { code: "UNSUPPORTED_DEPLOYMENT" });
});

test("pool state reports JPYdf per USDC from the pool price at one block", async () => {
  const deployment = await loadProductionDeployment({ descriptorJson });
  const pool = await getJpydfUsdcPool({ publicClient: fakeClient(), deployment });
  assert.equal(pool.observedAtBlock, 100n);
  assert.equal(pool.jpydfPerUsdcRaw / 10n ** 15n, 157_814n); // 157.814 JPYdf per USDC
  await assert.rejects(getJpydfUsdcPool({ publicClient: fakeClient({ sqrtPriceX96: 0n }), deployment }), { code: "UNSUPPORTED_DEPLOYMENT" });
});

test("quotes pick the swap direction from the pool ordering and reject bad amounts", async () => {
  const deployment = await loadProductionDeployment({ descriptorJson });
  const calls = [];
  const publicClient = fakeClient({ calls });
  const usdcIn = await quoteJpydfUsdc({ publicClient, deployment, tokenIn: "USDC", amountInRaw: 1_000_000n });
  assert.equal(usdcIn.tokenOut, "JPYdf");
  assert.equal(calls.at(-1).args[0].zeroForOne, true); // USDC is currency0
  await quoteJpydfUsdc({ publicClient, deployment, tokenIn: "JPYdf", amountInRaw: 10n ** 18n });
  assert.equal(calls.at(-1).args[0].zeroForOne, false);
  assert.equal(calls.at(-1).blockNumber, 100n);
  await assert.rejects(quoteJpydfUsdc({ publicClient, deployment, tokenIn: "JPYdf", amountInRaw: 0n }), { code: "INVALID_INPUT" });
  await assert.rejects(quoteJpydfUsdc({ publicClient, deployment, tokenIn: "ETH", amountInRaw: 1n }), { code: "INVALID_INPUT" });
});

test("test-only deployments have no production market", async () => {
  await assert.rejects(loadMainnetStagingDeployment({ manifestJson: "{}" }), { code: "MANIFEST_MISMATCH" });
});

test("production agent rejects write authority", async () => {
  const deployment = await loadProductionDeployment({ descriptorJson });
  for (const authority of [{ writeAdmission: {} }, { authorizeFinalization: () => true }]) {
    assert.throws(() => createJpydfProductionAgentClient({ publicClient: fakeClient(), deployment, scope: "production", account: "0x0000000000000000000000000000000000000001", ...authority }),
      (error) => error.code === "POLICY_VIOLATION");
  }
});
