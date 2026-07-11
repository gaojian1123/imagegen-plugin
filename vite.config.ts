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
const projectDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  fmt: { ignorePatterns: ["mcp-server/dist/**"] },
  lint: {
    ignorePatterns: ["mcp-server/dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  staged: (files) => {
    const changed = files.map((file) => path.relative(projectDir, file).replaceAll("\\", "/"));
    const rebuild = changed.some(
      (file) =>
        (file.startsWith("mcp-server/") && !file.startsWith("mcp-server/dist/")) ||
        ["vite.config.ts", "package.json", "package-lock.json", "tsconfig.json"].includes(file),
    );
    return ["vp check --fix", ...(rebuild ? ["vp run build", "git add mcp-server/dist"] : [])];
  },
  root: uiDir,
  plugins: lazyPlugins(() => [viteSingleFile()]),
  build: {
    outDir,
    emptyOutDir: false, // keep the committed dist/index.js next to it
    rolldownOptions: { input: path.join(uiDir, "mcp-app.html") },
  },
  pack: {
    entry: "mcp-server/index.ts",
    outDir,
    clean: false,
    fixedExtension: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    outputOptions: { codeSplitting: false },
  },
  test: {
    root: projectDir,
    include: ["mcp-server/**/*.test.ts"],
  },
});
