# Gita Scroll

A swipeable Bhagavad Gita reader for the web. Every verse is a full-screen card with three sections you swipe between:

1. **Verse**: Sanskrit, transliteration and English translation
2. **Meaning**: translation and commentary in English or Hindi
3. **Shorts**: a 30-word take on the verse for today's generation (English or Hinglish)

Swipe up for the next verse; the section you're on stays the same. Each verse can be read aloud (browser text-to-speech), shared and saved. **Ask Gita** answers questions from the Gita's verses and commentary and links to the verses it used.

## Project layout

| Path | What it is |
| --- | --- |
| `public/` | The static site (`index.html`, generated `genz.js` and `data/`) |
| `api/ask.js` | Ask Gita serverless function (Claude API) |
| `content/shorts/` | Shorts for every verse (`chN.json`) and chapter TL;DRs (`chapters.json`). Edit these, not `public/genz.js` |
| `source/` | Raw dataset: chapters, verses, translations, commentaries |
| `scripts/build_data.py` | Builds `public/data/`, `public/genz.js` and `data/gita-context.json` from `source/` and `content/` |
| `data/gita-context.json` | Compact text the Ask Gita function loads |

After editing anything in `source/` or `content/`, rebuild with `npm run build:data` and commit the generated files.

## Running locally

```bash
npm install
npm test                 # Ask Gita unit tests (no API calls)
npx vercel dev           # site + /api/ask on http://localhost:3000
```

Ask Gita needs `ANTHROPIC_API_KEY` in the environment (for `vercel dev`, put it in `.env.local`, which is git-ignored).

## Deploying

1. Import this repository in Vercel (no framework preset, no build command).
2. Add the environment variable `ANTHROPIC_API_KEY` (from console.anthropic.com).
3. Deploy. The site is served from `public/`, and Ask Gita runs at `/api/ask`.

## How Ask Gita works

- All 701 English verse translations and the 18 chapter summaries go in the system prompt, which is prompt-cached, so repeat questions only pay cache-read rates for it.
- For each question, a small keyword search (BM25) picks up to 5 verses and sends their commentary excerpts along with the question.
- The model (`claude-opus-5-5`, low effort) answers in under ~150 words in the user's language and cites verses as `[2.47]`; the site turns those into links to the verse cards.
- Server-side refusal fallback is on (`fallbacks: "default"`).

## Content sources

Text comes from the Bhagavad-Gita-JSON-data set: translations by Swami Adidevananda (English) and Swami Ramsukhdas (Hindi), commentary by Swami Sivananda (English) and Swami Chinmayananda (Hindi). Check the licence of these translations and commentaries before commercial use. Shorts and chapter TL;DRs were written for this project.

## Google AdSense

Ads are off until `public/config.js` has your publisher ID and ad slot. Until an ad fills, each in-feed ad card shows a Bhagwat Gita card instead.

1. Sign up at adsense.google.com with your own domain (AdSense does not approve `*.vercel.app` addresses).
2. Create a display ad unit and put the IDs in `public/config.js`:
   `adsenseClient: "ca-pub-…"`, `adsenseSlot: "…"`.
3. Add `public/ads.txt` containing `google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0` (your number, without `ca-`).

## Home-screen app

The site is an installable web app (`manifest.webmanifest`, icons in `public/icons/`, offline cache in `sw.js`). On iPhone: Safari, Share, Add to Home Screen. The service worker only registers over HTTPS.
