import type { RecallTerm } from "./recall-vocabulary.ts";
import { containsSecret } from "./write-policy.ts";

export function normalizeRecallPhrase(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function recallInput(prompt: string): string {
  prompt = prompt.normalize("NFKC");
  if (prompt.length > 4096 || containsSecret(prompt)) return "";
  if (
    /(?:翻译|字符串|打印|translate|literal string|print)/iu.test(prompt) ||
    /(?:不要|不用|不需要|别).{0,8}(?:记忆|回忆|检索)|\b(?:without|no|don't use|do not use)\s+memory\b/iu.test(
      prompt,
    )
  )
    return "";
  return normalizeRecallPhrase(
    prompt
      .replace(/```[\s\S]*?(?:```|$)/gu, " ")
      .replace(/`[^`\n]*(?:`|$)|“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*'/gu, " "),
  );
}

export function literalPositions(text: string, phrase: string, prefix = false): number[] {
  const found: number[] = [];
  if (!phrase) return found;
  let position = text.indexOf(phrase);
  while (position >= 0) {
    const left = text[position - 1] ?? "",
      right = text[position + phrase.length] ?? "";
    const leftBoundary =
      !/^[\p{Script=Latin}\p{N}_]/u.test(phrase) || !/[\p{Script=Latin}\p{N}_]/u.test(left);
    const rightBoundary =
      prefix ||
      !/[\p{Script=Latin}\p{N}_]$/u.test(phrase) ||
      !/[\p{Script=Latin}\p{N}_]/u.test(right);
    if (leftBoundary && rightBoundary) found.push(position);
    position = text.indexOf(phrase, position + 1);
  }
  return found;
}

function contextMatches(
  text: string,
  words: readonly string[] | undefined,
  before: boolean,
  term: RecallTerm,
): boolean {
  if (!words) return true;
  return words.some((word) =>
    literalPositions(text, word, term.afterPrefix && !before).some((position) => {
      const gap = before ? text.slice(position + word.length) : text.slice(0, position);
      return (
        gap.trim().length <= (term.gap ?? 4096) && (!term.sentence || !/[。！？?\n]/u.test(gap))
      );
    }),
  );
}

export function matchesRecallTerm(text: string, term: RecallTerm): boolean {
  return literalPositions(text, term.phrase).some((position) => {
    if (term.start && position !== 0) return false;
    const before = text.slice(0, position),
      after = text.slice(position + term.phrase.length);
    if (term.followedByName && !/^\s+[\p{L}]/u.test(after)) return false;
    return (
      contextMatches(before, term.before, true, term) &&
      contextMatches(after, term.after, false, term)
    );
  });
}

export function selectRecallTerm(
  text: string,
  terms: readonly RecallTerm[],
): RecallTerm | undefined {
  const matches = terms.filter((term) => matchesRecallTerm(text, term));
  return matches.find((term) => term.mode === "retrieve") ?? matches[0];
}
