import { createHash } from "node:crypto";
import { join } from "node:path";
import { NmgStore } from "../../../../src/core/store.ts";
import { createEmbeddingClientFromEnv } from "../../../../src/core/embedding-provider.ts";
import { CachedOmniEmbeddingClient } from "../../embedding-cache.ts";
import { parseAdvancedQuery, applyAdvancedFilters } from "../../../../src/core/store/advanced-query.ts";
import { searchMemoryContext } from "../../../../src/integration/search.ts";

process.env.NMG_EMBED_BASE_URL = "http://127.0.0.1:8000";
process.env.NMG_EMBED_MODEL = "BAAI/bge-small-en-v1.5";
process.env.NMG_EMBED_API_KEY = "dummy";
process.env.NMG_EMBED_PROFILE = "bge-en";

const uidArg = process.argv[2] ?? "132";
const uid = /^\d+$/.test(uidArg) ? `lme_exper_user_lme500_bgefix_header_20260804_${uidArg}` : uidArg;
const key = createHash("sha256").update(uid).digest("hex").slice(0, 24);
const store = new NmgStore(join(".benchmarks/omnimemeval-nmg", `${key}.sqlite`));
const embedding = new CachedOmniEmbeddingClient(".benchmarks/shared-embedding-cache.sqlite",
  await createEmbeddingClientFromEnv());
const opts = { limit: 20, maxTier: 3, graphHops: 1, vectorGranularity: "records",
  secondPass: false, progressiveWarmDisclosure: false,
  activeGraphBudget: { maxNodes: 20, maxEvidence: 20, maxTokens: 6000, maxTierBudget: 20 } };

const raws = process.argv[3] ? process.argv.slice(3) : ["recommend video editing learning resources"];
const primary = await (async () => {
  const { semantic, filters } = parseAdvancedQuery(raws[0]);
  const ctx = await searchMemoryContext(store, embedding, semantic, opts);
  ctx.results = applyAdvancedFilters(ctx.results, filters);
  return { raw: raws[0], semantic, filters, ctx };
})();
console.log(`user=${uid.split("_").pop()}  indexId=${embedding.indexId}`);
console.log(`  health: ${JSON.stringify(store.embeddingIndexHealth(embedding.indexId))}`);
console.log(`  retrieval: ${JSON.stringify(primary.ctx.retrieval)}`);
console.log(`clause[0]: "${raws[0]}"  -> semantic: "${primary.semantic}"`);
for (const r of primary.ctx.results.slice(0, 6)) {
  console.log(`  [${r.memory.memoryType}] ${r.memory.statement.slice(0, 65)}`);
}
const seen = new Set(primary.ctx.results.map((r) => r.memory.id));
for (let i = 1; i < raws.length; i++) {
  const { semantic, filters } = parseAdvancedQuery(raws[i]);
  const extra = await searchMemoryContext(store, embedding, semantic, opts);
  const filtered = applyAdvancedFilters(extra.results, filters);
  for (const r of filtered) if (!seen.has(r.memory.id)) { seen.add(r.memory.id); primary.ctx.results.push(r); }
}
console.log(`total fused: ${primary.ctx.results.length}`);
store.close(); embedding.close();
