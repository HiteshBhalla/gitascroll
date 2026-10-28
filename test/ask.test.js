import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY ||= "test-key";
const { findVerses, buildUserTurn, citedVerses, default: handler } = await import("../api/ask.js");

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(b) { this.body = b; return this; },
  };
}

test("finds the karma yoga verses for a question about results", () => {
  const keys = findVerses("How do I stop worrying about the results of my work?").map((v) => v.key);
  assert.ok(keys.some((k) => k.startsWith("2.4") || k.startsWith("3.") || k.startsWith("18.")), keys.join(","));
});

test("finds anger verses", () => {
  const keys = findVerses("I get angry too quickly").map((v) => v.key);
  assert.ok(keys.includes("2.63") || keys.includes("2.62") || keys.includes("3.37") || keys.includes("16.21"), keys.join(","));
});

test("user turn carries the question and app language", () => {
  const turn = buildUserTurn("What is dharma?", "hi");
  assert.match(turn, /App language: Hindi/);
  assert.match(turn, /Question: What is dharma\?$/);
});

test("only real verse references are returned as citations", () => {
  assert.deepEqual(citedVerses("See [2.47] and [2.47], also [18.66] but not [19.1] or [2.99]."), ["2.47", "18.66"]);
});

test("rejects GET and empty questions without calling the API", async () => {
  let res = mockRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
  res = mockRes();
  await handler({ method: "POST", body: { question: "  " } }, res);
  assert.equal(res.statusCode, 400);
  res = mockRes();
  await handler({ method: "POST", body: { question: "x".repeat(601) } }, res);
  assert.equal(res.statusCode, 400);
});
