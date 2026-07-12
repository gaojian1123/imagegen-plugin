import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import type { OpenAI } from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { buildServer } from "./server.ts";

test("plain clients receive only the fallback registration surface", async () => {
  const server = buildServer({} as unknown as OpenAI, "test-deployment");
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...tools.keys()].sort(), ["edit_image", "generate_image"]);
    assert.equal(
      tools.get("generate_image")?.description,
      "Generate images from a text prompt. Returns standard image content plus session image ids for later edits.",
    );
    assert.equal(
      tools.get("edit_image")?.description,
      "Edit or inpaint images from file paths or session image ids. Returns standard image content plus new session image ids.",
    );
    for (const name of ["generate_image", "edit_image"]) {
      const tool = tools.get(name);
      assert.deepEqual(tool?._meta, {});
      assert.equal(tool?.inputSchema.properties?.output_dir, undefined);
      const outputSchema = JSON.stringify(tool?.outputSchema);
      assert.doesNotMatch(outputSchema, /"path":/);
      assert.match(outputSchema, /"required":\["id"/);
    }

    const ui = (await client.listResources()).resources.find(
      (resource) => resource.uri === "ui://imagegen/app.html",
    );
    assert.equal(ui, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP Apps clients receive the app registration surface", async () => {
  const server = buildServer({} as unknown as OpenAI, "test-deployment");
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
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...tools.keys()].sort(), ["edit_image", "generate_image", "read_image"]);
    for (const name of tools.keys()) {
      assert.equal(tools.get(name)?._meta?.["ui/resourceUri"], "ui://imagegen/app.html");
    }
    assert.equal(
      tools.get("generate_image")?.description,
      "Generate images from a text prompt. Displays results in the App and returns session image ids for later edits.",
    );
    assert.equal(
      tools.get("edit_image")?.description,
      "Edit or inpaint images from file paths or session image ids. Displays results in the App and returns new session image ids.",
    );
    assert.equal(tools.get("read_image")?.inputSchema.properties?.path, undefined);
    assert.doesNotMatch(JSON.stringify(tools.get("read_image")?.outputSchema), /"path":/);
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

test("registration surface follows client capabilities after reconnecting", async () => {
  const server = buildServer({} as unknown as OpenAI, "test-deployment");

  async function getSurface(client: Client) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return {
        tools: new Map((await client.listTools()).tools.map((tool) => [tool.name, tool])),
        resources: (await client.listResources()).resources,
      };
    } finally {
      await client.close();
      await server.close();
    }
  }

  const appClient = () =>
    new Client(
      { name: "mcp-app-client", version: "0" },
      {
        capabilities: {
          extensions: {
            [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
          },
        },
      },
    );

  await getSurface(appClient());

  const plain = await getSurface(new Client({ name: "plain-mcp-client", version: "0" }));
  assert.deepEqual([...plain.tools.keys()].sort(), ["edit_image", "generate_image"]);
  assert.equal(
    plain.resources.some((resource) => resource.uri === "ui://imagegen/app.html"),
    false,
  );

  const app = await getSurface(appClient());
  assert.equal(
    app.tools.get("generate_image")?._meta?.["ui/resourceUri"],
    "ui://imagegen/app.html",
  );
  assert.equal(app.tools.has("read_image"), true);
  assert.equal(
    app.resources.some((resource) => resource.uri === "ui://imagegen/app.html"),
    true,
  );
});

test("generate_image returns standard image content and a session id to plain clients", async () => {
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
    const parsed = CallToolResultSchema.parse(result);
    assert.deepEqual(
      parsed.content.find((item) => item.type === "image"),
      {
        type: "image",
        data,
        mimeType: "image/png",
      },
    );
    const images = parsed.structuredContent?.images;
    assert.ok(Array.isArray(images));
    assert.equal(typeof images[0]?.id, "string");
    assert.equal("path" in images[0], false);
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
      const images = result.structuredContent?.images;
      assert.ok(Array.isArray(images));
      assert.equal(typeof images[0]?.id, "string");
      assert.equal("path" in images[0], false);
    }
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
    const parsed = CallToolResultSchema.parse(result);
    assert.deepEqual(
      parsed.content.find((item) => item.type === "image"),
      {
        type: "image",
        data,
        mimeType: "image/png",
      },
    );
    const images = parsed.structuredContent?.images;
    assert.ok(Array.isArray(images));
    assert.equal(typeof images[0]?.id, "string");
    assert.equal("path" in images[0], false);
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
