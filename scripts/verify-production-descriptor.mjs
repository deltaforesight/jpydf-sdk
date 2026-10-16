// Verifies descriptors/jpydf-production.json against Ethereum mainnet at one pinned block (SDK-GOV-002 §1).
// Usage: RPC_URLS=https://a,https://b node scripts/verify-production-descriptor.mjs
// Every RPC must return identical results for the same block; any mismatch fails.
import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { DESCRIPTOR_PATH, poolIdOf } from "./build-production-descriptor.mjs";

const d = JSON.parse(readFileSync(DESCRIPTOR_PATH, "utf8"));
const urls = (process.env.RPC_URLS ?? "").split(",").filter(Boolean);
if (urls.length === 0) throw new Error("set RPC_URLS (comma-separated mainnet RPC URLs)");

const abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalCollaterals() view returns (uint256)",
  "function getToken(uint256) view returns (address)",
  "function getTroveManager(uint256) view returns (address)",
  "function borrowerOperations() view returns (address)",
  "function activePool() view returns (address)",
  "function stabilityPool() view returns (address)",
  "function troveManager() view returns (address)",
  "function sortedTroves() view returns (address)",
  "function priceFeed() view returns (address)",
  "function collToken() view returns (address)",
  "function troveNFT() view returns (address)",
  "function dToken() view returns (address)",
  "function underlying() view returns (address)",
  "function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)",
  "function collateralRegistry() view returns (address)",
  "function collateralVault() view returns (address)",
  "function source() view returns (address)",
  "function jpyUsdRateProvider() view returns (address)",
  "function poolManager() view returns (address)",
]);

async function readback(url, blockNumber) {
  const client = createPublicClient({ transport: http(url, { timeout: 30_000, retryCount: 2 }) });
  if (await client.getChainId() !== 1) throw new Error(`${url}: not Ethereum mainnet`);
  const block = blockNumber ?? (await client.getBlockNumber()) - 2n;
  const read = (address, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: block });
  const out = { block: block.toString(), blockHash: (await client.getBlock({ blockNumber: block })).hash, values: {} };
  const put = async (label, value) => { out.values[label] = typeof value === "string" && value.startsWith("0x") && value.length === 42 ? getAddress(value) : String(await value); };
  const code = new Set([d.jpydfToken, d.collateralRegistry, d.hintHelpers, d.liquidationCandidateGetter,
    ...Object.values(d.uniswapV4).filter((v) => typeof v === "string" && v.length === 42),
    ...d.branches.flatMap((b) => Object.values(b).filter((v) => typeof v === "string" && v.startsWith("0x")))]);
  for (const address of code) out.values[`code:${address}`] = String(((await client.getCode({ address, blockNumber: block })) ?? "0x").length > 2);
  await put("jpydf.symbol", read(d.jpydfToken, "symbol"));
  await put("jpydf.decimals", read(d.jpydfToken, "decimals"));
  await put("registry.totalCollaterals", read(d.collateralRegistry, "totalCollaterals"));
  for (const b of d.branches) {
    const i = BigInt(b.branchId);
    out.values[`registry.token.${b.branchId}`] = getAddress(await read(d.collateralRegistry, "getToken", [i]));
    out.values[`registry.troveManager.${b.branchId}`] = getAddress(await read(d.collateralRegistry, "getTroveManager", [i]));
    for (const f of ["borrowerOperations", "activePool", "stabilityPool", "troveManager", "sortedTroves", "priceFeed", "collToken", "troveNFT"]) {
      out.values[`branch.${b.branchId}.${f}`] = getAddress(await read(b.addressesRegistry, f));
    }
    out.values[`vault.${b.branchId}.dToken`] = getAddress(await read(b.collateralVault, "dToken"));
    out.values[`vault.${b.branchId}.underlying`] = getAddress(await read(b.collateralVault, "underlying"));
  }
  out.values["hintHelpers.collateralRegistry"] = getAddress(await read(d.hintHelpers, "collateralRegistry"));
  out.values["liquidationCandidateGetter.collateralRegistry"] = getAddress(await read(d.liquidationCandidateGetter, "collateralRegistry"));
  for (const b of d.branches) {
    for (const f of ["collateralVault", "dToken", "borrowerOperations"]) {
      out.values[`zapper.${b.branchId}.${f}`] = getAddress(await read(b.collateralYieldZapper, f));
    }
    const source = await read(b.priceFeed, "source");
    out.values[`priceFeed.${b.branchId}.jpyUsdRateProvider`] = getAddress(await read(source, "jpyUsdRateProvider"));
  }
  for (const f of ["positionManager", "stateView", "quoter", "universalRouter"]) {
    out.values[`uniswapV4.${f}.poolManager`] = getAddress(await read(d.uniswapV4[f], "poolManager"));
  }
  out.values["pool.sqrtPriceX96"] = String((await read(d.uniswapV4.stateView, "getSlot0", [d.uniswapV4.poolId]))[0]);
  return out;
}

const failures = [];
const expect = (label, actual, expected) => { if (actual !== expected) failures.push(`${label}: ${actual} != ${expected}`); };
const first = await readback(urls[0]);
for (const url of urls.slice(1)) {
  const other = await readback(url, BigInt(first.block));
  if (JSON.stringify(other) !== JSON.stringify(first)) failures.push(`${url}: differs from ${urls[0]} at block ${first.block}`);
}
const v = first.values;
for (const [k, value] of Object.entries(v)) if (k.startsWith("code:")) expect(k, value, "true");
expect("jpydf.symbol", v["jpydf.symbol"], "JPYdf");
expect("jpydf.decimals", v["jpydf.decimals"], "18");
expect("registry.totalCollaterals", v["registry.totalCollaterals"], "8");
for (const b of d.branches) {
  expect(`registry.token.${b.branchId}`, v[`registry.token.${b.branchId}`], b.dToken);
  expect(`registry.troveManager.${b.branchId}`, v[`registry.troveManager.${b.branchId}`], b.troveManager);
  for (const f of ["borrowerOperations", "activePool", "stabilityPool", "troveManager", "sortedTroves", "priceFeed", "troveNFT"]) {
    expect(`branch.${b.branchId}.${f}`, v[`branch.${b.branchId}.${f}`], b[f]);
  }
  expect(`branch.${b.branchId}.collToken`, v[`branch.${b.branchId}.collToken`], b.dToken);
  expect(`vault.${b.branchId}.dToken`, v[`vault.${b.branchId}.dToken`], b.dToken);
  expect(`vault.${b.branchId}.underlying`, v[`vault.${b.branchId}.underlying`], b.underlyingToken);
}
expect("hintHelpers.collateralRegistry", v["hintHelpers.collateralRegistry"], d.collateralRegistry);
expect("liquidationCandidateGetter.collateralRegistry", v["liquidationCandidateGetter.collateralRegistry"], d.collateralRegistry);
for (const b of d.branches) {
  expect(`zapper.${b.branchId}.collateralVault`, v[`zapper.${b.branchId}.collateralVault`], b.collateralVault);
  expect(`zapper.${b.branchId}.dToken`, v[`zapper.${b.branchId}.dToken`], b.dToken);
  expect(`zapper.${b.branchId}.borrowerOperations`, v[`zapper.${b.branchId}.borrowerOperations`], b.borrowerOperations);
  expect(`priceFeed.${b.branchId}.jpyUsdRateProvider`, v[`priceFeed.${b.branchId}.jpyUsdRateProvider`], b.jpyUsdRateProvider);
}
for (const f of ["positionManager", "stateView", "quoter", "universalRouter"]) {
  expect(`uniswapV4.${f}.poolManager`, v[`uniswapV4.${f}.poolManager`], d.uniswapV4.poolManager);
}
expect("uniswapV4.poolId", poolIdOf(d.uniswapV4.poolKey), d.uniswapV4.poolId);
if (v["pool.sqrtPriceX96"] === "0") failures.push("pool is not initialized");

const result = { result: failures.length ? "FAIL" : "PASS", descriptorSourceManifestSha256: d.sourceManifestSha256, block: first.block, blockHash: first.blockHash, rpcCount: urls.length, checks: Object.keys(v).length + 2, failures };
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
