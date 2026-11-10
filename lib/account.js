// Accounts for Ask Gita: who is signed in (Supabase Auth, email + one-time code), how many questions they
// have left, and paid packs (Razorpay). Reading the Gita never touches any of this.
//
// Environment variables (set in Vercel):
//   SUPABASE_URL, SUPABASE_ANON_KEY       same values as public/config.js
//   SUPABASE_SERVICE_ROLE_KEY             secret; lets the server update question counts
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET  from the Razorpay dashboard
//   RAZORPAY_WEBHOOK_SECRET               the secret you type when adding the webhook
//   ASK_FREE_QUESTIONS (3), ASK_PACK_PRICE (9900 = ₹99 in paise), ASK_PACK_CURRENCY (INR),
//   ASK_PACK_QUESTIONS (100), ASK_PACK_DAYS (30)
import { createHmac, timingSafeEqual } from "node:crypto";

const env = (k, d) => process.env[k] || d;
const int = (k, d) => Number.parseInt(process.env[k] || "", 10) || d;

export const plan = () => ({
  free: int("ASK_FREE_QUESTIONS", 3),
  price: int("ASK_PACK_PRICE", 9900),
  currency: env("ASK_PACK_CURRENCY", "INR"),
  questions: int("ASK_PACK_QUESTIONS", 100),
  days: int("ASK_PACK_DAYS", 30),
});

export class AccountError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const supabaseUrl = () => {
  const url = env("SUPABASE_URL");
  if (!url || !env("SUPABASE_ANON_KEY") || !env("SUPABASE_SERVICE_ROLE_KEY")) {
    console.error("Ask Gita: SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY is missing");
    throw new AccountError(500, "Sign-in isn't set up yet.");
  }
  return url.replace(/\/$/, "");
};

// Returns { id, email } for the access token in the Authorization header, or throws 401.
export async function currentUser(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers?.authorization || "");
  if (!m) throw new AccountError(401, "Sign in to ask Gita.", { needLogin: true });
  const r = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: env("SUPABASE_ANON_KEY"), Authorization: `Bearer ${m[1]}` },
  });
  if (r.status === 401 || r.status === 403) throw new AccountError(401, "Sign in again to keep asking.", { needLogin: true });
  if (!r.ok) throw new AccountError(502, "Couldn't check your sign-in. Try again.");
  const u = await r.json();
  return { id: u.id, email: u.email };
}

async function rest(pathAndQuery, init = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(`${supabaseUrl()}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!r.ok) {
    console.error(`Ask Gita: Supabase ${pathAndQuery} failed`, r.status, await r.text().catch(() => ""));
    throw new AccountError(502, "Couldn't reach your account. Try again.");
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
const rpc = (fn, args) => rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

// What the app shows: free questions left, paid questions left and when they expire, and the pack on offer.
export function summary(row, email) {
  const p = plan();
  const paidActive = row?.paid_until && new Date(row.paid_until) > new Date();
  return {
    email,
    freeLeft: Math.max(p.free - (row?.free_used || 0), 0),
    paidLeft: paidActive ? row.paid_left : 0,
    paidUntil: paidActive ? row.paid_until : null,
    pack: { price: p.price, currency: p.currency, questions: p.questions, days: p.days },
  };
}

export async function accountFor(user) {
  const rows = await rest(`ask_accounts?user_id=eq.${encodeURIComponent(user.id)}&select=free_used,paid_left,paid_until`);
  return summary(rows?.[0], user.email);
}

// Takes one question. Returns { wasFree, account }, or throws 402 when the user needs to pay.
export async function takeQuestion(user) {
  const [row] = await rpc("ask_take_question", { p_user: user.id, p_free: plan().free });
  const account = summary(row, user.email);
  if (!row?.allowed) {
    throw new AccountError(402, "You've used your free questions.", { needPay: true, account });
  }
  return { wasFree: row.was_free, account };
}

export const refundQuestion = (user, wasFree) => rpc("ask_refund_question", { p_user: user.id, p_was_free: wasFree });

/* Razorpay */

const razorpayAuth = () => {
  const id = env("RAZORPAY_KEY_ID");
  const secret = env("RAZORPAY_KEY_SECRET");
  if (!id || !secret) {
    console.error("Ask Gita: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing");
    throw new AccountError(500, "Payments aren't set up yet.");
  }
  return { id, secret, header: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") };
};

async function razorpay(pathAndQuery, init = {}) {
  const r = await fetch(`https://api.razorpay.com/v1/${pathAndQuery}`, {
    ...init,
    headers: { Authorization: razorpayAuth().header, "Content-Type": "application/json", ...init.headers },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`Ask Gita: Razorpay ${pathAndQuery} failed`, r.status, body?.error?.description);
    throw new AccountError(502, "Couldn't reach the payment service. Try again.");
  }
  return body;
}

export async function createOrder(user) {
  const p = plan();
  const order = await razorpay("orders", {
    method: "POST",
    body: JSON.stringify({
      amount: p.price,
      currency: p.currency,
      receipt: `ask-${Date.now()}`,
      notes: { user_id: user.id, questions: String(p.questions), days: String(p.days) },
    }),
  });
  return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: razorpayAuth().id, email: user.email };
}

export const hmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Credits the pack for a paid order. The order's notes say who it belongs to and what it buys,
// so a payment can only ever credit the account that created the order.
export async function creditOrder(orderId, paymentId, expectedUserId) {
  const order = await razorpay(`orders/${encodeURIComponent(orderId)}`);
  const userId = order.notes?.user_id;
  if (!userId || (expectedUserId && userId !== expectedUserId)) {
    throw new AccountError(400, "This payment belongs to a different account.");
  }
  if (order.status !== "paid") throw new AccountError(409, "The payment hasn't gone through yet.");
  await rpc("ask_record_payment", {
    p_order: order.id,
    p_payment: paymentId || null,
    p_user: userId,
    p_amount: order.amount_paid || order.amount,
    p_currency: order.currency,
    p_questions: Number.parseInt(order.notes.questions, 10) || plan().questions,
    p_days: Number.parseInt(order.notes.days, 10) || plan().days,
  });
  return userId;
}

export function sendError(res, error, label) {
  if (error instanceof AccountError) return res.status(error.status).json({ error: error.message, ...error.extra });
  console.error(label, error);
  return res.status(500).json({ error: "Something went wrong. Try again." });
}
