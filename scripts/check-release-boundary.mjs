import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// @requirement SDK-FR-001 SDK-FR-002 SDK-FR-003
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedDist = new Set([
  "agent.d.ts",
  "agent.js",
  "client.d.ts",
  "client.js",
  "deployment.d.ts",
  "deployment.js",
  "errors.d.ts",
  "errors.js",
  "generated/abis.d.ts",
  "generated/abis.js",
  "lp.js",
  "lp.d.ts",
  "generated/lp-simulation.js",
  "generated/lp-simulation.d.ts",
  "generated/uniV4PositionMath.js",
  "generated/uniV4PositionMath.d.ts",
  "index.d.ts",
  "index.js",
  "mainnet-canary-univ4.d.ts",
  "mainnet-canary-univ4.js",
  "production-market.d.ts",
  "production-market.js",
  "rpc.d.ts",
  "rpc.js",
  "types.d.ts",
  "types.js",
]);

function files(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(resolve(directory, entry.name), relative) : [relative];
  });
}

const distFiles = files(resolve(packageDir, "dist"));
if (distFiles.length !== expectedDist.size || distFiles.some((file) => !expectedDist.has(file))) {
  throw new Error("SDK dist contains an unexpected release file");
}

const body = ["LICENSE", "README.md", "package.json", ...distFiles.map((file) => `dist/${file}`)]
  .map((file) => readFileSync(resolve(packageDir, file), "utf8"))
  .join("\n");
if (/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.test(body)) {
  throw new Error("SDK release files must not embed deployment addresses");
}
const allowedUrls = new Set([
  "https://github.com/deltaforesight/jpydf-sdk.git",
  "https://github.com/deltaforesight/jpydf-sdk/issues",
  "https://github.com/deltaforesight/jpydf-sdk/security/policy",
  "https://github.com/deltaforesight/jpydf-sdk/security/advisories/new",
]);
const urls = body.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
if (urls.some((url) => !allowedUrls.has(url))) {
  throw new Error("SDK release files must not embed unapproved URLs or RPC endpoints");
}

const packageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
// SDK-GOV-002 is met for the 0.x public preview; publish.yml still refuses non-0.x versions.
if (packageJson.private !== undefined || packageJson.license !== "MIT" || !/^0\.\d+\.\d+$/.test(packageJson.version)) {
  throw new Error("SDK public preview must be a non-private, MIT-licensed 0.x release");
}
if (
  packageJson.type !== "module"
  || !isDeepStrictEqual(packageJson.engines, { node: ">=22" })
  || !isDeepStrictEqual(packageJson.peerDependencies, { viem: "^2.31.4" })
) {
  throw new Error("SDK runtime or peer dependency contract changed");
}
if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist", "README.md"])) {
  throw new Error("SDK package files allowlist changed");
}
if (
  packageJson.main !== "./dist/index.js"
  || packageJson.types !== "./dist/index.d.ts"
  || !isDeepStrictEqual(packageJson.exports, {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
    "./agent": {
      types: "./dist/agent.d.ts",
      import: "./dist/agent.js",
    },
  })
) {
  throw new Error("SDK public entrypoint contract changed");
}
const pack = JSON.parse(execFileSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  { cwd: packageDir, encoding: "utf8" },
));
const expectedPackage = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  ...distFiles.map((file) => `dist/${file}`),
]);
const packedFiles = pack[0]?.files?.map(({ path }) => path) ?? [];
if (packedFiles.length !== expectedPackage.size || packedFiles.some((file) => !expectedPackage.has(file))) {
  throw new Error("SDK tarball contains an unexpected release file");
}

console.log("SDK release boundary: PASS");
