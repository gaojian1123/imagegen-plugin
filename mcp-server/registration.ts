import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ImageContent,
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppTool,
  registerAppResource,
  getUiCapability,
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
  generateStream,
  editStream,
  resolveFilenames,
  storeBase64Images,
} from "./client.ts";
import type { ImageItem, StreamFrame, ImageResult, GenerateArgs, EditArgs } from "./client.ts";
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

// Register imagegen's complete MCP surface. The OpenAI-compatible `client` is
// injected so production and the fake dev host run the same tool handlers.
export function registerImagegen(server: McpServer, client: OpenAI, deployment: string): void {
  // Mirror in-progress streamed frames to a subscribable MCP resource so a client
  // (and the App UI, via read_image) can render partials live; updated in runStream.
  const previewResource = attachPreviewResource(server);

  // Holds image bytes when a call isn't asked to write them to disk, so the App UI
  // can fetch them by id (read_image) without embedding them in an App client's
  // tool result.
  const store = createImageStore();

  const uiResource = registerAppResource(
    server,
    "Imagegen UI",
    UI_URI,
    {
      title: "Imagegen image viewer",
      description:
        "Interactive image viewer: shows generated/edited images, a save button, and live streamed partials.",
    },
    () => {
      uiHtml ??= fs.readFileSync(uiHtmlPath, "utf8");
      return { contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: uiHtml }] };
    },
  );
  uiResource.disable();

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
    output_format: z.enum(["png", "jpeg", "webp"]).default("png").describe("Output image format."),
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
          id: z.string(),
          filename: z.string(),
          bytes: z.number(),
          revised_prompt: z.string().optional(),
        }),
      )
      .describe("The generated images and their session ids for later edits."),
  };

  function summarize(results: ImageResult[]): string {
    return results
      .map(
        (r) =>
          `Generated ${r.filename} (${r.bytes} bytes)${r.revised_prompt ? ` — revised prompt: ${r.revised_prompt}` : ""}`,
      )
      .join("\n");
  }

  function imageContent(b64: string | undefined, outputFormat: string): ImageContent {
    if (typeof b64 !== "string")
      throw new Error("Image response is missing base64 data (b64_json).");
    return { type: "image", data: b64, mimeType: previewMime(outputFormat) };
  }

  type Call = (client: OpenAI, deployment: string) => Promise<ImageItem[]>;

  async function run(args: RunArgs, call: Call, includeImageContent: boolean) {
    try {
      const data = await call(client, deployment);
      const images = storeBase64Images(store, data, {
        filename: args.filename,
        prompt: args.prompt,
        outputFormat: args.output_format,
      });
      return {
        content: [
          { type: "text" as const, text: summarize(images) },
          ...(includeImageContent
            ? data.map((item) => imageContent(item.b64_json, args.output_format))
            : []),
        ],
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

  type FrameSource = (
    client: OpenAI,
    deployment: string,
    signal: AbortSignal,
  ) => AsyncGenerator<StreamFrame>;

  async function runStream(
    args: RunArgs & { n: number; partial_images: number },
    extra: ToolExtra,
    source: FrameSource,
    includeImageContent: boolean,
  ) {
    try {
      // ponytail: streaming is one image at a time; multi-image streaming isn't
      // in the API surface. Lift the guard if Azure ever indexes streamed images.
      if (args.n > 1) throw new Error("Streaming (partial_images > 0) supports n = 1 only.");
      // Clear any stale frame so the UI's first poll shows "generating", not the
      // previous run's image, before the first partial lands.
      previewResource.reset();
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
      let finalContent: ImageContent | undefined;
      for await (const frame of source(client, deployment, extra.signal)) {
        const frameContent = imageContent(frame.b64, args.output_format);
        await previewResource.update(frameContent.data, frameContent.mimeType);
        if (frame.kind === "final") {
          const id = store.put(frameContent.data, frameContent.mimeType);
          final = {
            id,
            filename: finalName,
            bytes: Buffer.byteLength(frameContent.data, "base64"),
          };
          if (includeImageContent) finalContent = frameContent;
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
        content: [
          { type: "text" as const, text: summarize([final]) },
          ...(finalContent ? [finalContent] : []),
        ],
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

  function handleGenerate(args: GenerateToolArgs, extra: ToolExtra, includeImageContent: boolean) {
    return args.partial_images > 0
      ? runStream(
          args,
          extra,
          (client, deployment, signal) => generateStream(client, deployment, args, signal),
          includeImageContent,
        )
      : run(args, (client, deployment) => generate(client, deployment, args), includeImageContent);
  }

  function handleEdit(args: EditToolArgs, extra: ToolExtra, includeImageContent: boolean) {
    return args.partial_images > 0
      ? runStream(
          args,
          extra,
          (client, deployment, signal) => editStream(client, deployment, args, store, signal),
          includeImageContent,
        )
      : run(
          args,
          (client, deployment) => edit(client, deployment, args, store),
          includeImageContent,
        );
  }

  const generateInputSchema = {
    prompt: z.string().min(1).describe("What to generate."),
    ...common,
    moderation,
    partial_images: partialImages,
  };
  const editInputSchema = {
    prompt: z.string().min(1).describe("How to edit the image(s)."),
    images: z
      .array(z.string())
      .min(1)
      .describe(
        "Input images: file paths or session image ids returned by a previous generate/edit.",
      ),
    mask: z
      .string()
      .optional()
      .describe(
        "Optional PNG mask (a file path or session image id) with an alpha channel marking the region to edit.",
      ),
    ...common,
    partial_images: partialImages,
  };
  const generateAppDescription =
    "Generate images from a text prompt. Displays results in the App and returns session image ids for later edits.";
  const generatePlainDescription =
    "Generate images from a text prompt. Returns standard image content plus session image ids for later edits.";
  const editAppDescription =
    "Edit or inpaint images from file paths or session image ids. Displays results in the App and returns new session image ids.";
  const editPlainDescription =
    "Edit or inpaint images from file paths or session image ids. Returns standard image content plus new session image ids.";
  const generateAppCallback = (args: GenerateToolArgs, extra: ToolExtra) =>
    handleGenerate(args, extra, false);
  const generatePlainCallback = (args: GenerateToolArgs, extra: ToolExtra) =>
    handleGenerate(args, extra, true);
  const editAppCallback = (args: EditToolArgs, extra: ToolExtra) => handleEdit(args, extra, false);
  const editPlainCallback = (args: EditToolArgs, extra: ToolExtra) => handleEdit(args, extra, true);

  const generateTool = registerAppTool(
    server,
    "generate_image",
    {
      title: "Generate image",
      description: generateAppDescription,
      inputSchema: generateInputSchema,
      outputSchema,
      _meta: { ui: { resourceUri: UI_URI } },
    },
    generateAppCallback,
  );

  const editTool = registerAppTool(
    server,
    "edit_image",
    {
      title: "Edit image",
      description: editAppDescription,
      inputSchema: editInputSchema,
      outputSchema,
      _meta: { ui: { resourceUri: UI_URI } },
    },
    editAppCallback,
  );

  // App-only helper the UI calls (never the model): returns image bytes as a data:
  // URI so the app can render/download them. Fetch by session `id`, or with no
  // argument to get the latest streamed partial.
  const readImageTool = registerAppTool(
    server,
    "read_image",
    {
      title: "Read image (UI)",
      description:
        "Return an image as a data URI for the UI: by session image id, or the latest streamed partial when no id is given.",
      inputSchema: {
        id: z.string().optional().describe("Session image id from a tool result."),
      },
      outputSchema: {
        dataUri: z.string().optional(),
        id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } },
    },
    (args) => {
      try {
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
  readImageTool.disable();
  const generateAppMeta = generateTool._meta ?? {};
  const editAppMeta = editTool._meta ?? {};

  server.server.oninitialized = () => {
    const clientSupportsApps =
      getUiCapability(server.server.getClientCapabilities())?.mimeTypes?.includes(
        RESOURCE_MIME_TYPE,
      ) === true;

    generateTool.update({
      description: clientSupportsApps ? generateAppDescription : generatePlainDescription,
      paramsSchema: generateInputSchema,
      callback: clientSupportsApps ? generateAppCallback : generatePlainCallback,
      _meta: clientSupportsApps ? generateAppMeta : {},
    });
    editTool.update({
      description: clientSupportsApps ? editAppDescription : editPlainDescription,
      paramsSchema: editInputSchema,
      callback: clientSupportsApps ? editAppCallback : editPlainCallback,
      _meta: clientSupportsApps ? editAppMeta : {},
    });
    uiResource.update({ enabled: clientSupportsApps });
    readImageTool.update({ enabled: clientSupportsApps });
  };
}

interface RunArgs {
  prompt: string;
  output_format: string;
  filename?: string;
}

type GenerateToolArgs = GenerateArgs & { filename?: string; partial_images: number };
type EditToolArgs = EditArgs & { filename?: string; partial_images: number };

// The tool handler's `extra`, used to emit progress notifications. The
// notification is best-effort (a host that ignores it loses nothing).
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
