import { type Address, getAddress, isAddress, zeroAddress } from "viem";

import { JpydfSdkError } from "./errors.js";
import type { JpydfBranchDeployment, JpydfDeployment } from "./types.js";

export const MAINNET_CANARY_IDENTITY = Object.freeze(
  {
    chainId: 1,
    deploymentClassification: "TEST_ONLY_NOT_FOR_PRODUCTION",
    deploymentProfile: "mainnet-persistent-canary-v2-min-debt-1000",
    deploymentId: "jpydf-mainnet-persistent-canary-v2-2026-08",
    deploymentScope: "mainnet-canary",
    deploymentMode: "complete",
    create2Salt: "0x6ea17b1accc940857615c85844fca690284fa6cb6a90f3a9812845d3fbc77aaf",
    manifestSha256: "c534e0b2af71ec9300d65a4d3862d82883bcffe1f6c03ce6d69244072a3baddf",
    ethGasCompensation: "37500000000000000",
    maxAnnualInterestRate: "2500000000000000000",
    minAnnualInterestRate: "5000000000000000",
    minDebt: "1000000000000000000000",
    spYieldSplit: "750000000000000000",
  } as const,
);

export const MAINNET_STAGING_IDENTITY = Object.freeze({
  chainId: 1,
  deploymentClassification: "TEST_ONLY_NOT_FOR_PRODUCTION",
  deploymentProfile: "mainnet-staging",
  deploymentId: "jpydf-mainnet-staging-20260924-01",
  deploymentScope: "mainnet-staging",
  deploymentMode: "use-existing-jpydf",
  create2Salt: "0x0fa6b79ae8cc7c43db842f68c47a78be829f7933edbdef8cc674e4f576baab32",
  manifestSha256: "285d0d55884e38805537282faa3f82188c74dbb1f85450f971fcfdbf66d2008e",
  ethGasCompensation: "37500000000000000",
  maxAnnualInterestRate: "2500000000000000000",
  minAnnualInterestRate: "5000000000000000",
  minDebt: "100000000000000000000000",
  spYieldSplit: "750000000000000000",
} as const);

const PUBLIC_BRANCH_SYMBOLS = ["dwstETH", "dUSDC"] as const;
const verifiedDeployments = new WeakSet<JpydfDeployment>();

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function address(value: unknown, label: string, allowZero = false): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must be a valid address`);
  }
  const result = getAddress(value);
  if (!allowZero && result === zeroAddress) {
    throw new JpydfSdkError("INVALID_INPUT", `${label} must not be the zero address`);
  }
  return result;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", `${label} does not match the pinned deployment`);
  }
}

export async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "SHA-256 is unavailable in this runtime");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function loadMainnetCanaryDeployment(input: { manifestJson: string }): Promise<JpydfDeployment> {
  return loadPinnedDeployment(input, MAINNET_CANARY_IDENTITY);
}

export function loadMainnetStagingDeployment(input: { manifestJson: string }): Promise<JpydfDeployment> {
  return loadPinnedDeployment(input, MAINNET_STAGING_IDENTITY);
}

async function loadPinnedDeployment(
  input: { manifestJson: string },
  identity: typeof MAINNET_CANARY_IDENTITY | typeof MAINNET_STAGING_IDENTITY,
): Promise<JpydfDeployment> {
  if (typeof input?.manifestJson !== "string" || input.manifestJson.length === 0) {
    throw new JpydfSdkError("INVALID_INPUT", "manifestJson must be a non-empty string");
  }
  if (await sha256Text(input.manifestJson) !== identity.manifestSha256) {
    throw new JpydfSdkError(
      "MANIFEST_MISMATCH",
      "The deployment manifest SHA-256 does not match the package-pinned deployment",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.manifestJson);
  } catch (cause) {
    throw new JpydfSdkError("INVALID_INPUT", "manifestJson must contain valid JSON", { cause });
  }
  const manifest = record(parsed, "manifest");
  equal(manifest.chainId, identity.chainId, "chainId");
  equal(
    manifest.deploymentClassification,
    identity.deploymentClassification,
    "deploymentClassification",
  );
  equal(manifest.deploymentProfile, identity.deploymentProfile, "deploymentProfile");
  equal(manifest.deploymentId, identity.deploymentId, "deploymentId");
  equal(manifest.deploymentMode, identity.deploymentMode, "deploymentMode");
  equal(
    typeof manifest.create2Salt === "string" ? manifest.create2Salt.toLowerCase() : manifest.create2Salt,
    identity.create2Salt,
    "create2Salt",
  );
  if (Object.hasOwn(manifest, "mainnetPilotController")) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "Test deployment must not contain a pilot controller");
  }
  const deployer = address(manifest.deployer, "deployer");
  const bridgeAdmin = address(manifest.bridgeAdmin, "bridgeAdmin");
  if (deployer === bridgeAdmin) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "bridgeAdmin must differ from deployer");
  }
  const constants = record(manifest.constants, "constants");
  equal(constants.MIN_DEBT, identity.minDebt, "MIN_DEBT");
  equal(constants.SP_YIELD_SPLIT, identity.spYieldSplit, "SP_YIELD_SPLIT");
  equal(
    constants.ETH_GAS_COMPENSATION,
    identity.ethGasCompensation,
    "ETH_GAS_COMPENSATION",
  );
  equal(
    constants.MIN_ANNUAL_INTEREST_RATE,
    identity.minAnnualInterestRate,
    "MIN_ANNUAL_INTEREST_RATE",
  );
  equal(
    constants.MAX_ANNUAL_INTEREST_RATE,
    identity.maxAnnualInterestRate,
    "MAX_ANNUAL_INTEREST_RATE",
  );
  const launchEvidence = record(manifest.launchEvidence, "launchEvidence");
  equal(launchEvidence.uniswapV4RouteStatus, "unwired-audit-scope", "uniswapV4RouteStatus");

  if (!Array.isArray(manifest.branches) || manifest.branches.length !== 8) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "Test deployment must contain exactly 8 branches");
  }
  if (!Array.isArray(manifest.dfYield) || manifest.dfYield.length !== 8) {
    throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", "Test deployment must contain exactly 8 yield entries");
  }
  const manifestBranches = manifest.branches;
  const manifestYield = manifest.dfYield;
  const branches: JpydfBranchDeployment[] = PUBLIC_BRANCH_SYMBOLS.map((collSymbol, branchId) => {
    const branch = record(manifestBranches[branchId], `branches[${branchId}]`);
    const yieldEntry = record(manifestYield[branchId], `dfYield[${branchId}]`);
    equal(branch.collSymbol, collSymbol, `branches[${branchId}].collSymbol`);
    const collToken = address(branch.collToken, `branches[${branchId}].collToken`);
    if (collToken !== address(yieldEntry.dToken, `dfYield[${branchId}].dToken`)) {
      throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", `branch ${branchId} dToken does not match collToken`);
    }
    return Object.freeze({
      activePool: address(branch.activePool, `branches[${branchId}].activePool`),
      branchId,
      borrowerOperations: address(branch.borrowerOperations, `branches[${branchId}].borrowerOperations`),
      collSymbol,
      collateralVault: address(yieldEntry.collateralVault, `dfYield[${branchId}].collateralVault`),
      collateralYieldZapper: address(
        yieldEntry.collateralYieldZapper,
        `dfYield[${branchId}].collateralYieldZapper`,
      ),
      dToken: collToken,
      dTokenDecimals: 18,
      jpyUsdRateProvider: address(
        yieldEntry.jpyUsdRateProvider,
        `dfYield[${branchId}].jpyUsdRateProvider`,
      ),
      priceFeed: address(branch.priceFeed, `branches[${branchId}].priceFeed`),
      sortedTroves: address(branch.sortedTroves, `branches[${branchId}].sortedTroves`),
      stabilityPool: address(branch.stabilityPool, `branches[${branchId}].stabilityPool`),
      troveManager: address(branch.troveManager, `branches[${branchId}].troveManager`),
      underlyingToken: address(yieldEntry.underlying, `dfYield[${branchId}].underlying`),
    });
  });
  for (let branchId = 2; branchId < 8; branchId++) {
    const yieldEntry = record(manifestYield[branchId], `dfYield[${branchId}]`);
    if (address(yieldEntry.underlying, `dfYield[${branchId}].underlying`, true) !== zeroAddress) {
      throw new JpydfSdkError("UNSUPPORTED_DEPLOYMENT", `branch ${branchId} must remain inert`);
    }
  }

  const deployment = Object.freeze({
    chainId: identity.chainId,
    deploymentClassification: identity.deploymentClassification,
    deploymentProfile: identity.deploymentProfile,
    deploymentId: identity.deploymentId,
    deploymentScope: identity.deploymentScope,
    hintHelpers: address(manifest.hintHelpers, "hintHelpers"),
    manifestSha256: identity.manifestSha256,
    jpydfToken: address(manifest.jpydfToken, "jpydfToken"),
    liquidationCandidateGetter: address(manifest.liquidationCandidateGetter, "liquidationCandidateGetter"),
    protocolConstants: Object.freeze({
      ethGasCompensationRaw: BigInt(identity.ethGasCompensation),
      maxAnnualInterestRateRaw: BigInt(identity.maxAnnualInterestRate),
      minAnnualInterestRateRaw: BigInt(identity.minAnnualInterestRate),
      minDebtRaw: BigInt(identity.minDebt),
      stabilityPoolYieldShareRaw: BigInt(identity.spYieldSplit),
    }),
    branches: Object.freeze(branches),
  }) as JpydfDeployment;
  verifiedDeployments.add(deployment);
  return deployment;
}

export function assertVerifiedDeployment(deployment: JpydfDeployment): void {
  if (!verifiedDeployments.has(deployment)) {
    throw new JpydfSdkError(
      "UNSUPPORTED_DEPLOYMENT",
      "deployment must come from a package-pinned deployment loader",
    );
  }
}
