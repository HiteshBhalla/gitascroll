// Paid Ask Gita packs through Razorpay Checkout. Needs "Authorization: Bearer <Supabase access token>".
// POST { action: "order" }  -> { orderId, amount, currency, keyId, email } to open Razorpay Checkout with.
// POST { action: "verify", razorpay_order_id, razorpay_payment_id, razorpay_signature } -> the updated account.
// The webhook (api/razorpay-webhook.js) credits the same order too, in case the browser closes mid-payment.
import { currentUser, createOrder, creditOrder, accountFor, hmac, safeEqual, sendError, AccountError } from "../lib/account.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  try {
    const user = await currentUser(req);
    const body = req.body || {};
    if (body.action === "order") return res.status(200).json(await createOrder(user));
    if (body.action === "verify") {
      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body;
      const secret = process.env.RAZORPAY_KEY_SECRET;
      if (!secret) throw new AccountError(500, "Payments aren't set up yet.");
      if (!orderId || !paymentId || !signature || !safeEqual(hmac(secret, `${orderId}|${paymentId}`), signature)) {
        throw new AccountError(400, "We couldn't confirm that payment. If money left your account, it will be credited within a few minutes.");
      }
      await creditOrder(orderId, paymentId, user.id);
      return res.status(200).json(await accountFor(user));
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (error) {
    return sendError(res, error, "Ask Gita pay:");
  }
}
