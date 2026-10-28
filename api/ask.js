// Ask Gita: answers a question from the Bhagavad Gita's verses, using Gita Scroll's own translations and notes.
// Vercel serverless function. POST { question, lang: "en" | "hi", history?: [{ role, content }] }
// Returns { answer, verses: ["2.47", ...] }.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import path from "node:path";

const MODEL = "claude-opus-5-5";
const MAX_QUESTION_CHARS = 600;
const MAX_HISTORY_TURNS = 6;
const EXCERPTS = 5;

const context = JSON.parse(readFileSync(path.join(process.cwd(), "data", "gita-context.json"), "utf8"));
const client = new Anthropic();

// Built once per cold start and kept byte-identical so the prompt cache hits on every request.
const SYSTEM_PROMPT = [
  "You are Ask Gita, the guide inside Gita Scroll, an app for reading the Bhagavad Gita.",
  "People ask you about life, choices, feelings and the Gita itself. Answer only from the Bhagavad Gita:",
  "the verse translations below and the notes on relevant verses supplied with each question.",
  "",
  "How to answer:",
  "- Speak warmly and plainly, the way a wise friend would explain it to someone in their twenties. No preaching.",
  "- Keep it under 150 words unless the person asks for more.",
  "- Ground every point in specific verses and cite them inline in square brackets with chapter.verse, e.g. [2.47].",
  "  Cite 1 to 3 verses. Only cite verses that appear in the list below, and never invent or misquote a verse.",
  "- If the Gita doesn't really address the question, say so honestly and share the closest relevant teaching.",
  "- Answer in the language the person writes in. If they write in Hinglish, answer in Hinglish.",
  "  If the app language is Hindi and they write in English, answer in simple Hindi.",
  "- You are not a doctor, lawyer or therapist. If someone mentions self-harm or being in danger, respond with care,",
  "  encourage them to reach out to someone they trust, and suggest calling a local helpline (in India, Tele-MANAS: 14416).",
  "- Plain text only. No headings or bullet lists unless asked.",
  "",
  "# Chapters",
  ...context.chapters.map((c) => `Chapter ${c.n}: ${c.name} (${c.meaning}). ${c.summary.replace(/\s+/g, " ")}`),
  "",
  "# Verses (English translation)",
  ...context.verses.map((v) => `[${v.key}] ${v.en.replace(/\s+/g, " ")}`),
].join("\n");

const STOPWORDS = new Set(
  "a an and are as at be but by do does for from how i if in is it its me my of on or should so that the this to was what when where which who why will with you your can am im not no".split(" "),
);
// Everyday feeling words mapped to the nouns the notes use, so "angry" finds the verses on anger.
const SAME_AS = {
  angry: "anger", anxious: "anxiety", worried: "worry", worrying: "worry", scared: "fear", afraid: "fear",
  sad: "grief", sadness: "grief", jealous: "envy", lazy: "laziness", stressed: "stress", lonely: "alone",
  confused: "confusion", greedy: "greed", proud: "pride", hurt: "pain", desires: "desire", results: "result",
};
const tokenize = (s) =>
  (s.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOPWORDS.has(w)).map((w) => SAME_AS[w] || w);

// Small BM25 index over each verse's translation, Short and notes, used to pick
// which verse notes to send with a question.
const docs = context.verses.map((v) => tokenize(`${v.en} ${v.short} ${v.notes}`));
const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length;
const docFreq = new Map();
for (const d of docs) for (const w of new Set(d)) docFreq.set(w, (docFreq.get(w) || 0) + 1);

export function findVerses(question, k = EXCERPTS) {
  const terms = [...new Set(tokenize(question))];
  if (!terms.length) return [];
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const t of terms) {
      const tf = d.filter((w) => w === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - docFreq.get(t) + 0.5) / (docFreq.get(t) + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.length / avgLen)));
    }
    return { i, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((s) => context.verses[s.i]);
}

export function buildUserTurn(question, lang) {
  const excerpts = findVerses(question)
    .map((v) => `[${v.key}] ${v.short} ${v.notes}`)
    .join("\n\n");
  return [
    `App language: ${lang === "hi" ? "Hindi" : "English"}`,
    excerpts ? `Notes on verses that may help:\n${excerpts}` : "",
    `Question: ${question}`,
  ].filter(Boolean).join("\n\n");
}

const validKeys = new Set(context.verses.map((v) => v.key));
export function citedVerses(text) {
  const keys = [...text.matchAll(/\[(\d{1,2}\.\d{1,2})\]/g)].map((m) => m[1]).filter((k) => validKeys.has(k));
  return [...new Set(keys)];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  const { question, lang = "en", history = [] } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Ask a question first." });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return res.status(400).json({ error: `Keep your question under ${MAX_QUESTION_CHARS} characters.` });
  }

  const past = (Array.isArray(history) ? history : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (past.length && past[0].role !== "user") past.shift();
  const messages = [...past, { role: "user", content: buildUserTurn(question.trim(), lang) }];

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages,
    });
    if (response.stop_reason === "refusal") {
      return res.status(200).json({
        answer: lang === "hi" ? "माफ़ कीजिए, मैं इस सवाल का जवाब नहीं दे सकता। कुछ और पूछिए।" : "Sorry, I can't help with that one. Try asking something else.",
        verses: [],
      });
    }
    const answer = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return res.status(200).json({ answer, verses: citedVerses(answer) });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Lots of people are asking right now. Try again in a minute." });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("Ask Gita: ANTHROPIC_API_KEY is missing or invalid");
      return res.status(500).json({ error: "Ask Gita isn't set up yet." });
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`Ask Gita: API error ${error.status}`, error.message);
      return res.status(502).json({ error: "Ask Gita couldn't answer just now. Try again." });
    }
    console.error("Ask Gita:", error);
    return res.status(500).json({ error: "Something went wrong. Try again." });
  }
}
