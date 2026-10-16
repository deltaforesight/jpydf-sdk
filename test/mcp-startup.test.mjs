import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("MCP startup fails closed without printing host configuration to either stream", () => {
  const entrypoint = fileURLToPath(new URL("../examples/mcp-stdio.mjs", import.meta.url));
  for (const env of [{}, {
    JPYDF_MANIFEST_PATH: "/missing/secret-manifest-path",
    JPYDF_RPC_URL: "https://secret-rpc-credential.example",
    JPYDF_ACCOUNT: "secret-account",
  }]) {
    const result = spawnSync(process.execPath, [entrypoint], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^JPYdf MCP startup failed\./);
    assert.doesNotMatch(result.stderr, /secret-/);
  }
});
