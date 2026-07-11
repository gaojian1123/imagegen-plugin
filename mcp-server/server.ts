import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenAI } from "openai";
import { registerImagegen } from "./registration.ts";

// Build a fully-wired imagegen MCP server. Transport is attached by the caller.
export function buildServer(client: OpenAI, deployment: string): McpServer {
  const server = new McpServer(
    { name: "imagegen", version: "0.1.0" },
    { capabilities: { resources: { subscribe: true } } },
  );
  registerImagegen(server, client, deployment);
  return server;
}
