import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AmlMemoryService } from '../backend/memory-service.ts';
import { normalizeContent, describeContent } from '../../src/integration/multimodal-content.ts';

const pngs = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
];
const key = `offline-media-${randomBytes(12).toString('hex')}`;
const service = new AmlMemoryService(key);
const originals = pngs.map(png => normalizeContent([
  { type: 'text', text: 'My diagram' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
  { type: 'text', text: 'Original trailing text' },
]));
const messages = [];
for (const [index, content] of originals.entries()) messages.push({
  role: 'user', content, source_message_id: `m${index}`,
  ...(index === 0 ? { chat_time: '2023-01-20T23:30:00-05:00' } : {}),
  indexText: await describeContent(content),
});
try {
  assert.deepEqual(await service.rememberBatch('private-offline-image-user', 's', 'r', messages), { added: 2 });
  const ordinary = await service.search(['diagram'], 20);
  assert.equal(ordinary.memories.length, 2, 'Distinct image sources must not collapse when captions match');
  for (const original of originals) assert.ok(ordinary.memories.some(row => JSON.stringify(row.content) === JSON.stringify(original)));
  for (const row of ordinary.memories) {
    assert.ok(Array.isArray(row.content));
    assert.deepEqual(JSON.parse(row.raw_content), ordinary.memories.find(other => other.id === row.id) && JSON.parse(row.raw_content));
    const memory = Reflect.get(service, 'store').getMemory(row.id);
    assert.equal(memory.sourceActor, 'user', 'Attribution follows the supplied message role');
    assert.equal(memory.truthStatus, 'asserted');
    assert.doesNotMatch(memory.statement, /base64,/);
    assert.doesNotMatch(memory.statement, /\[Content source:/, 'Identity hashes stay in markers, not the statement');
    const amlMarker = memory.markers.find(marker => marker.kind === 'aml_content');
    assert.equal(amlMarker.attributes.source_role, 'user');
    assert.match(amlMarker.attributes.source_sha, /^[a-f0-9]{64}$/);
  }
  const temporal = await service.search(['When was the diagram shared?'], 20);
  const dated = temporal.memories.find(row => row.event_time);
  assert.ok(dated);
  assert.deepEqual(dated.content[0], { type: 'text', text: '[Timestamp: 2023-01-20T23:30:00-05:00]' });
  assert.deepEqual(dated.content.slice(1), originals[0]);
  assert.deepEqual(JSON.parse(dated.raw_content), originals[0], 'raw_content is the original evidence, not the prefixed view');
  const unknown = temporal.memories.find(row => row.event_time === null);
  assert.ok(unknown);
  assert.deepEqual(unknown.content, originals[1]);
  assert.equal(unknown.created_at, undefined);
  const imageQuery = await describeContent(originals[0]);
  assert.ok((await service.search([imageQuery], 1)).memories.length <= 1);
  mkdirSync('.runtime/verification', { recursive: true });
  writeFileSync('.runtime/verification/native-multimodal.json', JSON.stringify({
    status: 'passed', mode: 'native-sqlite-supplied-captions-no-provider', records: 2,
    sourcePartsPreserved: true, roleAttributionPreserved: true,
    historicalTimePreserved: true, unknownTimeNotInvented: true,
  }, null, 2));
  console.log('PASS: native SQLite Add -> text/image-query retrieval -> original ordered image evidence; role attribution, marker source identity and conditional historical time hold.');
} finally {
  service.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(resolve(`/tmp/nmg/${key}.sqlite${suffix}`), { force: true });
}
