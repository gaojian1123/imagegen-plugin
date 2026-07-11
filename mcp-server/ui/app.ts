// MCP Apps UI for imagegen. Rendered inline by hosts that support MCP Apps.
// Shows the generated/edited image with a Save button, and during a streaming
// run (partial_images > 0) polls the app-only read_image tool to display the
// latest partial frame live. Bundled into a single self-contained HTML by
// scripts/build-ui.mjs and served from the server's ui://imagegen/app.html.
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "imagegen", version: "0.1.0" });

const root = document.getElementById("app")!;
const statusEl = document.createElement("div");
statusEl.className = "status";
const gallery = document.createElement("div");
gallery.className = "gallery";
root.append(statusEl, gallery);

function setStatus(text: string): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? "block" : "none";
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || "image";
}

// One image from a tool result: `path` is set when it was saved to disk, `id`
// when it's only held in the app; `filename` is the download name either way.
interface ResultImage {
  path?: string;
  id?: string;
  filename?: string;
  revised_prompt?: string;
}

// A resolved image ready to render.
interface ShownImage {
  dataUri: string;
  filename: string;
  path?: string;
  revised_prompt?: string;
}

// One reused <img> for live partials, so polling swaps the src instead of
// stacking elements.
let previewImg: HTMLImageElement | undefined;

function showPreview(dataUri: string): void {
  if (!previewImg) {
    gallery.replaceChildren();
    previewImg = document.createElement("img");
    previewImg.className = "img";
    gallery.append(previewImg);
  }
  previewImg.src = dataUri;
}

async function downloadImage(item: ShownImage, button: HTMLButtonElement): Promise<void> {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(item.dataUri);
  if (!match) {
    setStatus("Save failed: invalid image data.");
    return;
  }
  button.disabled = true;
  try {
    const result = await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: `file:///${encodeURIComponent(item.filename)}`,
            mimeType: match[1],
            blob: match[2],
          },
        },
      ],
    });
    setStatus(result.isError ? "Save cancelled." : "");
  } catch (error) {
    console.error(error);
    setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
}

function showFinal(items: ShownImage[]): void {
  previewImg = undefined;
  gallery.replaceChildren();
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.className = "img";
    img.src = it.dataUri;
    img.alt = it.filename;

    const bar = document.createElement("div");
    bar.className = "bar";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "save";
    save.textContent = "Save";
    save.addEventListener("click", () => void downloadImage(it, save));
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = it.path ?? `${it.filename} — not saved to disk (click Save to keep it)`;
    bar.append(save, meta);

    card.append(img, bar);
    if (it.revised_prompt) {
      const rp = document.createElement("div");
      rp.className = "rp";
      rp.textContent = it.revised_prompt;
      card.append(rp);
    }
    gallery.append(card);
  }
}

function dataUriOf(result: { structuredContent?: Record<string, unknown> }): string | undefined {
  const d = result.structuredContent?.dataUri;
  return typeof d === "string" ? d : undefined;
}

// --- Streaming: poll read_image (no path) for the newest partial frame ---
let pollTimer: number | undefined;

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function startPolling(): void {
  stopPolling();
  setStatus("Generating…");
  const poll = async (): Promise<void> => {
    try {
      const r = await app.callServerTool({ name: "read_image", arguments: {} });
      const d = dataUriOf(r);
      if (d) {
        setStatus("");
        showPreview(d);
      }
    } catch {
      // transient (server busy mid-stream) — keep polling
    }
  };
  void poll();
  pollTimer = window.setInterval(() => void poll(), 500);
}

app.onerror = (e) => console.error(e);

app.ontoolinput = (params) => {
  const n = Number((params.arguments as { partial_images?: unknown } | undefined)?.partial_images);
  if (n > 0) startPolling();
  else setStatus("Generating…");
};

app.ontoolresult = async (result) => {
  stopPolling();
  if (result.isError) {
    const first = result.content?.find((c) => c.type === "text") as { text?: string } | undefined;
    setStatus(first?.text || "Image generation failed.");
    return;
  }
  const images = (result.structuredContent?.images as ResultImage[] | undefined) ?? [];
  const resolved: ShownImage[] = [];
  for (const im of images) {
    const arg = im.path ? { path: im.path } : im.id ? { id: im.id } : undefined;
    if (!arg) continue;
    try {
      const r = await app.callServerTool({ name: "read_image", arguments: arg });
      const d = dataUriOf(r);
      if (d)
        resolved.push({
          dataUri: d,
          filename: im.filename ?? (im.path ? basename(im.path) : "image"),
          path: im.path,
          revised_prompt: im.revised_prompt,
        });
    } catch {
      // skip an image the UI can't read; others still render
    }
  }
  if (resolved.length) {
    setStatus("");
    showFinal(resolved);
  } else {
    setStatus("No image to display.");
  }
};

app.ontoolcancelled = ({ reason }) => {
  stopPolling();
  setStatus(reason ? `Cancelled: ${reason}` : "Image generation cancelled.");
};

function applyHostContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
}

app.onhostcontextchanged = applyHostContext;

setStatus("Waiting for image…");
void app
  .connect()
  .then(() => applyHostContext(app.getHostContext()))
  .catch((error: unknown) => {
    console.error(error);
    setStatus(
      `Unable to connect to host: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
