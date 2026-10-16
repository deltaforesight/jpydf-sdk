import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getAddress } from "viem";
import { buildDescriptor, DESCRIPTOR_PATH, poolIdOf, PRODUCTION_MANIFEST_SHA256 } from "../scripts/build-production-descriptor.mjs";

const d = JSON.parse(readFileSync(DESCRIPTOR_PATH, "utf8"));

test("production descriptor is pinned to the reviewed manifest and the live JPYdf/USDC pool", () => {
  assert.equal(d.kind, "jpydf-public-deployment-descriptor");
  assert.equal(d.sourceManifestSha256, PRODUCTION_MANIFEST_SHA256);
  assert.deepEqual(d.branches.map((b) => [b.branchId, b.collSymbol]), [[0, "dwstETH"], [1, "dUSDC"]]);
  assert.equal(poolIdOf(d.uniswapV4.poolKey), d.uniswapV4.poolId);
  assert.equal(d.uniswapV4.poolId, "0x09a7a021c3bee7bb98ce64e17f060968ed0c95c4dde5a7136511bebf1c6a8370");
  assert.ok(BigInt(d.uniswapV4.poolKey.currency0) < BigInt(d.uniswapV4.poolKey.currency1));
  const addresses = JSON.stringify(d).match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g);
  for (const a of addresses) assert.equal(a, getAddress(a), `${a} must be checksummed`);
});

test("descriptor builder rejects any manifest other than the reviewed production bytes", () => {
  assert.throws(() => buildDescriptor('{"chainId":1}'), /not the reviewed production manifest/);
});
