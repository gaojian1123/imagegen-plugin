import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["mcp-server/dist/index.js"],
  env: {
    ...process.env,
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/openai/v1",
    AZURE_OPENAI_API_KEY: "smoke-test",
    AZURE_OPENAI_IMAGE_DEPLOYMENT: "smoke-test",
  },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
await client.close();
if (!names.includes("generate_image") || !names.includes("edit_image")) {
  console.error("FAIL: expected generate_image and edit_image");
  process.exit(1);
}
console.log("OK");
process.exit(0);
