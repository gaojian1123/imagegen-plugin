// A tiny in-memory store for generated image bytes. The App UI fetches bytes via
// read_image({ id }); any client can pass the same session id to edit_image.
export interface ImageStore {
  put(b64: string, mimeType: string): string;
  get(id: string): { b64: string; mimeType: string } | undefined;
}

// ponytail: bounded FIFO — keeps the last `cap` images and evicts the oldest. A
// single-user local server won't generate enough to matter; the UI reads an id
// right after the tool returns. Raise cap or add TTL eviction only if long
// sessions balloon memory.
export function createImageStore(cap = 24): ImageStore {
  const map = new Map<string, { b64: string; mimeType: string }>();
  let seq = 0;
  return {
    put(b64, mimeType) {
      const id = `img-${++seq}`;
      map.set(id, { b64, mimeType });
      if (map.size > cap) map.delete(map.keys().next().value as string);
      return id;
    },
    get(id) {
      return map.get(id);
    },
  };
}
