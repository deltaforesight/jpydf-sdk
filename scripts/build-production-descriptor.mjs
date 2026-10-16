// Builds the sanitized public production descriptor (SDK-GOV-002 §1) from the reviewed production manifest.
// Usage: node scripts/build-production-descriptor.mjs <deployment-manifest.json>
// The descriptor holds only public on-chain identity; verify it with verify-production-descriptor.mjs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, zeroAddress } from "viem";

export const PRODUCTION_MANIFEST_SHA256 = "ac28e506b373762d67d6de2c3139f7c6fd95853fdd02aa0a328a3629a3747fd7";
export const DESCRIPTOR_PATH = new URL("../descriptors/jpydf-production.json", import.meta.url);
const PUBLIC_BRANCHES = ["dwstETH", "dUSDC"];
// Uniswap v4 Ethereum deployments (developers.uniswap.org/docs/protocols/v4/deployments).
const UNISWAP_V4 = {
  poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
  positionManager: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
  stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
  quoter: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203",
  universalRouter: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

export function poolIdOf(key) {
  return keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"),
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

export function buildDescriptor(manifestText) {
  const sha = createHash("sha256").update(manifestText).digest("hex");
  if (sha !== PRODUCTION_MANIFEST_SHA256) throw new Error(`manifest SHA-256 ${sha} is not the reviewed production manifest`);
  const m = JSON.parse(manifestText);
  if (m.chainId !== 1 || m.deploymentId !== "jpydf-production-candidate" || m.deploymentClassification !== "PRODUCTION_CANDIDATE") {
    throw new Error("manifest is not the production deployment");
  }
  const branches = PUBLIC_BRANCHES.map((collSymbol, branchId) => {
    const b = m.branches[branchId], y = m.dfYield[branchId];
    if (b.collSymbol !== collSymbol || getAddress(b.collToken) !== getAddress(y.dToken)) throw new Error(`branch ${branchId} mismatch`);
    return {
      branchId, collSymbol,
      addressesRegistry: getAddress(b.addressesRegistry), activePool: getAddress(b.activePool),
      borrowerOperations: getAddress(b.borrowerOperations), collateralVault: getAddress(y.collateralVault),
      collateralYieldZapper: getAddress(y.collateralYieldZapper), dToken: getAddress(b.collToken),
      jpyUsdRateProvider: getAddress(y.jpyUsdRateProvider), priceFeed: getAddress(b.priceFeed),
      sortedTroves: getAddress(b.sortedTroves), stabilityPool: getAddress(b.stabilityPool),
      troveManager: getAddress(b.troveManager), troveNFT: getAddress(b.troveNFT), underlyingToken: getAddress(y.underlying),
    };
  });
  for (let i = 2; i < m.dfYield.length; i++) {
    if (getAddress(m.dfYield[i].underlying) !== zeroAddress) throw new Error(`branch ${i} must remain inert`);
  }
  const jpydfToken = getAddress(m.jpydfToken);
  const [currency0, currency1] = BigInt(USDC) < BigInt(jpydfToken) ? [USDC, jpydfToken] : [jpydfToken, USDC];
  const poolKey = { currency0, currency1, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  const c = m.constants;
  return {
    schemaVersion: 1,
    kind: "jpydf-public-deployment-descriptor",
    chainId: 1,
    deploymentId: m.deploymentId,
    deploymentClassification: m.deploymentClassification,
    deploymentProfile: m.deploymentProfile,
    sourceManifestSha256: sha,
    jpydfToken,
    collateralRegistry: getAddress(m.collateralRegistry),
    hintHelpers: getAddress(m.hintHelpers),
    liquidationCandidateGetter: getAddress(m.liquidationCandidateGetter),
    protocolConstants: {
      minDebt: c.MIN_DEBT, ethGasCompensation: c.ETH_GAS_COMPENSATION, stabilityPoolYieldShare: c.SP_YIELD_SPLIT,
      minAnnualInterestRate: c.MIN_ANNUAL_INTEREST_RATE, maxAnnualInterestRate: c.MAX_ANNUAL_INTEREST_RATE,
    },
    branches,
    uniswapV4: { ...Object.fromEntries(Object.entries(UNISWAP_V4).map(([k, v]) => [k, getAddress(v)])), poolKey, poolId: poolIdOf(poolKey) },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const descriptor = buildDescriptor(readFileSync(process.argv[2], "utf8"));
  writeFileSync(DESCRIPTOR_PATH, JSON.stringify(descriptor, null, 2) + "\n");
  console.log(`wrote ${DESCRIPTOR_PATH.pathname} (poolId ${descriptor.uniswapV4.poolId})`);
}
