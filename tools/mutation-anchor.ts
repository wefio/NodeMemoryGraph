// Where a mutant applies, and what it writes there.
//
// This module is the anchor: a mutant may name its site by syntax tree, by bytes, or by a derived
// selector (`derive`: an operator over a member-scoped fragment), and the replacement bytes are
// returned with the range. It holds no state and reads no file, so the sweep and the anchors-only pass
// ask the same function the same question, and a test can ask it about a source string.
import ts from "typescript";

export interface Mutant {
  /** What the wrong version does, in the words of the rule it breaks. */
  readonly name: string;
  /** The exact bytes to replace. Omitted when `ast` or `derive` locates the site instead. */
  readonly from?: string;
  /** A format-independent locator: find the site by syntax tree, not by text. Prettier reflows these
   *  files on every commit, and a text anchor silently stops applying the first time that happens. */
  readonly ast?: {
    /** The method or function whose body is searched. The structurally scoped form: it survives
     *  reflow, and it refuses when the code it guards has moved out of the member it belongs to. */
    readonly within?: string;
    /** The call or constructor to locate, by its callee name. */
    readonly call?: string;
    /** How many arguments it takes, when the count is what tells the sites apart. */
    readonly argCount?: number;
  };
  /**
   * A derived site: the operator and the selector are the mutant's durable part, and the bytes are
   * computed here on every run. This is what keeps a tooth alive across the edits that retire a text
   * anchor - inlining a call, extracting a message, reflowing a statement. The name stays hand-written,
   * because it is what the ledger and the named case refer to.
   */
  readonly derive?: Derive;
  readonly to?: string;
  /** The test that must be the one to fail. */
  readonly expect: string;
}

/** The operators a derived mutant may use, and the selector each one needs. */
export interface Derive {
  /** The member whose body holds the site. Exact, and required: the scope is what makes it unique. */
  readonly within: string;
  readonly operator:
    /** The condition the selector identifies never holds: it becomes `false`. */
    | "condition-never"
    /** The condition the selector identifies always holds: it becomes `true`. The mirror of
     *  `condition-never`, because a rule written as `return a && b` says "this holds" - replacing it
     *  with `false` would reverse the rule instead of removing it. */
    | "condition-holds"
    /** One term of that condition becomes its identity: `true` under `&&`, `false` under `||`. */
    | "neutralize-term"
    /** Argument `arg` of the call to `call` becomes the declared `to` fragment. */
    | "replace-argument"
    /** The value of the object property named `property` becomes the declared `to` fragment. */
    | "replace-property"
    /** The statement the selector identifies is removed, with its line and its indentation. */
    | "drop-statement";
  /** Which guard: a fragment its condition's own text contains, e.g. `existing.deliveredBy`. */
  readonly condition?: string;
  /** Which term of it, for `neutralize-term`: the term's own text, e.g. `!task.cancelled`. */
  readonly term?: string;
  /** Which call, for `replace-argument`: its callee as written, e.g. `startableTasks`. */
  readonly call?: string;
  /** Which argument, for `replace-argument`, counting from zero. */
  readonly arg?: number;
  /** Which property, for `replace-property`: its name as written, e.g. `sessionReusable`. */
  readonly property?: string;
  /** For `replace-property`: a fragment of the object literal that holds it, when the same property
   *  name is written in several literals of one member and only one of them is the site. */
  readonly in?: string;
  /** Which statement, for `drop-statement`: a fragment of the statement's own text. */
  readonly statement?: string;
}

/** The replacement bytes, absent only while `derive` computes them. The two value-substituting
 *  operators (`replace-argument`, `replace-property`) read it as the new value's text. */

/** A located site: the byte range to replace, and what to put there. */
export interface Site {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly retaken: boolean;
}

/** Whitespace-normalized text search: exact bytes first, then reflowed form.
 *
 *  The commit hook runs prettier, so a reflowed anchor must not retire a tooth. More than one match
 *  is still refused, because replacing the first would leave the rule intact somewhere else. */
export function matchText(
  haystack: string,
  anchor: string,
): { start: number; end: number; retaken: boolean } | { reason: string } {
  const occurrences = haystack.split(anchor).length - 1;
  if (occurrences === 1) {
    const start = haystack.indexOf(anchor);
    return { start, end: start + anchor.length, retaken: false };
  }
  if (occurrences > 1)
    return { reason: `marker occurs ${occurrences} times, refusing to claim a check` };
  // Built without a regex literal: one containing `${` confuses Node's type-stripping parser.
  const special = ".*+?^$()[]{}|\\";
  const escaped = anchor
    .trim()
    .split(/\s+/u)
    .map((part) => [...part].map((ch) => (special.includes(ch) ? "\\" + ch : ch)).join(""))
    .join("\\s+");
  const matches = [...haystack.matchAll(new RegExp(escaped, "gu"))];
  if (matches.length !== 1)
    return {
      reason: `marker not found (${matches.length} matches once whitespace is normalized), refusing to claim a check`,
    };
  const match = matches[0]!;
  return { start: match.index, end: match.index + match[0].length, retaken: true };
}

/** Where a mutant applies: by selector when it derives one, by syntax tree when it says so, by bytes
 *  otherwise.
 *
 *  A site that cannot be located is a failure, not an "not applicable": that verdict is reserved for
 *  a target file that is not on this branch at all. Files that are still being edited should carry a
 *  derived selector or an `ast` locator, because a text anchor in them retires itself the first time
 *  the formatter runs. */
export function locate(text: string, mutant: Mutant): Site | { reason: string } {
  if (mutant.derive) {
    const derived = deriveSite(text, mutant.derive, mutant.to);
    if ("reason" in derived)
      return { reason: `derived ${mutant.derive.operator}: ${derived.reason}` };
    return derived;
  }
  if (mutant.to === undefined)
    return { reason: "mutant has no replacement and no derive operator" };
  if (mutant.ast) {
    const source = ts.createSourceFile("mutant.ts", text, ts.ScriptTarget.Latest, true);
    if (mutant.ast.within !== undefined) {
      const members: ts.Node[] = [];
      const visit = (node: ts.Node): void => {
        const named =
          (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
          node.name?.getText(source) === mutant.ast!.within;
        if (named) members.push(node);
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (members.length !== 1)
        return {
          reason: `ast scope ${mutant.ast.within} matched ${members.length} members, refusing to claim a check`,
        };
      const member = members[0]!;
      if (mutant.from === undefined)
        return { reason: "an ast scope needs a from anchor to find inside it" };
      const inner = matchText(member.getText(source), mutant.from);
      if ("reason" in inner) return { reason: `inside ${mutant.ast.within}: ${inner.reason}` };
      const offset = member.getStart(source);
      return {
        start: offset + inner.start,
        end: offset + inner.end,
        retaken: inner.retaken,
        replacement: mutant.to,
      };
    }
    const found: ts.Node[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const args = node.arguments?.length ?? 0;
        if (
          node.expression.getText(source) === mutant.ast!.call &&
          (mutant.ast!.argCount === undefined || args === mutant.ast!.argCount)
        )
          found.push(node);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    if (found.length !== 1)
      return {
        reason: `ast locator ${mutant.ast.call} matched ${found.length} sites, refusing to claim a check`,
      };
    return {
      start: found[0]!.getStart(source),
      end: found[0]!.getEnd(),
      retaken: false,
      replacement: mutant.to,
    };
  }
  if (mutant.from === undefined)
    return { reason: "mutant has neither an ast locator nor a from anchor" };
  const found = matchText(text, mutant.from);
  if ("reason" in found) return found;
  if (found.retaken)
    process.stdout.write(
      `  re-taken anchor: ${mutant.name} (formatting reflowed it; ${String(found.end - found.start)} bytes)\n`,
    );
  return { ...found, replacement: mutant.to };
}

/** Every node a predicate accepts, in source order. */
function collect<T extends ts.Node>(root: ts.Node, isWanted: (node: ts.Node) => boolean): T[] {
  const found: T[] = [];
  const walk = (node: ts.Node): void => {
    if (isWanted(node)) found.push(node as T);
    ts.forEachChild(node, walk);
  };
  walk(root);
  return found;
}

/** The one member with this name in the file, or why it is not one site. */
function uniqueMember(source: ts.SourceFile, name: string): ts.Node | { reason: string } {
  const named = (node: ts.Node): boolean =>
    (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
    node.name?.getText(source) === name;
  const members = collect<ts.Node>(source, named);
  if (members.length !== 1)
    return {
      reason: `member ${name} matched ${members.length} members, refusing to claim a check`,
    };
  return members[0]!;
}

/** Argument `arg` of the one call to `call` inside the member. */
function argumentSite(
  source: ts.SourceFile,
  member: ts.Node,
  derive: Derive,
  to: string | undefined,
): Site | { reason: string } {
  if (derive.call === undefined || derive.arg === undefined)
    return { reason: "replace-argument needs `call` and `arg`" };
  if (to === undefined) return { reason: "replace-argument needs the mutant's `to` fragment" };
  const calls = collect<ts.CallExpression>(
    member,
    (node) => ts.isCallExpression(node) && node.expression.getText(source) === derive.call,
  );
  if (calls.length !== 1)
    return {
      reason: `call ${derive.call} matched ${calls.length} sites in ${derive.within}, refusing to claim a check`,
    };
  const argument = calls[0]!.arguments[derive.arg];
  if (!argument)
    return {
      reason: `call ${derive.call} has no argument ${derive.arg}, refusing to claim a check`,
    };
  return {
    start: argument.getStart(source),
    end: argument.getEnd(),
    replacement: to,
    retaken: false,
  };
}

/** The text of the object literal a property sits in, which is what tells two same-named ones apart. */
function holderText(source: ts.SourceFile, node: ts.Node): string {
  let holder: ts.Node | undefined = node.parent;
  while (holder && !ts.isObjectLiteralExpression(holder)) holder = holder.parent;
  return holder ? holder.getText(source) : "";
}

/** The value of the one object property with this name inside the member. */
function propertySite(
  source: ts.SourceFile,
  member: ts.Node,
  derive: Derive,
  to: string | undefined,
): Site | { reason: string } {
  if (derive.property === undefined) return { reason: "replace-property needs a `property` name" };
  if (to === undefined) return { reason: "replace-property needs the mutant's `to` fragment" };
  const named = (node: ts.Node): boolean =>
    ts.isPropertyAssignment(node) && node.name.getText(source) === derive.property;
  const properties = collect<ts.PropertyAssignment>(member, named);
  const held =
    derive.in === undefined
      ? properties
      : properties.filter((node) => holderText(source, node).includes(derive.in!));
  if (held.length !== 1)
    return {
      reason: `property ${derive.property} matched ${held.length} sites in ${derive.within}, refusing to claim a check`,
    };
  const value = held[0]!.initializer;
  return { start: value.getStart(source), end: value.getEnd(), replacement: to, retaken: false };
}

/** The statement containing this fragment, deleted with its line and its indentation. */
function statementSite(
  source: ts.SourceFile,
  member: ts.Node,
  derive: Derive,
  text: string,
): Site | { reason: string } {
  if (derive.statement === undefined)
    return { reason: "drop-statement needs a `statement` fragment" };
  const fragment = derive.statement;
  const containing = (node: ts.Node): boolean =>
    (ts.isExpressionStatement(node) ||
      ts.isVariableStatement(node) ||
      ts.isReturnStatement(node) ||
      ts.isThrowStatement(node)) &&
    node.getText(source).includes(fragment);
  const statements = collect<ts.Statement>(member, containing);
  if (statements.length !== 1)
    return {
      reason: `${statements.length} statements in ${derive.within} contain the fragment, refusing to claim a check`,
    };
  const statement = statements[0]!;
  // The whole line goes: the indentation to its left and the newline to its right. A trailing comment
  // on that line would be dropped with it, and a statement that shares its line with anything else
  // would leave half of that line behind, so both are refused rather than silently damaged.
  let start = statement.getStart(source);
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start -= 1;
  if (start > 0 && text[start - 1] !== "\n")
    return {
      reason: "the statement does not begin its line, refusing to delete part of another one",
    };
  const newline = text.slice(statement.getEnd()).match(/^[ \t]*(\r?\n)/u);
  if (!newline)
    return { reason: "the statement is not alone on its line, refusing to drop the line with it" };
  return { start, end: statement.getEnd() + newline[0].length, replacement: "", retaken: false };
}

/** The expression a decision position holds: a test, a returned value, an arrow's body, a bound value. */
function decisionExpression(node: ts.Node): ts.Expression | undefined {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node))
    return node.expression;
  if (ts.isConditionalExpression(node)) return node.condition;
  if (ts.isReturnStatement(node)) return node.expression;
  if (ts.isForStatement(node)) return node.condition;
  if (ts.isVariableDeclaration(node)) return node.initializer;
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return node.body;
  return undefined;
}

/** Every decision expression in the member, in source order. */
function decisionExpressions(member: ts.Node): ts.Expression[] {
  const found: ts.Expression[] = [];
  const walk = (node: ts.Node): void => {
    const expression = decisionExpression(node);
    if (expression) found.push(expression);
    ts.forEachChild(node, walk);
  };
  walk(member);
  return found;
}

/**
 * The boolean expression the selector names: the member's decision positions, innermost first.
 *
 * Decision positions rather than only guards, because `return a && b` and `array.filter((x) => x.y)`
 * are the same rule written without an `if`. A fragment can sit inside two of them at once, because
 * an arrow's body may hold another arrow:
 * `const ids = (pending) => tasks.filter((task) => !task.claimed && ready(task))`. The innermost one
 * is the position the fragment names; two disjoint positions are two possible sites, and a site the
 * selector cannot tell apart is refused.
 */
function conditionSite(
  source: ts.SourceFile,
  member: ts.Node,
  derive: Derive,
): ts.Expression | { reason: string } {
  const conditions = decisionExpressions(member);
  const matching =
    derive.condition === undefined
      ? conditions
      : conditions.filter((condition) => condition.getText(source).includes(derive.condition!));
  const innermost = matching.filter(
    (condition) =>
      !matching.some(
        (other) =>
          other !== condition &&
          other.getStart(source) >= condition.getStart(source) &&
          other.getEnd() <= condition.getEnd(),
      ),
  );
  if (innermost.length !== 1)
    return {
      reason:
        derive.condition === undefined
          ? `${conditions.length} conditions in ${derive.within}, refusing to choose one`
          : `${innermost.length} conditions in ${derive.within} mention ${derive.condition}, refusing to claim a check`,
    };
  return innermost[0]!;
}

/** A condition replaced whole: it never holds, or it always holds. */
function wholeCondition(
  source: ts.SourceFile,
  condition: ts.Expression,
  derive: Derive,
): Site | { reason: string } {
  if (derive.condition === undefined)
    return { reason: `${derive.operator} needs a \`condition\` fragment` };
  // These two operators replace the condition whole, so a fragment that names only part of it would
  // silently widen the mutant into "every reason this rule has". A term has its own operator.
  const text = condition.getText(source);
  const whole = matchText(text, derive.condition);
  if ("reason" in whole) return { reason: `inside the condition: ${whole.reason}` };
  if (whole.start !== 0 || whole.end !== text.length)
    return {
      reason: `the fragment names part of ${derive.within}'s condition; ${derive.operator} replaces all of it - use neutralize-term for a term`,
    };
  return {
    start: condition.getStart(source),
    end: condition.getEnd(),
    replacement: derive.operator === "condition-never" ? "false" : "true",
    retaken: whole.retaken,
  };
}

/**
 * The literal that makes a term's operator absorb it: `true` under `&&`, `false` under `||`. The
 * literal is what keeps the rest of the condition - and its formatting - intact. `null` when the code
 * does not say which operator joins the term, which is refused rather than guessed at.
 */
function identityLiteral(before: string, after: string): string | null {
  // The fragment may be the last operand of a parenthesized group, so brackets between it and the
  // joining operator are skipped before the operator is read, and the operator on the left is read
  // only when there is nothing to the right.
  const afterBare = after
    .trimStart()
    .replace(/^[)\]},;]+/u, "")
    .trimStart();
  const beforeBare = before
    .trimEnd()
    .replace(/[[({]+$/u, "")
    .trimEnd();
  if (afterBare.startsWith("&&")) return "true";
  if (afterBare.startsWith("||")) return "false";
  if (afterBare !== "") return null;
  if (beforeBare.endsWith("&&")) return "true";
  if (beforeBare.endsWith("||")) return "false";
  return null;
}

/** One term of a condition becomes its identity. */
function neutralizedTerm(
  source: ts.SourceFile,
  condition: ts.Expression,
  derive: Derive,
): Site | { reason: string } {
  if (derive.term === undefined) return { reason: "neutralize-term needs a `term` fragment" };
  const text = condition.getText(source);
  const term = matchText(text, derive.term);
  if ("reason" in term) return { reason: `inside the condition: ${term.reason}` };
  const literal = identityLiteral(text.slice(0, term.start), text.slice(term.end));
  if (literal === null)
    return {
      reason: `cannot tell which operator joins the term in ${derive.within}, refusing to claim a check`,
    };
  const offset = condition.getStart(source);
  return {
    start: offset + term.start,
    end: offset + term.end,
    replacement: literal,
    retaken: term.retaken,
  };
}

/**
 * Resolve a derived mutant: the selector picks the code, the operator says what to do to it, and the
 * bytes are computed here rather than stored. Every selector is scoped to one member, and every
 * fragment is matched as exactly one occurrence or refused, so a reflow or an inlining that would
 * retire a byte anchor leaves a derived tooth applying.
 */
function deriveSite(
  text: string,
  derive: Derive,
  to: string | undefined,
): Site | { reason: string } {
  const source = ts.createSourceFile("mutant.ts", text, ts.ScriptTarget.Latest, true);
  const member = uniqueMember(source, derive.within);
  if ("reason" in member) return member;
  if (derive.operator === "replace-argument") return argumentSite(source, member, derive, to);
  if (derive.operator === "replace-property") return propertySite(source, member, derive, to);
  if (derive.operator === "drop-statement") return statementSite(source, member, derive, text);
  const condition = conditionSite(source, member, derive);
  if ("reason" in condition) return condition;
  return derive.operator === "neutralize-term"
    ? neutralizedTerm(source, condition, derive)
    : wholeCondition(source, condition, derive);
}
