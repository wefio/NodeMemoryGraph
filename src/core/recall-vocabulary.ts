/** Editable seed data. Entries compete with learned phrases; they are not permanent rules. */
export interface RecallTerm {
  phrase: string;
  mode: "retrieve" | "cue";
  before?: readonly string[];
  after?: readonly string[];
  gap?: number;
  start?: boolean;
  sentence?: boolean;
  afterPrefix?: boolean;
  followedByName?: boolean;
}

function words(
  phrases: readonly string[],
  mode: RecallTerm["mode"],
  conditions: Omit<RecallTerm, "phrase" | "mode"> = {},
): RecallTerm[] {
  return phrases.map((phrase) => ({ phrase, mode, ...conditions }));
}

export const RECALL_VOCABULARY: readonly RecallTerm[] = [
  ...words(
    ["之前", "先前", "以前", "上次", "曾经", "当时", "还记得", "回忆", "记忆中"],
    "retrieve",
  ),
  ...words(["你记得", "您记得"], "retrieve", {
    after: ["吗", "什么", "哪", "谁", "多少", "几", "？", "?"],
    sentence: true,
  }),
  ...words(["来着"], "retrieve", { after: ["？", "?"], gap: 0 }),
  ...words(["用过", "说过", "提过", "决定过", "选择过", "讨论过", "告诉过"], "retrieve", {
    before: ["我", "我们"],
    gap: 16,
  }),
  ...words(["现在", "当前", "最近", "最新"], "retrieve", {
    before: ["我", "我们"],
    after: ["什么", "哪个", "多少", "是谁", "用", "使用", "喜欢", "偏好", "决定", "选择"],
    gap: 12,
  }),
  ...words(["偏好", "习惯", "要求", "历史"], "retrieve", {
    before: ["根据我的", "按照我的"],
    gap: 0,
  }),
  ...words(
    [
      "remember",
      "previously",
      "before",
      "last time",
      "earlier",
      "used to",
      "did i",
      "did we",
      "have i",
      "have we",
    ],
    "retrieve",
  ),
  ...words(["what", "how many", "how long"], "retrieve", { after: ["i", "we"], gap: 32 }),
  ...words(["what", "when", "where", "who", "which", "how many", "how long"], "retrieve", {
    start: true,
    after: ["my"],
    gap: 32,
  }),
  ...words(
    [
      "my current",
      "my latest",
      "my previous",
      "my last",
      "my preference",
      "my preferences",
      "my history",
    ],
    "retrieve",
  ),
  ...words(["what did", "when did", "where did", "which did", "how did"], "retrieve", {
    followedByName: true,
  }),
  ...words(
    [
      "letztes mal",
      "früher",
      "erinnerst du",
      "dernière fois",
      "auparavant",
      "souviens-toi",
      "前回",
      "覚えて",
      "última vez",
      "anteriormente",
      "recuerdas",
    ],
    "retrieve",
  ),
  ...words(["meine"], "retrieve", { after: ["bevorzugte", "präferenz"], gap: 24 }),
  ...words(["ma", "mon", "mes"], "retrieve", { after: ["préfér"], afterPrefix: true, gap: 24 }),
  ...words(["私"], "retrieve", { after: ["好む", "好み", "好き", "選ん", "決め"], gap: 20 }),
  ...words(["mi"], "retrieve", { after: ["preferida", "preferido", "preferencia"], gap: 24 }),
  ...words(
    [
      "推荐",
      "建议",
      "方案",
      "规划",
      "计划",
      "怎么做",
      "如何选择",
      "帮我选",
      "recommend",
      "recommendation",
      "suggest",
      "suggestion",
      "advice",
      "plan",
      "planning",
      "which should i",
      "which should we",
      "what should i",
      "what should we",
      "how should i",
      "how should we",
    ],
    "cue",
  ),
];

/** Seed count + room for new terms, rather than a separate eight-entry exception cache. */
export const RECALL_POOL_CAPACITY = 128;
export const RECALL_POOL_PROTECTED_CAPACITY = 64;
