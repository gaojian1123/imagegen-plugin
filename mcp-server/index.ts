import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getClient } from "./client.ts";
import { buildServer } from "./server.ts";

// Build the Azure client once at startup: a missing/invalid config fails fast
// here instead of on the first tool call, and the Entra credential's token cache
// is reused across requests instead of re-running the credential chain each time.
const { client, deployment } = getClient();
const server = buildServer(client, deployment);

await server.connect(new StdioServerTransport());