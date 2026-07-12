import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { OpenAI } from "openai";
import { buildServer } from "./server.ts";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

function sendError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export async function startHttpMcpServer(
  client: OpenAI,
  deployment: string,
  { host = "127.0.0.1", port = 3001 }: { host?: string; port?: number } = {},
) {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (req, res) => {
    if ((req.url ?? "").split("?")[0] !== "/mcp") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin) {
      if (!isLoopbackOrigin(origin)) {
        res.writeHead(403);
        res.end("forbidden origin");
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, mcp-session-id, mcp-protocol-version, last-event-id",
      );
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const header = req.headers["mcp-session-id"];
    const sessionId = typeof header === "string" ? header : undefined;

    try {
      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          sendError(res, 400, -32700, "Invalid JSON");
          return;
        }

        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          if (sessionId) {
            sendError(res, 404, -32001, "Unknown MCP session");
            return;
          }
          if (!isInitializeRequest(body)) {
            sendError(res, 400, -32000, "No session; send initialize first");
            return;
          }

          let created: StreamableHTTPServerTransport;
          created = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => {
              transports.set(id, created);
            },
          });
          transport = created;
          transport.onclose = () => {
            if (transport?.sessionId) transports.delete(transport.sessionId);
          };
          await buildServer(client, deployment).connect(transport);
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          sendError(
            res,
            sessionId ? 404 : 400,
            sessionId ? -32001 : -32000,
            sessionId ? "Unknown MCP session" : "Missing MCP session",
          );
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { Allow: "GET, POST, DELETE" });
      res.end();
    } catch (error) {
      console.error("HTTP MCP request failed:", error);
      if (!res.headersSent) sendError(res, 500, -32603, "Internal server error");
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${address.port}/mcp`,
    async close(): Promise<void> {
      await Promise.all([
        Promise.all([...transports.values()].map((transport) => transport.close())),
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    },
  };
}
