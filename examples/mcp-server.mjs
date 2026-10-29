import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// @requirement SDK-FR-004 SDK-SEC-002 SDK-ERR-001
// Use the low-level server to preserve the SDK's JSON schemas without translation.
export function createReadOnlyMcpServer(...models) {
  const operations = models.flatMap((model) => model.operationCatalog
    .filter(({ kind }) => kind === "read" || kind === "simulation")
    .map((operation) => ({ ...operation, model })));
  if (new Set(operations.map(({ id }) => id)).size !== operations.length) {
    throw new Error("Duplicate MCP operation");
  }
  const server = new Server(
    { name: "jpydf-read-only", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "Internal alpha. Chain sessions start with integration.get: testOnly=true deployments are TEST_ONLY_NOT_FOR_PRODUCTION, testOnly=false is the read-only production deployment. Offline lp.simulate uses supplied prices, never live data. "
        + "Chain amounts are base-unit decimal strings; LP inputs are decimal strings in the named human units. Report the returned deployment and block identity for chain reads. "
        + "jpydfUsdc.pool and jpydfUsdc.quote report the JPYdf market price and an execution quote; never present either as a fixed ¥1 price or a guaranteed fill. "
        + "liquidation.scan is discovery only: never enqueue or trigger execution. "
        + "For pagination, set a finite page budget, reject repeated cursors, deduplicate branchId/troveId, "
        + "and report incomplete scans. Pages may observe different blocks. "
        + "LP execution and transaction preparation, signing, and broadcast are unavailable.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: operations.map(({ id, kind, description, inputSchema }) => ({
      name: id,
      description,
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: kind === "read" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const operation = operations.find(({ id }) => id === params.name);
    if (!operation) {
      throw new McpError(ErrorCode.InvalidParams, "Unknown read-only tool");
    }
    let result;
    try {
      // The SDK validates every input and sanitizes RPC failures. Never pass .host here.
      result = await operation.model.invoke({ operation: params.name, input: params.arguments ?? {} });
    } catch {
      // Do not expose unexpected exceptions, which could contain host configuration.
      throw new McpError(ErrorCode.InternalError, "JPYdf read failed");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: !result.ok,
    };
  });
  return server;
}
