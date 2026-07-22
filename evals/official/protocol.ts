export function personaMemCorrect(hypothesis: string, reference: string): boolean {
  const expected = reference.toLocaleLowerCase().replace(/[()\s]/gu, "");
  const final = hypothesis.includes("<final_answer>")
    ? hypothesis.split("<final_answer>").at(-1)!.replace(/<\/final_answer>\s*$/u, "").trim()
    : hypothesis.trim();
  return optionLetters(final).size === 1 && optionLetters(final).has(expected) ||
    optionLetters(hypothesis).size === 1 && optionLetters(hypothesis).has(expected);
}

function optionLetters(value: string): Set<string> {
  const lower = value.toLocaleLowerCase();
  const parenthesized = [...lower.matchAll(/\(([a-d])\)/gu)].map((match) => match[1]!);
  return new Set(parenthesized.length > 0
    ? parenthesized
    : [...lower.matchAll(/\b([a-d])\b/gu)].map((match) => match[1]!));
}

export function beamJudgePrompt(question: string, rubric: string, response: string): string {
  return `You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- QUESTION (what the user asked): ${question}
- RUBRIC CRITERION (what to check): ${rubric}
- RESPONSE TO EVALUATE: ${response}

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate.

**IMPORTANT**: Pay careful attention to whether the rubric specifies positive requirements (things the response should include or do) or negative constraints (things it should not include or do).

## RESPONSIVENESS REQUIREMENT (anchored to the QUESTION)
A compliant response must be on-topic with respect to the question and attempt to answer it.
- If the response does not address the question, score 0.0 and stop.
- For negative constraints, both must hold: the response is responsive and the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept paraphrases and synonyms that preserve intent.
- Ignore case, punctuation, and whitespace differences.
- Treat equivalent numbers, currencies, dates, and durations as equal.
- If a number or duration is expected, extract and compare normalized values rather than strings.

## STYLE NEUTRALITY:
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format or structure. Do not penalize hedging, voice, or verbosity if the content satisfies the rubric.

## SCORING SCALE:
- 1.0 (Complete Compliance): the required element is present and accurate, or a prohibited element is absent in a responsive answer.
- 0.5 (Partial Compliance): the element is present with a minor inaccuracy or incomplete execution, or a negative constraint has only a minor edge violation.
- 0.0 (No Compliance): the required element is missing or incorrect, a prohibited element is present, or the answer is non-responsive.

## EVALUATION INSTRUCTIONS:
1. Determine whether the requirement asks for something to be present or absent.
2. For compound criteria, require all elements for 1.0, some for 0.5, and none for 0.0.
3. Check only compliance with this specific rubric criterion.
4. Assign a score from the scale above.
5. Explain whether the criterion was satisfied and why the score follows.

## OUTPUT FORMAT:
Return only a JSON object with fields "score" and "reason". The score must be 1.0, 0.5, or 0.0. Do not include any text before or after the JSON object.`;
}

export function beamEventAlignmentPrompt(
  question: string,
  rubric: string[],
  systemItems: string[],
): string {
  return `You align BEAM system-response items to its reference event list.

QUESTION:
${question}

REFERENCE EVENTS (their array indices are stable identifiers):
${JSON.stringify(rubric.map((event, index) => ({ index, event })), null, 2)}

SYSTEM ITEMS (one item per non-empty response line):
${JSON.stringify(systemItems.map((item, index) => ({ index, item })), null, 2)}

For every system item, in the original order, return {"referenceIndex": <integer or null>, "item": <the original item>}. Match by semantic equivalence, not exact wording. A reference index may be used at most once. Use null when no unused reference event is equivalent. Return exactly one output object per system item and only the JSON array, for example [{"referenceIndex":0,"item":"first line"},{"referenceIndex":null,"item":"extra line"}].`;
}

/**
 * BEAM event_ordering uses scipy.stats.kendalltau(variant="b") over the
 * union of reference and system events. Events missing from either list share
 * a common tie rank. This is the same calculation expressed without scipy.
 */
export function normalizedKendallTauB(reference: number[], candidate: number[]): number {
  const referenceUnique = unique(reference);
  const candidateUnique = unique(candidate);
  const union = unique([...referenceUnique, ...candidateUnique]);
  if (union.length < 2) return union.length === 1 ? 1 : 0;

  const tieRank = union.length + 1;
  const referenceRanks = ranks(referenceUnique, union, tieRank);
  const candidateRanks = ranks(candidateUnique, union, tieRank);
  let concordant = 0;
  let discordant = 0;
  let referenceOnlyTies = 0;
  let candidateOnlyTies = 0;

  for (let left = 0; left < union.length; left += 1) {
    for (let right = left + 1; right < union.length; right += 1) {
      const referenceDelta = Math.sign(referenceRanks[left]! - referenceRanks[right]!);
      const candidateDelta = Math.sign(candidateRanks[left]! - candidateRanks[right]!);
      if (referenceDelta === 0 && candidateDelta === 0) continue;
      if (referenceDelta === 0) referenceOnlyTies += 1;
      else if (candidateDelta === 0) candidateOnlyTies += 1;
      else if (referenceDelta === candidateDelta) concordant += 1;
      else discordant += 1;
    }
  }

  const denominator = Math.sqrt(
    (concordant + discordant + referenceOnlyTies) *
    (concordant + discordant + candidateOnlyTies),
  );
  if (denominator === 0) return 0;
  return ((concordant - discordant) / denominator + 1) / 2;
}

function ranks(sequence: number[], union: number[], missing: number): number[] {
  const byValue = new Map(sequence.map((value, index) => [value, index + 1]));
  return union.map((value) => byValue.get(value) ?? missing);
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}
