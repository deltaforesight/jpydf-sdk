import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadMainnetCanaryDeployment,
  loadMainnetStagingDeployment,
  loadProductionDeployment,
} from "@jpydf/sdk";
import {
  createJpydfLpSimulationModel,
  createJpydfMainnetCanaryAgentClient,
  createJpydfMainnetStagingAgentClient,
  createJpydfMainnetRpcClient,
  createJpydfProductionAgentClient,
} from "@jpydf/sdk/agent";
import { createReadOnlyMcpServer } from "./mcp-server.mjs";

try {
  // Trusted local host configuration only; these are never tool arguments.
  const { JPYDF_MODE = "mainnet-canary", JPYDF_MANIFEST_PATH, JPYDF_RPC_URL, JPYDF_ACCOUNT } = process.env;
  const models = [createJpydfLpSimulationModel()];
  if (JPYDF_MODE !== "offline") {
    if (!(["mainnet-canary", "mainnet-staging", "production"].includes(JPYDF_MODE))
      || !JPYDF_MANIFEST_PATH || !JPYDF_RPC_URL || !JPYDF_ACCOUNT) {
      throw new Error("Invalid startup configuration");
    }
    // production reads the verified public descriptor (JPYDF_MANIFEST_PATH points at descriptors/jpydf-production.json).
    const text = await readFile(JPYDF_MANIFEST_PATH, "utf8");
    const deployment = JPYDF_MODE === "production" ? await loadProductionDeployment({ descriptorJson: text })
      : JPYDF_MODE === "mainnet-staging" ? await loadMainnetStagingDeployment({ manifestJson: text })
      : await loadMainnetCanaryDeployment({ manifestJson: text });
    const createSession = JPYDF_MODE === "production" ? createJpydfProductionAgentClient
      : JPYDF_MODE === "mainnet-staging" ? createJpydfMainnetStagingAgentClient : createJpydfMainnetCanaryAgentClient;
    const session = createSession({
      deployment, scope: JPYDF_MODE, account: JPYDF_ACCOUNT,
      publicClient: createJpydfMainnetRpcClient({ rpcUrl: JPYDF_RPC_URL }),
    });
    models.push(session.model);
  }
  await createReadOnlyMcpServer(...models).connect(new StdioServerTransport());
} catch {
  // stdout is reserved for MCP. Do not log paths, manifests, RPC URLs, or causes.
  console.error("JPYdf MCP startup failed. Check the local mode, configuration, pinned manifest, and SDK build.");
  process.exitCode = 1;
}
