import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import type { OpenAI } from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./server.ts";

test("server exposes an accurate MCP registration surface", async () => {
  const server = buildServer({} as unknown as OpenAI, "test-deployment");
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    assert.equal(
      tools.get("generate_image")?.description,
      "Generate images from a text prompt. Keeps them in the app by default; pass output_dir to also save files to disk.",
    );
    assert.equal(
      tools.get("edit_image")?.description,
      "Edit or inpaint one or more existing images with a text prompt. Keeps results in the app by default; pass output_dir to also save files to disk.",
    );
    assert.deepEqual(tools.get("read_image")?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
    });

    const ui = (await client.listResources()).resources.find(
      (resource) => resource.uri === "ui://imagegen/app.html",
    );
    assert.equal(ui?.title, "Imagegen image viewer");
  } finally {
    await client.close();
    await server.close();
  }
});
