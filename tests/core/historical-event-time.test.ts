import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { eventTimeMillis } from "../../src/core/event-time.ts";
import { newMemory, validateMemoryInput } from "../../src/core/memory/model.ts";
import { NmgStore } from "../../src/core/store.ts";
import type { RememberInput } from "../../src/core/types.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

const historical = {
  statement: "我昨天买了辆车",
  nodeName: "出行",
  eventTime: "昨天",
  referenceTime: "2025-05-10T00:30:00+08:00",
  timeZone: "Asia/Shanghai",
};

test("portable writes keep historical event dates independent of ingestion clock and host zone", () => {
  const module = new URL("../../src/core/memory/model.ts", import.meta.url).href;
  const script = `import { newMemory } from ${JSON.stringify(module)};
    const input = ${JSON.stringify(historical)};
    const writes = ['2026-01-01T00:00:00.000Z', '2027-09-30T16:30:00.000Z'];
    console.log(JSON.stringify(writes.map(now => {
      const memory = newMemory(input, 'memory', 'node', 'history', now);
      return [memory.eventTime, memory.createdAt];
    })));`;
  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: zone },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(
      JSON.parse(child.stdout),
      [
        ["2025-05-09T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
        ["2025-05-09T00:00:00.000Z", "2027-09-30T16:30:00.000Z"],
      ],
      zone,
    );
  }
});

test("store writes use the source offset when no named zone is supplied", () => {
  const store = new NmgStore(":memory:");
  try {
    const before = Date.now();
    const result = store.remember({ ...historical, timeZone: undefined });
    assert.equal(result.memory.eventTime, "2025-05-09T00:00:00.000Z");
    assert.ok(Date.parse(result.memory.createdAt) >= before);
    assert.ok(Date.parse(result.history.createdAt) >= before);
    assert.deepEqual(
      store
        .search(historical.statement, {
          eventTimeFrom: "2025-05-09",
          eventTimeTo: "2025-05-09",
          interpretTemporalQuery: false,
        })
        .map((row) => row.memory.id),
      [result.memory.id],
    );
  } finally {
    store.close();
  }
});

test("named source zones follow DST calendar boundaries while hour offsets use elapsed time", () => {
  const input = {
    ...historical,
    referenceTime: "2025-03-10T03:30:00Z",
    timeZone: "America/New_York",
  };
  const write = (eventTime: string) =>
    newMemory({ ...input, eventTime }, "m", "n", "h", "2026-01-01T00:00:00.000Z").eventTime;
  assert.equal(write("昨天"), "2025-03-08T00:00:00.000Z");
  assert.equal(write("上周三"), "2025-02-26T00:00:00.000Z");
  assert.equal(write("2小时前"), "2025-03-10T01:30:00.000Z");
  assert.equal(write("2 hours ago"), "2025-03-10T01:30:00.000Z");
  assert.equal(write("刚才"), "2025-03-10T03:30:00.000Z");
  assert.equal(write("2024-07-01"), "2024-07-01T00:00:00.000Z");
});

test("invalid replay context fails explicitly in both write engines", () => {
  for (const patch of [
    { referenceTime: "昨天" },
    { referenceTime: "2025-05-10T12:00:00" },
    { referenceTime: "2025-02-30T12:00:00Z" },
    { timeZone: "Not/AZone" },
  ]) {
    const input: RememberInput = { ...historical, ...patch };
    assert.throws(() => validateMemoryInput(input), /referenceTime|timeZone/);
    const store = new NmgStore(":memory:");
    try {
      assert.throws(() => store.remember(input), /referenceTime|timeZone/);
      assert.equal(store.search("买车").length, 0);
    } finally {
      store.close();
    }
  }
});

test("an explicit source clock does not infer an event from statement text", () => {
  const memory = newMemory(
    { ...historical, eventTime: undefined },
    "m",
    "n",
    "h",
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(memory.eventTime, null);
});

test("stored relative phrases without a source anchor do not acquire a reading-clock date", () => {
  assert.equal(eventTimeMillis("昨天"), null);
  assert.equal(eventTimeMillis("11月6日"), null);
});

test("legacy unanchored phrases remain discoverable but cannot satisfy temporal SQL bounds", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-legacy-event-"));
  const path = join(directory, "memory.sqlite");
  let store = new NmgStore(path);
  try {
    const record = store.remember({ statement: "LegacyClockMarker", nodeName: "历史" });
    const previous = store.remember({
      statement: "LegacyOldClockMarker",
      nodeName: "old",
      eventTime: "2020-01-01",
    });
    const successor = store.remember({
      statement: "ReplacementClockMarker",
      nodeName: "new",
      eventTime: "2024-01-01",
      supersedesId: previous.memory.id,
    });
    store.close();
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE memory_records SET event_time='昨天' WHERE id=?").run(record.memory.id);
      db.prepare("UPDATE memory_records SET event_time='11月6日' WHERE id=?").run(
        successor.memory.id,
      );
    } finally {
      db.close();
    }
    store = new NmgStore(path);
    assert.equal(store.search("LegacyClockMarker")[0]?.memory.eventTime, "昨天");
    for (const bounds of [{ eventTimeFrom: "1900-01-01" }, { eventTimeTo: "2099-01-01" }])
      assert.ok(
        store
          .search("LegacyClockMarker", bounds)
          .every((row) => ![record.memory.id, successor.memory.id].includes(row.memory.id)),
      );
    assert.deepEqual(
      store
        .search("LegacyOldClockMarker", { eventTimeTo: "2022-01-01", includeHistorical: true })
        .map((row) => row.memory.id),
      [previous.memory.id],
    );
  } finally {
    store.close();
    removeTempDirectory(directory);
  }
});
