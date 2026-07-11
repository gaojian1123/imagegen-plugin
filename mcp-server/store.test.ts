import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createImageStore } from "./store.ts";

test("image store round-trips bytes by id", () => {
  const s = createImageStore();
  const id = s.put("QUJD", "image/png");
  assert.equal(id, "img-1");
  assert.deepEqual(s.get(id), { b64: "QUJD", mimeType: "image/png" });
  assert.equal(s.get("nope"), undefined);
});

test("image store evicts the oldest past its cap", () => {
  const s = createImageStore(2);
  const a = s.put("a", "image/png");
  const b = s.put("b", "image/png");
  const c = s.put("c", "image/png"); // evicts a
  assert.equal(s.get(a), undefined, "oldest evicted");
  assert.ok(s.get(b), "b still present");
  assert.ok(s.get(c), "c still present");
});
