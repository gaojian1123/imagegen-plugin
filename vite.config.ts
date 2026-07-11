import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Bundle the MCP Apps UI (mcp-server/ui) into a single self-contained
// mcp-server/dist/mcp-app.html — the sandboxed iframe can't load sibling assets,
// so viteSingleFile inlines the JS and CSS. Output lands next to the server
// bundle (dist/index.js), which the server reads at runtime.
const uiDir = fileURLToPath(new URL("./mcp-server/ui", import.meta.url));
const outDir = fileURLToPath(new URL("./mcp-server/dist", import.meta.url));

export default defineConfig({
  root: uiDir,
  plugins: [viteSingleFile()],
  build: {
    outDir,
    emptyOutDir: false, // keep the committed dist/index.js next to it
    target: "es2020",
    sourcemap: false,
    rollupOptions: { input: path.join(uiDir, "mcp-app.html") },
  },
});
