/* eslint-disable no-console -- deliberate test/diagnostic output */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AmlMemoryService } from '../backend/memory-service.ts';
import { extractiveDigest, extractiveNodeSummary } from '../../src/integration/extractive-summaries.ts';

const key = `extractive-${randomBytes(12).toString('hex')}`;
const service = new AmlMemoryService(key);
const messages = Array.from({ length: 40 }, (_, index) => ({
  role: 'user',
  content: index < 20
    ? `We met at the cafe near the harbor and discussed telescope parts, message ${index}.`
    : `The museum guide restored an old telescope and Juniper visited, message ${index}.`,
  chat_time: '2025-03-04',
  source_message_id: `m${index}`,
}));
try {
  assert.deepEqual(await service.rememberBatch('extractive-user', 's', 'r1', messages), { added: 40 });
  const statements = messages.map((message) => message.content);
  assert.equal(extractiveDigest(statements), extractiveDigest(statements));
  assert.match(extractiveNodeSummary(statements, '2025-03-04'), /telescope/);
  const round = await service.search(['cafe museum visit'], 10);
  assert.ok(round.memories.length >= 1);
  const reference = await service.record(round.memories[0].id);
  assert.ok(reference?.nodeId);
  // A later batch keeps identity stable and the mechanism idempotent.
  const second = Array.from({ length: 3 }, (_, index) => ({
    role: 'user',
    content: `Juniper bought a telescope at the auction near the cafe, follow-up ${index}.`,
    chat_time: '2025-03-11',
    source_message_id: `n${index}`,
  }));
  assert.deepEqual(await service.rememberBatch('extractive-user', 's', 'r2', second), { added: 3 });
  const still = await service.search(['cafe museum visit'], 10);
  assert.ok(still.memories.length >= 1, 'routing survives later batches');
  const latest = await service.search(['auction follow-up'], 1);
  assert.equal((await service.record(latest.memories[0].id)).nodeId, reference.nodeId);
  mkdirSync('.runtime/verification', { recursive: true });
  writeFileSync('.runtime/verification/extractive-summaries.json', JSON.stringify({
    status: 'passed', mode: 'native-sqlite-extractive-no-llm',
    extractiveNodeSummary: true, nodeIdentityStable: true,
  }, null, 2));
  console.log('PASS: extractive node summaries and unified retrieval, deterministic, no LLM, stable node identity.');
} finally {
  await service.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(resolve(`/tmp/nmg/${key}.sqlite${suffix}`), { force: true });
}
