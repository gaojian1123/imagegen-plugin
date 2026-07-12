import { getClient } from "../mcp-server/client.ts";
import { startHttpMcpServer } from "../mcp-server/http.ts";

const { client, deployment } = getClient();
const service = await startHttpMcpServer(client, deployment, {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
});
const shutdown = () =>
  service.close().catch((error) => {
    console.error("Failed to stop imagegen HTTP MCP:", error);
    process.exitCode = 1;
  });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`imagegen HTTP MCP (real Azure images) -> ${service.url}`);
