// Dev-only, no network: prove the server serves streamed partials *during* a
// generate call (the core of "real-time partial rendering"), plus that the app's
// read_image({ id }) fetch works. Uses the fake image client over an in-memory
// transport. Run: npm run dev:check
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../mcp-server/server.ts";
import { createFakeClient } from "./fake-images.mjs";

const server = buildServer(createFakeClient(300), "fake-deployment");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "dev-check", version: "0" });
await Promise.all([server.connect(serverT), client.connect(clientT)]);

console.log("Streaming generate_image (partial_images: 2) while polling read_image({}) concurrently...\n");

let done = false;
const genP = client
  .callTool({ name: "generate_image", arguments: { prompt: "a red fox", partial_images: 2 } })
  .then((r) => { done = true; return r; });

// Poll the live preview the same way the app does, while the generate call runs.
const framesDuringCall = new Set();
while (!done) {
  const r = await client.callTool({ name: "read_image", arguments: {} }).catch(() => null);
  const d = r?.structuredContent?.dataUri;
  if (typeof d === "string") framesDuringCall.add(d);
  await new Promise((res) => setTimeout(res, 100));
}

const final = await genP;
const img = final.structuredContent?.images?.[0];
console.log(`distinct preview frames seen DURING the call: ${framesDuringCall.size}`);
console.log(`final result: id=${img?.id ?? "-"} filename=${img?.filename ?? "-"} bytes=${img?.bytes ?? "-"}`);

let idOk = false;
if (img?.id) {
  const byId = await client.callTool({ name: "read_image", arguments: { id: img.id } });
  idOk = typeof byId.structuredContent?.dataUri === "string";
}
console.log(`read_image({ id }) returns bytes: ${idOk}`);

await client.close();
const pass = framesDuringCall.size >= 2 && idOk;
console.log(pass ? "\nPASS: partials are served live during the call, and id fetch works." : "\nFAIL");
process.exit(pass ? 0 : 1);
