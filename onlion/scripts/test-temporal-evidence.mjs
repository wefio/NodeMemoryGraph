import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AmlMemoryService } from '../backend/memory-service.ts';

const key = `offline-temporal-${randomBytes(12).toString('hex')}`;
const service = new AmlMemoryService(key);
const messages = [
  { role: 'user', content: 'I visited the museum yesterday.', chat_time: '2023-01-20T23:30:00-05:00', source_message_id: 'm1' },
  { role: 'user', content: 'The museum is called Cedar.', chat_time: '2023-01-21', source_message_id: 'm2' },
  { role: 'user', content: 'The museum offers free admission.', source_message_id: 'm3' },
];
try {
  assert.deepEqual(await service.rememberBatch('offline-user', 's', 'r', messages), { added: 3 });
  const ordinary = await service.search(['museum'], 20);
  const temporal = await service.search(['When was the museum visit?'], 20);
  for (const response of [ordinary, temporal]) {
    assert.equal(response.memories.length, 3);
    for (const message of messages) {
      const row = response.memories.find(row => row.raw_content === message.content);
      assert.ok(row, message.content);
      assert.equal(row.event_time, message.chat_time ?? null);
      assert.equal(row.created_at, message.chat_time);
      assert.ok(row.stored_at);
      assert.equal(service.store.getMemory(row.id).statement, message.content);
    }
  }
  assert.equal(ordinary.memories.find(row => row.event_time === '2023-01-21').content, messages[1].content);
  assert.match(ordinary.memories.find(row => row.event_time === messages[0].chat_time).content, /^\[Timestamp: 2023-01-20T23:30:00-05:00\]/);
  assert.match(temporal.memories.find(row => row.event_time === '2023-01-21').content, /^\[Timestamp: 2023-01-21\]/);
  assert.equal(temporal.memories.find(row => row.event_time === null).content, messages[2].content);
  mkdirSync('.runtime/verification', { recursive: true });
  writeFileSync('.runtime/verification/native-temporal.json', JSON.stringify({ status: 'passed', mode: 'offline-native-sqlite-no-provider', ordinary, temporal }, null, 2));
  console.log('PASS: actual AmlMemoryService ingestion -> native store/search -> shared AML projection; 3 source records unchanged; conditional timestamps and unknown-time semantics verified.');
} finally {
  service.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(resolve(`/tmp/nmg/${key}.sqlite${suffix}`), { force: true });
}
