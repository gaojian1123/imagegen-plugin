// Minimal client that proves the live-preview resource end to end: it spawns
// the server, subscribes to imagegen://preview, and writes each streamed frame
// to disk as the `resources/updated` notifications arrive — before the
// generate_image call returns. Requires the AZURE_OPENAI_* env vars (a real
// generation runs). Usage:
//   vp run build
//   vp run preview "your prompt here"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";

const PREVIEW_URI = "imagegen://preview";
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const prompt =
  process.argv.slice(2).join(" ") || "a red fox sitting in snow, minimal flat vector illustration";
const outDir = path.resolve("preview-out");
fs.mkdirSync(outDir, { recursive: true });

// Forward the full env: the SDK's stdio transport otherwise passes only a safe
// subset, so the spawned server would never see AZURE_OPENAI_* and fail to auth.
const transport = new StdioClientTransport({
  command: "node",
  args: ["mcp-server/dist/index.js"],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "preview-client", version: "0.0.0" });

let frames = 0;
client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
  if (n.params.uri !== PREVIEW_URI) return;
  const i = ++frames;
  const res = await client.readResource({ uri: PREVIEW_URI });
  const c = res.contents?.[0];
  if (!c?.blob) return;
  const buf = Buffer.from(c.blob, "base64");
  const file = path.join(outDir, `frame-${String(i).padStart(2, "0")}.${EXT[c.mimeType] ?? "png"}`);
  fs.writeFileSync(file, buf);
  console.log(`  live frame ${i} -> ${file} (${buf.length} bytes)`);
});

try {
  await client.connect(transport);
  await client.subscribeResource({ uri: PREVIEW_URI });
  console.log(`subscribed to ${PREVIEW_URI}\ngenerating: "${prompt}"\n`);

  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt, partial_images: 3, quality: "medium", output_dir: outDir },
  });

  // Frame handlers are async re-reads; give any in-flight one a moment to finish
  // before we tear the transport down.
  await new Promise((r) => setTimeout(r, 300));

  console.log("\ntool result:");
  for (const block of result.content ?? [])
    if (block.type === "text") console.log("  " + block.text.replace(/\n/g, "\n  "));
  console.log(`\ncaptured ${frames} live preview frame(s) in ${outDir}`);
  if (frames === 0)
    console.log(
      "(the model emitted no partials this run — common for simple/fast prompts; the final image still saved)",
    );

  await client.close();
  process.exit(0);
} catch (e) {
  console.error(`\nFAILED: ${e?.message ?? e}`);
  console.error(
    "If this is a missing-env error, set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_IMAGE_DEPLOYMENT (and a key or Entra login).",
  );
  process.exit(1);
}
