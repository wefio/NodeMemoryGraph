import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAmlMultimodalMemory } from "../../src/integration/aml-projection.ts";
import { searchResultFixture } from "../helpers/search-result.ts";
import {
  ContentValidationError,
  describeContent,
  normalizeContent,
} from "../../src/integration/multimodal-content.ts";

const image = {
  type: "image_url" as const,
  image_url: {
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
  },
};

test("plain content remains byte-for-byte text and never invokes vision", async () => {
  const text = "  original text\nlast summer  ";
  assert.equal(normalizeContent(text), text);
  assert.equal(await describeContent(text, async () => assert.fail("no image")), text);
});

test("ordered text/image parts survive normalization without mutation or aliasing", () => {
  const input = [{ type: "text", text: "before" }, image, { type: "text", text: "after" }];
  const before = JSON.stringify(input);
  const content = normalizeContent(input);
  assert.deepEqual(content, input);
  assert.notEqual(content, input);
  assert.equal(JSON.stringify(input), before);
});

test("vision supplies an explicitly derived retrieval view, not a replacement source", async () => {
  const content = normalizeContent([{ type: "text", text: "My diagram" }, image]);
  const original = JSON.stringify(content);
  const urls: string[] = [];
  const view = await describeContent(content, async (url) => {
    urls.push(url);
    return "A red square beside a blue circle.";
  });
  assert.match(view, /My diagram/);
  assert.match(view, /Image.*[a-f0-9]{64}/);
  assert.match(view, /red square beside a blue circle/);
  assert.deepEqual(urls, [image.image_url.url]);
  assert.equal(JSON.stringify(content), original);
});

test("ordered text-only parts need no vision model", async () => {
  const content = normalizeContent([
    { type: "text", text: "alpha" },
    { type: "text", text: "beta" },
  ]);
  assert.match(await describeContent(content, async () => assert.fail("no image")), /alpha\nbeta/);
});

for (const value of [
  null,
  12,
  {},
  [],
  " ",
  [{ type: "audio", data: "unsupported" }],
  [{ type: "text", text: 1 }],
  [{ type: "text", text: " " }],
  [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }],
  [{ type: "image_url", image_url: { url: "data:image/png;base64,bm90LWFuLWltYWdl" } }],
]) {
  test(`invalid or unsupported content fails explicitly: ${JSON.stringify(value)}`, () => {
    assert.throws(() => normalizeContent(value), ContentValidationError);
  });
}

test("image/text/count budgets reject oversized inputs before model invocation", () => {
  assert.throws(() => normalizeContent("abcd", { maxTextChars: 3 }), /limit/i);
  assert.throws(() => normalizeContent([image], { maxImageBytes: 1 }), /limit/i);
  assert.throws(() => normalizeContent([image, image], { maxImages: 1 }), /limit/i);
});

test("multimodal projection preserves ordered original parts and separate historical/storage times", () => {
  const memory = searchResultFixture("image", "Derived image retrieval view").memory;
  memory.eventTime = "2023-01-20";
  const parts = normalizeContent([
    { type: "text", text: "before" },
    image,
    { type: "text", text: "after" },
  ]);
  assert.ok(Array.isArray(parts));
  const original = structuredClone({ memory, parts });
  const ordinary = projectAmlMultimodalMemory(memory, "Which picture?", 0.5, parts);
  assert.deepEqual(ordinary.content, parts);
  const temporal = projectAmlMultimodalMemory(memory, "When was this shared?", 0.5, parts);
  assert.deepEqual(temporal.content, [{ type: "text", text: "[Timestamp: 2023-01-20]" }, ...parts]);
  assert.equal(temporal.event_time, memory.eventTime);
  assert.equal(temporal.stored_at, memory.createdAt);
  assert.deepEqual({ memory, parts }, original);
});

test("image projection keeps unknown time unknown and protects withdrawn image evidence", () => {
  const memory = searchResultFixture("withdrawn-image", "private visual description").memory;
  memory.eventTime = null;
  const parts = normalizeContent([image]);
  assert.ok(Array.isArray(parts));
  const row = projectAmlMultimodalMemory(memory, "When?", 1, parts);
  assert.deepEqual(row.content, parts);
  assert.equal(row.created_at, undefined);
  memory.markers = [{ kind: "forget", attributes: {} }];
  const withdrawn = projectAmlMultimodalMemory(memory, "When?", 1, parts);
  assert.doesNotMatch(JSON.stringify(withdrawn), /private visual description|data:image/u);
});

test("supplied image captions form a retrieval view without a vision model", async () => {
  const content = normalizeContent([
    { type: "text", text: "A green triangle named Juniper." },
    image,
    { type: "text", text: "Original trailing evidence." },
  ]);
  const original = structuredClone(content);
  const view = await describeContent(content);
  assert.match(view, /A green triangle named Juniper\./);
  assert.match(view, /Original trailing evidence\./);
  assert.match(view, /\[Image [a-f0-9]{64}\]/);
  assert.doesNotMatch(view, /data:image|derived description/);
  assert.deepEqual(content, original);
  assert.equal(await describeContent(content), view);
});

test("images without a supplied caption retain an opaque source reference, not an invented description", async () => {
  const content = normalizeContent([image]);
  const view = await describeContent(content);
  assert.match(view, /^\[Image [a-f0-9]{64}\]$/);
  assert.equal(await describeContent(content), view);
  assert.deepEqual(content, [image]);
});

test("an explicitly enabled image describer must return a nonempty description", async () => {
  const content = normalizeContent([image]);
  await assert.rejects(() => describeContent(content, async () => " "), /empty|nonempty/i);
});
