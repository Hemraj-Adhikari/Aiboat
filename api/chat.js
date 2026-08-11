// ============================================================================
// api/chat.js — the "AI / LLM Layer" + "Intent + Data Extraction" steps.
//
//   User -> Chat Interface -> AI / LLM Layer -> Intent + Data Extraction
//        -> University JSON / Data -> Accurate Answer
//
// This is a Vercel serverless function (Node runtime). It never lets the
// model answer from its own knowledge: it first retrieves the exact rows /
// fields from data/*.json that match the question (Intent + Data
// Extraction), then asks the LLM to phrase an answer using ONLY that
// retrieved data (grounding). If nothing matches, or no API key is
// configured, it tells the client so and the UI falls back to the local
// template engine in app.js.
//
// LLM provider: Google Gemini API — chosen because it has a genuine free
// tier (no credit card, ~1,500 requests/day on Gemini Flash as of 2026).
// Get a key at https://ai.google.dev and set GEMINI_API_KEY.
// ============================================================================

const ugCourses = require('../data/ug_courses.json');
const pgCourses = require('../data/pg_courses.json');
const universities = require('../data/universities.json');

// Google Gemini API — free tier, no credit card required (as of 2026:
// ~1,500 requests/day on Gemini Flash). Get a key at https://ai.google.dev
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const MAX_MATCHES = 4;

// ---------------------------------------------------------------------------
// Intent + Data Extraction (retrieval) — same matching approach as app.js,
// kept in sync deliberately so server and offline-client answers agree.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'ko', 'ka', 'ki', 'ma', 'ho', 'k', 'chai', 'bare', 'le', 'lai', 'ney', 'ni', 'vaneko', 'vanda',
  'kun', 'kunai', 'herna', 'chha', 'xa', 'details', 'detail', 'please', 'kati', 'university',
  'universi', 'college', 'course', 'courses', 'ho?', 'k?', 'the', 'of', 'in', 'for', 'a', 'an',
  'is', 'are', 'what', 'tell', 'me', 'about', 'info', 'information', 'entry', 'and', 'requirement',
  'requirements', 'need', 'needed', 'required', 'apply', 'huncha', 'huncha?', 'ki?',
]);

const FIELD_ORDER = [
  'ACADEMIC CRITERIA', 'ENGLISH LANGUAGE CRITERIA', 'ENGLISH WAIVER CRITERIA',
  'FEE STRUCTURE', 'SCHOLARSHIP', 'GAP', 'GAP ', 'CAS Deposit', 'Enrollment Fee',
];

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function scoreRow(row, tokens) {
  const course = (row.course || '').toLowerCase();
  const uni = (row.university || '').toLowerCase();
  const campus = (row.campus || '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (course.includes(t)) score += 3;
    if (uni.includes(t)) score += 2;
    if (campus.includes(t)) score += 1;
  }
  return score;
}

function pickCategory(uniData, level) {
  const cats = uniData.categories || [];
  if (cats.length === 0) return null;
  const pgHints = ['POSTGRADUATE', 'MASTER', 'MSC', 'MBA', 'MRES', 'MA '];
  const ugHints = ['UNDERGRADUATE', 'DIRECT UNDERGRADUATE', 'FOUNDATION', 'INTERNATIONAL YEAR ONE'];
  const hints = level === 'PG' ? pgHints : ugHints;
  for (const h of hints) {
    const found = cats.find((c) => c.toUpperCase().includes(h));
    if (found) return found;
  }
  return level === 'PG' ? cats[cats.length - 1] : cats[0];
}

function metaValue(meta, label, cat) {
  return meta[label] && meta[label][cat] ? meta[label][cat] : null;
}

function allRows() {
  return [
    ...ugCourses.map((r) => ({ ...r, level: 'UG' })),
    ...pgCourses.map((r) => ({ ...r, level: 'PG' })),
  ];
}

function findMatches(question) {
  const tokens = tokenize(question);
  if (tokens.length === 0) return [];
  return allRows()
    .map((row) => ({ row, score: scoreRow(row, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES)
    .map((x) => x.row);
}

// Build a plain-text, fully-sourced context block for the LLM — this IS the
// "University JSON / Data" step reaching the model, nothing else does.
function buildContext(matches) {
  return matches
    .map((row) => {
      const uniData = row.uni_key ? universities[row.uni_key] : null;
      const cat = uniData ? pickCategory(uniData, row.level) : null;
      const meta = uniData ? uniData.meta : {};
      const fields = FIELD_ORDER
        .map((label) => {
          const val = metaValue(meta, label, cat);
          return val ? `${label.trim()}: ${val}` : null;
        })
        .filter(Boolean);
      return [
        `COURSE: ${row.course}`,
        `LEVEL: ${row.level}`,
        `UNIVERSITY: ${row.university}`,
        `CAMPUS: ${row.campus || 'N/A'}`,
        `INTAKE: ${row.intake || 'N/A'}`,
        `CRITERIA CATEGORY: ${cat || 'N/A'}`,
        ...fields,
      ].join('\n');
    })
    .join('\n\n---\n\n');
}

const SYSTEM_PROMPT_HEADER = `You are the answer engine for "Ask UK Intake", a UK university course-finder
used by prospective students applying for the September 2026 intake.

Rules (follow strictly):
- Answer ONLY using the DATA block below. It is the sole source of truth.
- Never invent or estimate a fee, IELTS/PTE score, GPA, percentage, scholarship
  amount, or date that is not literally present in DATA.
- If the exact fact asked for is not in DATA, say so plainly and offer what IS
  available in DATA instead. Do not apologize at length.
- Reply in clear English. Keep it to 2-6 sentences, using a short bullet list
  when listing several facts (e.g. multiple fee tiers).
- Do not mention that you are an AI, a model, or that you were given rules.

DATA:
`;

async function callGemini(question, contextText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { answer: null, grounded: false, reason: 'no_api_key' };

  const system = SYSTEM_PROMPT_HEADER + contextText;

  let resp;
  try {
    resp = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: question }] }],
        generationConfig: { maxOutputTokens: 500 },
      }),
    });
  } catch (err) {
    return { answer: null, grounded: false, reason: 'network_error', detail: String(err) };
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return { answer: null, grounded: false, reason: 'api_error', detail };
  }

  const data = await resp.json();
  const answer = (data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map((p) => p.text || '').join('\n')
    : ''
  ).trim();

  return { answer: answer || null, grounded: Boolean(answer) };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const question = req.body && req.body.question;
  if (!question || typeof question !== 'string') {
    res.status(400).json({ error: 'question (string) is required' });
    return;
  }

  const matches = findMatches(question);
  if (matches.length === 0) {
    res.status(200).json({ answer: null, matches: [], grounded: false, reason: 'no_match' });
    return;
  }

  const contextText = buildContext(matches);
  const result = await callGemini(question, contextText);

  res.status(200).json({
    matches,
    answer: result.answer,
    grounded: result.grounded,
    reason: result.reason || null,
  });
};
