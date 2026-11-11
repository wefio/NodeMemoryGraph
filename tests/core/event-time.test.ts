import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  eventTimeMillis,
  eventWindowEnd,
  eventWindowStart,
  extractChineseEventWindow,
  normalizeEventTime,
  parseEventTime,
} from "../../src/core/event-time.ts";
import { NmgStore } from "../../src/core/store.ts";
import { migrate } from "../../src/core/store/schema.ts";

const NOW = new Date("2026-11-07T10:30:00+08:00");

test("normalizeEventTime keeps a canonical instant byte for byte", () => {
  assert.equal(normalizeEventTime("2026-09-19T21:31:55.000Z", NOW), "2026-09-19T21:31:55.000Z");
});

test("normalizeEventTime resolves every accepted date shape to one form", () => {
  const canonical = "2026-11-06T00:00:00.000Z";
  for (const raw of ["2026-11-06", "2026/11/6", "2026.11.6", "2026年11月6日", "2026年11月6号"]) {
    assert.equal(normalizeEventTime(raw, NOW), canonical, raw);
  }
  assert.equal(normalizeEventTime("2026年11月6日 14:30", NOW), "2026-11-06T14:30:00.000Z");
  assert.equal(normalizeEventTime("2026/11/6 14:30", NOW), "2026-11-06T14:30:00.000Z");
});

test("normalizeEventTime converts a zone offset to UTC", () => {
  assert.equal(normalizeEventTime("2026-09-19T21:31:55+08:00", NOW), "2026-09-19T13:31:55.000Z");
});

test("normalizeEventTime infers the year of a bare month-day", () => {
  assert.equal(normalizeEventTime("11月6日", NOW), "2026-11-06T00:00:00.000Z");
  // A month-day still ahead of the clock means the previous year.
  assert.equal(normalizeEventTime("12月25日", NOW), "2025-12-25T00:00:00.000Z");
});

test("normalizeEventTime resolves Chinese relative phrases against the clock", () => {
  assert.equal(normalizeEventTime("今天", NOW), "2026-11-07T00:00:00.000Z");
  assert.equal(normalizeEventTime("昨天", NOW), "2026-11-06T00:00:00.000Z");
  assert.equal(normalizeEventTime("前天", NOW), "2026-11-05T00:00:00.000Z");
  assert.equal(normalizeEventTime("上周三", NOW), "2026-10-28T00:00:00.000Z");
  assert.equal(normalizeEventTime("本周一", NOW), "2026-11-02T00:00:00.000Z");
  assert.equal(normalizeEventTime("上个月", NOW), "2026-10-01T00:00:00.000Z");
  assert.equal(normalizeEventTime("去年", NOW), "2025-01-01T00:00:00.000Z");
  assert.equal(normalizeEventTime("三天前", NOW), "2026-11-04T00:00:00.000Z");
  assert.equal(normalizeEventTime("两周以前", NOW), "2026-10-24T00:00:00.000Z");
  assert.equal(normalizeEventTime("3个月前", NOW), "2026-08-01T00:00:00.000Z");
});

test("normalizeEventTime resolves English relative phrases", () => {
  assert.equal(normalizeEventTime("yesterday", NOW), "2026-11-06T00:00:00.000Z");
  assert.equal(normalizeEventTime("3 days ago", NOW), "2026-11-04T00:00:00.000Z");
  assert.equal(normalizeEventTime("last month", NOW), "2026-10-01T00:00:00.000Z");
});

test("normalizeEventTime refuses what is not a date", () => {
  assert.equal(normalizeEventTime("傍晚", NOW), null);
  assert.equal(normalizeEventTime("2026年2月31日", NOW), null);
  assert.equal(normalizeEventTime("2026-13-01", NOW), null);
  assert.equal(normalizeEventTime("", NOW), null);
  assert.equal(normalizeEventTime(undefined, NOW), null);
});

test("parseEventTime reports the granularity the phrase stated", () => {
  assert.equal(parseEventTime("2026年11月", NOW)?.granularity, "month");
  assert.equal(parseEventTime("2026年", NOW)?.granularity, "year");
  assert.equal(parseEventTime("2026年11月6日 09:15", NOW)?.granularity, "minute");
});

test("window bounds cover the whole stated grain", () => {
  assert.equal(eventWindowStart("2026年11月6日", NOW), "2026-11-06T00:00:00.000Z");
  assert.equal(eventWindowEnd("2026年11月6日", NOW), "2026-11-06T23:59:59.999Z");
  assert.equal(eventWindowEnd("上个月", NOW), "2026-10-31T23:59:59.999Z");
  assert.equal(eventWindowEnd("2026年11月", NOW), "2026-11-30T23:59:59.999Z");
  assert.equal(eventWindowEnd("2026年", NOW), "2026-12-31T23:59:59.999Z");
  assert.equal(eventWindowEnd("2026-11-06T09:15:00.000Z", NOW), "2026-11-06T09:15:00.000Z");
  assert.equal(eventWindowStart("傍晚", NOW), null);
});

test("eventTimeMillis compares legacy shapes through the canonical form", () => {
  assert.equal(
    eventTimeMillis("2026-09-19T21:31:55+08:00", NOW),
    Date.parse("2026-09-19T13:31:55.000Z"),
  );
  assert.equal(eventTimeMillis("2026-09-19", NOW), Date.parse("2026-09-19T00:00:00.000Z"));
  assert.equal(eventTimeMillis("傍晚", NOW), null);
});

test("extractChineseEventWindow leaves an intent-free statement alone", () => {
  assert.deepEqual(extractChineseEventWindow("安静的房间", NOW), {});
  assert.deepEqual(extractChineseEventWindow("把 2026年11月6日 记下来", NOW), {});
});

test("extractChineseEventWindow reads 之前/之后 as an open side", () => {
  assert.deepEqual(extractChineseEventWindow("9月19日之后发生了什么", NOW), {
    from: "2026-09-19T00:00:00.000Z",
  });
  assert.deepEqual(extractChineseEventWindow("9月19日之前去过哪里", NOW), {
    to: "2026-09-19T23:59:59.999Z",
  });
});

test("a Chinese event time is accepted on write and found by its window", () => {
  const store = new NmgStore(":memory:");
  try {
    const record = store.remember({
      statement: "在东京见了客户",
      nodeName: "行程",
      eventTime: "2026年9月19日",
    });
    assert.equal(record.memory.eventTime, "2026-09-19T00:00:00.000Z");
    const hit = store.search("东京 客户", {
      eventTimeFrom: "2026-09-19",
      eventTimeTo: "2026-09-19",
    });
    assert.deepEqual(
      hit.map((result) => result.memory.id),
      [record.memory.id],
    );
    assert.deepEqual(
      store.search("东京 客户", { eventTimeFrom: "2026-09-20" }).map((result) => result.memory.id),
      [],
    );
  } finally {
    store.close();
  }
});

test("reopening a store repairs event times written before canonicalization", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    for (const [id, value] of [
      ["legacy-day", "2026-10-13"],
      ["legacy-offset", "2026-09-19T21:31:55+08:00"],
      ["legacy-canonical", "2026-09-19T13:31:55.000Z"],
      ["legacy-garbage", "傍晚"],
      ["legacy-relative", "昨天"],
      ["legacy-yearless", "11月6日"],
    ] as const) {
      db.prepare(
        `INSERT INTO history_records (id, session_id, role, content, created_at)
         VALUES (?, NULL, 'user', 'content', '2026-01-01T00:00:00.000Z')`,
      ).run(`h-${id}`);
      db.prepare(
        `INSERT INTO memory_nodes (id, canonical_name, kind, summary, created_at, updated_at)
         VALUES (?, ?, 'topic', 'summary', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(`n-${id}`, `node ${id}`);
      db.prepare(
        `INSERT INTO memory_records
           (id, node_id, evidence_id, statement, event_time, valid_from, tier, importance, created_at)
         VALUES (?, ?, ?, 'statement', ?, ?, 1, 0.5, '2026-01-01T00:00:00.000Z')`,
      ).run(id, `n-${id}`, `h-${id}`, value, value);
    }
    migrate(db);
    const read = (id: string) =>
      db
        .prepare("SELECT event_time AS t, valid_from AS v FROM memory_records WHERE id = ?")
        .get(id) as { t: string; v: string };
    assert.equal(read("legacy-day").t, "2026-10-13T00:00:00.000Z");
    assert.equal(read("legacy-offset").t, "2026-09-19T13:31:55.000Z");
    assert.equal(read("legacy-offset").v, "2026-09-19T13:31:55.000Z");
    assert.equal(read("legacy-canonical").t, "2026-09-19T13:31:55.000Z");
    // Unparseable text keeps the author's words: repair never rewrites meaning.
    assert.equal(read("legacy-garbage").t, "傍晚");
    assert.equal(read("legacy-relative").t, "昨天");
    assert.equal(read("legacy-relative").v, "昨天");
    assert.equal(read("legacy-yearless").t, "11月6日");
    // The guard must skip repaired rows, or every open rewrites the whole table.
    const stale = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_records WHERE event_time NOT GLOB '????-??-??T??:??:??.???Z'",
      )
      .get() as { n: number };
    assert.equal(stale.n, 3, "unanchored and unparseable values keep their source text");
  } finally {
    db.close();
  }
});
