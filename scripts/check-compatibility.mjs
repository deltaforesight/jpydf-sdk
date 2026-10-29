import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// @requirement SDK-FR-001 SDK-FR-002 SDK-FR-003
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "../..");
// Standalone mode checks a given release tarball from the public mirror, where the monorepo's
// console vite and pnpm typescript do not exist; both come from the consumer install instead.
const releaseTarball = process.env.JPYDF_SDK_TARBALL && resolve(process.env.JPYDF_SDK_TARBALL);
const STANDALONE_VITE = "^6.3.5"; // shortcut: mirrors frontend/console's vite range, bump with it
const viemSpecifier = process.env.JPYDF_SDK_VIEM;
if (!new Set(["2.31.4", "2"]).has(viemSpecifier)) {
  throw new Error("JPYDF_SDK_VIEM must be 2.31.4 or 2");
}

const temporaryDir = realpathSync(mkdtempSync(join(tmpdir(), "jpydf-sdk-compatibility-")));
const packDir = join(temporaryDir, "pack");
const consumerDir = join(temporaryDir, "consumer");
const mcpVersion = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).devDependencies["@modelcontextprotocol/sdk"];

function run(command, args, cwd = consumerDir) {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    stdio: "inherit",
  });
}

let buildForBrowser;
async function browserBuild(viteBuild, createLogger, outDir) {
  const logger = createLogger("silent");
  const warn = logger.warn.bind(logger);
  const warnOnce = logger.warnOnce.bind(logger);
  const rejectNodeBuiltin = (message) => {
    if (String(message).includes("has been externalized for browser compatibility")) {
      throw new Error("SDK browser entry requires a Node builtin");
    }
  };
  logger.warn = (message, options) => {
    rejectNodeBuiltin(message);
    warn(message, options);
  };
  logger.warnOnce = (message, options) => {
    rejectNodeBuiltin(message);
    warnOnce(message, options);
  };
  await viteBuild({
    build: { emptyOutDir: true, outDir },
    configFile: false,
    customLogger: logger,
    root: consumerDir,
  });
}

try {
  mkdirSync(packDir);
  mkdirSync(consumerDir);

  const tarballName = releaseTarball ? basename(releaseTarball) : JSON.parse(execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    { cwd: packageDir, encoding: "utf8" },
  ))[0]?.filename;
  if (releaseTarball) copyFileSync(releaseTarball, join(packDir, tarballName));
  if (typeof tarballName !== "string" || basename(tarballName) !== tarballName) {
    throw new Error("npm pack did not return a safe tarball filename");
  }
  const tarballPath = resolve(packDir, tarballName);
  if (dirname(tarballPath) !== resolve(packDir)) {
    throw new Error("npm pack returned a tarball outside the temporary directory");
  }

  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({
    name: "jpydf-sdk-compatibility-consumer",
    private: true,
    type: "module",
  }));
  copyFileSync(tarballPath, join(consumerDir, tarballName));
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    `./${tarballName}`,
    `viem@${viemSpecifier}`,
    `@modelcontextprotocol/sdk@${mcpVersion}`,
    ...(releaseTarball ? [
      `typescript@${JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).devDependencies.typescript}`,
      `vite@${STANDALONE_VITE}`,
    ] : []),
  ]);
  const viteModule = realpathSync(releaseTarball
    ? join(consumerDir, "node_modules", "vite", "dist", "node", "index.js")
    : join(repoDir, "frontend", "console", "node_modules", "vite", "dist", "node", "index.js"));
  const { build: viteBuild, createLogger } = await import(pathToFileURL(viteModule));
  buildForBrowser = (outDir) => browserBuild(viteBuild, createLogger, outDir);

  mkdirSync(join(consumerDir, "examples"));
  mkdirSync(join(consumerDir, "test"));
  const exampleFiles = ["examples/mcp-stdio.mjs", "examples/mcp-server.mjs", "examples/README.md", "examples/README.jp.md", "test/mcp-modes.test.mjs"];
  for (const file of exampleFiles) copyFileSync(join(packageDir, file), join(consumerDir, file));
  run(process.execPath, ["--test", "test/mcp-modes.test.mjs"]);

  const installedSdkDir = join(consumerDir, "node_modules", "@jpydf", "sdk");
  const installedSdkRealPath = realpathSync(installedSdkDir);
  const packageRealPath = realpathSync(packageDir);
  if (
    lstatSync(installedSdkDir).isSymbolicLink()
    || installedSdkRealPath === packageRealPath
    || installedSdkRealPath.startsWith(`${packageRealPath}${sep}`)
  ) {
    throw new Error("SDK compatibility check must use the packed copy, not the workspace");
  }

  const installedViem = JSON.parse(readFileSync(
    join(consumerDir, "node_modules", "viem", "package.json"),
    "utf8",
  )).version;
  if (
    (viemSpecifier === "2.31.4" && installedViem !== viemSpecifier)
    || (viemSpecifier === "2" && !installedViem.startsWith("2."))
  ) {
    throw new Error(`Unexpected installed viem version: ${installedViem}`);
  }

  run(process.execPath, [
    "--input-type=module",
    "--eval",
    'await import("@jpydf/sdk"); await import("@jpydf/sdk/agent");',
  ]);

  writeFileSync(
    join(consumerDir, "consumer.ts"),
    readFileSync(join(packageDir, "test", "consumer.ts"), "utf8"),
  );
  writeFileSync(join(consumerDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      lib: ["ES2022", "DOM"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: false,
      strict: true,
      target: "ES2022",
    },
    files: ["consumer.ts"],
  }));
  if (releaseTarball) {
    run(join(consumerDir, "node_modules", ".bin", "tsc"), ["--project", join(consumerDir, "tsconfig.json")]);
  } else {
    run("pnpm", [
      "--filter",
      "@jpydf/sdk",
      "exec",
      "tsc",
      "--project",
      join(consumerDir, "tsconfig.json"),
    ], repoDir);
  }

  writeFileSync(join(consumerDir, "index.html"), [
    '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>',
    "",
  ].join("\n"));
  writeFileSync(join(consumerDir, "main.js"), [
    'import { createJpydfClient, simulateLp } from "@jpydf/sdk";',
    'document.body.dataset.sdk = typeof createJpydfClient + typeof simulateLp;',
    "",
  ].join("\n"));
  await buildForBrowser("browser-dist");

  writeFileSync(join(consumerDir, "main.js"), [
    'import fs from "node:fs";',
    'document.body.textContent = fs.readFileSync("x", "utf8");',
    "",
  ].join("\n"));
  let nodeBuiltinRejected = false;
  try {
    await buildForBrowser("browser-node-builtin-dist");
  } catch (error) {
    if (error instanceof Error && error.message.includes("SDK browser entry requires a Node builtin")) {
      nodeBuiltinRejected = true;
    } else {
      throw error;
    }
  }
  if (!nodeBuiltinRejected) {
    throw new Error("SDK browser Node builtin guard did not reject its mutation check");
  }

  if (process.env.JPYDF_SDK_BUNDLE_DIR) {
    if (releaseTarball) throw new Error("Trial bundles are exported from the monorepo, not a release tarball");
    if (viemSpecifier !== "2") throw new Error("Trial bundles require the current viem 2.x compatibility run");
    run("npm", ["audit", "--omit=dev"]);
    // Explicit export only; never include node_modules, credentials, or a manifest.
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const sourceDirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }).trim().length > 0;
    if (sourceDirty) throw new Error("Commit the reviewed source before exporting a handoff bundle");
    const bundleDir = resolve(process.env.JPYDF_SDK_BUNDLE_DIR);
    mkdirSync(bundleDir, { mode: 0o700 }); // Refuse overwriting an existing handoff.
    mkdirSync(join(bundleDir, "examples"));
    mkdirSync(join(bundleDir, "test"));
    const bundledFiles = [tarballName, "package.json", "package-lock.json", ...exampleFiles];
    for (const file of bundledFiles) copyFileSync(join(consumerDir, file), join(bundleDir, file));
    writeFileSync(join(bundleDir, "README.md"), [
      "# JPYdf local integration trial", "",
      "Requires Node 22+. This bundle is TEST_ONLY_NOT_FOR_PRODUCTION.", "",
      "```sh", "npm ci --ignore-scripts --no-audit --no-fund", "node --test test/mcp-modes.test.mjs",
      "JPYDF_MODE=offline node examples/mcp-stdio.mjs", "```", "",
      "See [the MCP setup guide](examples/README.md) for trusted local chain configuration.", "",
      "## Deployment and release boundary", "",
      "Trial scope: offline LP simulation, read-only staging and local MCP. Canary is internal testing only.",
      "Production and npm publication require a separate release approval.",
      "Before distributing: confirm a reachable support contact and approved staging-manifest handoff with the provider.",
      "See [日本語の接続手順](examples/README.jp.md).",
      "Manifests, RPC endpoints and accounts are supplied separately by the operator; no signing or broadcasting is exposed.", "",
    ].join("\n"));
    const hashes = Object.fromEntries([...bundledFiles, "README.md"].map((file) =>
      [file, createHash("sha256").update(readFileSync(join(bundleDir, file))).digest("hex")]));
    writeFileSync(join(bundleDir, "verification.json"), JSON.stringify({
      distributionStatus: "candidate-support-and-staging-handoff-pending",
      sourceCommit, sourceDirty, verifiedAt: new Date().toISOString(), node: process.version,
      viem: installedViem, mcp: mcpVersion, checks: ["offline-stdio", "strict-types", "browser-bundle", "browser-node-builtin-rejection", "dependency-audit"],
      sha256: hashes,
    }, null, 2) + "\n");
  }

  console.log(`SDK compatibility: PASS (viem ${installedViem})`);
} finally {
  rmSync(temporaryDir, { force: true, recursive: true });
}
