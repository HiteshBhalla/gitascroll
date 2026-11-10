// GET /api/account with "Authorization: Bearer <Supabase access token>".
// Returns { email, freeLeft, paidLeft, paidUntil, pack: { price, currency, questions, days } }.
import { currentUser, accountFor, sendError } from "../lib/account.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Use GET." });
  }
  try {
    const user = await currentUser(req);
    return res.status(200).json(await accountFor(user));
  } catch (error) {
    return sendError(res, error, "Ask Gita account:");
  }
}
