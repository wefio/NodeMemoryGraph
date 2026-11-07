import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { statementSimilarity } from "../../src/core/store/search-ranking.ts";
import { readRelevanceModel } from "../../src/lab/relevance-model.ts";
import { writeJsonAtomic } from "../../tools/parts/fs.ts";
import { characterNgramCosine, pairFeatures } from "./pair-features.ts";

interface TraceRow {
  session_id: string | null;
  query: string;
  result_memory_ids_json: string;
  selections_json: string;
  useful_memory_ids_json: string;
  contradicted_memory_ids_json: string;
  rejected_memory_ids_json: string;
}

interface MemoryRow {
  id: string;
  statement: string;
}

interface TraceSelection {
  memoryId: string;
  scores: {
    lexical: number;
    vector: number;
    route: number;
    combined: number;
    usefulness: number;
  };
}

const { values } = parseArgs({
  options: {
    store: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});

if (!values.store || !values.model) {
  throw new Error(
    "usage: local-trace-ranking-probe.ts --store <nmg.sqlite> --model <weights.json> [--out report.json]",
  );
}

const model = readRelevanceModel(resolve(values.model));
if (!model) throw new Error("could not load relevance model");

const { traces, memories, explicitNegativeInstances } = (() => {
  const db = new DatabaseSync(resolve(values.store), { readOnly: true });
  try {
    return {
      traces: db
        .prepare(
          `
        SELECT session_id, query, result_memory_ids_json, selections_json, useful_memory_ids_json,
               contradicted_memory_ids_json, rejected_memory_ids_json
        FROM retrieval_traces
        WHERE json_array_length(useful_memory_ids_json) > 0
        ORDER BY created_at, id
      `,
        )
        .all() as TraceRow[],
      explicitNegativeInstances: Number(
        db
          .prepare(
            `
        SELECT SUM(json_array_length(contradicted_memory_ids_json) + json_array_length(rejected_memory_ids_json)) AS n
        FROM retrieval_traces
      `,
          )
          .get()?.n ?? 0,
      ),
      memories: db
        .prepare(
          `
        SELECT id, statement FROM memory_records
        WHERE status = 'active'
        ORDER BY id
      `,
        )
        .all() as MemoryRow[],
    };
  } finally {
    db.close();
  }
})();

const byId = new Map(memories.map((memory) => [memory.id, memory]));
const rows = traces.map((trace) => ({
  session: trace.session_id || "__anonymous__",
  query: trace.query,
  historical: JSON.parse(trace.result_memory_ids_json) as string[],
  selections: JSON.parse(trace.selections_json) as TraceSelection[],
  gold: JSON.parse(trace.useful_memory_ids_json) as string[],
}));
const goldIds = rows.flatMap((row) => row.gold);
const unavailableGolds = goldIds.filter((id) => !byId.has(id)).length;
if (rows.length === 0 || unavailableGolds > 0) {
  throw new Error(
    `usable labeled traces=${rows.length}; golds absent from active corpus=${unavailableGolds}`,
  );
}

type Method = "historical" | "wordJaccard" | "characterNgram" | "programComposite" | "semrelMlp";
type TieBreakMethod = "characterNgram" | "programComposite" | "semrelMlp";
const methods: Method[] = [
  "historical",
  "wordJaccard",
  "characterNgram",
  "programComposite",
  "semrelMlp",
];
const tieBreakMethods: TieBreakMethod[] = ["characterNgram", "programComposite", "semrelMlp"];
const rankings = new Map<Method, string[][]>(methods.map((method) => [method, []]));
const historicalCandidateRankings = new Map<Method, string[][]>(
  methods.map((method) => [method, []]),
);
const historicalSemrelRankFusion: string[][] = [];
const historicalTopTieBreaks = new Map<TieBreakMethod, string[][]>(
  tieBreakMethods.map((method) => [method, []]),
);
const topOneDisagreements: Array<{
  historicalCorrect: boolean;
  semrelCorrect: boolean;
  candidateCount: number;
  usefulnessGap: number | null;
  neuralAdvantage: number;
  lexicalGap: number | null;
  vectorGap: number | null;
  routeGap: number | null;
}> = [];
for (const row of rows) {
  const historicalRank = new Map(row.historical.map((id, index) => [id, index]));
  const historicalCandidates = row.historical.filter((id) => byId.has(id));
  const historicalCandidateRank = new Map(historicalCandidates.map((id, index) => [id, index]));
  const baseline = [
    ...historicalCandidates,
    ...memories.map((memory) => memory.id).filter((id) => !historicalRank.has(id)),
  ];
  rankings.get("historical")!.push(baseline);
  historicalCandidateRankings.get("historical")!.push(historicalCandidates);

  const scored = memories.map((memory) => {
    const wordJaccard = statementSimilarity(row.query, memory.statement);
    const characterNgram = characterNgramCosine(row.query, memory.statement);
    return {
      id: memory.id,
      wordJaccard,
      characterNgram,
      programComposite: (wordJaccard + characterNgram) / 2,
      semrelMlp: model.predict(pairFeatures(row.query, memory.statement)),
      historicalRank: historicalRank.get(memory.id) ?? Number.MAX_SAFE_INTEGER,
    };
  });
  const semrelCandidates = [...scored]
    .filter((item) => historicalRank.has(item.id))
    .sort(
      (left, right) =>
        right.semrelMlp - left.semrelMlp ||
        left.historicalRank - right.historicalRank ||
        left.id.localeCompare(right.id),
    );
  const historicalTop = historicalCandidates[0];
  const semrelTop = semrelCandidates[0];
  const selectionById = new Map(row.selections.map((selection) => [selection.memoryId, selection]));
  if (historicalTop && semrelTop && historicalTop !== semrelTop.id) {
    const historicalScores = selectionById.get(historicalTop)?.scores;
    const semrelScores = selectionById.get(semrelTop.id)?.scores;
    const historicalNeuralScore = scored.find((item) => item.id === historicalTop)!.semrelMlp;
    topOneDisagreements.push({
      historicalCorrect: row.gold.includes(historicalTop),
      semrelCorrect: row.gold.includes(semrelTop.id),
      candidateCount: historicalCandidates.length,
      usefulnessGap:
        historicalScores && semrelScores
          ? historicalScores.usefulness - semrelScores.usefulness
          : null,
      neuralAdvantage: semrelTop.semrelMlp - historicalNeuralScore,
      lexicalGap:
        historicalScores && semrelScores ? historicalScores.lexical - semrelScores.lexical : null,
      vectorGap:
        historicalScores && semrelScores ? historicalScores.vector - semrelScores.vector : null,
      routeGap:
        historicalScores && semrelScores ? historicalScores.route - semrelScores.route : null,
    });
  }
  for (const method of methods.slice(1)) {
    const ranking = [...scored]
      .sort(
        (left, right) =>
          right[method] - left[method] ||
          left.historicalRank - right.historicalRank ||
          left.id.localeCompare(right.id),
      )
      .map((item) => item.id);
    rankings.get(method)!.push(ranking);
    const rerankedCandidates = scored
      .filter((item) => historicalRank.has(item.id))
      .sort(
        (left, right) =>
          right[method] - left[method] ||
          left.historicalRank - right.historicalRank ||
          left.id.localeCompare(right.id),
      )
      .map((item) => item.id);
    historicalCandidateRankings.get(method)!.push(rerankedCandidates);
  }

  const historicalTopUsefulness = historicalTop
    ? selectionById.get(historicalTop)?.scores.usefulness
    : undefined;
  const tiedTopIds = new Set<string>();
  if (historicalTopUsefulness !== undefined) {
    for (const id of historicalCandidates) {
      if (selectionById.get(id)?.scores.usefulness !== historicalTopUsefulness) break;
      tiedTopIds.add(id);
    }
  }
  for (const method of tieBreakMethods) {
    const proposedTop = historicalCandidateRankings
      .get(method)!
      .at(-1)
      ?.find((id) => tiedTopIds.has(id));
    historicalTopTieBreaks
      .get(method)!
      .push(
        historicalTop && proposedTop && historicalTop !== proposedTop
          ? [proposedTop, ...historicalCandidates.filter((id) => id !== proposedTop)]
          : historicalCandidates,
      );
  }

  const semrelRank = new Map(semrelCandidates.map((item, index) => [item.id, index]));
  const fused = [...scored]
    .filter((item) => historicalRank.has(item.id))
    .sort((left, right) => {
      const leftRank = historicalCandidateRank.get(left.id)!;
      const rightRank = historicalCandidateRank.get(right.id)!;
      const leftRankSum = leftRank + semrelRank.get(left.id)!;
      const rightRankSum = rightRank + semrelRank.get(right.id)!;
      return leftRankSum - rightRankSum || leftRank - rightRank || left.id.localeCompare(right.id);
    })
    .map((item) => item.id);
  historicalSemrelRankFusion.push(fused);
}

function evaluate(method: Method, pool: "fullCorpus" | "historicalCandidatePool") {
  const methodRankings = pool === "fullCorpus" ? rankings : historicalCandidateRankings;
  return evaluateRankings(methodRankings.get(method)!);
}

function evaluateRankings(methodRankings: readonly string[][]) {
  let totalGolds = 0;
  const hitLabels = new Map<number, number>([1, 3, 5, 10].map((k) => [k, 0]));
  const hitQueries = new Map<number, number>([1, 3, 5, 10].map((k) => [k, 0]));
  const reciprocalRanks: number[] = [];
  rows.forEach((row, index) => {
    totalGolds += row.gold.length;
    const ranking = methodRankings[index]!;
    const ranks = row.gold.map((id) => ranking.indexOf(id) + 1).filter((rank) => rank > 0);
    reciprocalRanks.push(ranks.length ? 1 / Math.min(...ranks) : 0);
    for (const k of hitLabels.keys()) {
      hitLabels.set(k, hitLabels.get(k)! + ranks.filter((rank) => rank <= k).length);
      if (ranks.some((rank) => rank <= k)) hitQueries.set(k, hitQueries.get(k)! + 1);
    }
  });
  return {
    recallAt: Object.fromEntries([...hitLabels].map(([k, hits]) => [String(k), hits / totalGolds])),
    queryHitAt: Object.fromEntries(
      [...hitQueries].map(([k, hits]) => [String(k), hits / rows.length]),
    ),
    mrrQuestion: reciprocalRanks.reduce((sum, value) => sum + value, 0) / rows.length,
    perQueryReciprocalRank: reciprocalRanks,
  };
}

function exactSessionSignFlipP(
  left: readonly number[],
  right: readonly number[],
): { pTwoSided: number; groups: number } {
  const grouped = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const delta = left[index]! - right[index]!;
    const values = grouped.get(row.session) ?? [];
    values.push(delta);
    grouped.set(row.session, values);
  });
  const deltas = [...grouped.values()].map((values) =>
    values.reduce((sum, value) => sum + value, 0),
  );
  if (deltas.length > 20) throw new Error("exact session test supports at most 20 groups");
  const observed = Math.abs(deltas.reduce((sum, value) => sum + value, 0));
  const permutations = 1 << deltas.length;
  let extreme = 0;
  for (let mask = 0; mask < permutations; mask += 1) {
    let statistic = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      statistic += mask & (1 << index) ? deltas[index]! : -deltas[index]!;
    }
    if (Math.abs(statistic) >= observed - 1e-12) extreme += 1;
  }
  return { pTwoSided: extreme / permutations, groups: deltas.length };
}

function summariesFor(pool: "fullCorpus" | "historicalCandidatePool") {
  return Object.fromEntries(
    methods.map((method) => {
      const result = evaluate(method, pool);
      return [
        method,
        {
          recallAt: result.recallAt,
          queryHitAt: result.queryHitAt,
          mrrQuestion: result.mrrQuestion,
        },
      ];
    }),
  );
}

const fullCorpus = summariesFor("fullCorpus");
const historicalCandidatePool = summariesFor("historicalCandidatePool");
const fullMlpMrr = evaluate("semrelMlp", "fullCorpus").perQueryReciprocalRank;
const fullProgramMrr = evaluate("programComposite", "fullCorpus").perQueryReciprocalRank;
const rerankHistoricalMlpMrr = evaluate(
  "semrelMlp",
  "historicalCandidatePool",
).perQueryReciprocalRank;
const rerankHistoricalBaseMrr = evaluate(
  "historical",
  "historicalCandidatePool",
).perQueryReciprocalRank;
const rerankProgramMrr = evaluate(
  "programComposite",
  "historicalCandidatePool",
).perQueryReciprocalRank;
const rerankFusion = evaluateRankings(historicalSemrelRankFusion);
const rerankTopTieBreaks = Object.fromEntries(
  tieBreakMethods.map((method) => [method, evaluateRankings(historicalTopTieBreaks.get(method)!)]),
) as Record<TieBreakMethod, ReturnType<typeof evaluateRankings>>;
const topOneOutcomes = { bothCorrect: 0, historicalOnly: 0, semrelOnly: 0, neitherCorrect: 0 };
rows.forEach((row, index) => {
  const historicalCorrect = row.gold.includes(
    historicalCandidateRankings.get("historical")![index]![0]!,
  );
  const semrelCorrect = row.gold.includes(
    historicalCandidateRankings.get("semrelMlp")![index]![0]!,
  );
  if (historicalCorrect && semrelCorrect) topOneOutcomes.bothCorrect++;
  else if (historicalCorrect) topOneOutcomes.historicalOnly++;
  else if (semrelCorrect) topOneOutcomes.semrelOnly++;
  else topOneOutcomes.neitherCorrect++;
});
const topTieBreakOutcomes = Object.fromEntries(
  tieBreakMethods.map((method) => {
    const outcomes = { changed: 0, fixed: 0, regressed: 0 };
    rows.forEach((row, index) => {
      const historicalTop = historicalCandidateRankings.get("historical")![index]![0];
      const tieBreakTop = historicalTopTieBreaks.get(method)![index]![0];
      if (historicalTop === tieBreakTop) return;
      outcomes.changed++;
      if (!row.gold.includes(historicalTop!) && row.gold.includes(tieBreakTop!)) outcomes.fixed++;
      if (row.gold.includes(historicalTop!) && !row.gold.includes(tieBreakTop!))
        outcomes.regressed++;
    });
    return [method, outcomes];
  }),
);
const report = {
  protocol: {
    data: "read-only local retrieval traces and current active memory records",
    trainingData:
      "pinned multilingual SemRel train split only; no local trace used for training or tuning",
    primaryMetric: "query MRR of explicitly useful memory IDs, paired by session",
    candidatePool: memories.length,
    labeledQueries: rows.length,
    usefulMemoryLabels: goldIds.length,
    explicitNegativeLabels: explicitNegativeInstances,
    sessionGroups: exactSessionSignFlipP(rerankHistoricalMlpMrr, rerankHistoricalBaseMrr).groups,
    rawQueryOrMemoryTextWritten: false,
  },
  metrics: {
    fullCorpus,
    historicalCandidatePool: {
      ...historicalCandidatePool,
      historicalSemrelRankFusion: {
        recallAt: rerankFusion.recallAt,
        queryHitAt: rerankFusion.queryHitAt,
        mrrQuestion: rerankFusion.mrrQuestion,
      },
      ...Object.fromEntries(
        tieBreakMethods.map((method) => [
          `historical${method}TopTieBreak`,
          {
            recallAt: rerankTopTieBreaks[method].recallAt,
            queryHitAt: rerankTopTieBreaks[method].queryHitAt,
            mrrQuestion: rerankTopTieBreaks[method].mrrQuestion,
          },
        ]),
      ),
    },
  },
  diagnostics: { topOneOutcomes, topTieBreakOutcomes, topOneDisagreements },
  tests: {
    semrelMlpRerankVsHistoricalOrder: {
      mrrDelta:
        historicalCandidatePool.semrelMlp!.mrrQuestion -
        historicalCandidatePool.historical!.mrrQuestion,
      ...exactSessionSignFlipP(rerankHistoricalMlpMrr, rerankHistoricalBaseMrr),
    },
    semrelMlpRerankVsProgramComposite: {
      mrrDelta:
        historicalCandidatePool.semrelMlp!.mrrQuestion -
        historicalCandidatePool.programComposite!.mrrQuestion,
      ...exactSessionSignFlipP(rerankHistoricalMlpMrr, rerankProgramMrr),
    },
    historicalSemrelRankFusionVsHistoricalOrder: {
      mrrDelta: rerankFusion.mrrQuestion - historicalCandidatePool.historical!.mrrQuestion,
      ...exactSessionSignFlipP(rerankFusion.perQueryReciprocalRank, rerankHistoricalBaseMrr),
    },
    ...Object.fromEntries(
      tieBreakMethods.map((method) => [
        `historical${method}TopTieBreakVsHistoricalOrder`,
        {
          mrrDelta:
            rerankTopTieBreaks[method].mrrQuestion -
            historicalCandidatePool.historical!.mrrQuestion,
          ...exactSessionSignFlipP(
            rerankTopTieBreaks[method].perQueryReciprocalRank,
            rerankHistoricalBaseMrr,
          ),
        },
      ]),
    ),
    semrelMlpFullCorpusVsProgramComposite: {
      mrrDelta: fullCorpus.semrelMlp!.mrrQuestion - fullCorpus.programComposite!.mrrQuestion,
      ...exactSessionSignFlipP(fullMlpMrr, fullProgramMrr),
    },
  },
};

if (values.out) writeJsonAtomic(resolve(values.out), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
