# imagegen

A GitHub Copilot CLI plugin that generates and edits images with a `gpt-image-2`
model deployed on Azure OpenAI (Microsoft Foundry). It adds two MCP tools
(`generate_image`, `edit_image`).

On hosts that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps),
each generated/edited image renders inline in an interactive panel where you can
view it and click **Save**. By default nothing is written to disk — pass
`output_dir` to also save files there (e.g. for non-UI hosts). Either way the tool
result carries only a small handle — a file path or an in-app id, never base64 —
so image bytes stay out of the model's context; the panel fetches them over an
app-only `read_image` helper. `edit_image` accepts either a file path or a
previous result's in-app **id**, so you can edit an unsaved image without writing
it first. During streaming (`partial_images > 0`) the panel shows the
intermediate frames live; streamed frames are never written to disk.

## Prerequisites

- Node.js 24 or newer.
- An Azure OpenAI resource with a `gpt-image` model deployment.

## Configure

Copilot passes only `PATH` through to a local MCP server, so the plugin's
`.mcp.json` forwards the settings below into the server using `${VAR}` expansion.
That means you just set them **once in your own environment** — no secrets are
stored in the plugin.

| Variable                        | Required | Purpose                                                               |
| ------------------------------- | -------- | --------------------------------------------------------------------- |
| `AZURE_OPENAI_ENDPOINT`         | yes      | Full v1 base URL, e.g. `https://my-res.openai.azure.com/openai/v1`    |
| `AZURE_OPENAI_API_KEY`          | no\*     | API key. Omit to sign in with Microsoft Entra ID instead (see below). |
| `AZURE_OPENAI_IMAGE_DEPLOYMENT` | yes      | Your gpt-image deployment name                                        |

\***Authentication** — set `AZURE_OPENAI_API_KEY`, **or** leave it unset to use
**Microsoft Entra ID** (the "login" method). With no key the server authenticates
via `DefaultAzureCredential`: Azure CLI `az login` for local dev, a managed
identity when hosted on Azure, or a service principal
(`AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET`). Your identity
needs the **Cognitive Services OpenAI User** role on the resource. Tokens are
fetched and refreshed automatically.

Images are shown in the app and **not** written to disk by default; pass the
optional `output_dir` argument on a tool call to also save files there.

PowerShell (persistent, user-level) — then **restart Copilot**:

```powershell
setx AZURE_OPENAI_ENDPOINT "https://my-res.openai.azure.com"
setx AZURE_OPENAI_API_KEY "..."
setx AZURE_OPENAI_IMAGE_DEPLOYMENT "gpt-image-2"
```

`setx` only affects new processes, so restart Copilot afterward. If a tool errors
with "unexpanded placeholder", your Copilot build didn't expand `${VAR}` — set the
values directly with `/mcp edit imagegen` instead.

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

Set the variables from **Configure** above, then restart Copilot. The MCP server is registered automatically from `.mcp.json`.

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
