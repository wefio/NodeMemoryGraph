// Progressive-disclosure evaluation probe for the NMG retrieval pipeline.
// Opens the HaluMem trial19 store for Martin Mark, runs real queries, and
// prints the full contextUsefulness-ranked candidate order (direct/related,
// tier, combined, usefulness) plus the progressiveWarmDisclosure on/off
// difference — i.e. whether strong signals (promotion memory) surface first
// ("position") and whether warm memories are folded/deferred ("timing").
import { createHash } from "node:crypto";
import { join } from "node:path";
import { NmgStore } from "../../src/core/store.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { parseAdvancedQuery } from "../../src/core/store/advanced-query.ts";
import { searchMemoryContext } from "../../src/integration/search.ts";

process.env.NMG_EMBED_BASE_URL = "http://127.0.0.1:8000";
process.env.NMG_EMBED_MODEL = "BAAI/bge-small-en-v1.5";
process.env.NMG_EMBED_API_KEY = "dummy";
process.env.NMG_EMBED_PROFILE = "bge-en";

const USER_ID = "hm_exp_user_supersession_trial19_2f1f897e-d67f-dbc5-6a7b-b7634a9e294f";
const key = createHash("sha256").update(USER_ID).digest("hex").slice(0, 24);
const STORE_DIR = join(import.meta.dirname, "..", "..", ".benchmarks/omnimemeval-nmg");
const store = new NmgStore(join(STORE_DIR, `${key}.sqlite`));
const embedding = await createEmbeddingClientFromEnv();

const QUERIES = [
  "What is Martin Mark's current job title as of June 15, 2033?",
  "How did Martin's promotion on April 25, 2033, impact his health practices by June 15, 2033?",
  "What is Martin Mark's birth date?",
];

const mkOpts = (warm) => ({
  limit: 50,
  maxTier: 3,
  graphHops: 1,
  vectorGranularity: "records",
  sourceActor: "user",
  secondPass: false,
  progressiveWarmDisclosure: warm,
  activeGraphBudget: { maxNodes: 50, maxEvidence: 50, maxTokens: 100000, maxTierBudget: 50 },
});

const describe = (m) => {
  const s = m.statement.slice(0, 78);
  const flag = /promot|director|nurse|transition|sabbatical/i.test(s) ? " <<<" : "";
  return `[${m.memoryType} t${m.tier ?? "?"}] ${s}${flag}`;
};

for (const raw of QUERIES) {
  console.log(`\n${"=".repeat(100)}`);
  console.log(`QUERY: "${raw}"`);
  console.log(`${"=".repeat(100)}`);
  const { semantic } = parseAdvancedQuery(raw);
  for (const warm of [false, true]) {
    const ctx = await searchMemoryContext(store, embedding, semantic, mkOpts(warm));
    const title = warm ? "WARM ON  (CLI default)" : "WARM OFF (eval bridge)";
    console.log(`\n--- ${title} ---`);
    console.log(`results=${ctx.results.length}  progressiveDisclosure=${JSON.stringify(ctx.progressiveDisclosure ?? null)}`);
    ctx.results.forEach((r, i) => {
      const src = r.source === "direct" ? "D" : "G";
      const s = r.scores;
      console.log(`  ${String(i + 1).padStart(2)} [${src} r${r.rank}] ${describe(r.memory)}  use=${r.usefulness?.toFixed(3)} comb=${s?.combined?.toFixed(3)}`);
    });
  }
}

store.close();
embedding.close();
