import { decideMemoryLoad } from "../../src/core/gate.ts";

interface GateCase {
  language: string;
  prompt: string;
  needsRecall: boolean;
}

const cases: GateCase[] = [
  { language: "en", prompt: "What did we decide last time?", needsRecall: true },
  { language: "en", prompt: "What is my current preferred database?", needsRecall: true },
  { language: "en", prompt: "Explain how SQLite indexes work.", needsRecall: false },
  { language: "en", prompt: "Calculate 17 times 4.", needsRecall: false },
  { language: "zh", prompt: "我们上次决定了什么？", needsRecall: true },
  { language: "zh", prompt: "我现在偏好哪个数据库？", needsRecall: true },
  { language: "zh", prompt: "解释一下 SQLite 索引。", needsRecall: false },
  { language: "zh", prompt: "计算十七乘以四。", needsRecall: false },
  { language: "de", prompt: "Was haben wir letztes Mal entschieden?", needsRecall: true },
  { language: "de", prompt: "Was ist meine bevorzugte Datenbank?", needsRecall: true },
  { language: "de", prompt: "Erkläre SQLite-Indizes.", needsRecall: false },
  { language: "de", prompt: "Berechne siebzehn mal vier.", needsRecall: false },
  { language: "fr", prompt: "Qu'avons-nous décidé la dernière fois ?", needsRecall: true },
  { language: "fr", prompt: "Quelle est ma base de données préférée ?", needsRecall: true },
  { language: "fr", prompt: "Explique les index SQLite.", needsRecall: false },
  { language: "fr", prompt: "Calcule dix-sept fois quatre.", needsRecall: false },
  { language: "ja", prompt: "前回は何を決めましたか？", needsRecall: true },
  { language: "ja", prompt: "私が今好むデータベースは何ですか？", needsRecall: true },
  { language: "ja", prompt: "SQLiteのインデックスを説明してください。", needsRecall: false },
  { language: "ja", prompt: "17かける4を計算してください。", needsRecall: false },
  { language: "es", prompt: "¿Qué decidimos la última vez?", needsRecall: true },
  { language: "es", prompt: "¿Cuál es mi base de datos preferida?", needsRecall: true },
  { language: "es", prompt: "Explica los índices de SQLite.", needsRecall: false },
  { language: "es", prompt: "Calcula diecisiete por cuatro.", needsRecall: false },
];

const rows = cases.map((item) => {
  const decision = decideMemoryLoad(item.prompt);
  const predictedRecall = decision.mode === "retrieve";
  return { ...item, mode: decision.mode, predictedRecall, correct: predictedRecall === item.needsRecall };
});

const languages = [...new Set(rows.map((row) => row.language))];
const byLanguage = Object.fromEntries(
  languages.map((language) => {
    const group = rows.filter((row) => row.language === language);
    const tp = group.filter((row) => row.needsRecall && row.predictedRecall).length;
    const tn = group.filter((row) => !row.needsRecall && !row.predictedRecall).length;
    const fp = group.filter((row) => !row.needsRecall && row.predictedRecall).length;
    const fn = group.filter((row) => row.needsRecall && !row.predictedRecall).length;
    return [language, { total: group.length, tp, tn, fp, fn, accuracy: (tp + tn) / group.length }];
  }),
);

const falsePositives = rows.filter((row) => !row.needsRecall && row.predictedRecall);
const falseNegatives = rows.filter((row) => row.needsRecall && !row.predictedRecall);

console.log(
  JSON.stringify(
    {
      caseCount: rows.length,
      byLanguage,
      falsePositiveRate: falsePositives.length / rows.filter((row) => !row.needsRecall).length,
      falseNegativeRate: falseNegatives.length / rows.filter((row) => row.needsRecall).length,
      falsePositives,
      falseNegatives,
      limitation:
        "Curated probes measure deterministic gate coverage, not production language frequency or semantic-task prevalence.",
    },
    null,
    2,
  ),
);
