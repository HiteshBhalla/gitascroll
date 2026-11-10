# Gita4U

A swipeable Bhagavad Gita reader for the web. Built for young readers. Every verse is a full-screen card with two sections you swipe between:

1. **Verse**: Sanskrit, transliteration and English translation
2. **Shorts**: a 30-word take on the verse for today's generation (English or Hinglish), with "People also ask" questions that open the verse's FAQ

Swipe up for the next verse; the section you're on stays the same. Each verse can be shared and saved. Reading needs no account. **Ask Gita** answers questions from the Gita's verses and links to the verses it used; it needs a free sign-up (email + one-time code), gives 3 free questions, then sells packs of questions.

## Project layout

| Path | What it is |
| --- | --- |
| `public/` | The static site (`index.html`, generated `genz.js` and `data/`) |
| `api/ask.js` | Ask Gita serverless function (Claude API), signed-in users only |
| `api/account.js`, `api/pay.js`, `api/razorpay-webhook.js` | Questions left, Razorpay checkout and the payment webhook |
| `lib/account.js` | Sign-in check (Supabase Auth), question quota and Razorpay helpers |
| `supabase/schema.sql` | Tables and functions for question counts and payments; run once in Supabase |
| `content/shorts/` | Shorts for every verse (`chN.json`) and chapter TL;DRs (`chapters.json`). Edit these, not `public/genz.js` |
| `source/` | Raw dataset: Sanskrit text, transliteration and chapter names |
| `content/translations/` | Our own English and Hindi translations (`chN.json`) |
| `scripts/build_data.py` | Builds `public/data/`, `public/genz.js` and `data/gita-context.json` from `source/` and `content/` |
| `data/gita-context.json` | Compact text the Ask Gita function loads |

After editing anything in `source/` or `content/`, rebuild with `npm run build:data` and commit the generated files.

## Running locally

```bash
npm install
npm test                 # Ask Gita unit tests (no API calls)
npx vercel dev           # site + /api/ask on http://localhost:3000
```

Ask Gita needs the environment variables below (for `vercel dev`, put them in `.env.local`, which is git-ignored).

## Deploying

1. Import this repository in Vercel (no framework preset, no build command).
2. Add the environment variables:

   | Variable | Where it comes from |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | console.anthropic.com |
   | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase, Project Settings, API (also put these two in `public/config.js`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Same page. Secret: server only, never in `config.js` |
   | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay dashboard, Account & Settings, API keys |
   | `RAZORPAY_WEBHOOK_SECRET` | The secret you type when adding the webhook (below) |
   | `ASK_MODEL` (optional) | Defaults to `claude-opus-5-5`; `claude-haiku-5-5` is far cheaper |
   | `ASK_FREE_QUESTIONS`, `ASK_PACK_PRICE`, `ASK_PACK_CURRENCY`, `ASK_PACK_QUESTIONS`, `ASK_PACK_DAYS` (optional) | Defaults: 3 free, 9900 (₹99 in paise), INR, 100 questions, 30 days |

3. Deploy. The site is served from `public/`, and the API runs under `/api/`.

### Sign-in and payments

1. **Supabase:** create a project, run `supabase/schema.sql` in the SQL editor. In Authentication, Email, keep email sign-in on and edit the "Magic Link" template so it shows the code: `Your Gita4U code is {{ .Token }}`. Add custom SMTP (for example Resend) before launch, because Supabase's built-in mailer only sends a few emails an hour.
2. **Razorpay:** turn on automatic capture (Account & Settings, Payment capture). Add a webhook to `https://<your domain>/api/razorpay-webhook` with the `order.paid` event.
3. Sign up on the site, ask 3 questions, then buy a pack in Razorpay test mode before switching to live keys.

## How Ask Gita works

- All 701 English verse translations and the 18 chapter TL;DRs go in the system prompt, which is prompt-cached, so repeat questions only pay cache-read rates for it.
- For each question, a small keyword search (BM25) picks up to 5 verses and sends their Shorts and FAQ notes along with the question.
- Only signed-in users can ask. Each question is counted on the server before the model is called, and given back if the answer fails.
- The model (`claude-opus-5-5` by default, low effort) answers in under ~150 words in the user's language and cites verses as `[2.47]`; the site turns those into links to the verse cards.
- Server-side refusal fallback is on (`fallbacks: "default"`).

## Content sources

The Sanskrit text, transliteration and chapter names come from the Bhagavad-Gita-JSON-data set. Translations, Shorts, chapter TL;DRs and FAQs are written for this project, and the build fails if any verse lacks our own English or Hindi translation. No third-party translation or commentary ships.

## Google AdSense

Ads are off until `public/config.js` has your publisher ID and ad slot. Until an ad fills, each in-feed ad card shows a Bhagwat Gita card instead.

1. Sign up at adsense.google.com with your own domain (AdSense does not approve `*.vercel.app` addresses).
2. Create a display ad unit and put the IDs in `public/config.js`:
   `adsenseClient: "ca-pub-…"`, `adsenseSlot: "…"`.
3. Add `public/ads.txt` containing `google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0` (your number, without `ca-`).

## Home-screen app

The site is an installable web app (`manifest.webmanifest`, icons in `public/icons/`, offline cache in `sw.js`). On iPhone: Safari, Share, Add to Home Screen. The service worker only registers over HTTPS.
