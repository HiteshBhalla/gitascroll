import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";

Object.assign(process.env, {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "test-key",
  SUPABASE_URL: "https://sb.test",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  RAZORPAY_KEY_ID: "rzp_test_id",
  RAZORPAY_KEY_SECRET: "rzp_secret",
  RAZORPAY_WEBHOOK_SECRET: "hook_secret",
});

// Fake Supabase, Razorpay and Claude API behind fetch, so these tests never touch the network.
const realFetch = globalThis.fetch;
let calls, account, orders;
const USER = { id: "u1", email: "a@b.c" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  if (url === "https://sb.test/auth/v1/user") {
    const auth = new Headers(init.headers).get("authorization");
    return auth === "Bearer good" ? json(USER) : json({ msg: "bad jwt" }, 401);
  }
  if (url.startsWith("https://sb.test/rest/v1/rpc/ask_take_question")) {
    const free = account.free_used < body.p_free;
    if (free) account.free_used++;
    else if (account.paid_left > 0) account.paid_left--;
    else return json([{ allowed: false, was_free: false, ...account }]);
    return json([{ allowed: true, was_free: free, ...account }]);
  }
  if (url.startsWith("https://sb.test/rest/v1/rpc/ask_refund_question")) {
    if (body.p_was_free) account.free_used--;
    else account.paid_left++;
    return new Response(null, { status: 204 });
  }
  if (url.startsWith("https://sb.test/rest/v1/rpc/ask_record_payment")) {
    account.paid_left += body.p_questions;
    account.paid_until = new Date(Date.now() + 864e5 * body.p_days).toISOString();
    return new Response(null, { status: 204 });
  }
  if (url.startsWith("https://sb.test/rest/v1/ask_accounts")) return json([account]);
  if (url === "https://api.razorpay.com/v1/orders") return json({ id: "order_1", amount: body.amount, currency: body.currency, notes: body.notes });
  if (url.startsWith("https://api.razorpay.com/v1/orders/")) return json(orders[url.split("/").pop()] || {}, orders[url.split("/").pop()] ? 200 : 404);
  if (url.startsWith("https://api.anthropic.com/")) return json({ type: "error", error: { type: "invalid_request_error", message: "no" } }, 400);
  throw new Error("Unexpected fetch " + url);
};
after(() => { globalThis.fetch = realFetch; });

beforeEach(() => {
  calls = [];
  account = { free_used: 0, paid_left: 0, paid_until: null };
  orders = {};
});

const { default: ask } = await import("../api/ask.js");
const { default: pay } = await import("../api/pay.js");
const { default: accountApi } = await import("../api/account.js");
const { default: webhook } = await import("../api/razorpay-webhook.js");

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(b) { this.body = b; return this; },
  };
}
const authed = { authorization: "Bearer good" };
const anthropicCalls = () => calls.filter((c) => c.url.startsWith("https://api.anthropic.com/")).length;

test("asking without signing in asks for sign-in and never calls Claude", async () => {
  const res = mockRes();
  await ask({ method: "POST", headers: {}, body: { question: "What is karma?" } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.needLogin, true);
  assert.equal(anthropicCalls(), 0);
});

test("an expired session asks for sign-in again", async () => {
  const res = mockRes();
  await ask({ method: "POST", headers: { authorization: "Bearer old" }, body: { question: "What is karma?" } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.needLogin, true);
});

test("after 3 free questions the 4th asks to pay and never calls Claude", async () => {
  account.free_used = 3;
  const res = mockRes();
  await ask({ method: "POST", headers: authed, body: { question: "What is karma?" } }, res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.needPay, true);
  assert.equal(res.body.account.freeLeft, 0);
  assert.equal(anthropicCalls(), 0);
});

test("a failed answer gives the free question back", async () => {
  const res = mockRes();
  await ask({ method: "POST", headers: authed, body: { question: "What is karma?" } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(anthropicCalls(), 1);
  assert.equal(account.free_used, 0);
});

test("account status shows free questions left and the pack on offer", async () => {
  account.free_used = 1;
  const res = mockRes();
  await accountApi({ method: "GET", headers: authed }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.freeLeft, 2);
  assert.equal(res.body.paidLeft, 0);
  assert.deepEqual(res.body.pack, { price: 9900, currency: "INR", questions: 100, days: 30 });
});

test("creating an order tags it with the buyer", async () => {
  const res = mockRes();
  await pay({ method: "POST", headers: authed, body: { action: "order" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.keyId, "rzp_test_id");
  assert.equal(res.body.amount, 9900);
  assert.equal(calls.find((c) => c.url.endsWith("/v1/orders")).body.notes.user_id, "u1");
});

test("a payment with a forged signature is refused", async () => {
  const res = mockRes();
  await pay({ method: "POST", headers: authed, body: { action: "verify", razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "nope" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(account.paid_left, 0);
});

test("a verified payment adds 100 questions", async () => {
  orders.order_1 = { id: "order_1", status: "paid", amount: 9900, amount_paid: 9900, currency: "INR", notes: { user_id: "u1", questions: "100", days: "30" } };
  const sig = createHmac("sha256", "rzp_secret").update("order_1|pay_1").digest("hex");
  const res = mockRes();
  await pay({ method: "POST", headers: authed, body: { action: "verify", razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: sig } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paidLeft, 100);
});

test("someone else's paid order can't be credited to you", async () => {
  orders.order_2 = { id: "order_2", status: "paid", amount: 9900, currency: "INR", notes: { user_id: "someone-else" } };
  const sig = createHmac("sha256", "rzp_secret").update("order_2|pay_2").digest("hex");
  const res = mockRes();
  await pay({ method: "POST", headers: authed, body: { action: "verify", razorpay_order_id: "order_2", razorpay_payment_id: "pay_2", razorpay_signature: sig } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(account.paid_left, 0);
});

function hookReq(payload, secret = "hook_secret") {
  const raw = JSON.stringify(payload);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = "POST";
  req.headers = { "x-razorpay-signature": createHmac("sha256", secret).update(raw).digest("hex") };
  return req;
}

test("the webhook credits a paid order and rejects bad signatures", async () => {
  orders.order_3 = { id: "order_3", status: "paid", amount: 9900, currency: "INR", notes: { user_id: "u1", questions: "100", days: "30" } };
  const payload = { event: "order.paid", payload: { order: { entity: { id: "order_3" } }, payment: { entity: { id: "pay_3" } } } };
  let res = mockRes();
  await webhook(hookReq(payload, "wrong"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(account.paid_left, 0);
  res = mockRes();
  await webhook(hookReq(payload), res);
  assert.equal(res.statusCode, 200);
  assert.equal(account.paid_left, 100);
});
