import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { OpenAI } from "openai";
import {
  generate,
  edit,
  saveBase64Images,
  generateStream,
  editStream,
  writeB64,
  resolveFilenames,
  readImageAsDataUri,
  storeBase64Images,
} from "./client.ts";
import type { ImageItem, SavedImage, StreamFrame, ImageResult } from "./client.ts";
import { attachPreviewResource, previewMime } from "./preview.ts";
import { createImageStore } from "./store.ts";

const UI_URI = "ui://imagegen/app.html";

// The built UI sits next to this file when bundled (dist/mcp-app.html), or under
// dist/ when running the TypeScript source directly (tests/dev-host).
const here = path.dirname(fileURLToPath(import.meta.url));
const uiHtmlPath = import.meta.url.endsWith(".ts")
  ? path.join(here, "dist", "mcp-app.html")
  : path.join(here, "mcp-app.html");
let uiHtml: string | undefined;

// Build a fully-wired imagegen MCP server. The OpenAI-compatible `client` is
// injected (real Azure client in production, a fake in the dev host) so the same
// tool logic runs against either backend. Transport is attached by the caller.
export function buildServer(client: OpenAI, deployment: string): McpServer {
  const server = new McpServer(
    { name: "imagegen", version: "0.1.0" },
    { capabilities: { resources: { subscribe: true } } },
  );

  // Mirror in-progress streamed frames to a subscribable MCP resource so a client
  // (and the App UI, via read_image) can render partials live; updated in runStream.
  const previewResource = attachPreviewResource(server);

  // Holds image bytes when a call isn't asked to write them to disk, so the App UI
  // can fetch them by id (read_image) without a file and without base64 in the
  // model's context.
  const store = createImageStore();

  registerAppResource(
    server,
    "Imagegen UI",
    UI_URI,
    {
      description:
        "Interactive image viewer: shows generated/edited images, a save button, and live streamed partials.",
    },
    () => {
      uiHtml ??= fs.readFileSync(uiHtmlPath, "utf8");
      return { contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: uiHtml }] };
    },
  );

  const common = {
    size: z
      .string()
      .regex(/^(auto|\d+x\d+)$/, "size must be 'auto' or a WIDTHxHEIGHT string like '1536x864'")
      .default("auto")
      .describe(
        "'auto' (default; the model picks dimensions) or a WIDTHxHEIGHT string for gpt-image-2. Common sizes: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160. Constraints: both edges multiples of 16, longest edge ≤ 3840, long:short ratio ≤ 3:1, total pixels between 655,360 and 8,294,400.",
      ),
    quality: z
      .enum(["low", "medium", "high", "auto"])
      .default("auto")
      .describe(
        "Rendering quality; 'auto' (default) lets the model choose. 'high' looks best but is slower and costlier.",
      ),
    background: z
      .enum(["transparent", "opaque", "auto"])
      .default("auto")
      .describe("Background; 'transparent' requires png or webp."),
    output_format: z
      .enum(["png", "jpeg", "webp"])
      .default("png")
      .describe("Saved image file format."),
    output_compression: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Compression level 0-100 for webp/jpeg output (GPT image models only; not valid with png).",
      ),
    n: z.number().int().min(1).max(10).default(1).describe("How many images to generate (max 10)."),
    output_dir: z
      .string()
      .optional()
      .describe(
        "Directory to write image files to. Omit to keep the image only in the app (view and Save it there) without writing any file to disk.",
      ),
    filename: z.string().optional().describe("Base filename (an index is appended when n > 1)."),
  };

  // moderation is a generate-only param (the OpenAI SDK's ImageEditParams omits it),
  // so it lives on generate_image rather than in the shared `common` schema.
  const moderation = z
    .enum(["low", "auto"])
    .default("auto")
    .describe(
      "Content-moderation level for GPT image models; 'low' is less restrictive than the default 'auto'.",
    );

  const partialImages = z
    .number()
    .int()
    .min(0)
    .max(3)
    .default(0)
    .describe(
      "Stream this many progressive preview frames for live viewing before the final image (0 = off). Requires n = 1.",
    );

  const outputSchema = {
    images: z
      .array(
        z.object({
          path: z.string().optional(),
          id: z.string().optional(),
          filename: z.string(),
          bytes: z.number(),
          revised_prompt: z.string().optional(),
        }),
      )
      .describe(
        "The generated images. `path` is set when written to disk; `id` is the in-app handle when it wasn't.",
      ),
  };

  function summarize(results: ImageResult[]): string {
    return results
      .map((r) => {
        const where = r.path
          ? `Saved ${r.path}`
          : `Generated ${r.filename} (shown in the app; pass output_dir to also save it to disk)`;
        return `${where} (${r.bytes} bytes)${r.revised_prompt ? ` — revised prompt: ${r.revised_prompt}` : ""}`;
      })
      .join("\n");
  }

  // A disk-saved image and an in-store image are the same shape to the UI/model.
  function savedToResult(s: SavedImage): ImageResult {
    return {
      path: s.path,
      filename: path.basename(s.path),
      bytes: s.bytes,
      revised_prompt: s.revised_prompt,
    };
  }

  type Call = (client: OpenAI, deployment: string) => Promise<ImageItem[]>;

  async function run(args: RunArgs, call: Call) {
    try {
      const data = await call(client, deployment);
      // Opt-in disk save: write files only when output_dir is given, otherwise keep
      // the bytes in memory for the app to fetch by id.
      const images = args.output_dir
        ? saveBase64Images(data, {
            outputDir: args.output_dir,
            filename: args.filename,
            prompt: args.prompt,
            outputFormat: args.output_format,
          }).map(savedToResult)
        : storeBase64Images(store, data, {
            filename: args.filename,
            prompt: args.prompt,
            outputFormat: args.output_format,
          });
      return {
        content: [{ type: "text" as const, text: summarize(images) }],
        structuredContent: { images },
      };
    } catch (e) {
      const err = e as Error;
      return {
        content: [{ type: "text" as const, text: `Error (${err.name}): ${err.message}` }],
        isError: true,
      };
    }
  }

  type FrameSource = (client: OpenAI, deployment: string) => AsyncGenerator<StreamFrame>;

  async function runStream(
    args: RunArgs & { n: number; partial_images: number },
    extra: ToolExtra,
    source: FrameSource,
  ) {
    try {
      // ponytail: streaming is one image at a time; multi-image streaming isn't
      // in the API surface. Lift the guard if Azure ever indexes streamed images.
      if (args.n > 1) throw new Error("Streaming (partial_images > 0) supports n = 1 only.");
      // Clear any stale frame so the UI's first poll shows "generating", not the
      // previous run's image, before the first partial lands.
      previewResource.reset();
      // Opt-in disk save: write the final image only when output_dir is given.
      // Partial frames are never written to disk — they're exposed only through the
      // in-memory preview resource (which the app polls via read_image).
      const saveDir = args.output_dir;
      const [finalName] = resolveFilenames({
        filename: args.filename,
        prompt: args.prompt,
        count: 1,
        outputFormat: args.output_format,
        now: new Date(),
      });
      const total = args.partial_images + 1;
      const token = extra?._meta?.progressToken;
      let final: ImageResult | undefined;
      for await (const frame of source(client, deployment)) {
        await previewResource.update(frame.b64, previewMime(args.output_format));
        if (frame.kind === "final") {
          if (saveDir) {
            const s = writeB64(frame.b64, path.join(saveDir, finalName));
            final = { path: s.path, filename: finalName, bytes: s.bytes };
          } else {
            const id = store.put(frame.b64, previewMime(args.output_format));
            final = { id, filename: finalName, bytes: Buffer.byteLength(frame.b64, "base64") };
          }
        }
        if (token !== undefined) {
          // The model may emit fewer partials than requested, so force the final
          // frame to progress === total instead of counting frames.
          const progress = frame.kind === "final" ? total : frame.index + 1;
          await extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: token,
                progress,
                total,
                message:
                  frame.kind === "final"
                    ? "final image"
                    : `partial ${frame.index + 1}/${args.partial_images}`,
              },
            })
            .catch(() => {});
        }
      }
      if (!final) throw new Error("Stream ended without a completed image.");
      return {
        content: [{ type: "text" as const, text: summarize([final]) }],
        structuredContent: { images: [final] },
      };
    } catch (e) {
      const err = e as Error;
      return {
        content: [{ type: "text" as const, text: `Error (${err.name}): ${err.message}` }],
        isError: true,
      };
    }
  }

  registerAppTool(
    server,
    "generate_image",
    {
      title: "Generate image",
      description:
        "Generate an image from a text prompt. Saves the image to disk and returns the file path.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to generate."),
        ...common,
        moderation,
        partial_images: partialImages,
      },
      outputSchema,
      _meta: { ui: { resourceUri: UI_URI } },
    },
    (args, extra) =>
      args.partial_images > 0
        ? runStream(args, extra, (client, deployment) => generateStream(client, deployment, args))
        : run(args, (client, deployment) => generate(client, deployment, args)),
  );

  registerAppTool(
    server,
    "edit_image",
    {
      title: "Edit image",
      description:
        "Edit or inpaint one or more existing images with a text prompt. Saves the result to disk and returns the file path.",
      inputSchema: {
        prompt: z.string().min(1).describe("How to edit the image(s)."),
        images: z
          .array(z.string())
          .min(1)
          .describe(
            "Input images: file paths, or in-app image ids returned by a previous generate/edit that wasn't saved to disk.",
          ),
        mask: z
          .string()
          .optional()
          .describe(
            "Optional PNG mask (a file path or in-app id) with an alpha channel marking the region to edit.",
          ),
        ...common,
        partial_images: partialImages,
      },
      outputSchema,
      _meta: { ui: { resourceUri: UI_URI } },
    },
    (args, extra) =>
      args.partial_images > 0
        ? runStream(args, extra, (client, deployment) =>
            editStream(client, deployment, args, store),
          )
        : run(args, (client, deployment) => edit(client, deployment, args, store)),
  );

  // App-only helper the UI calls (never the model): returns image bytes as a data:
  // URI so the app can render/download them. Fetch by `path` (a saved file), by
  // `id` (an in-memory image from a tool result), or with neither to get the latest
  // streamed partial. Base64 rides this UI channel instead of the tool result,
  // keeping it out of the model's context.
  registerAppTool(
    server,
    "read_image",
    {
      title: "Read image (UI)",
      description:
        "Return an image as a data URI for the UI: by `path` (saved file), by `id` (in-app image), or the latest streamed partial when neither is given.",
      inputSchema: {
        path: z.string().optional().describe("Saved image path."),
        id: z.string().optional().describe("In-app image id from a tool result."),
      },
      outputSchema: {
        dataUri: z.string().optional(),
        path: z.string().optional(),
        id: z.string().optional(),
      },
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } },
    },
    (args) => {
      try {
        if (args.path) {
          const { dataUri } = readImageAsDataUri(args.path);
          return {
            content: [{ type: "text" as const, text: "ok" }],
            structuredContent: { dataUri, path: args.path },
          };
        }
        if (args.id) {
          const entry = store.get(args.id);
          if (!entry) throw new Error(`Unknown image id: ${args.id}`);
          return {
            content: [{ type: "text" as const, text: "ok" }],
            structuredContent: {
              dataUri: `data:${entry.mimeType};base64,${entry.b64}`,
              id: args.id,
            },
          };
        }
        const frame = previewResource.latest();
        const structuredContent = frame
          ? { dataUri: `data:${frame.mimeType};base64,${frame.blob}` }
          : {};
        return {
          content: [{ type: "text" as const, text: frame ? "ok" : "no preview" }],
          structuredContent,
        };
      } catch (e) {
        const err = e as Error;
        return {
          content: [{ type: "text" as const, text: `Error (${err.name}): ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

interface RunArgs {
  prompt: string;
  output_format: string;
  output_dir?: string;
  filename?: string;
}

// The tool handler's `extra`, used to emit progress notifications. The
// notification is best-effort (a host that ignores it loses nothing).
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
