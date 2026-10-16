import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadMainnetCanaryDeployment,
  loadMainnetStagingDeployment,
} from "@jpydf/sdk";
import {
  createJpydfLpSimulationModel,
  createJpydfMainnetCanaryAgentClient,
  createJpydfMainnetStagingAgentClient,
  createJpydfMainnetRpcClient,
} from "@jpydf/sdk/agent";
import { createReadOnlyMcpServer } from "./mcp-server.mjs";

try {
  // Trusted local host configuration only; these are never tool arguments.
  const { JPYDF_MODE = "mainnet-canary", JPYDF_MANIFEST_PATH, JPYDF_RPC_URL, JPYDF_ACCOUNT } = process.env;
  const models = [createJpydfLpSimulationModel()];
  if (JPYDF_MODE !== "offline") {
    if (!(["mainnet-canary", "mainnet-staging"].includes(JPYDF_MODE))
      || !JPYDF_MANIFEST_PATH || !JPYDF_RPC_URL || !JPYDF_ACCOUNT) {
      throw new Error("Invalid startup configuration");
    }
    const staging = JPYDF_MODE === "mainnet-staging";
    const loadDeployment = staging ? loadMainnetStagingDeployment : loadMainnetCanaryDeployment;
    const createSession = staging ? createJpydfMainnetStagingAgentClient : createJpydfMainnetCanaryAgentClient;
    const deployment = await loadDeployment({ manifestJson: await readFile(JPYDF_MANIFEST_PATH, "utf8") });
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
