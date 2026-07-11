import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import type { OpenAI } from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
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
      "Generate images from a text prompt. MCP Apps clients display them in the app; other clients receive standard image content. Pass output_dir to save files instead.",
    );
    assert.equal(
      tools.get("edit_image")?.description,
      "Edit or inpaint one or more existing images with a text prompt. MCP Apps clients display results in the app; other clients receive standard image content. Pass output_dir to save files instead.",
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

test("generate_image returns standard image content without output_dir", async () => {
  const data = Buffer.from("image bytes").toString("base64");
  const openai = {
    images: { generate: async () => ({ data: [{ b64_json: data }] }) },
  } as unknown as OpenAI;
  const server = buildServer(openai, "test-deployment");
  const client = new Client({ name: "plain-mcp-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "test image" },
    });
    const content = CallToolResultSchema.parse(result).content;
    assert.deepEqual(
      content.find((item) => item.type === "image"),
      {
        type: "image",
        data,
        mimeType: "image/png",
      },
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("generate_image omits image content for MCP Apps clients", async () => {
  const data = Buffer.from("app image").toString("base64");
  const openai = {
    images: {
      generate: async (params: Record<string, unknown>) =>
        params.stream
          ? (async function* () {
              yield { type: "image_generation.completed", b64_json: data };
            })()
          : { data: [{ b64_json: data }] },
    },
  } as unknown as OpenAI;
  const server = buildServer(openai, "test-deployment");
  const client = new Client(
    { name: "mcp-app-client", version: "0" },
    {
      capabilities: {
        extensions: {
          [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
        },
      },
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    for (const arguments_ of [
      { prompt: "test image" },
      { prompt: "test image", partial_images: 1 },
    ]) {
      const result = CallToolResultSchema.parse(
        await client.callTool({ name: "generate_image", arguments: arguments_ }),
      );
      assert.equal(
        result.content.some((item) => item.type === "image"),
        false,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("generate_image rejects an empty output_dir", async () => {
  let called = false;
  const openai = {
    images: {
      generate: async () => {
        called = true;
        return { data: [] };
      },
    },
  } as unknown as OpenAI;
  const server = buildServer(openai, "test-deployment");
  const client = new Client({ name: "plain-mcp-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "generate_image",
        arguments: { prompt: "test image", output_dir: "" },
      }),
    );
    const message = result.content.find((item) => item.type === "text");
    assert.equal(result.isError, true);
    assert.equal(called, false);
    assert.ok(message && message.type === "text");
    assert.match(message.text, /output_dir must not be empty/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("streaming generate_image returns its final image as standard content", async () => {
  const data = Buffer.from("streamed image").toString("base64");
  const openai = {
    images: {
      generate: async () =>
        (async function* () {
          yield { type: "image_generation.completed", b64_json: data };
        })(),
    },
  } as unknown as OpenAI;
  const server = buildServer(openai, "test-deployment");
  const client = new Client({ name: "plain-mcp-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "test image", partial_images: 1 },
    });
    const content = CallToolResultSchema.parse(result).content;
    assert.deepEqual(
      content.find((item) => item.type === "image"),
      {
        type: "image",
        data,
        mimeType: "image/png",
      },
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("streaming generate_image reports missing base64 data explicitly", async () => {
  const openai = {
    images: {
      generate: async () =>
        (async function* () {
          yield { type: "image_generation.completed" };
        })(),
    },
  } as unknown as OpenAI;
  const server = buildServer(openai, "test-deployment");
  const client = new Client({ name: "plain-mcp-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "generate_image",
        arguments: { prompt: "test image", partial_images: 1 },
      }),
    );
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: "Error (Error): Image response is missing base64 data (b64_json).",
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
