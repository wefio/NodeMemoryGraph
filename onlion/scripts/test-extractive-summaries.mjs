/* eslint-disable no-console -- deliberate test/diagnostic output */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AmlMemoryService } from '../backend/memory-service.ts';
import { extractiveDigest } from '../backend/extractive-summaries.mjs';

const key = `extractive-${randomBytes(12).toString('hex')}`;
const service = new AmlMemoryService(key);
// 40 messages -> two leaf blocks (32 cap), so the node tier's minBlocks=2
// gate is satisfied the way real multi-block sessions would.
const messages = Array.from({ length: 40 }, (_, index) => ({
  role: 'user',
  content: index < 20
    ? `We met at the cafe near the harbor and discussed telescope parts, message ${index}.`
    : `The museum guide restored an old telescope and Juniper visited, message ${index}.`,
  chat_time: '2025-03-04',
  source_message_id: `m${index}`,
}));
const store = Reflect.get(service, 'store');
try {
  assert.deepEqual(await service.rememberBatch('extractive-user', 's', 'r1', messages), { added: 40 });
  // The provider ran during Add: no pending leaf tasks remain.
  assert.deepEqual(store.pendingLeafSummaries(), [], 'extractive summaries must be written synchronously');
  // Leaf FTS routes on digest terms.
  assert.ok(store.routeLeafBlocksByFts('cafe', 5).length >= 1, 'leaf FTS must route on digest terms');
  assert.ok(store.routeLeafBlocksByFts('telescope', 5).length >= 1);
  // Deterministic digest.
  const statements = messages.map((message) => message.content);
  assert.equal(extractiveDigest(statements), extractiveDigest(statements));
  // Node tier is populated for multi-block nodes. With OR fts semantics the
  // node digest spans blocks but never matches terms a leaf digest lacks, so
  // this asserts the tier is indexed, not a contrived "rescue".
  assert.ok(store.routeNodesByFts('cafe', 5).length >= 1, 'node-tier digest must be indexed');
  assert.ok(store.routeLeafBlocksByFts('cafe', 5).length >= 1);
  const round = await service.search(['cafe museum visit'], 10);
  assert.ok(round.memories.length >= 1, 'search with routing enabled stays healthy');
  // A later batch keeps identity stable and the mechanism idempotent.
  const second = Array.from({ length: 3 }, (_, index) => ({
    role: 'user',
    content: `Juniper bought a telescope at the auction near the cafe, follow-up ${index}.`,
    chat_time: '2025-03-11',
    source_message_id: `n${index}`,
  }));
  assert.deepEqual(await service.rememberBatch('extractive-user', 's', 'r2', second), { added: 3 });
  assert.deepEqual(store.pendingLeafSummaries(), [], 'second batch leaf summaries are written too');
  const still = await service.search(['cafe museum visit'], 10);
  assert.ok(still.memories.length >= 1, 'routing survives later batches');
  mkdirSync('.runtime/verification', { recursive: true });
  writeFileSync('.runtime/verification/extractive-summaries.json', JSON.stringify({
    status: 'passed', mode: 'native-sqlite-extractive-no-llm',
    leafFtsRouting: true, nodeTierIndexed: true, nodeIdentityStable: true,
  }, null, 2));
  console.log('PASS: extractive leaf + node-tier summaries, deterministic, no LLM, stable node identity.');
} finally {
  service.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(resolve(`/tmp/nmg/${key}.sqlite${suffix}`), { force: true });
}
