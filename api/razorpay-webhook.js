// Razorpay webhook: credits a paid pack even if the buyer closed the page before checkout finished.
// In Razorpay: Settings, Webhooks, add https://<your domain>/api/razorpay-webhook with the "order.paid" event,
// and put the secret you choose there in RAZORPAY_WEBHOOK_SECRET.
import { creditOrder, hmac, safeEqual } from "../lib/account.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Ask Gita: RAZORPAY_WEBHOOK_SECRET is missing");
    return res.status(500).json({ error: "Webhook isn't set up." });
  }
  const body = await rawBody(req);
  if (!safeEqual(hmac(secret, body), req.headers["x-razorpay-signature"] || "")) {
    return res.status(400).json({ error: "Bad signature." });
  }
  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: "Bad body." });
  }
  if (event.event !== "order.paid") return res.status(200).json({ ok: true, ignored: event.event });
  try {
    const orderId = event.payload?.order?.entity?.id;
    const paymentId = event.payload?.payment?.entity?.id;
    await creditOrder(orderId, paymentId);
    return res.status(200).json({ ok: true });
  } catch (error) {
    // A non-2xx answer makes Razorpay retry later, which is what we want.
    console.error("Ask Gita webhook:", error);
    return res.status(500).json({ error: "Try again." });
  }
}
