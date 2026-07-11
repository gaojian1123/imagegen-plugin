# imagegen

A GitHub Copilot CLI plugin that generates and edits images with a `gpt-image-2`
model deployed on Azure OpenAI (Microsoft Foundry). It adds two MCP tools
(`generate_image`, `edit_image`).

On hosts that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps),
each generated/edited image renders inline in an interactive panel where you can
view it and click **Save**. By default nothing is written to disk. App-capable
hosts receive an in-memory id, and the panel fetches the bytes through its
app-only `read_image` helper so they stay out of the model-visible tool result.
Other hosts receive standard MCP image content and may retain it in the
conversation context. Pass `output_dir` to save files and return paths instead.
`edit_image` accepts either a file path or a previous result's in-app **id**, so
you can edit an unsaved image without writing it first. During streaming
(`partial_images > 0`) the panel shows intermediate frames live; streamed frames
are never written to disk.

## Prerequisites

- Node.js 24 or newer.
- An Azure OpenAI resource with a `gpt-image` model deployment.

## Configure

Ask Copilot to "Configure imagegen", or open the native MCP editor directly:

```text
/mcp edit imagegen
```

In **Environment Variables**, enter one of these JSON objects.

Microsoft Entra ID:

```json
{
  "AZURE_OPENAI_ENDPOINT": "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
  "AZURE_OPENAI_IMAGE_DEPLOYMENT": "gpt-image-2"
}
```

API key:

```json
{
  "AZURE_OPENAI_ENDPOINT": "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
  "AZURE_OPENAI_IMAGE_DEPLOYMENT": "gpt-image-2",
  "AZURE_OPENAI_API_KEY": "YOUR-KEY"
}
```

Enter API keys only in the MCP editor, never in chat. For Entra ID, omit
`AZURE_OPENAI_API_KEY`; sign in with `az login` or use a managed identity or
service principal. The identity needs the **Cognitive Services OpenAI User**
role. Press **Ctrl+S**, then retry the image request.

Images are shown in MCP Apps and returned inline to other clients. They are
**not** written to disk by default; pass `output_dir` to save files instead.

## Install

Directly from the repo:

```shell
copilot plugin install OWNER/REPO
```

Or via the marketplace:

```shell
copilot plugin marketplace add OWNER/REPO
copilot plugin install imagegen@imagegen
```

The MCP server is registered automatically from `.mcp.json`; complete the
**Configure** step above before generating an image.

## Use

Ask Copilot, for example:

- "Generate a 1024x1024 image of a red fox on a transparent background."
- "Edit ./fox.png to add a snowy background."

## Develop

Development uses [Vite+](https://viteplus.dev/) and pins Node.js 24 through
`package.json`; the bundled server itself runs on Node.js 24+. Install the `vp`
CLI first, then use it for dependencies, checks, tests, and builds.

The server is written in TypeScript (`mcp-server/*.ts`) and packed by tsdown into
the self-contained `mcp-server/dist/index.js`. The App UI (`mcp-server/ui/`) is
bundled by Vite (`vite-plugin-singlefile`) into the self-contained
`mcp-server/dist/mcp-app.html`.

```shell
vp install
vp config --no-agent # install the Vite+ pre-commit hook
vp check           # format, lint, and fast type-check
vp run typecheck   # full tsc check
vp test            # unit tests (no network)
vp run build       # build the UI and pack the server into dist/
vp run smoke       # verify the built server lists its tools
```

`vp build` builds only the UI and `vp pack` builds only the server.
`vp run build` runs the package script that produces both committed artifacts.

Both `mcp-server/dist/index.js` and `mcp-server/dist/mcp-app.html` are committed;
rebuild and commit them after changing anything under `mcp-server/`.

### Testing the App UI (no Azure needed)

The App UI can be exercised with a fake image backend — no Azure, no network:

```shell
vp run dev:check   # headless: proves streamed partials are served live during a
                   # generate call, and that read_image({ id }) fetch works
```

To see it render in a real browser host, run the dev server (Streamable HTTP with
fake images) and point [ext-apps `basic-host`](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host)
at it:

```shell
vp run dev:host    # serves http://localhost:3001/mcp (fake images)

# in a clone of modelcontextprotocol/ext-apps:
cd examples/basic-host && npm install
SERVERS='["http://localhost:3001/mcp"]' npm run start   # open http://localhost:8080
```

Then call `generate_image` (with `partial_images: 2`) from basic-host and watch the
panel render. Whether partials animate live depends on the host mounting the iframe
at tool‑call time; the fake stream is spaced (default 10 s/frame, set
`FAKE_STEP_MS` in ms to change) so a live host shows the frames resolving. Fake
images are PNG, so keep `output_format` at its `png` default.

## License

MIT

## Before you publish

Fill in these placeholders first:

- `plugin.json` → `author.name`
- `.github/plugin/marketplace.json` → `owner.name`
- `LICENSE` → copyright holder (replace `YOUR NAME`)
- `README.md` install commands → your real `OWNER/REPO`

Then run one real `generate_image` against your deployment to confirm credentials and the live API contract.
