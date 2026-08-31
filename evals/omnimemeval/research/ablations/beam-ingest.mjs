// Ingest BEAM 100K conversation 1 into a fresh NMG database for the
// polarity-worker experiment. Uses the hashing embedder (offline, no model
// download); retrieval quality is irrelevant here, only the record store.
import { readFileSync } from 'node:fs';
import { NmgStore } from '../../../../src/index.ts';

const DATA = '.benchmarks/official/OmniMemEval/data/beam/chats/100K/1/chat.json';
const DB = process.argv[2] ?? '.benchmarks/beam-conv1-nmg.sqlite';

const batches = JSON.parse(readFileSync(DATA, 'utf8'));
const store = new NmgStore(DB);
let n = 0;
for (const b of batches) {
  for (const turn of b.turns) {
    for (const m of turn) {
      store.remember({
        nodeName: 'beam-conv1',
        statement: `${m.role}: ${m.content}`,
        sourceActor: m.role === 'user' ? 'user' : 'assistant',
      });
      n++;
    }
  }
}
store.close();
console.log(`ingested ${n} messages into ${DB}`);
