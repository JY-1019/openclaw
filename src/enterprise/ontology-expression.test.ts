import { describe, expect, it } from "vitest";
import {
  evaluateOntologyExpression,
  inferOntologyExpressionType,
  ontologyExpressionProperties,
  parseOntologyExpression,
  type OntologyScope,
} from "./ontology-expression.js";
import type { OntologyValueType } from "./types.js";

function evaluate(source: string, scope: OntologyScope = {}) {
  const parsed = parseOntologyExpression(source);
  if (!parsed.ok) {
    return { parseError: parsed.error };
  }
  return evaluateOntologyExpression(parsed.expression, scope);
}

describe("parseOntologyExpression", () => {
  it("rejects anything that is not in the closed op set", () => {
    // The whole point of the language: a tree is imported data, so an expression
    // must not be able to reach the host. None of these are parseable at all.
    for (const source of [
      "process.exit(1)",
      "globalThis",
      "require('fs')",
      "(() => 1)()",
      "import('fs')",
      "eval('1')",
    ]) {
      expect(parseOntologyExpression(source).ok, source).toBe(false);
    }
  });

  it("cannot read up the prototype chain", () => {
    // `__proto__` is not even lexable: `_` is not a valid ontology id character.
    expect(parseOntologyExpression("$__proto__").ok).toBe(false);
    // But a dotted ref like $a.constructor IS a legal property NAME (ontology ids
    // are dotted), so it parses — the safety has to hold at LOOKUP, not at parse.
    // Own keys only: a bare scope[id] would hand back Object.prototype.constructor,
    // i.e. a live host function escaping as an "ontology value".
    for (const source of ["$constructor", "$to-string", "$a.constructor"]) {
      expect(evaluate(source, { amount: 1 }), source).toEqual({ ok: true, value: null });
    }
  });

  it("reports syntax errors instead of throwing", () => {
    expect(parseOntologyExpression("1 +")).toEqual({ ok: false, error: expect.any(String) });
    expect(parseOntologyExpression("")).toEqual({ ok: false, error: expect.any(String) });
    expect(parseOntologyExpression("$")).toEqual({ ok: false, error: expect.any(String) });
    expect(parseOntologyExpression("frobnicate(1)")).toEqual({
      ok: false,
      error: expect.stringContaining('unknown function "frobnicate"'),
    });
    expect(parseOntologyExpression("min(1)")).toEqual({
      ok: false,
      error: expect.stringContaining("takes 2 argument(s), got 1"),
    });
  });

  it("collects the property ids an expression reads", () => {
    const parsed = parseOntologyExpression("$fraud-score > 80 ? $status : 'ok'");
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(ontologyExpressionProperties(parsed.expression)).toEqual(["fraud-score", "status"]);
  });
});

describe("inferOntologyExpressionType", () => {
  const PROPERTIES = new Map<string, OntologyValueType>([
    ["score", "number"],
    ["status", "string"],
    ["verified", "boolean"],
    ["claim-id", "id"],
    ["booked-at", "date"],
  ]);

  function infer(source: string) {
    const parsed = parseOntologyExpression(source);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return inferOntologyExpressionType(parsed.expression, PROPERTIES);
  }

  it("infers the type an expression yields", () => {
    expect(infer("$score >= 75")).toEqual({ ok: true, type: "boolean" });
    expect(infer("$score * 2")).toEqual({ ok: true, type: "number" });
    expect(infer("$score > 5 ? 'hi' : 'lo'")).toEqual({ ok: true, type: "string" });
    expect(infer("coalesce($score, 0)")).toEqual({ ok: true, type: "number" });
    // date and id are strings inside an expression: ISO dates order lexically.
    expect(infer("$booked-at < '2026-01-01'")).toEqual({ ok: true, type: "boolean" });
    expect(infer("upper($claim-id)")).toEqual({ ok: true, type: "string" });
  });

  it("rejects an expression that misuses a declared property type", () => {
    expect(infer("$claim-id + 1").ok).toBe(false);
    expect(infer("$verified * 2").ok).toBe(false);
    expect(infer("!$score").ok).toBe(false);
    expect(infer("$status && true").ok).toBe(false);
  });

  it("rejects a null literal everywhere it is guaranteed to fail", () => {
    // null is tolerated ONLY by ==/!=, coalesce, and the ternary branches. Letting
    // it slide anywhere else would import a function that can never evaluate.
    for (const source of [
      "abs(null)",
      "null ? 1 : 2",
      "$score + null",
      "$score - null",
      "$score > null",
      "null && true",
      "-null",
      "min(null, 1)",
    ]) {
      expect(infer(source).ok, source).toBe(false);
    }
    // ...but the null-aware positions still work.
    expect(infer("$score != null").ok).toBe(true);
    expect(infer("coalesce($score, 0)").ok).toBe(true);
    expect(infer("$verified ? $score : null")).toEqual({ ok: true, type: "number" });
  });
});

describe("evaluateOntologyExpression", () => {
  it("evaluates arithmetic, comparison, boolean, and ternary", () => {
    expect(evaluate("1 + 2 * 3")).toEqual({ ok: true, value: 7 });
    expect(evaluate("(1 + 2) * 3")).toEqual({ ok: true, value: 9 });
    expect(evaluate("-4 + 10 % 3")).toEqual({ ok: true, value: -3 });
    expect(evaluate("2 < 3 && !false")).toEqual({ ok: true, value: true });
    expect(evaluate("'a' == 'a' || 1 > 2")).toEqual({ ok: true, value: true });
    expect(evaluate("3 > 2 ? 'high' : 'low'")).toEqual({ ok: true, value: "high" });
  });

  it("reads hyphenated properties through the $ sigil", () => {
    // A bare `claimed-amount` would lex as subtraction; the sigil is what makes
    // hyphenated ontology ids usable at all.
    expect(evaluate("$claimed-amount * 2", { "claimed-amount": 50 })).toEqual({
      ok: true,
      value: 100,
    });
  });

  it("computes a realistic derived property", () => {
    const source = "$fraud-score >= 80 ? 'refer' : ($claimed-amount > 10000 ? 'review' : 'auto')";
    expect(evaluate(source, { "fraud-score": 91, "claimed-amount": 100 })).toEqual({
      ok: true,
      value: "refer",
    });
    expect(evaluate(source, { "fraud-score": 10, "claimed-amount": 25000 })).toEqual({
      ok: true,
      value: "review",
    });
    expect(evaluate(source, { "fraud-score": 10, "claimed-amount": 25 })).toEqual({
      ok: true,
      value: "auto",
    });
  });

  it("applies the builtin calls", () => {
    expect(evaluate("abs(-5) + round(2.6) + floor(2.9) + ceil(2.1)")).toEqual({
      ok: true,
      value: 5 + 3 + 2 + 3,
    });
    expect(evaluate("min(3, 9) + max(3, 9)")).toEqual({ ok: true, value: 12 });
    expect(evaluate("upper('ab') + lower('CD')")).toEqual({ ok: true, value: "ABcd" });
    expect(evaluate("length('abcd')")).toEqual({ ok: true, value: 4 });
  });

  it("is strict about null rather than coercing it", () => {
    // A null property silently reading as 0/false/"null" is how a governed
    // computation quietly produces a wrong answer. Only coalesce is null-aware.
    expect(evaluate("$score + 1", { score: null })).toEqual({
      ok: false,
      error: expect.stringContaining("expects a number"),
    });
    expect(evaluate("$verified ? 'y' : 'n'", { verified: null })).toEqual({
      ok: false,
      error: expect.stringContaining("expects a boolean"),
    });
    expect(evaluate("coalesce($score, 0) + 1", { score: null })).toEqual({ ok: true, value: 1 });
  });

  it("short-circuits so a null guard actually guards", () => {
    expect(evaluate("$score != null && $score > 5", { score: null })).toEqual({
      ok: true,
      value: false,
    });
    expect(evaluate("$score != null && $score > 5", { score: 9 })).toEqual({
      ok: true,
      value: true,
    });
  });

  it("reads a dotted property id", () => {
    // Ontology ids are DOTTED ids (EnterpriseIdSchema allows "a.b"), so stopping
    // the ref at the first dot would make a schema-valid property unusable.
    expect(evaluate("$claim.amount * 2", { "claim.amount": 21 })).toEqual({ ok: true, value: 42 });
    expect(parseOntologyExpression("$claim..amount")).toEqual({
      ok: false,
      error: expect.stringContaining("not a valid property id"),
    });
  });

  it("treats an unset optional property as null rather than an error", () => {
    // Import validation already proved the ref is DECLARED, so a missing key here
    // is an optional property this instance does not carry.
    expect(evaluate("coalesce($settled-amount, 0)", {})).toEqual({ ok: true, value: 0 });
  });

  it("evaluates the coalesce fallback lazily", () => {
    // The guard must not blow up on the branch it exists to avoid: with a live
    // $amount, a failing fallback is never reached.
    expect(evaluate("coalesce($amount, 1 / 0)", { amount: 7 })).toEqual({ ok: true, value: 7 });
    expect(evaluate("coalesce($amount, $other + 1)", { amount: 7 })).toEqual({
      ok: true,
      value: 7,
    });
    // ...but a fallback that IS reached still reports its own error.
    expect(evaluate("coalesce($amount, 1 / 0)", { amount: null })).toEqual({
      ok: false,
      error: "division by zero",
    });
  });

  it("errors instead of throwing on bad values", () => {
    expect(evaluate("$missing + 1", {})).toEqual({
      ok: false,
      error: expect.stringContaining("expects a number, got null"),
    });
    expect(evaluate("1 / 0")).toEqual({ ok: false, error: "division by zero" });
    expect(evaluate("'a' - 1")).toEqual({
      ok: false,
      error: expect.stringContaining("expects a number"),
    });
    // "+" must not coerce across types: 1 + "a" being "1a" would let a number
    // property silently become a string in a typed ontology.
    expect(evaluate("1 + 'a'")).toEqual({
      ok: false,
      error: expect.stringContaining("expects a string"),
    });
  });
});
