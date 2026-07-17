/**
 * The expression language behind OntologyFunction: a derived value computed from
 * an object's properties.
 *
 * Deliberately NOT eval/new Function/vm. A workflow tree is operator-authored
 * data that reaches the runtime through an import, so an expression is untrusted
 * input on a par with config — executing it as JavaScript would turn "import a
 * tree" into "run arbitrary code". The op set below is closed, total, and pure:
 * every operator is one of the cases here, there is no host access, no loops, and
 * no way to reach a global.
 *
 * Expressions parse at IMPORT time, not first use, so a typo'd property reference
 * fails the import with a path instead of surfacing as a null halfway through a
 * governed run.
 *
 * Properties are referenced with a `$` sigil ($claimed-amount) because ontology
 * ids are hyphenated: a bare `claimed-amount` would lex as subtraction.
 *
 * Expressions are also TYPE-CHECKED at import against the declared property types
 * and the function's declared `returns`. Without that, `returns` would be a label
 * nobody enforces: `$score >= 75` could claim `returns: string` and every client
 * reading the ontology would be told a lie that only surfaces at evaluation.
 */
import type { OntologyValue, OntologyValueType } from "./types.js";

/**
 * How a declared ontology type behaves INSIDE an expression. `date` and `id`
 * are strings: dates are ISO-8601 (so lexical order is chronological order) and
 * ids are opaque. `null` is the type of the null literal and of a coalesce guard.
 */
export type ExpressionType = "number" | "string" | "boolean" | "null";

export function expressionTypeOf(valueType: OntologyValueType): ExpressionType {
  switch (valueType) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

/**
 * Does a concrete value match a declared ontology type? Used wherever untyped
 * data meets the ontology — seeded objects at import, action parameters at call
 * time. null is always accepted: it is how an optional property says "unset".
 */
export function ontologyValueMatchesType(value: OntologyValue, type: OntologyValueType): boolean {
  return value === null || typeof value === expressionTypeOf(type);
}

type Node =
  | { kind: "literal"; value: OntologyValue }
  | { kind: "property"; id: string }
  | { kind: "unary"; op: "-" | "!"; operand: Node }
  | { kind: "binary"; op: BinaryOp; left: Node; right: Node }
  | { kind: "ternary"; condition: Node; whenTrue: Node; whenFalse: Node }
  | { kind: "call"; name: CallName; args: Node[] };

type BinaryOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";

/** Parsed, validated expression. Opaque: only this module reads the tree. */
export type OntologyExpression = { readonly root: Node };

export type OntologyExpressionParseResult =
  | { ok: true; expression: OntologyExpression }
  | { ok: false; error: string };

export type OntologyExpressionEvalResult =
  | { ok: true; value: OntologyValue }
  | { ok: false; error: string };

/**
 * Callable helpers, with arity. Closed on purpose: each one is total (no throw,
 * no host access) so an expression cannot fail the run, only return an error.
 */
const CALLS = {
  abs: 1,
  round: 1,
  floor: 1,
  ceil: 1,
  lower: 1,
  upper: 1,
  length: 1,
  min: 2,
  max: 2,
  coalesce: 2,
} as const satisfies Record<string, number>;

type CallName = keyof typeof CALLS;

function isCallName(name: string): name is CallName {
  return Object.hasOwn(CALLS, name);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "property"; id: string }
  | { kind: "name"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "end" };

/** Multi-char operators first: "<" would otherwise shadow "<=". */
const PUNCT = [
  "||",
  "&&",
  "==",
  "!=",
  "<=",
  ">=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "(",
  ")",
  ",",
  "?",
  ":",
];
/** Call names: a closed set, none of which is dotted. */
const NAME_CHAR = /[a-z0-9-]/;
/**
 * Property refs additionally take dots, because ontology ids are DOTTED ids
 * (EnterpriseIdSchema allows "a.b"). Stopping the ref at the first dot would make
 * a schema-valid property impossible to reference from a function.
 */
const PROPERTY_REF_CHAR = /[a-z0-9-.]/;
/** Same shape EnterpriseIdSchema enforces, so a ref cannot name an invalid id. */
const PROPERTY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

function tokenize(source: string): Token[] | string {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    if (char === "$") {
      let end = at + 1;
      while (end < source.length && PROPERTY_REF_CHAR.test(source[end])) {
        end += 1;
      }
      const id = source.slice(at + 1, end);
      if (!id) {
        return `expected a property id after "$" at position ${at}`;
      }
      // Catch a malformed ref (trailing/doubled dot) here rather than letting it
      // become a property id that no object type can ever declare.
      if (!PROPERTY_ID_PATTERN.test(id)) {
        return `"$${id}" at position ${at} is not a valid property id`;
      }
      tokens.push({ kind: "property", id });
      at = end;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = source.indexOf(char, at + 1);
      if (end < 0) {
        return `unterminated string starting at position ${at}`;
      }
      tokens.push({ kind: "string", value: source.slice(at + 1, end) });
      at = end + 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = at;
      while (end < source.length && /[0-9.]/.test(source[end])) {
        end += 1;
      }
      const raw = source.slice(at, end);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return `invalid number "${raw}" at position ${at}`;
      }
      tokens.push({ kind: "number", value });
      at = end;
      continue;
    }
    if (/[a-z]/.test(char)) {
      let end = at;
      while (end < source.length && NAME_CHAR.test(source[end])) {
        end += 1;
      }
      tokens.push({ kind: "name", value: source.slice(at, end) });
      at = end;
      continue;
    }
    const punct = PUNCT.find((candidate) => source.startsWith(candidate, at));
    if (!punct) {
      return `unexpected character "${char}" at position ${at}`;
    }
    tokens.push({ kind: "punct", value: punct });
    at += punct.length;
  }
  tokens.push({ kind: "end" });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent, lowest precedence first)
// ---------------------------------------------------------------------------

/** Binary tiers, loosest binding first. */
const BINARY_TIERS: readonly (readonly BinaryOp[])[] = [
  ["||"],
  ["&&"],
  ["==", "!="],
  ["<", "<=", ">", ">="],
  ["+", "-"],
  ["*", "/", "%"],
];

class Parser {
  private at = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.at];
  }

  private eatPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parse(): Node {
    const node = this.parseTernary();
    if (this.peek().kind !== "end") {
      throw new SyntaxError("unexpected trailing input");
    }
    return node;
  }

  private parseTernary(): Node {
    const condition = this.parseBinary(0);
    if (!this.eatPunct("?")) {
      return condition;
    }
    const whenTrue = this.parseTernary();
    if (!this.eatPunct(":")) {
      throw new SyntaxError('expected ":" to complete the "? :" expression');
    }
    return { kind: "ternary", condition, whenTrue, whenFalse: this.parseTernary() };
  }

  private parseBinary(tier: number): Node {
    const ops = BINARY_TIERS[tier];
    if (!ops) {
      return this.parseUnary();
    }
    let left = this.parseBinary(tier + 1);
    for (;;) {
      const token = this.peek();
      const op = ops.find((candidate) => token.kind === "punct" && token.value === candidate);
      if (!op) {
        return left;
      }
      this.at += 1;
      left = { kind: "binary", op, left, right: this.parseBinary(tier + 1) };
    }
  }

  private parseUnary(): Node {
    if (this.eatPunct("-")) {
      return { kind: "unary", op: "-", operand: this.parseUnary() };
    }
    if (this.eatPunct("!")) {
      return { kind: "unary", op: "!", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.peek();
    if (this.eatPunct("(")) {
      const inner = this.parseTernary();
      if (!this.eatPunct(")")) {
        throw new SyntaxError('expected ")"');
      }
      return inner;
    }
    if (token.kind === "number" || token.kind === "string") {
      this.at += 1;
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "property") {
      this.at += 1;
      return { kind: "property", id: token.id };
    }
    if (token.kind === "name") {
      this.at += 1;
      if (token.value === "true" || token.value === "false") {
        return { kind: "literal", value: token.value === "true" };
      }
      if (token.value === "null") {
        return { kind: "literal", value: null };
      }
      return this.parseCall(token.value);
    }
    throw new SyntaxError("expected a value");
  }

  private parseCall(name: string): Node {
    if (!isCallName(name)) {
      throw new SyntaxError(
        `unknown function "${name}"; available: ${Object.keys(CALLS).toSorted().join(", ")}`,
      );
    }
    if (!this.eatPunct("(")) {
      throw new SyntaxError(`expected "(" after "${name}"`);
    }
    const args: Node[] = [];
    if (!this.eatPunct(")")) {
      do {
        args.push(this.parseTernary());
      } while (this.eatPunct(","));
      if (!this.eatPunct(")")) {
        throw new SyntaxError(`expected ")" to close "${name}("`);
      }
    }
    const arity = CALLS[name];
    if (args.length !== arity) {
      throw new SyntaxError(`"${name}" takes ${arity} argument(s), got ${args.length}`);
    }
    return { kind: "call", name, args };
  }
}

/** Parse an expression. Errors are messages, never throws: this runs on import. */
export function parseOntologyExpression(source: string): OntologyExpressionParseResult {
  if (!source.trim()) {
    return { ok: false, error: "expression must not be blank" };
  }
  const tokens = tokenize(source);
  if (typeof tokens === "string") {
    return { ok: false, error: tokens };
  }
  try {
    return { ok: true, expression: { root: new Parser(tokens).parse() } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Property ids the expression reads. Import validation checks they are declared. */
export function ontologyExpressionProperties(expression: OntologyExpression): string[] {
  const found = new Set<string>();
  const visit = (node: Node): void => {
    // A literal reads nothing, so it has no branch here.
    if (node.kind === "property") {
      found.add(node.id);
    } else if (node.kind === "unary") {
      visit(node.operand);
    } else if (node.kind === "binary") {
      visit(node.left);
      visit(node.right);
    } else if (node.kind === "ternary") {
      visit(node.condition);
      visit(node.whenTrue);
      visit(node.whenFalse);
    } else if (node.kind === "call") {
      node.args.forEach(visit);
    }
  };
  visit(expression.root);
  return [...found].toSorted();
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** Thrown internally, caught at the boundary: an expression never breaks a run. */
class EvalError extends Error {}

function asNumber(value: OntologyValue, context: string): number {
  if (typeof value !== "number") {
    throw new EvalError(`${context} expects a number, got ${describe(value)}`);
  }
  return value;
}

function asString(value: OntologyValue, context: string): string {
  if (typeof value !== "string") {
    throw new EvalError(`${context} expects a string, got ${describe(value)}`);
  }
  return value;
}

function describe(value: OntologyValue): string {
  return value === null ? "null" : typeof value;
}

/** Only booleans are truthy/falsy: a null property must not silently read false. */
function asBoolean(value: OntologyValue, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new EvalError(`${context} expects a boolean, got ${describe(value)}`);
  }
  return value;
}

function compare(op: BinaryOp, left: OntologyValue, right: OntologyValue): boolean {
  // Ordering compares numbers with numbers and strings with strings (dates are
  // ISO strings, so lexical order is chronological order). Mixing them is a
  // definition bug worth surfacing, not something to coerce past.
  if (typeof left === "number" && typeof right === "number") {
    return orderedCompare(op, left, right);
  }
  if (typeof left === "string" && typeof right === "string") {
    return orderedCompare(op, left, right);
  }
  throw new EvalError(
    `"${op}" expects two numbers or two strings, got ${describe(left)} and ${describe(right)}`,
  );
}

function orderedCompare<T extends number | string>(op: BinaryOp, left: T, right: T): boolean {
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    default:
      return left >= right;
  }
}

function evaluateBinary(
  node: Extract<Node, { kind: "binary" }>,
  scope: OntologyScope,
): OntologyValue {
  // Short-circuit before evaluating the right side, so `$a != null && $a > 5`
  // does not blow up on the comparison when $a is absent.
  if (node.op === "&&" || node.op === "||") {
    const left = asBoolean(evaluate(node.left, scope), `"${node.op}"`);
    if (node.op === "&&" && !left) {
      return false;
    }
    if (node.op === "||" && left) {
      return true;
    }
    return asBoolean(evaluate(node.right, scope), `"${node.op}"`);
  }

  const left = evaluate(node.left, scope);
  const right = evaluate(node.right, scope);
  switch (node.op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compare(node.op, left, right);
    case "+":
      // "+" concatenates two strings and adds two numbers; it never coerces
      // across the two, so a null property cannot become "null" in the output.
      if (typeof left === "string" || typeof right === "string") {
        return asString(left, '"+"') + asString(right, '"+"');
      }
      return asNumber(left, '"+"') + asNumber(right, '"+"');
    case "-":
      return asNumber(left, '"-"') - asNumber(right, '"-"');
    case "*":
      return asNumber(left, '"*"') * asNumber(right, '"*"');
    case "/": {
      const divisor = asNumber(right, '"/"');
      if (divisor === 0) {
        throw new EvalError("division by zero");
      }
      return asNumber(left, '"/"') / divisor;
    }
    default: {
      const divisor = asNumber(right, '"%"');
      if (divisor === 0) {
        throw new EvalError("division by zero");
      }
      return asNumber(left, '"%"') % divisor;
    }
  }
}

function evaluateCall(node: Extract<Node, { kind: "call" }>, scope: OntologyScope): OntologyValue {
  const label = `"${node.name}"`;
  // coalesce is the ONLY null-aware op: it is how a definition says "this
  // property may be absent", which is what keeps every other operator strict.
  // Its fallback must therefore be LAZY. Evaluating it eagerly would let
  // `coalesce($amount, 1 / 0)` fail on a row whose $amount is perfectly fine —
  // the guard blowing up on the branch it exists to avoid.
  if (node.name === "coalesce") {
    const [primary, fallback] = node.args as [Node, Node];
    const value = evaluate(primary, scope);
    return value === null ? evaluate(fallback, scope) : value;
  }
  const args = node.args.map((arg) => evaluate(arg, scope));
  const [first, second] = args as [OntologyValue, OntologyValue];
  switch (node.name) {
    case "abs":
      return Math.abs(asNumber(first, label));
    case "round":
      return Math.round(asNumber(first, label));
    case "floor":
      return Math.floor(asNumber(first, label));
    case "ceil":
      return Math.ceil(asNumber(first, label));
    case "lower":
      return asString(first, label).toLowerCase();
    case "upper":
      return asString(first, label).toUpperCase();
    case "length":
      return asString(first, label).length;
    case "min":
      return Math.min(asNumber(first, label), asNumber(second, label));
    default:
      return Math.max(asNumber(first, label), asNumber(second, label));
  }
}

function evaluate(node: Node, scope: OntologyScope): OntologyValue {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "property":
      // An absent key is null, not an error. Import validation already proved
      // every `$ref` names a DECLARED property, so the only way to arrive here
      // without a value is an optional property this instance does not carry —
      // which is exactly what `coalesce` is for. Throwing instead would leave
      // optional properties with no way to be defaulted at all.
      //
      // hasOwn, not a bare lookup: `$constructor` / `$__proto__` would otherwise
      // resolve up the prototype chain and hand a live host function back as an
      // ontology value. Own keys only, and anything else is null.
      return Object.hasOwn(scope, node.id) ? (scope[node.id] ?? null) : null;
    case "unary":
      return node.op === "-"
        ? -asNumber(evaluate(node.operand, scope), '"-"')
        : !asBoolean(evaluate(node.operand, scope), '"!"');
    case "binary":
      return evaluateBinary(node, scope);
    case "ternary":
      return asBoolean(evaluate(node.condition, scope), '"? :" condition')
        ? evaluate(node.whenTrue, scope)
        : evaluate(node.whenFalse, scope);
    default:
      return evaluateCall(node, scope);
  }
}

// ---------------------------------------------------------------------------
// Type checker
// ---------------------------------------------------------------------------

/** Declared types of the object type's properties, keyed by property id. */
export type OntologyPropertyTypes = ReadonlyMap<string, OntologyValueType>;

export type OntologyExpressionTypeResult =
  | { ok: true; type: ExpressionType }
  | { ok: false; error: string };

class TypeError_ extends Error {}

/**
 * The one place null meets a real type. `null` unifies with anything (that is
 * what makes `coalesce($maybe, 0)` and `$x != null` type-check); two different
 * concrete types never unify, because silently widening them is how a typed
 * ontology stops meaning anything.
 */
function unify(left: ExpressionType, right: ExpressionType, context: string): ExpressionType {
  if (left === right) {
    return left;
  }
  if (left === "null") {
    return right;
  }
  if (right === "null") {
    return left;
  }
  throw new TypeError_(`${context} mixes ${left} and ${right}`);
}

/**
 * Strict: null is NOT accepted here. Only `==`/`!=`, `coalesce`, and the two
 * ternary branches are null-tolerant (they go through unify). Everywhere else a
 * null literal is a guaranteed evaluation failure — `abs(null)`, `null ? 1 : 2`,
 * `$score + null` — and letting it pass the import check would leave exactly the
 * broken definitions this check exists to reject.
 */
function expect(actual: ExpressionType, wanted: ExpressionType, context: string): ExpressionType {
  if (actual !== wanted) {
    throw new TypeError_(`${context} expects ${wanted}, got ${actual}`);
  }
  return wanted;
}

/** Ordering and "+" need two concrete operands; a null literal can only fail. */
function concreteOperand(
  left: ExpressionType,
  right: ExpressionType,
  context: string,
): ExpressionType {
  if (left === "null" || right === "null") {
    throw new TypeError_(`${context} cannot operate on null`);
  }
  return unify(left, right, context);
}

function inferCall(
  node: Extract<Node, { kind: "call" }>,
  properties: OntologyPropertyTypes,
): ExpressionType {
  const label = `"${node.name}"`;
  const args = node.args.map((arg) => infer(arg, properties));
  const [first, second] = args as [ExpressionType, ExpressionType];
  switch (node.name) {
    case "abs":
    case "round":
    case "floor":
    case "ceil":
      return expect(first, "number", label);
    case "lower":
    case "upper":
      return expect(first, "string", label);
    case "length":
      expect(first, "string", label);
      return "number";
    case "min":
    case "max":
      expect(first, "number", label);
      return expect(second, "number", label);
    default:
      // coalesce is the guard for an optional property, so its whole job is to
      // turn "T or null" into T: the two arms must agree on T.
      return unify(first, second, label);
  }
}

function inferBinary(
  node: Extract<Node, { kind: "binary" }>,
  properties: OntologyPropertyTypes,
): ExpressionType {
  const op = `"${node.op}"`;
  const left = infer(node.left, properties);
  const right = infer(node.right, properties);
  switch (node.op) {
    case "&&":
    case "||":
      expect(left, "boolean", op);
      expect(right, "boolean", op);
      return "boolean";
    case "==":
    case "!=":
      // Equality is the only place two types may meet without unifying to a
      // value: comparing against null is how an optional property is guarded.
      unify(left, right, op);
      return "boolean";
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const operand = concreteOperand(left, right, op);
      if (operand !== "number" && operand !== "string") {
        throw new TypeError_(`${op} orders numbers or strings, got ${operand}`);
      }
      return "boolean";
    }
    case "+": {
      // "+" is the one overloaded operator: number+number or string+string, and
      // never across, so a number property cannot silently become a string.
      const operand = concreteOperand(left, right, op);
      if (operand !== "number" && operand !== "string") {
        throw new TypeError_(`${op} adds numbers or concatenates strings, got ${operand}`);
      }
      return operand;
    }
    default:
      expect(left, "number", op);
      expect(right, "number", op);
      return "number";
  }
}

function infer(node: Node, properties: OntologyPropertyTypes): ExpressionType {
  switch (node.kind) {
    case "literal":
      return node.value === null ? "null" : (typeof node.value as ExpressionType);
    case "property": {
      const declared = properties.get(node.id);
      if (!declared) {
        throw new TypeError_(`"$${node.id}" is not a declared property`);
      }
      return expressionTypeOf(declared);
    }
    case "unary":
      return node.op === "-"
        ? expect(infer(node.operand, properties), "number", '"-"')
        : expect(infer(node.operand, properties), "boolean", '"!"');
    case "binary":
      return inferBinary(node, properties);
    case "ternary": {
      expect(infer(node.condition, properties), "boolean", '"? :" condition');
      return unify(
        infer(node.whenTrue, properties),
        infer(node.whenFalse, properties),
        '"? :" branches',
      );
    }
    default:
      return inferCall(node, properties);
  }
}

/**
 * Type-check an expression against the object type's declared property types.
 *
 * Runs at IMPORT. Without it, `returns` is a label nobody enforces and the typed
 * ontology is decoration: `$score >= 75` could claim `returns: string`, the
 * gateway would project that lie to every client, and only an evaluation would
 * ever contradict it.
 */
export function inferOntologyExpressionType(
  expression: OntologyExpression,
  properties: OntologyPropertyTypes,
): OntologyExpressionTypeResult {
  try {
    return { ok: true, type: infer(expression.root, properties) };
  } catch (err) {
    if (err instanceof TypeError_) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/** Property values the expression reads, keyed by property id. */
export type OntologyScope = Readonly<Record<string, OntologyValue>>;

/**
 * Evaluate against one object's properties. Total: a bad expression yields an
 * error result, never a throw, so a computed value can never break a run.
 */
export function evaluateOntologyExpression(
  expression: OntologyExpression,
  scope: OntologyScope,
): OntologyExpressionEvalResult {
  try {
    return { ok: true, value: evaluate(expression.root, scope) };
  } catch (err) {
    if (err instanceof EvalError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
