import { defineConfig, lazyPlugins } from "vite-plus";
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
  fmt: { ignorePatterns: ["mcp-server/dist/**"] },
  lint: {
    ignorePatterns: ["mcp-server/dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  root: uiDir,
  plugins: lazyPlugins(() => [viteSingleFile()]),
  build: {
    outDir,
    emptyOutDir: false, // keep the committed dist/index.js next to it
    target: "es2020",
    sourcemap: false,
    rollupOptions: { input: path.join(uiDir, "mcp-app.html") },
  },
  pack: {
    entry: "mcp-server/index.ts",
    outDir,
    clean: false,
    format: "esm",
    platform: "node",
    target: "node18",
    fixedExtension: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    outputOptions: { codeSplitting: false },
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["mcp-server/**/*.test.ts"],
  },
});
