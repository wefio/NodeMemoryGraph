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
    /** The condition the selector identifies becomes its negation. The operator pitest calls Negate
     *  Conditionals: a rule that refuses when the condition holds now refuses when it does not. */
    | "negate-condition"
    /** The comparison the selector identifies gets the negated comparison operator (`===` becomes
     *  `!==`, `<` becomes `>=`). The narrower sibling of `negate-condition`, for a rule whose point is
     *  the comparison itself. */
    | "negate-comparison"
    /** The guard the selector identifies is dropped and its body is kept, so the guarded code runs
     *  whatever the condition said. pitest's Remove Conditionals. */
    | "remove-conditionals"
    /** The call the selector identifies becomes its receiver, so the method's work is skipped: a
     *  `filter` that no longer filters, a `slice` that no longer cuts. pitest's Void Method Calls and
     *  Stryker's filter/slice/sort removals. */
    | "remove-call"
    /** The call the selector identifies becomes the declared `to` fragment, for a call replaced by a
     *  different source of the same shape. */
    | "replace-call"
    /** One term of that condition becomes its identity: `true` under `&&`, `false` under `||`. */
    | "neutralize-term"
    /** Argument `arg` of the call to `call` becomes the declared `to` fragment. */
    | "replace-argument"
    /** The value of the object property named `property` becomes the declared `to` fragment. */
    | "replace-property"
    /** The initializer of the variable named `variable` becomes the declared `to` fragment: the value
     *  bound here is a different one, which is what `primitive returns` and `inline constant` mutate. */
    | "replace-initializer"
    /** The iterable of the loop the selector identifies becomes the declared `to` fragment, so the
     *  loop runs over an empty or a shortened collection. */
    | "replace-iterable"
    /** The statement the selector identifies is removed, with its line and its indentation: an
     *  expression, a declaration, a `return`, a `throw`, or a guard clause. */
    | "drop-statement";
  /** Which guard or which comparison: a fragment its own text contains, e.g. `existing.deliveredBy`. */
  readonly condition?: string;
  /** Which term of it, for `neutralize-term`: the term's own text, e.g. `!task.cancelled`. */
  readonly term?: string;
  /** Which call, for `replace-argument`, `remove-call` and `replace-call`: its callee as written,
   *  e.g. `startableTasks`, or `board.candidates().filter` when the receiver is what tells it apart. */
  readonly call?: string;
  /** Which argument, for `replace-argument`, counting from zero. */
  readonly arg?: number;
  /** Which property, for `replace-property`: its name as written, e.g. `sessionReusable`. */
  readonly property?: string;
  /** Which variable, for `replace-initializer`: its name as written. */
  readonly variable?: string;
  /** Which loop, for `replace-iterable`: a fragment of the loop's own text, e.g. `of unknownBudget`. */
  readonly iterable?: string;
  /** The holder that tells two same-named sites apart: for `replace-property`, a fragment of the
   *  object literal that holds it; for `replace-argument`, a fragment of the call's own text; for
   *  `remove-call` and `replace-call`, a fragment of the statement the call sits in. */
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

/** Does this text contain the fragment, ignoring the line breaks the formatter chose? A filter that
 *  asks "which candidate mentions this" must not require the fragment to be unique inside the
 *  candidate: `b` appears three times in `a && (b || !b)`, and that condition is still the one a
 *  selector naming `b` is talking about. */
function containsText(haystack: string, fragment: string): boolean {
  return haystack.replace(/\s+/gu, " ").includes(fragment.replace(/\s+/gu, " ").trim());
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

/** The one member with this name in the file, or why it is not one site. A class constructor is a
 *  member too: its name is written `constructor`, and code that refuses a second plan while it opens
 *  the store lives there and nowhere else. So is a function bound to a name - `const count = (label)
 *  => ...` names one function, and whether the formatter wrote it as a declaration is not a fact about
 *  which rules live inside it. */
function uniqueMember(source: ts.SourceFile, name: string): ts.Node | { reason: string } {
  const boundFunction = (node: ts.Node): boolean =>
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === name &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
  const named = (node: ts.Node): boolean =>
    ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.getText(source) === name) ||
    boundFunction(node) ||
    (ts.isConstructorDeclaration(node) && name === "constructor");
  const members = collect<ts.Node>(source, named);
  if (members.length !== 1)
    return {
      reason: `member ${name} matched ${members.length} members, refusing to claim a check`,
    };
  const member = members[0]!;
  // A name bound to a function is the function's body for every purpose here, so the selectors search
  // the body rather than the declaration that wraps it.
  if (ts.isVariableDeclaration(member) && member.initializer) return member.initializer;
  return member;
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
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(source) === derive.call &&
      (derive.in === undefined || containsText(node.getText(source), derive.in)),
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
  // A guard clause is a statement like any other: `if (...) throw ...;` is dropped whole, and the
  // statement matcher normalizes whitespace so a reflow cannot make it unfindable.
  const containing = (node: ts.Node): boolean =>
    (ts.isExpressionStatement(node) ||
      ts.isVariableStatement(node) ||
      ts.isReturnStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isIfStatement(node)) &&
    containsText(node.getText(source), fragment);
  const statements = collect<ts.Statement>(member, containing);
  // The innermost statement wins, the same rule conditions follow: a guard whose body is itself a
  // statement is the guard, not the two of them.
  const innermost = statements.filter(
    (statement) =>
      !statements.some(
        (other) =>
          other !== statement &&
          other.getStart(source) >= statement.getStart(source) &&
          other.getEnd() <= statement.getEnd(),
      ),
  );
  if (innermost.length !== 1)
    return {
      reason: `${innermost.length} statements in ${derive.within} contain the fragment, refusing to claim a check`,
    };
  const statement = innermost[0]!;
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
  // Matched with the same whitespace normalization as everything else: a condition written across
  // lines is still one condition, and a fragment that names it must not have to reproduce the line
  // breaks prettier chose.
  const mentions = (condition: ts.Expression): boolean =>
    derive.condition === undefined || containsText(condition.getText(source), derive.condition);
  const matching = conditions.filter(mentions);
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

/** What every resolver is given: the parsed file, the one member, the selector, and the bytes a
 *  value-substituting operator declares. */
interface Context {
  readonly source: ts.SourceFile;
  readonly text: string;
  readonly member: ts.Node;
  readonly derive: Derive;
  readonly to: string | undefined;
}

type Resolver = (context: Context) => Site | { reason: string };

/** The inner sites of one collection, with the nested ones dropped: a guard whose body is a statement
 *  is the guard and not the two of them, and the same rule serves conditions, statements, comparisons
 *  and guards. */
function innermost<T extends ts.Node>(source: ts.SourceFile, nodes: readonly T[]): T[] {
  return nodes.filter(
    (node) =>
      !nodes.some(
        (other) =>
          other !== node &&
          other.getStart(source) >= node.getStart(source) &&
          other.getEnd() <= node.getEnd(),
      ),
  );
}

/** The one collection site the fragment identifies, or why there is not one. */
function oneSite<T extends ts.Node>(
  source: ts.SourceFile,
  derive: Derive,
  nodes: readonly T[],
  what: string,
): T | { reason: string } {
  const inner = innermost(source, nodes);
  if (inner.length !== 1)
    return {
      reason: `${inner.length} ${what} in ${derive.within} match the selector, refusing to claim a check`,
    };
  return inner[0]!;
}

/** Every comparison operator, and the one that reverses it. */
const NEGATED_COMPARISON: Readonly<Record<string, string>> = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
};

/** The condition the selector identifies becomes its negation. A condition that is already a whole
 *  negation drops its `!` - which is exactly the negation - and anything else is wrapped, because
 *  removing a `!` that binds only the first operand (`!a || b`) would not negate the whole. */
function negateCondition(context: Context): Site | { reason: string } {
  const condition = conditionSite(context.source, context.member, context.derive);
  if ("reason" in condition) return condition;
  if (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken
  )
    return {
      start: condition.getStart(context.source),
      end: condition.operand.getStart(context.source),
      replacement: "",
      retaken: false,
    };
  return {
    start: condition.getStart(context.source),
    end: condition.getEnd(),
    replacement: `!(${condition.getText(context.source)})`,
    retaken: false,
  };
}

/** The comparison the selector identifies gets the operator that reverses it. */
function negateComparison(context: Context): Site | { reason: string } {
  const { source, derive } = context;
  if (derive.condition === undefined)
    return { reason: "negate-comparison needs a `condition` fragment naming the comparison" };
  const fragment = derive.condition;
  const comparing = (node: ts.Node): boolean =>
    ts.isBinaryExpression(node) &&
    NEGATED_COMPARISON[node.operatorToken.getText(source)] !== undefined &&
    containsText(node.getText(source), fragment);
  const found = oneSite(
    source,
    derive,
    collect<ts.BinaryExpression>(context.member, comparing),
    "comparisons",
  );
  if ("reason" in found) return found;
  const written = found.operatorToken.getText(source);
  const after = found.left.getEnd();
  const gap = context.text.slice(after, found.right.getStart());
  const at = gap.indexOf(written);
  if (at < 0)
    return { reason: `cannot read ${written} in ${derive.within}, refusing to claim a check` };
  return {
    start: after + at,
    end: after + at + written.length,
    replacement: NEGATED_COMPARISON[written]!,
    retaken: false,
  };
}

/** The guard the selector identifies goes, and its body stays: the guarded code runs whatever the
 *  condition said. A guard with an `else` would have to choose a branch, and a block body would have
 *  to be unindented, so both are refused rather than rewritten. */
function removeConditionals(context: Context): Site | { reason: string } {
  const { source, derive } = context;
  if (derive.condition === undefined)
    return { reason: "remove-conditionals needs a `condition` fragment naming the guard" };
  const fragment = derive.condition;
  const found = oneSite(
    source,
    derive,
    collect<ts.IfStatement>(
      context.member,
      (node) => ts.isIfStatement(node) && containsText(node.expression.getText(source), fragment),
    ),
    "guards",
  );
  if ("reason" in found) return found;
  if (found.elseStatement)
    return { reason: `the guard in ${derive.within} has an else, refusing to choose a branch` };
  if (ts.isBlock(found.thenStatement))
    return {
      reason: `the guard's body in ${derive.within} is a block, refusing to rewrite its indentation`,
    };
  return {
    start: found.getStart(source),
    end: found.getEnd(),
    replacement: found.thenStatement.getText(source),
    retaken: false,
  };
}

/** The text of the nearest statement a node sits in. Two identical expressions can be written in one
 *  member - `board.candidates()` on offer and the same call filtered - and the statement that holds
 *  each is what tells them apart without naming a line. */
function holderStatementText(source: ts.SourceFile, node: ts.Node): string {
  let holder: ts.Node = node;
  while (holder.parent && !ts.isStatement(holder)) holder = holder.parent;
  return ts.isStatement(holder) ? holder.getText(source) : node.getText(source);
}

/** The one call the selector names, by the callee as written. */
function callSite(context: Context): ts.CallExpression | { reason: string } {
  const { source, derive } = context;
  if (derive.call === undefined) return { reason: `${derive.operator} needs a \`call\` fragment` };
  const found = oneSite(
    source,
    derive,
    collect<ts.CallExpression>(
      context.member,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(source) === derive.call &&
        (derive.in === undefined || containsText(holderStatementText(source, node), derive.in)),
    ),
    `calls to ${derive.call}`,
  );
  if ("reason" in found) return found;
  return found;
}

/** The call becomes its receiver: the method's work is skipped, and what it was called on is what is
 *  left. Only a method call has a receiver to fall back to, so anything else is refused. */
function removeCall(context: Context): Site | { reason: string } {
  const call = callSite(context);
  if ("reason" in call) return call;
  if (!ts.isPropertyAccessExpression(call.expression))
    return { reason: `remove-call needs a method call, and ${context.derive.call} is not one` };
  return {
    start: call.getStart(context.source),
    end: call.getEnd(),
    replacement: call.expression.expression.getText(context.source),
    retaken: false,
  };
}

/** The call becomes the declared fragment: a different source of the same shape. */
function replaceCall(context: Context): Site | { reason: string } {
  if (context.to === undefined) return { reason: "replace-call needs the mutant's `to` fragment" };
  const call = callSite(context);
  if ("reason" in call) return call;
  return {
    start: call.getStart(context.source),
    end: call.getEnd(),
    replacement: context.to,
    retaken: false,
  };
}

/** The initializer of the one variable the selector names becomes the declared fragment. */
function replaceInitializer(context: Context): Site | { reason: string } {
  const { source, derive } = context;
  if (derive.variable === undefined)
    return { reason: "replace-initializer needs a `variable` name" };
  if (context.to === undefined)
    return { reason: "replace-initializer needs the mutant's `to` fragment" };
  const found = oneSite(
    source,
    derive,
    collect<ts.VariableDeclaration>(
      context.member,
      (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === derive.variable,
    ),
    `declarations of ${derive.variable}`,
  );
  if ("reason" in found) return found;
  const initializer = found.initializer;
  if (!initializer)
    return { reason: `${derive.variable} has no initializer, refusing to claim a check` };
  return {
    start: initializer.getStart(source),
    end: initializer.getEnd(),
    replacement: context.to,
    retaken: false,
  };
}

/** The iterable of the one loop the selector identifies becomes the declared fragment: the loop body
 *  runs over a collection that is empty, or shorter than the one the code meant. */
function replaceIterable(context: Context): Site | { reason: string } {
  const { source, derive } = context;
  if (derive.iterable === undefined)
    return { reason: "replace-iterable needs an `iterable` fragment naming the loop" };
  if (context.to === undefined)
    return { reason: "replace-iterable needs the mutant's `to` fragment" };
  const fragment = derive.iterable;
  const found = oneSite(
    source,
    derive,
    collect<ts.ForOfStatement>(
      context.member,
      (node) => ts.isForOfStatement(node) && containsText(node.getText(source), fragment),
    ),
    "loops",
  );
  if ("reason" in found) return found;
  return {
    start: found.expression.getStart(source),
    end: found.expression.getEnd(),
    replacement: context.to,
    retaken: false,
  };
}

/** The operators, each one a function of the selector and the declared bytes. Adding an operator means
 *  adding an entry here and its name to `Derive["operator"]`: nothing else in the register changes. */
const RESOLVERS: Readonly<Record<Derive["operator"], Resolver>> = {
  "condition-never": (context) => {
    const condition = conditionSite(context.source, context.member, context.derive);
    if ("reason" in condition) return condition;
    return wholeCondition(context.source, condition, context.derive);
  },
  "condition-holds": (context) => {
    const condition = conditionSite(context.source, context.member, context.derive);
    if ("reason" in condition) return condition;
    return wholeCondition(context.source, condition, context.derive);
  },
  "negate-condition": negateCondition,
  "negate-comparison": negateComparison,
  "remove-conditionals": removeConditionals,
  "remove-call": removeCall,
  "replace-call": replaceCall,
  "replace-initializer": replaceInitializer,
  "replace-iterable": replaceIterable,
  "neutralize-term": (context) => {
    const condition = conditionSite(context.source, context.member, context.derive);
    if ("reason" in condition) return condition;
    return neutralizedTerm(context.source, condition, context.derive);
  },
  "replace-argument": (context) =>
    argumentSite(context.source, context.member, context.derive, context.to),
  "replace-property": (context) =>
    propertySite(context.source, context.member, context.derive, context.to),
  "drop-statement": (context) =>
    statementSite(context.source, context.member, context.derive, context.text),
};

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
  return RESOLVERS[derive.operator]({ source, text, member, derive, to });
}
