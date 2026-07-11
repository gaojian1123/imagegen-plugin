// Dev-only: serve the imagegen MCP server over Streamable HTTP with a FAKE image
// backend (no Azure, no network), so the App UI can be tested in a browser host
// like ext-apps' basic-host. Run: vp run dev:host  (then point basic-host here).
//
// Stateful sessions: one buildServer() per session so the in-memory image store
// and the live-preview resource are shared across a session's concurrent
// requests (generate_image streaming + read_image polling run as separate calls).
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../mcp-server/server.ts";
import { createFakeClient } from "./fake-images.mjs";

const PORT = Number(process.env.PORT ?? 3001);
// Slow, human-watchable frames by default: 10s per streamed frame (partial_images
// maxes at 3). Override with FAKE_STEP_MS (in milliseconds).
const stepMs = Number(process.env.FAKE_STEP_MS ?? 10000);
const fakeClient = createFakeClient(stepMs);
const transports = {};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

const httpServer = createServer(async (req, res) => {
  // Permissive CORS so a browser host on another port can connect (dev only).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if ((req.url ?? "").split("?")[0] !== "/mcp") {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  const sid = req.headers["mcp-session-id"];
  try {
    if (req.method === "POST") {
      const body = await readBody(req);
      let transport = sid ? transports[sid] : undefined;
      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "No session; send initialize first" },
              id: null,
            }),
          );
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
        };
        await buildServer(fakeClient, "fake-deployment").connect(transport);
      }
      await transport.handleRequest(req, res, body);
    } else if (req.method === "GET" || req.method === "DELETE") {
      const transport = sid ? transports[sid] : undefined;
      if (!transport) {
        res.writeHead(400);
        res.end();
        return;
      }
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(405);
      res.end();
    }
  } catch (e) {
    console.error("dev-host error:", e);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`imagegen dev host (fake images, no Azure) -> http://localhost:${PORT}/mcp`);
  console.log(`streamed frame spacing: ${stepMs}ms (set FAKE_STEP_MS to change)`);
  console.log(`Point a browser host at it, e.g. ext-apps basic-host:`);
  console.log(
    `  SERVERS='["http://localhost:${PORT}/mcp"]' npm run start   # then open http://localhost:8080`,
  );
});
