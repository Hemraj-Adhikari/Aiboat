# Ask UK Intake — September 2026 Intake

A university course-finder chatbot for UK September 2026 intake. Every answer
is **grounded** in the bundled JSON data (`data/*.json`) — the AI layer is
never allowed to invent a fee, IELTS score, GPA, or scholarship amount that
isn't in that data.

## Architecture

```
      User
       ↓
  Chat Interface        (index.html + app.js)
       ↓
  AI / LLM Layer         (api/chat.js → Anthropic API)
       ↓
  Intent + Data Extraction   (keyword/intent matching over the JSON)
       ↓
  University JSON / Data     (data/ug_courses.json, pg_courses.json,
                               universities.json)
       ↓
  Accurate Answer         (natural-language, sourced only from the data
                            above, shown next to the structured facts card)
```

- **Chat Interface** (`index.html`, `app.js`, `style.css`) — the browser UI.
  All copy comes from `lang.js`, a single centralized English language
  object, so there's one place to change any string in the app.
- **Intent + Data Extraction** — a small local matcher (course/university/
  campus keyword scoring + intent detection for things like "fee", "IELTS",
  "scholarship") that finds the right row(s) in the JSON data. This runs
  both in the browser (`app.js`, so the structured facts card always works,
  even offline) and again on the server (`api/chat.js`) to build the exact
  context handed to the model.
- **AI / LLM Layer** (`api/chat.js`) — a Vercel serverless function that
  calls the **Google Gemini API** (free tier, no credit card required) with
  a system prompt instructing the model to answer **only** from the
  retrieved data block, and to say so plainly if a specific fact isn't
  available. If no `GEMINI_API_KEY` is configured, or the request fails for
  any reason, the client silently falls back to a template-built answer
  from the same retrieved data — the app never breaks, it only loses the
  natural-language phrasing.
- **University JSON / Data** — extracted once from the intake spreadsheet
  into `data/*.json` (see below). This is the single source of truth; the AI
  layer never sees anything outside of it.

## Files

- `lang.js` — centralized English UI strings (single source of truth for copy)
- `index.html` / `style.css` — chat UI shell
- `app.js` — chat interface logic: local retrieval, calls the AI layer, renders answers
- `api/chat.js` — serverless "AI / LLM Layer" + "Intent + Data Extraction" (Vercel function)
- `data/ug_courses.json` — all Undergraduate courses (course, level, intake, university, campus)
- `data/pg_courses.json` — all Postgraduate courses
- `data/universities.json` — per-university criteria/fee/scholarship data, by category
- `scripts/extract.py` — re-extracts the JSON files from the source Excel workbook

## Setting up the AI layer (free)

1. Get a **free** API key at https://ai.google.dev → "Get API Key". No
   credit card required. Free tier is roughly 1,500 requests/day on Gemini
   Flash, which is far more than a course-finder like this needs.
2. Copy `.env.example` to `.env` for local dev, or add `GEMINI_API_KEY` in
   your Vercel project's **Settings → Environment Variables** for production.
3. No key configured? The app still works — it automatically falls back to
   the local template-based answer engine.

## Running locally

The chat UI itself needs no build step, but to exercise the AI layer
(`api/chat.js`) locally you need the Vercel CLI so the serverless function is
actually served:

```bash
npm i -g vercel
vercel dev
# open the printed http://localhost:3000
```

To preview just the static UI (AI layer will fall back automatically since
`/api/chat` won't exist):

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploying to Vercel

**Option A — from vercel.com:**
1. Log in at https://vercel.com (GitHub login works)
2. "Add New Project" → select this repo
3. Framework Preset: **Other** — no build command needed
4. Root Directory: repo root (where `index.html` lives)
5. Add `GEMINI_API_KEY` under Environment Variables (free — see above)
6. Deploy — live in ~30 seconds

**Option B — Vercel CLI:**
```bash
npm i -g vercel
vercel        # preview deploy
vercel --prod # production deploy
```

## Refreshing the data

If the source Excel workbook (`SEPTEMBER 2026 INTAKE - UNIVERSITY DETAILS.xlsx`)
is updated, re-run the extractor (requires Python + `openpyxl`) and commit the
refreshed JSON files:

```bash
python3 scripts/extract.py
git add data/*.json
git commit -m "Refresh intake data"
git push
```

## Notes

- Data was extracted from 44 university sheets with slightly different
  structures (some use "Undergraduate/Postgraduate" columns, others "Direct
  UG / Foundation / Year One"), so a small number of courses (~5-8%) may not
  have a detailed criteria match. In that case the answer says the detail
  couldn't be extracted — check the source sheet manually.
- The AI layer is strictly grounded: it is instructed never to state a fee,
  score, or amount that isn't present in the retrieved JSON data, and to say
  plainly when something isn't available rather than guessing.
