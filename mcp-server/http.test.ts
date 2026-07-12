import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import type { OpenAI } from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { startHttpMcpServer } from "./http.ts";

test("serves image generation over Streamable HTTP", async () => {
  const data = Buffer.from("real image bytes").toString("base64");
  const openai = {
    images: { generate: async () => ({ data: [{ b64_json: data }] }) },
  } as unknown as OpenAI;
  const host = await startHttpMcpServer(openai, "test-deployment", { port: 0 });
  const client = new Client({ name: "http-test", version: "0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(host.url)));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "generate_image"));

    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "generate_image",
        arguments: { prompt: "test image" },
      }),
    );
    assert.deepEqual(
      result.content.find((item) => item.type === "image"),
      { type: "image", data, mimeType: "image/png" },
    );
  } finally {
    await client.close();
    await host.close();
  }
});

test("allows browser access only from loopback origins", async () => {
  const host = await startHttpMcpServer({} as OpenAI, "test-deployment", { port: 0 });

  try {
    for (const origin of ["http://localhost:8080", "http://[::1]:8080"]) {
      const allowed = await fetch(host.url, { method: "OPTIONS", headers: { Origin: origin } });
      assert.equal(allowed.status, 204);
      assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
    }

    const denied = await fetch(host.url, {
      method: "OPTIONS",
      headers: { Origin: "https://example.com" },
    });
    assert.equal(denied.status, 403);
  } finally {
    await host.close();
  }
});
