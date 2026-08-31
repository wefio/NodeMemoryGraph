/**
 * Qualitative probe: MGR XOR on BEAM contradiction_resolution questions.
 *
 * BEAM's streaming runner deletes each user namespace after search, so no
 * benchmark SQLite survives. This probe embeds conversation 1's messages
 * directly with the local BGE server and compares, per question:
 *   baseline — top-5 by cos(question vector)
 *   xor      — Logic.xor(negation atom, affirmation atom)
 *   and      — Logic.and(...) for reference
 * checking whether the gold contradictory source messages surface.
 *
 * Requires evals/omnimemeval/bge_server.py on :8000.
 *
 * Usage:
 *   node --experimental-strip-types evals/omnimemeval/research/probes/mgr-xor-probe.ts \
 *     .benchmarks/official/OmniMemEval/data/beam/beam_100k.json
 */

import { readFileSync } from "node:fs";

import { Logic, MemoryGraphReasoner } from "../../../../src/lab/memory-graph-reasoner.ts";

const EMBED_URL = "http://127.0.0.1:8000/v1/embeddings";
const EMBED_MODEL = "BAAI/bge-small-en-v1.5";
const DIM = 384;

interface BeamMessage {
  id: number;
  role: string;
  content: string;
}

interface XorCase {
  question: string;
  negAtom: string;
  posAtom: string;
  goldIds: number[];
}

const CASES: XorCase[] = [
  {
    question: "Have I worked with Flask routes and handled HTTP requests in this project?",
    negAtom: "the user states they have never written Flask routes or handled HTTP requests",
    posAtom: "the user implemented Flask routes and HTTP request handling",
    goldIds: [58, 24],
  },
  {
    question: "Have I integrated Flask-Login for session management in my project?",
    negAtom: "the user states they never integrated Flask-Login session management",
    posAtom: "the user asked for help integrating Flask-Login session management",
    goldIds: [66],
  },
];

async function embed(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => Float32Array.from(d.embedding));
}

async function main(): Promise<void> {
  const dataPath = process.argv[2];
  if (!dataPath) {
    console.error("usage: mgr-xor-probe.ts <beam_100k.json>");
    process.exit(1);
  }
  const firstLine = readFileSync(dataPath, "utf-8").split("\n")[0]!;
  const conv = JSON.parse(firstLine) as { chat: BeamMessage[][] };
  const messages = conv.chat.flat();
  console.log(`loaded ${messages.length} messages from conversation 1`);

  const msgVecs = await embed(messages.map((m) => `${m.role}: ${m.content}`));
  const graph = new Map(
    messages.map((m, i) => [`msg-${m.id}`, { id: `msg-${m.id}`, vector: msgVecs[i]! }]),
  );
  const mgr = new MemoryGraphReasoner(DIM);
  const byId = new Map(messages.map((m) => [`msg-${m.id}`, m]));

  for (const c of CASES) {
    console.log("=".repeat(88));
    console.log("Q:", c.question);
    const [qVec, negVec, posVec] = await embed([c.question, c.negAtom, c.posAtom]);

    const runs: [string, ReturnType<typeof mgr.logicSearch>][] = [
      ["baseline (question vector)", mgr.logicSearch(Logic.atom(qVec!), graph, 10)],
      [
        "xor(never-claim, did-claim)",
        mgr.logicSearch(Logic.xor(Logic.atom(negVec!), Logic.atom(posVec!)), graph, 10),
      ],
      [
        "and(never-claim, did-claim)",
        mgr.logicSearch(Logic.and(Logic.atom(negVec!), Logic.atom(posVec!)), graph, 10),
      ],
    ];

    for (const [name, results] of runs) {
      console.log(`-- ${name}`);
      for (const gid of c.goldIds) {
        const rank = results.findIndex((r) => r.nodeId === `msg-${gid}`);
        console.log(
          rank >= 0
            ? `  gold msg-${gid} rank=${rank + 1} (m=${results[rank]!.membership.toFixed(3)})`
            : `  gold msg-${gid} NOT in top-10`,
        );
      }
      for (const r of results.slice(0, 3)) {
        const m = byId.get(r.nodeId)!;
        console.log(`    ${r.membership.toFixed(3)}  [${m.role}] ${m.content.slice(0, 90)}`);
      }
    }
    console.log();
  }
}

void main();
