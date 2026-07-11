import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenAI } from "openai";
import {
  required,
  assertValidFormat,
  assertValidSize,
  slugify,
  timestamp,
  resolveFilenames,
  saveBase64Images,
  generate,
  edit,
  generateStream,
  editStream,
  toImageFile,
  clientOptions,
  isPlaceholder,
  readImageAsDataUri,
  storeBase64Images,
} from "./client.ts";
import { createImageStore } from "./store.ts";

test("required returns value or throws by name", () => {
  assert.equal(required({ FOO: "x" }, "FOO"), "x");
  assert.throws(() => required({}, "FOO"), /Missing required env var: FOO/);
  assert.throws(() => required({ FOO: "  " }, "FOO"), /Missing required env var: FOO/);
});

test("required rejects an unexpanded ${...} placeholder", () => {
  assert.throws(() => required({ FOO: "${FOO}" }, "FOO"), /unexpanded placeholder/);
});

test("isPlaceholder detects unexpanded ${...}", () => {
  assert.equal(isPlaceholder("${X}"), true);
  assert.equal(isPlaceholder("  ${AZURE_OPENAI_API_KEY}  "), true);
  assert.equal(isPlaceholder("/real/path"), false);
  assert.equal(isPlaceholder(""), false);
});

test("assertValidSize accepts auto and valid gpt-image-2 sizes", () => {
  assert.doesNotThrow(() => assertValidSize("auto"));
  assert.doesNotThrow(() => assertValidSize("1024x1024"));
  assert.doesNotThrow(() => assertValidSize("1536x864"));
  assert.doesNotThrow(() => assertValidSize("3840x2160"));
});

test("assertValidSize rejects sizes that break the constraints", () => {
  assert.throws(() => assertValidSize("1000x1000"), /multiples of 16/); // not divisible by 16
  assert.throws(() => assertValidSize("4096x1024"), /3840px or less/); // edge too long
  assert.throws(() => assertValidSize("2048x512"), /ratio must not exceed 3:1/); // 4:1 ratio
  assert.throws(() => assertValidSize("512x512"), /total pixels/); // below the pixel floor
  assert.throws(() => assertValidSize("wide"), /use 'auto' or a WIDTHxHEIGHT/); // malformed
});

test("assertValidFormat rejects transparent+jpeg only", () => {
  assert.throws(() => assertValidFormat("transparent", "jpeg"), /requires output_format/);
  assert.doesNotThrow(() => assertValidFormat("transparent", "png"));
  assert.doesNotThrow(() => assertValidFormat("auto", "jpeg"));
});

test("slugify normalizes text", () => {
  assert.equal(slugify("A Red Cat!"), "a-red-cat");
  assert.equal(slugify("***"), "image");
});

test("timestamp formats a date", () => {
  assert.equal(timestamp(new Date(2026, 6, 4, 9, 8, 7)), "20260704-090807");
});

test("resolveFilenames single and multiple", () => {
  const now = new Date(2026, 6, 4, 9, 8, 7);
  assert.deepEqual(resolveFilenames({ prompt: "red cat", count: 1, outputFormat: "png", now }), [
    "red-cat-20260704-090807.png",
  ]);
  assert.deepEqual(resolveFilenames({ filename: "out.png", count: 2, outputFormat: "jpeg", now }), [
    "out-1.jpg",
    "out-2.jpg",
  ]);
});

test("saveBase64Images writes correct bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgtest-"));
  const payload = Buffer.from("hello-png-bytes");
  const data = [{ b64_json: payload.toString("base64"), revised_prompt: "hi" }];
  const now = new Date(2026, 6, 4, 1, 2, 3);
  const saved = saveBase64Images(data, { outputDir: dir, prompt: "hi", outputFormat: "png", now });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].bytes, payload.length);
  assert.equal(saved[0].revised_prompt, "hi");
  assert.deepEqual(fs.readFileSync(saved[0].path), payload);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readImageAsDataUri returns a data URI, but guards extension and existence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgtest-"));
  const png = path.join(dir, "a.png");
  const payload = Buffer.from("png-bytes");
  fs.writeFileSync(png, payload);
  assert.equal(
    readImageAsDataUri(png).dataUri,
    `data:image/png;base64,${payload.toString("base64")}`,
  );

  // A real but non-image file is rejected (blocks reading e.g. a key file).
  const txt = path.join(dir, "secret.txt");
  fs.writeFileSync(txt, "nope");
  assert.throws(() => readImageAsDataUri(txt), /Not an image file/);

  // An image extension that doesn't exist on disk is rejected.
  assert.throws(() => readImageAsDataUri(path.join(dir, "missing.png")), /Image not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("storeBase64Images keeps bytes in the store and returns handles (no disk write)", () => {
  const store = createImageStore();
  const b64 = Buffer.from("img-bytes").toString("base64");
  const now = new Date(2026, 6, 4, 1, 2, 3);
  const [res] = storeBase64Images(store, [{ b64_json: b64, revised_prompt: "hi" }], {
    prompt: "a cat",
    outputFormat: "png",
    now,
  });
  assert.equal(res.path, undefined, "no path when not saved to disk");
  assert.equal(res.filename, "a-cat-20260704-010203.png");
  assert.equal(res.revised_prompt, "hi");
  assert.equal(res.bytes, Buffer.from("img-bytes").length);
  assert.ok(res.id, "returns an in-store id");
  assert.deepEqual(store.get(res.id!), { b64, mimeType: "image/png" });
});

test("generate forwards params to the SDK and returns data", async () => {
  let captured: Record<string, unknown> = {};
  const fake = {
    images: {
      generate: async (p: Record<string, unknown>) => {
        captured = p;
        return { data: [{ b64_json: "AA==" }] };
      },
    },
  } as unknown as OpenAI;
  const data = await generate(fake, "gpt-image-2", {
    prompt: "cat",
    size: "1024x1024",
    quality: "high",
    background: "auto",
    output_format: "png",
    n: 1,
  });
  assert.equal(captured.model, "gpt-image-2");
  assert.equal(captured.prompt, "cat");
  assert.equal(captured.size, "1024x1024");
  assert.equal(data[0].b64_json, "AA==");
});

test("generate forwards moderation and output_compression only when set", async () => {
  let captured: Record<string, unknown> = {};
  const fake = {
    images: {
      generate: async (p: Record<string, unknown>) => {
        captured = p;
        return { data: [{ b64_json: "AA==" }] };
      },
    },
  } as unknown as OpenAI;
  await generate(fake, "gpt-image-2", {
    prompt: "cat",
    size: "1536x864",
    quality: "high",
    background: "auto",
    output_format: "webp",
    n: 1,
    moderation: "low",
    output_compression: 50,
  });
  assert.equal(captured.size, "1536x864");
  assert.equal(captured.moderation, "low");
  assert.equal(captured.output_compression, 50);

  captured = {};
  await generate(fake, "gpt-image-2", {
    prompt: "cat",
    size: "1024x1024",
    quality: "high",
    background: "auto",
    output_format: "png",
    n: 1,
  });
  assert.equal("moderation" in captured, false);
  assert.equal("output_compression" in captured, false);
});

test("edit forwards output_compression but never moderation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgtest-"));
  const imgPath = path.join(dir, "in.png");
  fs.writeFileSync(imgPath, Buffer.from("fake-png-bytes"));
  let captured: Record<string, unknown> = {};
  const fake = {
    images: {
      edit: async (p: Record<string, unknown>) => {
        captured = p;
        return { data: [{ b64_json: "AA==" }] };
      },
    },
  } as unknown as OpenAI;
  await edit(
    fake,
    "gpt-image-2",
    {
      prompt: "blue",
      images: [imgPath],
      size: "1024x1024",
      quality: "high",
      background: "auto",
      output_format: "webp",
      n: 1,
      output_compression: 30,
      moderation: "low",
    },
    createImageStore(),
  );
  assert.equal(captured.output_compression, 30);
  assert.equal("moderation" in captured, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("generate rejects transparent+jpeg before calling the SDK", async () => {
  let called = false;
  const fake = {
    images: {
      generate: async () => {
        called = true;
        return { data: [] };
      },
    },
  } as unknown as OpenAI;
  await assert.rejects(
    generate(fake, "d", {
      prompt: "x",
      size: "auto",
      quality: "auto",
      background: "transparent",
      output_format: "jpeg",
      n: 1,
    }),
    /requires output_format/,
  );
  assert.equal(called, false);
});

test("edit validates input files before calling the SDK", async () => {
  let called = false;
  const fake = {
    images: {
      edit: async () => {
        called = true;
        return { data: [] };
      },
    },
  } as unknown as OpenAI;
  await assert.rejects(
    edit(
      fake,
      "d",
      {
        prompt: "x",
        images: ["/no/such.png"],
        size: "auto",
        quality: "auto",
        background: "auto",
        output_format: "png",
        n: 1,
      },
      createImageStore(),
    ),
    /Input image not found/,
  );
  assert.equal(called, false);
});

test("edit resolves an in-store image id without reading disk", async () => {
  const store = createImageStore();
  const id = store.put(Buffer.from("stored-bytes").toString("base64"), "image/png");
  let captured: Record<string, unknown> = {};
  const fake = {
    images: {
      edit: async (p: Record<string, unknown>) => {
        captured = p;
        return { data: [{ b64_json: "AA==" }] };
      },
    },
  } as unknown as OpenAI;
  await edit(
    fake,
    "d",
    {
      prompt: "add snow",
      images: [id],
      size: "auto",
      quality: "auto",
      background: "auto",
      output_format: "png",
      n: 1,
    },
    store,
  );
  const files = captured.image as Array<{ type?: string; name?: string }>;
  assert.equal(files.length, 1);
  assert.equal(files[0].type, "image/png");
  assert.match(files[0].name ?? "", /^img-1\.png$/);
});

test("clientOptions uses the endpoint as-is with no api-version query", () => {
  const endpoint = "https://x.openai.azure.com/openai/v1";
  const o = clientOptions({ AZURE_OPENAI_ENDPOINT: endpoint, AZURE_OPENAI_API_KEY: "k" });
  assert.equal(o.baseURL, endpoint);
  assert.equal(o.apiKey, "k");
  assert.equal("defaultQuery" in o, false);
});

test("clientOptions falls back to an Entra token provider when no key is set", () => {
  const endpoint = "https://x.openai.azure.com/openai/v1";
  const o = clientOptions({ AZURE_OPENAI_ENDPOINT: endpoint });
  assert.equal(o.baseURL, endpoint);
  assert.equal(typeof o.apiKey, "function");
});

test("clientOptions ignores a placeholder key and uses Entra instead", () => {
  const o = clientOptions({
    AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com/openai/v1",
    AZURE_OPENAI_API_KEY: "${AZURE_OPENAI_API_KEY}",
  });
  assert.equal(typeof o.apiKey, "function");
});

test("saveBase64Images throws when b64_json is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgtest-"));
  assert.throws(
    () =>
      saveBase64Images([{}], { outputDir: dir, prompt: "x", outputFormat: "png", now: new Date() }),
    /missing base64/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("toImageFile sets the mimetype from the file extension", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgtest-"));
  const p = path.join(dir, "pic.webp");
  fs.writeFileSync(p, Buffer.from("x"));
  const f = await toImageFile(p);
  assert.equal(f.type, "image/webp");
  assert.equal(f.name, "pic.webp");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("generateStream sets stream params and translates events to frames", async () => {
  const events = [
    { type: "image_generation.partial_image", partial_image_index: 0, b64_json: "AA==" },
    { type: "image_generation.partial_image", partial_image_index: 1, b64_json: "BB==" },
    { type: "image_generation.completed", b64_json: "CC==" },
  ];
  let captured: Record<string, unknown> = {};
  let requestSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const fake = {
    images: {
      generate: async (p: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        captured = p;
        requestSignal = options?.signal;
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  } as unknown as OpenAI;
  const frames = [];
  for await (const f of generateStream(
    fake,
    "gpt-image-2",
    {
      prompt: "cat",
      size: "1024x1024",
      quality: "low",
      background: "auto",
      output_format: "png",
      n: 1,
      partial_images: 2,
    },
    controller.signal,
  )) {
    frames.push(f);
  }
  assert.equal(captured.stream, true);
  assert.equal(captured.partial_images, 2);
  assert.equal(captured.n, 1);
  assert.equal(requestSignal, controller.signal);
  assert.deepEqual(frames, [
    { kind: "partial", index: 0, b64: "AA==" },
    { kind: "partial", index: 1, b64: "BB==" },
    { kind: "final", index: 0, b64: "CC==" },
  ]);
});

test("editStream loads files, sets stream params, and translates edit events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgtest-"));
  const imgPath = path.join(dir, "in.png");
  fs.writeFileSync(imgPath, Buffer.from("fake-png-bytes"));
  const events = [
    { type: "image_edit.partial_image", partial_image_index: 0, b64_json: "AA==" },
    { type: "image_edit.completed", b64_json: "ZZ==" },
  ];
  let captured: Record<string, unknown> = {};
  let requestSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const fake = {
    images: {
      edit: async (p: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        captured = p;
        requestSignal = options?.signal;
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  } as unknown as OpenAI;
  const frames = [];
  for await (const f of editStream(
    fake,
    "gpt-image-2",
    {
      prompt: "make it blue",
      images: [imgPath],
      size: "1024x1024",
      quality: "low",
      background: "auto",
      output_format: "png",
      n: 1,
      partial_images: 1,
    },
    createImageStore(),
    controller.signal,
  )) {
    frames.push(f);
  }
  assert.equal(captured.stream, true);
  assert.equal(captured.partial_images, 1);
  assert.equal(captured.n, 1);
  assert.equal(requestSignal, controller.signal);
  assert.ok(Array.isArray(captured.image) && (captured.image as unknown[]).length === 1);
  assert.deepEqual(frames, [
    { kind: "partial", index: 0, b64: "AA==" },
    { kind: "final", index: 0, b64: "ZZ==" },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});
