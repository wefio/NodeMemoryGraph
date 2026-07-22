export type BenchmarkRole = "assistant" | "user";

export interface BenchmarkTurn {
  role: BenchmarkRole;
  speaker?: string;
  content: string;
  sourceId: string;
}

export interface BenchmarkSession {
  id: string;
  date?: string;
  turns: BenchmarkTurn[];
}

export interface BenchmarkCase {
  id: string;
  benchmark: "BEAM" | "LoCoMo" | "PersonaMem";
  category: string;
  question: string;
  reference: string;
  options?: string[];
  evidenceIds?: string[];
  sessions: BenchmarkSession[];
}
