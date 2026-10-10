import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";
import { encodeVector, scoringVector, storedVector } from "../../../src/core/store/vector-codec.ts";
import { cosineSimilarity } from "../../../src/core/vector.ts";

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

test("scoring borrows only the aligned projected byte range on a little-endian host", () => {
  const buffer = new ArrayBuffer(24);
  const bytes = new Uint8Array(buffer, 4, 8);
  bytes.set(encodeVector([0.25, -0.5]));
  const row = { ve_vector: bytes };
  const result = scoringVector(row, "ve_");
  assert.deepEqual(Array.from(result), storedVector(row, "ve_"));
  if (littleEndian) {
    assert.ok(result instanceof Float32Array);
    assert.equal(result.buffer, buffer);
    assert.equal(result.byteOffset, bytes.byteOffset);
    assert.equal(result.length, 2);
  } else {
    assert.ok(Array.isArray(result));
  }
});

test("scoring keeps projected NULL/type/JSON precedence and legacy separate-column fallback", () => {
  const rows: Parameters<typeof scoringVector>[0][] = [
    { ve_vector: null, ve_vector_blob: encodeVector([9]), ve_vector_json: "[8]" },
    { ve_vector: 123, ve_vector_blob: encodeVector([9]) },
    { ve_vector: '[1,"x",null,2]' },
    { ve_vector: "not JSON" },
    { ve_vector_blob: encodeVector([1, 2]), ve_vector_json: "[9]" },
    { ve_vector_blob: null, ve_vector_json: "[3,4]" },
    { ve_vector_blob: "mistyped blob", ve_vector_json: "[5,6]" },
    {},
  ];
  for (const row of rows) {
    const result = scoringVector(row, "ve_");
    assert.ok(Array.isArray(result));
    assert.deepEqual(result, storedVector(row, "ve_"));
  }
});

test("unaligned and partial float payloads retain the decoder's truncation behavior", () => {
  const original = encodeVector([0.25, -0.5]);
  const offset = new Uint8Array(9);
  offset.set(original, 1);
  const partial = new Uint8Array(11);
  partial.set(original);
  for (const bytes of [offset.subarray(1), partial, new Uint8Array(3)]) {
    const row = { vector: bytes };
    const result = scoringVector(row);
    assert.ok(Array.isArray(result));
    assert.deepEqual(result, storedVector(row));
  }
});

test("shared and resizable buffers keep snapshot decoding rather than borrowed scoring views", () => {
  const shared = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const resizable = Reflect.construct(ArrayBuffer, [8, { maxByteLength: 16 }]) as ArrayBuffer;
  assert.equal(Reflect.get(resizable, "resizable"), true);
  for (const buffer of [shared.buffer, resizable]) {
    const bytes = new Uint8Array(buffer, 0, 8);
    bytes.set(encodeVector([0.25, -0.5]));
    const result = scoringVector({ vector: bytes });
    assert.ok(Array.isArray(result));
    bytes.fill(0);
    assert.deepEqual(result, [0.25, -0.5]);
  }
});

test("native SQLite BLOB scoring survives statement reuse, row deletion and database close", () => {
  const db = new DatabaseSync(":memory:");
  let closed = false;
  try {
    db.exec("CREATE TABLE vectors(id INTEGER PRIMARY KEY, vector BLOB)");
    const insert = db.prepare("INSERT INTO vectors(id, vector) VALUES (?, ?)");
    insert.run(1, encodeVector([0.25, -0.5]));
    insert.run(2, encodeVector([0.75, -0.25]));
    const query = db.prepare("SELECT vector FROM vectors WHERE id = ?");
    const row = query.get(1)!;
    assert.ok(row.vector instanceof Uint8Array);
    const result = scoringVector({ vector: row.vector });
    query.get(2);
    db.exec("DELETE FROM vectors");
    db.close();
    closed = true;
    assert.deepEqual(Array.from(result), [0.25, -0.5]);
    assert.equal(cosineSimilarity([0.25, -0.5], result), 1);
  } finally {
    if (!closed) db.close();
  }
});

test("a private WASM heap view is consumed synchronously and is not a durable snapshot", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const bytes = new Uint8Array(memory.buffer, 0, 8);
  bytes.set(encodeVector([0.25, -0.5]));
  const row = { vector: bytes };
  const snapshot = storedVector(row);
  const result = scoringVector(row);
  assert.equal(cosineSimilarity(snapshot, result), 1);
  if (littleEndian) {
    assert.ok(result instanceof Float32Array);
    assert.equal(result.buffer, memory.buffer);
  }
  memory.grow(1);
  assert.deepEqual(snapshot, [0.25, -0.5]);
  if (littleEndian) assert.equal(result.length, 0);
});

test("Float32 edge values preserve exact cosine results and do not mutate stored bytes", () => {
  for (const values of [
    [0, -0, 1e-40, -1e-40, 0.1],
    [1, -1, 0.125, 0.25, 0.5],
    [0, 0, 0, 0, 0],
    [NaN, Infinity, -Infinity, 0, 1],
    [],
  ]) {
    const bytes = new Uint8Array(encodeVector(values));
    const before = bytes.slice();
    const row = { vector: bytes };
    const decoded = storedVector(row);
    const result = scoringVector(row);
    assert.deepEqual(Array.from(result), decoded);
    assert.ok(Object.is(cosineSimilarity(values, result), cosineSimilarity(values, decoded)));
    assert.equal(cosineSimilarity([1], result), 0);
    assert.deepEqual(bytes, before);
    assert.ok(Array.isArray(storedVector(row)));
  }
});

class InspectableStore extends NmgStore {
  get database(): DatabaseSync {
    return this.db;
  }
}

test("record scoring keeps ordering and all scores identical to decoder fallback without changing public arrays", (t) => {
  const store = new InspectableStore(":memory:");
  try {
    const records = store.rememberMany(
      Array.from({ length: 8 }, (_, index) => ({
        statement: `scoring corpus entry ${index}`,
        nodeName: `corpus ${index % 2}`,
        tier: 2,
        scope: { item: String(index) },
      })),
    );
    const vectors = records.map((record, index) => ({
      memoryId: record.memory.id,
      vector: Array.from(
        { length: 1024 },
        (_, dimension) => Math.sin((index + 1) * (dimension + 1)) * 0.03,
      ),
    }));
    store.upsertExternalEmbeddings("qwen-scoring-fixture", vectors);
    const query = vectors[0]!.vector;
    const payloads = () =>
      store.database
        .prepare(
          "SELECT memory_id, model, hex(vector_blob) AS bytes, vector_json, updated_at FROM memory_embeddings ORDER BY memory_id, model",
        )
        .all();
    const before = payloads();
    const modes = ["qwen3", "hybrid", "hashing"] as const;
    const search = (retrievalMode: (typeof modes)[number]) =>
      store.searchByVector("scoring corpus", query, "qwen-scoring-fixture", {
        retrievalMode,
        maxTier: 3,
      });
    const optimized = modes.map(search);
    for (const results of optimized) assert.ok(results.length > 0);
    const prepare = store.database.prepare.bind(store.database);
    t.mock.method(store.database, "prepare", (sql: string) => {
      const statement = prepare(sql);
      if (sql.includes("AS ve_vector")) {
        const all = statement.all.bind(statement);
        t.mock.method(statement, "all", (...parameters: Parameters<typeof all>) =>
          all(...parameters).map((row) => {
            if (!(row.ve_vector instanceof Uint8Array)) return row;
            const unaligned = new Uint8Array(row.ve_vector.byteLength + 1);
            unaligned.set(row.ve_vector, 1);
            return { ...row, ve_vector: unaligned.subarray(1) };
          }),
        );
      }
      return statement;
    });
    modes.forEach((mode, index) => assert.deepEqual(search(mode), optimized[index]));
    const exported = store.storedEmbeddings("qwen-scoring-fixture");
    assert.ok(exported.every((row) => Array.isArray(row.vector)));
    assert.equal(exported.length, records.length);
    assert.deepEqual(payloads(), before);
  } finally {
    store.close();
  }
});
