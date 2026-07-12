// Dev-only: serve the imagegen MCP server over Streamable HTTP with a FAKE image
// backend (no Azure, no network), so the App UI can be tested in a browser host
// like ext-apps' basic-host. Run: vp run dev:host  (then point basic-host here).
import { startHttpMcpServer } from "../mcp-server/http.ts";
import { createFakeClient } from "./fake-images.mjs";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3001);
// Slow, human-watchable frames by default: 10s per streamed frame (partial_images
// maxes at 3). Override with FAKE_STEP_MS (in milliseconds).
const stepMs = Number(process.env.FAKE_STEP_MS ?? 10000);
const service = await startHttpMcpServer(createFakeClient(stepMs), "fake-deployment", {
  host: HOST,
  port: PORT,
});
const shutdown = () =>
  service.close().catch((error) => {
    console.error("Failed to stop imagegen dev host:", error);
    process.exitCode = 1;
  });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`imagegen dev host (fake images, no Azure) -> ${service.url}`);
console.log(`streamed frame spacing: ${stepMs}ms (set FAKE_STEP_MS to change)`);
console.log(`Point a browser host at it, e.g. ext-apps basic-host:`);
console.log(`  SERVERS='["${service.url}"]' npm run start   # then open http://localhost:8080`);
