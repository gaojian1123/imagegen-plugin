// Dev-only: a fake stand-in for the OpenAI image client so the app can be tested
// with no Azure and no network. Produces small PNGs that visibly "resolve"
// left-to-right, and honors stream + partial_images so streamed partials arrive
// over time. Shared by scripts/dev-host.mjs and scripts/dev-check.mjs.
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal truecolor-RGB PNG encoder (no deps). rgb(x, y) -> [r, g, b].
function png(width, height, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

// A frame that resolves left-to-right as fraction (0..1) grows; the pending area
// shifts shade per frame so consecutive partials look different.
export function frame(fraction, seed) {
  const W = 320;
  const H = 320;
  return png(W, H, (x, y) => {
    if (x < W * fraction) return [Math.round((255 * x) / W), Math.round((255 * y) / H), 150];
    const g = 30 + ((seed * 17) % 40);
    return [g, g, g];
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function* fakeStream(total, kind, stepMs) {
  for (let i = 0; i < total - 1; i++) {
    await delay(stepMs);
    yield {
      type: `image_${kind}.partial_image`,
      partial_image_index: i,
      b64_json: frame((i + 1) / total, i),
    };
  }
  await delay(stepMs);
  yield { type: `image_${kind}.completed`, b64_json: frame(1, 99) };
}

// Only images.generate / images.edit — the surface client.ts actually calls.
// STEP_MS spaces the streamed frames so a 500ms UI poll can catch each one.
export function createFakeClient(stepMs = 450) {
  return {
    images: {
      async generate(body) {
        if (body.stream) return fakeStream((body.partial_images ?? 0) + 1, "generation", stepMs);
        const n = body.n ?? 1;
        return {
          data: Array.from({ length: n }, (_, i) => ({
            b64_json: frame(1, i),
            revised_prompt: `fake: ${body.prompt}`,
          })),
        };
      },
      async edit(params) {
        if (params.stream) return fakeStream((params.partial_images ?? 0) + 1, "edit", stepMs);
        return { data: [{ b64_json: frame(1, 7), revised_prompt: `fake edit: ${params.prompt}` }] };
      },
    },
  };
}
