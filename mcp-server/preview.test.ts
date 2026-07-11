import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { attachPreviewResource, previewMime, PREVIEW_URI } from "./preview.ts";

test("previewMime maps output formats, falling back to octet-stream", () => {
  assert.equal(previewMime("png"), "image/png");
  assert.equal(previewMime("jpeg"), "image/jpeg");
  assert.equal(previewMime("webp"), "image/webp");
  assert.equal(previewMime("bogus"), "application/octet-stream");
});

test("preview resource: listed, notifies only subscribers, read returns latest frame", async () => {
  const server = new McpServer(
    { name: "t", version: "0" },
    { capabilities: { resources: { subscribe: true } } },
  );
  const preview = attachPreviewResource(server);
  const client = new Client({ name: "c", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const { resources } = await client.listResources();
  assert.ok(
    resources.some((r) => r.uri === PREVIEW_URI),
    "preview resource is listed",
  );

  const updates: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updates.push(n.params.uri);
  });

  const b64 = (s: string) => Buffer.from(s).toString("base64");

  // Not subscribed yet: update stores the frame but sends no notification.
  await preview.update(b64("frame0"), "image/png");
  await client.subscribeResource({ uri: PREVIEW_URI });
  await preview.update(b64("frame1"), "image/png");
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(updates, [PREVIEW_URI], "one notification, only after subscribing");

  const read = await client.readResource({ uri: PREVIEW_URI });
  const c0 = read.contents[0] as { blob?: string; mimeType?: string };
  assert.equal(c0.blob, b64("frame1"), "read returns the most recent frame");
  assert.equal(c0.mimeType, "image/png");

  await client.close();
  await server.close();
});

test("preview latest() returns the newest frame and reset() clears it", async () => {
  const server = new McpServer(
    { name: "t", version: "0" },
    { capabilities: { resources: { subscribe: true } } },
  );
  const preview = attachPreviewResource(server);
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  assert.equal(preview.latest(), undefined, "no frame before any update");
  await preview.update(b64("p0"), "image/webp");
  assert.deepEqual(preview.latest(), { blob: b64("p0"), mimeType: "image/webp" });
  await preview.update(b64("p1"), "image/webp");
  assert.equal(preview.latest()?.blob, b64("p1"), "latest reflects the newest frame");
  preview.reset();
  assert.equal(preview.latest(), undefined, "reset clears the frame");
});
