import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";

type Add = {
  request_id: string;
  user_id: string;
  session_id: string;
  messages: {
    role: "user" | "assistant";
    content: string | { type: "text"; text: string }[];
    timestamp: number;
  }[];
};

type Receipt = {
  success: boolean;
  request_id: string;
  user_id: string;
  session_id: string;
  task_id: string;
  status: string;
};

type SearchResult = {
  data: { id: string; content: unknown; score: number }[];
  retrieval_mode: string;
};

const local = process.argv[2] === "--local";
const endpoint = process.env.NMG_ENDPOINT ?? process.argv[2];
const key = local ? "test-key" : (process.env.NMG_API_KEY ?? process.argv[3]);
const timeoutMs = 60_000;

function assertStatus(response: Response, status: number, operation: string): void {
  assert.equal(response.status, status, operation);
}

function matchingEvidence(result: SearchResult, marker: string) {
  return result.data.filter((row) => JSON.stringify(row.content)?.includes(marker));
}

test("NMG HTTP contract", { timeout: 480_000 }, async (t) => {
  assert.ok((local || endpoint) && key, "Set NMG_ENDPOINT and NMG_API_KEY, or pass --local");
  // Register disposal after cleanup so reset requests can reach the Worker.
  let dispose: (() => Promise<void>) | undefined;
  let base: URL;
  if (local) {
    const { createWorkerFixture } = await import("./worker-fixture.mjs");
    const fixture = createWorkerFixture({ bindings: { NMG_ADD_MODE: "log" } });
    dispose = () => fixture.dispose();
    try {
      base = await fixture.ready;
    } catch (error) {
      await dispose();
      throw error;
    }
  } else {
    base = new URL(endpoint!);
  }
  assert.ok(["http:", "https:"].includes(base.protocol) && !base.username && !base.password);

  const id = randomUUID();
  const users = { writer: `smoke-${id}`, other: `smoke-${id}-other` };
  const cleanup = new Set<string>();
  const root = base.href.replace(/\/+$/, "");
  let prefix = local ? "" : "/api";
  const send = (path: string, body?: object, authorization = key) =>
    fetch(`${root}${prefix}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

  const request = (user: string, requestId: string, marker: string, timestamp: number): Add => ({
    user_id: user,
    request_id: requestId,
    session_id: `contract-${id}`,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `The recovery keyword is ${marker}.` }],
        timestamp,
      },
      { role: "assistant", content: "Acknowledged.", timestamp: timestamp + 1 },
    ],
  });

  const add = (input: Add) => {
    cleanup.add(input.user_id);
    return send("/add", input);
  };

  async function receipt(response: Response, expected: Add): Promise<Receipt> {
    assertStatus(response, 200, "Add persisted");
    const body = (await response.json()) as Receipt;
    assert.equal(body.success, true);
    assert.equal(body.status, "completed");
    assert.equal(body.request_id, expected.request_id);
    assert.equal(body.user_id, expected.user_id);
    assert.equal(body.session_id, expected.session_id);
    assert.ok(typeof body.task_id === "string" && body.task_id);
    return body;
  }

  async function search(user: string, query: string, topK = 10): Promise<SearchResult> {
    const started = performance.now();
    const response = await send("/search", { user_id: user, query, top_k: topK });
    assertStatus(response, 200, "Search");
    const body = (await response.json()) as SearchResult;
    assert.ok(Array.isArray(body.data) && body.data.length <= topK);
    assert.equal(typeof body.retrieval_mode, "string");
    assert.ok(body.data.every((row) => typeof row.id === "string" && Number.isFinite(row.score)));
    t.diagnostic(
      `Search top_k=${topK}: ${Math.round(performance.now() - started)} ms (${body.retrieval_mode})`,
    );
    return body;
  }

  t.after(async () => {
    // Attempt cleanup independently so a reset failure for one user cannot block the other.
    const results = await Promise.allSettled(
      [...cleanup].map(async (user) => {
        try {
          const response = await send("/reset", {
            user_id: user,
            confirm_user_id: user,
            reset_id: id,
          });
          assertStatus(response, 200, "Reset synthetic user");
          await response.arrayBuffer();
          assert.deepEqual((await search(user, "recovery keyword")).data, []);
        } catch (error) {
          throw new Error(`Cleanup failed for test user ${user}`, { cause: error });
        }
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Could not reset all synthetic users");
  });
  t.after(() => dispose?.());

  const health = await send("/health", undefined, "");
  if (health.status === 404 && prefix) {
    await health.arrayBuffer();
    prefix = "";
    const fallback = await send("/health", undefined, "");
    assertStatus(fallback, 200, "Unauthenticated health");
    await fallback.arrayBuffer();
  } else {
    assertStatus(health, 200, "Unauthenticated health");
    await health.arrayBuffer();
  }

  await t.test("missing and invalid credentials are rejected", async () => {
    const query = { user_id: users.writer, query: "recovery keyword", top_k: 1 };
    for (const badKey of ["", randomUUID()]) {
      const denied = await send("/search", query, badKey);
      assertStatus(denied, 401, "Search authorization");
      await denied.arrayBuffer();
    }
  });

  await t.test("out-of-order Add is immediately visible and idempotent per user", async () => {
    const earlyMarker = "amethystfalcon";
    const lateMarker = "copperkestrel";
    const early = request(users.writer, "r1", earlyMarker, 1700000000000);
    const late = request(users.writer, "r2", lateMarker, 1700000100000);
    const started = performance.now();
    await receipt(await add(late), late);
    const [one, two] = await Promise.all([add(early), add(early)]);
    const original = await receipt(one, early);
    assert.deepEqual(await receipt(two, early), original);
    assert.equal(matchingEvidence(await search(users.writer, earlyMarker), earlyMarker).length, 1);
    t.diagnostic(
      `Add sequence through first confirmed search: ${Math.round(performance.now() - started)} ms`,
    );
    const olderArrival = matchingEvidence(await search(users.writer, lateMarker), lateMarker);
    assert.equal(olderArrival.length, 1);
    if (local) assert.match(olderArrival[0].id, /^pending:/);
    assert.equal(
      matchingEvidence(await search(users.writer, lateMarker, 1), lateMarker).length,
      1,
      "top_k=1 must rank both pending writes before limiting the result to one",
    );

    const other = request(users.other, early.request_id, "violetheron", 1700000000000);
    await receipt(await add(other), other);
    assert.equal(
      matchingEvidence(await search(users.other, "violetheron", 1), "violetheron").length,
      1,
    );
    assert.equal(
      matchingEvidence(await search(users.writer, "violetheron"), "violetheron").length,
      0,
    );
    assert.equal(matchingEvidence(await search(users.other, earlyMarker), earlyMarker).length, 0);

    const conflict = await add(
      request(users.writer, early.request_id, "changedpayload", 1700000000000),
    );
    assertStatus(conflict, 409, "Same ID with different content");
    const error = (await conflict.json()) as { error: { code: string } };
    assert.equal(error.error.code, "request_id_reused");

    const capacity = await send(`/capacity?user_id=${encodeURIComponent(users.writer)}`);
    assertStatus(capacity, 200, "Capacity");
    const usage = (await capacity.json()) as {
      sqlite_bytes?: { used: number };
      pending_entries?: number;
    };
    assert.ok((usage.sqlite_bytes?.used ?? 0) > 0 || (usage.pending_entries ?? 0) > 0);
  });

  await t.test(
    "HTTP 429 and a disconnected Add response recover with the same id",
    async (retryTest) => {
      const marker = "silverkite";
      const input = request(users.writer, "r-retry", marker, 1700000200000);
      const payload = JSON.stringify(input);
      const arrivals: number[] = [];
      let committed: Receipt | undefined;
      let forwardingError: unknown;
      // Inject faults outside the service. The relay drops the second response
      // only after the actual endpoint has returned a successful receipt.
      const relay = createServer(async (incoming, outgoing) => {
        try {
          const attempt = arrivals.push(performance.now());
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(chunk);
          assert.equal(Buffer.concat(chunks).toString(), payload);
          if (attempt === 1) {
            outgoing.writeHead(429, { "Retry-After": "1" }).end();
            return;
          }
          const result = await receipt(await add(input), input);
          if (attempt === 2) {
            committed = result;
            outgoing.destroy();
            return;
          }
          outgoing
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(result));
        } catch (error) {
          forwardingError = error;
          outgoing.destroy();
        }
      });
      retryTest.after(() => {
        relay.close();
        relay.closeAllConnections();
      });
      relay.listen(0, "127.0.0.1");
      await once(relay, "listening");
      const address = relay.address();
      assert.ok(address && typeof address !== "string");
      const deliver = () =>
        fetch(`http://127.0.0.1:${address.port}/add`, {
          method: "POST",
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      const limited = await deliver();
      assertStatus(limited, 429, "Injected rate limit");
      const retryAfter = Number(limited.headers.get("retry-after"));
      assert.ok(retryAfter > 0);
      await limited.arrayBuffer();
      await wait(retryAfter * 1000);
      await assert.rejects(deliver(), { name: "TypeError" });
      if (forwardingError) throw forwardingError;
      assert.ok(committed, "Upstream Add completed before the downstream socket closed");
      assert.ok(arrivals[1] - arrivals[0] >= retryAfter * 1000 - 1);
      assert.equal(matchingEvidence(await search(users.writer, marker), marker).length, 1);
      assert.deepEqual(await receipt(await deliver(), input), committed);
      assert.equal(arrivals.length, 3);
      assert.equal(matchingEvidence(await search(users.writer, marker), marker).length, 1);
    },
  );
});
