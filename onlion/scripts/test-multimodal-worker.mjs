import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkerFixture } from './worker-fixture.mjs';

const storage = path.resolve('.runtime/tests/multimodal-r2');
fs.rmSync(storage, { recursive: true, force: true });
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=' } };
const otherImage = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } };
const parts = [{ type: 'text', text: 'My diagram' }, image, { type: 'text', text: 'Keep this trailing text' }];
const captionParts = [{ type: 'text', text: 'A green triangle named Juniper.' }, image];
const request = { user_id: 'private-image-fixture', session_id: 'original-session', request_id: 'image-r1',
  messages: [{ role: 'user', content: parts, timestamp: 1674253800000 }] };
let mf = createWorkerFixture({ storage });
async function call(name, route, body) {
  const worker = await mf.getWorker(name);
  const response = await worker.fetch(`http://localhost${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
try {
  const health = await call('a', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.core_source, 'workspace:src');
  assert.equal(health.body.multimodal.format, 'ordered-text-base64-image-parts');
  assert.equal(health.body.multimodal.index_view, 'supplied-text-plus-image-hash');
  assert.ok(health.body.source_revision);
  const added = await call('a', '/add', request);
  assert.equal(added.status, 200, JSON.stringify(added));
  assert.equal(added.body.success, true);
  for (const key of ['user_id', 'session_id', 'request_id']) assert.equal(added.body[key], request[key]);
  assert.deepEqual(await call('b', '/add', request), added, 'Retry must reuse the original authoritative receipt');
  const changed = structuredClone(request);
  changed.messages[0].content[0].text = 'Different diagram text';
  assert.equal((await call('a', '/add', changed)).status, 409);
  const textSearch = await call('b', '/search', { user_id: request.user_id, query: 'diagram', top_k: 1 });
  assert.equal(textSearch.status, 200, JSON.stringify(textSearch));
  assert.equal(textSearch.body.data.length, 1);
  assert.deepEqual(textSearch.body.data[0].content, parts);
  assert.deepEqual(textSearch.body.data[0].raw_content, JSON.stringify(parts));
  assert.equal(textSearch.body.data[0].event_time, new Date(1674253800000).toISOString());
  for (const query of ['Which answer matches this diagram?', parts, [image]]) {
    const found = await call('a', '/search', {
      user_id: request.user_id, query, options: ['A. First option', 'B. Second option'], top_k: 1,
    });
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.equal(found.body.data.length, 1, `query ${JSON.stringify(query).slice(0, 60)} must find the image evidence`);
    assert.deepEqual(found.body.data[0].content, parts);
  }
  // An exact image without its caption still identifies the same evidence.
  const sameImage = await call('b', '/search', { user_id: request.user_id, query: [image], top_k: 1 });
  assert.deepEqual(sameImage.body.data[0].id, textSearch.body.data[0].id);
  assert.deepEqual((await call('b', '/search', { user_id: 'different-user', query: 'diagram', top_k: 100 })).body.data, []);
  const malformed = { user_id: request.user_id, query: [image], top_k: 0 };
  assert.equal((await call('a', '/search', malformed)).status, 400);
  assert.equal((await call('a', '/search', { ...malformed, top_k: 1, options: [''] })).status, 400);
  assert.equal((await call('a', '/search', { ...malformed, top_k: 1, query: [{ type: 'audio', data: 'unsupported' }] })).status, 400);
  // Caption-only multimodal Add and Search: supplied text is the retrieval view.
  const captionRequest = { ...request, user_id: 'caption-user', request_id: 'caption-only',
    messages: [{ role: 'user', content: captionParts }] };
  const captionAdded = await call('a', '/add', captionRequest);
  assert.equal(captionAdded.status, 200, JSON.stringify(captionAdded));
  assert.deepEqual(await call('b', '/add', captionRequest), captionAdded);
  for (const query of ['Juniper triangle', captionParts, [image]]) {
    const found = await call('b', '/search', { user_id: 'caption-user', query, top_k: 1 });
    assert.deepEqual(found.body.data[0].content, captionParts);
    assert.equal(found.body.data[0].event_time, null);
  }
  assert.deepEqual((await call('a', '/search', { user_id: 'different-user', query: captionParts, top_k: 1 })).body.data, []);
  await mf.dispose();
  // Reopen the persisted R2 snapshots with an empty configuration.
  mf = createWorkerFixture({ storage });
  assert.deepEqual(await call('a', '/add', request), added, 'Receipts survive cold restart');
  const restored = await call('b', '/search', { user_id: request.user_id, query: 'diagram', top_k: 1 });
  assert.deepEqual(restored.body.data[0].content, parts);
  const captionRestored = await call('a', '/search', { user_id: 'caption-user', query: 'Juniper', top_k: 1 });
  assert.deepEqual(captionRestored.body.data[0].content, captionParts);
  const plain = await call('b', '/add', { user_id: 'plain-user', session_id: 's', request_id: 'r', messages: [{ role: 'user', content: 'My robot is Cedar.' }] });
  assert.equal(plain.status, 200);
  assert.equal((await call('a', '/search', { user_id: 'plain-user', query: 'robot', top_k: 1 })).body.data[0].content, 'My robot is Cedar.');
  // A different picture with the same caption stays a distinct evidence row.
  const twin = { ...captionRequest, user_id: 'caption-user', request_id: 'caption-twin',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A green triangle named Juniper.' }, otherImage] }] };
  assert.equal((await call('a', '/add', twin)).status, 200);
  assert.equal((await call('b', '/search', { user_id: 'caption-user', query: 'Juniper', top_k: 10 })).body.data.length, 2);
  fs.mkdirSync('.runtime/verification', { recursive: true });
  fs.writeFileSync('.runtime/verification/worker-multimodal.json', JSON.stringify({
    status: 'passed', mode: 'miniflare-workers-r2-supplied-captions-no-external-model',
    sourceRevision: health.body.source_revision, sourcePartsPreserved: true, rawContentIsOriginalEvidence: true,
    imageQueryPassed: true, captionOnlyFlow: true, distinctImageSources: true,
    userIsolation: true, idempotentRetry: true, coldRestart: true, noVisionTextCompatibility: true,
    officialAmlSubmission: false, productionDeployment: false, realVisionProviderVerified: false,
  }, null, 2));
  console.log('PASS: built Worker HTTP Add -> R2 -> cross-isolate text/image Search -> original ordered evidence; supplied captions drive retrieval, no external model is called, receipts/isolation/cold restart hold.');
} finally { await mf.dispose(); }
