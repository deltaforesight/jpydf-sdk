import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createJpydfLpSimulationModel } from "@jpydf/sdk/agent";
const entry = fileURLToPath(new URL("../examples/mcp-stdio.mjs", import.meta.url));
const { createReadOnlyMcpServer } = await import(new URL("./mcp-server.mjs", pathToFileURL(entry)));
const input = { budgetJpy: "100000", fxJpyPerUsd: "150", spotJpydfPerUsdc: "150", lowerJpydfPerUsdc: "142.5", upperJpydfPerUsdc: "157.5", futureFxJpyPerUsd: "160", futureJpydfJpy: "1" };

test("official MCP stdio client runs offline without manifest, account or RPC", { timeout: 15_000 }, async () => {
  const client = new Client({ name: "jpydf-offline-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { JPYDF_MODE: "offline" }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ["lp.simulate"]);
    assert.equal(tools[0].annotations.openWorldHint, false);
    assert.equal(tools[0].annotations.readOnlyHint, true);
    const response = await client.callTool({ name: "lp.simulate", arguments: input });
    assert.equal(response.isError, false);
    assert.equal(response.structuredContent.data.simulationOnly, true);
    assert.equal(response.structuredContent.data.liveData, false);
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    const invalid = await client.callTool({ name: "lp.simulate", arguments: { ...input, budgetJpy: 100000 } });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, "INVALID_INPUT");
    await assert.rejects(client.callTool({ name: "earn.deposit", arguments: {} }), /Unknown read-only tool/);
    assert.equal(stderr, "");
  } finally {
    await client.close();
  }
});

test("combined catalogs route each allowed operation and never delegate writes", async () => {
  const calls = [];
  const chain = {
    operationCatalog: [
      { id: "protocol.get", kind: "read", description: "test read", inputSchema: { type: "object" } },
      { id: "earn.deposit", kind: "write", description: "test write", inputSchema: { type: "object" } },
    ],
    async invoke(request) { calls.push(request); return { ok: true, operationId: request.operation, data: {} }; },
  };
  const server = createReadOnlyMcpServer(chain, createJpydfLpSimulationModel());
  const client = new Client({ name: "combined-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ["protocol.get", "lp.simulate"]);
    assert.equal(tools[0].annotations.openWorldHint, true);
    assert.equal(tools[1].annotations.openWorldHint, false);
    await client.callTool({ name: "protocol.get", arguments: {} });
    await client.callTool({ name: "lp.simulate", arguments: input });
    await assert.rejects(client.callTool({ name: "earn.deposit", arguments: {} }), /Unknown read-only tool/);
    assert.deepEqual(calls, [{ operation: "protocol.get", input: {} }]);
  } finally { await client.close(); await server.close(); }
});

test("unknown and incomplete chain modes fail with sanitized startup errors", () => {
  for (const mode of ["invalid-secret-mode", "mainnet-canary", "mainnet-staging"]) {
    const result = spawnSync(process.execPath, [entry], { env: { JPYDF_MODE: mode }, encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /JPYdf MCP startup failed/);
    assert.doesNotMatch(result.stderr, /invalid-secret-mode/);
  }
});
