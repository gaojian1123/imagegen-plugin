import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A single stable MCP resource that mirrors the latest streamed image frame.
// A client that supports resource subscriptions can subscribe once to
// PREVIEW_URI and receive a `notifications/resources/updated` for every partial
// (and the final) frame, then re-read to render the newest preview live —
// without waiting for the generate/edit tool call to return. This is also what
// the App UI polls (via read_image) to show partials; streamed frames are never
// written to disk.
export const PREVIEW_URI = "imagegen://preview";

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export function previewMime(outputFormat: string): string {
  return MIME[outputFormat] ?? "application/octet-stream";
}

export interface PreviewResource {
  // Store the newest frame and notify subscribers. Best-effort: a notify
  // failure never interrupts generation.
  update(b64: string, mimeType: string): Promise<void>;
  // The most recent frame, for the app-only read_image tool to hand to the UI
  // while a stream is in flight (the App SDK can't subscribe to resources).
  latest(): { blob: string; mimeType: string } | undefined;
  // Clear the frame at the start of a run so the first poll doesn't flash the
  // previous run's image before the first partial arrives.
  reset(): void;
}

export function attachPreviewResource(server: McpServer): PreviewResource {
  let frame: { blob: string; mimeType: string } | undefined;
  // ponytail: one shared preview resource, so concurrent streaming runs clobber
  // each other's frame — fine for a single-user local server; make PREVIEW_URI
  // per-run (e.g. imagegen://preview/<id>) if that ever changes.
  const subscribers = new Set<string>();

  server.registerResource(
    "live-preview",
    PREVIEW_URI,
    {
      title: "Live generation preview",
      description:
        "The latest streamed frame of the in-progress image. Populated only while a generate/edit call runs with partial_images > 0. Subscribe to receive resources/updated as each frame arrives, then re-read to render it.",
      mimeType: "image/png",
    },
    () => ({ contents: frame ? [{ uri: PREVIEW_URI, mimeType: frame.mimeType, blob: frame.blob }] : [] }),
  );

  // McpServer registers resource read/list handlers but not subscribe/
  // unsubscribe, so wire them here and track who is listening.
  server.server.setRequestHandler(SubscribeRequestSchema, (req) => {
    subscribers.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (req) => {
    subscribers.delete(req.params.uri);
    return {};
  });

  return {
    async update(b64, mimeType) {
      frame = { blob: b64, mimeType };
      if (subscribers.has(PREVIEW_URI)) {
        await server.server.sendResourceUpdated({ uri: PREVIEW_URI }).catch(() => {});
      }
    },
    latest() {
      return frame;
    },
    reset() {
      frame = undefined;
    },
  };
}
