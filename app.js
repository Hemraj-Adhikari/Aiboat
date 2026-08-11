// ============================================================================
// Ask UK Intake — chat client.
//
// Architecture (matches the diagram this app is built around):
//
//   User -> Chat Interface -> AI / LLM Layer -> Intent + Data Extraction
//        -> University JSON / Data -> Accurate Answer
//
// This file IS the "Chat Interface". For each question it:
//   1. Runs local Intent + Data Extraction against data/*.json (findMatches)
//      so the structured facts card always shows real, sourced data — this
//      also works completely offline.
//   2. Calls /api/chat (the AI / LLM Layer), which repeats that same
//      retrieval server-side and asks an LLM to phrase a grounded natural-
//      language answer from ONLY that retrieved data.
//   3. If the AI layer is unavailable (no network, no API key configured,
//      running from a plain static host), it silently falls back to a
//      template-based answer built straight from the retrieved data — so
//      the app never breaks, it just loses the natural-language phrasing.
//
// All UI copy comes from LANG (lang.js) — nothing user-facing is hardcoded
// here.
// ============================================================================

const state = { rows: [], universities: {} };

const els = {
  thread: document.getElementById('thread'),
  intro: document.getElementById('intro'),
  chips: document.getElementById('chips'),
  form: document.getElementById('askForm'),
  q: document.getElementById('q'),
  stat: document.getElementById('statLine'),
  browseToggle: document.getElementById('browseToggle'),
  browsePanel: document.getElementById('browsePanel'),
  browseResults: document.getElementById('browseResults'),
  level: document.getElementById('levelFilter'),
  uni: document.getElementById('uniFilter'),
  campus: document.getElementById('campusFilter'),
  brandText: document.getElementById('brandText'),
  taglineText: document.getElementById('taglineText'),
  heroTitle: document.getElementById('heroTitle'),
  heroSubtitle: document.getElementById('heroSubtitle'),
};

// ---------------------------------------------------------------------------
// Apply centralized language object to the static shell
// ---------------------------------------------------------------------------
function applyLang() {
  document.documentElement.lang = LANG.meta.htmlLang;
  document.title = LANG.meta.pageTitle;
  els.brandText.textContent = LANG.brand;
  els.taglineText.textContent = LANG.tagline;
  els.heroTitle.textContent = LANG.hero.title;
  els.heroSubtitle.textContent = LANG.hero.subtitle;
  els.q.placeholder = LANG.input.placeholder;
  els.stat.textContent = LANG.status.loading;
  els.browseToggle.textContent = LANG.browse.show;
  els.level.options[0].textContent = LANG.browse.levelAll;
  els.uni.options[0].textContent = LANG.browse.uniAll;
  els.campus.options[0].textContent = LANG.browse.campusAll;
}
applyLang();

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
async function loadData() {
  const [ug, pg, unis] = await Promise.all([
    fetch('data/ug_courses.json').then(r => r.json()),
    fetch('data/pg_courses.json').then(r => r.json()),
    fetch('data/universities.json').then(r => r.json()),
  ]);
  state.universities = unis;
  state.rows = [
    ...ug.map(r => ({ ...r, level: 'UG' })),
    ...pg.map(r => ({ ...r, level: 'PG' })),
  ];
  els.stat.textContent = LANG.status.ready(state.rows.length, Object.keys(unis).length);
  populateFilters();
  renderBrowse();
}

function populateFilters() {
  const uniNames = [...new Set(state.rows.map(r => r.university).filter(Boolean))].sort();
  for (const u of uniNames) {
    const opt = document.createElement('option');
    opt.value = u; opt.textContent = u;
    els.uni.appendChild(opt);
  }
  const campuses = [...new Set(state.rows.map(r => r.campus).filter(Boolean))].sort();
  for (const c of campuses) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    els.campus.appendChild(opt);
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ---------------------------------------------------------------------------
// Intent + Data Extraction — local retrieval (English + romanized Nepali
// input is understood; UI output is always English).
// ---------------------------------------------------------------------------
const INTENTS = [
  { key: 'ACADEMIC CRITERIA', label: 'Academic Criteria', words: ['criteria','eligib','academic','gpa','percentage','yogyata','marks','grade'] },
  { key: 'ENGLISH LANGUAGE CRITERIA', label: 'English Language Criteria', words: ['ielts','pte','english','duolingo','selt','language','ellt','languagecert'] },
  { key: 'ENGLISH WAIVER CRITERIA', label: 'English Waiver Criteria', words: ['waiver','without ielts','moi','bina ielts'] },
  { key: 'FEE STRUCTURE', label: 'Fee Structure', words: ['fee','fees','tuition','cost','price','kati parcha','paisa','kharcha'] },
  { key: 'SCHOLARSHIP', label: 'Scholarship', words: ['scholarship','discount','chhatrabritti','chhatrabrit'] },
  { key: 'GAP', label: 'Gap Year', words: ['gap','year gap'] },
  { key: 'CAS Deposit', label: 'CAS Deposit', words: ['cas','deposit'] },
  { key: 'Enrollment Fee', label: 'Enrollment Fee', words: ['enrollment','enrolment','installment'] },
];

const STOPWORDS = new Set([
  'ko','ka','ki','ma','ho','k','chai','bare','le','lai','ney','ni','vaneko','vanda',
  'kun','kunai','herna','chha','xa','details','detail','please','kati','university',
  'universi','college','course','courses','ho?','k?','the','of','in','for','a','an',
  'is','are','what','tell','me','about','info','information','entry','and','requirement',
  'requirements','need','needed','required','apply','huncha','huncha?','ki','ki?'
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function detectIntents(rawTextLower) {
  const found = [];
  for (const intent of INTENTS) {
    if (intent.words.some(w => rawTextLower.includes(w))) found.push(intent);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Row scoring — plain substring/token overlap, weighted by field.
// ---------------------------------------------------------------------------
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

function findMatches(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { top: null, alts: [] };
  const scored = state.rows
    .map(r => ({ row: r, score: scoreRow(r, tokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { top: null, alts: [] };
  const topScore = scored[0].score;
  const top = scored[0].row;
  const alts = scored
    .filter(x => x.row !== top && x.score >= topScore * 0.6)
    .slice(0, 5)
    .map(x => x.row);
  return { top, alts, tokens };
}

// ---------------------------------------------------------------------------
// Category picking (which column of a university's meta block applies)
// ---------------------------------------------------------------------------
function pickCategory(uniData, level) {
  const cats = uniData.categories || [];
  if (cats.length === 0) return null;
  const pgHints = ['POSTGRADUATE', 'MASTER', 'MSC', 'MBA', 'MRES', 'MA '];
  const ugHints = ['UNDERGRADUATE', 'DIRECT UNDERGRADUATE', 'FOUNDATION', 'INTERNATIONAL YEAR ONE'];
  const hints = level === 'PG' ? pgHints : ugHints;
  for (const h of hints) {
    const found = cats.find(c => c.toUpperCase().includes(h));
    if (found) return found;
  }
  return level === 'PG' ? cats[cats.length - 1] : cats[0];
}

function fieldHTML(label, value) {
  if (!value) return '';
  return `<div class="field"><div class="k">${escapeHTML(label)}</div><div class="v">${escapeHTML(value)}</div></div>`;
}

const FIELD_ORDER = ['ACADEMIC CRITERIA','ENGLISH LANGUAGE CRITERIA','ENGLISH WAIVER CRITERIA',
  'FEE STRUCTURE','SCHOLARSHIP','GAP','GAP ','CAS Deposit','Enrollment Fee'];

function metaValue(meta, label, cat) {
  return meta[label] && meta[label][cat] ? meta[label][cat] : null;
}

// ---------------------------------------------------------------------------
// AI / LLM Layer — ask the grounded server endpoint. Returns null on any
// failure so the caller can fall back to the local template engine.
// ---------------------------------------------------------------------------
async function askAI(question) {
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.grounded && data.answer ? data.answer : null;
  } catch (err) {
    return null; // offline / no serverless function available — use fallback
  }
}

// ---------------------------------------------------------------------------
// Compose an answer for a matched row. aiAnswer (if present) is the
// AI-generated, data-grounded natural-language answer shown above the
// structured facts grid.
// ---------------------------------------------------------------------------
function composeAnswer(query, top, alts, aiAnswer) {
  const uniData = top.uni_key ? state.universities[top.uni_key] : null;
  const cat = uniData ? pickCategory(uniData, top.level) : null;
  const meta = uniData ? uniData.meta : {};
  const rawLower = query.toLowerCase();
  const intents = detectIntents(rawLower);

  let leadParts = [];
  leadParts.push(`<b>${escapeHTML(top.course)}</b> — ${escapeHTML(top.university)}${top.campus ? ' · ' + escapeHTML(top.campus) : ''}${top.intake ? ' · Intake ' + escapeHTML(top.intake) : ''}`);

  let fieldsToShow = [];
  if (intents.length > 0) {
    // specific intent(s) asked — answer directly with just those
    for (const intent of intents) {
      const val = meta && cat ? metaValue(meta, intent.key, cat) : null;
      if (val) fieldsToShow.push(fieldHTML(intent.label, val));
    }
    if (fieldsToShow.length === 0) {
      leadParts.push(LANG.answer.specificMissing);
      fieldsToShow = FIELD_ORDER.map(l => fieldHTML(l.trim(), meta ? metaValue(meta, l, cat) : null)).filter(Boolean);
    }
  } else {
    // general question — show a compact summary of everything available
    fieldsToShow = FIELD_ORDER.map(l => fieldHTML(l.trim(), meta ? metaValue(meta, l, cat) : null)).filter(Boolean);
  }

  const seen = new Set();
  fieldsToShow = fieldsToShow.filter(html => {
    if (seen.has(html)) return false;
    seen.add(html); return true;
  });

  const pillClass = top.level === 'PG' ? 'course-tag pg' : 'course-tag';
  const catNote = cat ? `<div class="catnote">${escapeHTML(LANG.answer.criteriaCategoryMatched)}: <b>${escapeHTML(cat)}</b>${uniData ? ' ' + escapeHTML(LANG.answer.at) + ' ' + escapeHTML(uniData.name) : ''}</div>` : '';

  const aiHTML = aiAnswer ? `
    <div class="ai-answer">
      <div class="ai-answer-label">${escapeHTML(LANG.answer.aiLabel)}</div>
      <p>${escapeHTML(aiAnswer)}</p>
    </div>` : '';

  const otherHTML = alts.length ? `
    <div class="other-matches">
      <div class="ttl">${escapeHTML(LANG.answer.otherMatches)}</div>
      <div class="chiprow">
        ${alts.map(r => `<button data-ask="${escapeHTML(r.course + ' ' + r.university)}">${escapeHTML(r.course)} — ${escapeHTML(r.university)}</button>`).join('')}
      </div>
    </div>` : '';

  return `
    <span class="${pillClass}">${top.level}</span>
    ${aiHTML}
    <p class="lead">${leadParts.join('<br>')}</p>
    <div class="grid">${fieldsToShow.join('') || `<div class="field"><div class="v">${escapeHTML(LANG.answer.detailMissing)}</div></div>`}</div>
    ${catNote}
    ${otherHTML}
  `;
}

function composeNoMatch(query) {
  return `
    <p class="lead">${escapeHTML(LANG.answer.noMatchLead(query))}</p>
    <div class="catnote">${escapeHTML(LANG.answer.noMatchHint)}</div>
  `;
}

// ---------------------------------------------------------------------------
// Rendering chat thread
// ---------------------------------------------------------------------------
function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="bubble">${escapeHTML(text)}</div>`;
  els.thread.appendChild(div);
}

function addAnswerMsg(html) {
  const div = document.createElement('div');
  div.className = 'msg answer';
  div.innerHTML = `<div class="answer-card">${html}</div>`;
  els.thread.appendChild(div);
  div.querySelectorAll('button[data-ask]').forEach(btn => {
    btn.addEventListener('click', () => ask(btn.getAttribute('data-ask')));
  });
  return div;
}

function addThinkingMsg() {
  const div = document.createElement('div');
  div.className = 'msg answer thinking';
  div.innerHTML = `<div class="answer-card thinking-card">${escapeHTML(LANG.status.thinking)}</div>`;
  els.thread.appendChild(div);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  return div;
}

async function ask(text) {
  text = text.trim();
  if (!text) return;
  if (els.intro) { els.intro.remove(); els.intro = null; }
  addUserMsg(text);
  els.q.value = '';

  const { top, alts } = findMatches(text);
  const thinkingEl = addThinkingMsg();

  // AI / LLM Layer call — local retrieval above already gives us the
  // structured facts even if the AI layer is slow, down, or not configured.
  const aiAnswer = top ? await askAI(text) : null;

  thinkingEl.remove();
  if (!top) {
    addAnswerMsg(composeNoMatch(text));
  } else {
    addAnswerMsg(composeAnswer(text, top, alts, aiAnswer));
  }
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

els.form.addEventListener('submit', e => {
  e.preventDefault();
  ask(els.q.value);
});

// ---------------------------------------------------------------------------
// Example chips
// ---------------------------------------------------------------------------
for (const ex of LANG.examples) {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'chip';
  c.textContent = ex;
  c.addEventListener('click', () => ask(ex));
  els.chips.appendChild(c);
}

// ---------------------------------------------------------------------------
// Browse panel (full filterable list, kept as a secondary view)
// ---------------------------------------------------------------------------
function renderBrowse() {
  const level = els.level.value;
  const uni = els.uni.value;
  const campus = els.campus.value;
  const filtered = state.rows.filter(r =>
    (!level || r.level === level) &&
    (!uni || r.university === uni) &&
    (!campus || r.campus === campus)
  ).slice(0, 80);

  if (filtered.length === 0) {
    els.browseResults.innerHTML = `<div class="empty">${escapeHTML(LANG.browse.empty)}</div>`;
    return;
  }
  els.browseResults.innerHTML = filtered.map(row => {
    const uniData = row.uni_key ? state.universities[row.uni_key] : null;
    const cat = uniData ? pickCategory(uniData, row.level) : null;
    const meta = uniData ? uniData.meta : {};
    const fields = FIELD_ORDER.map(l => fieldHTML(l.trim(), meta ? metaValue(meta, l, cat) : null)).filter(Boolean);
    const seen = new Set();
    const dedup = fields.filter(h => (seen.has(h) ? false : (seen.add(h), true)));
    const pillClass = row.level === 'PG' ? 'pill pg' : 'pill';
    return `
      <details class="rcard">
        <summary>
          <div>
            <div class="course">${escapeHTML(row.course)}</div>
            <div class="uniline">
              <span class="${pillClass}">${row.level}</span>
              <span>${escapeHTML(row.university)}</span>
              ${row.campus ? `<span>· ${escapeHTML(row.campus)}</span>` : ''}
            </div>
          </div>
        </summary>
        <div class="detail"><div class="grid">${dedup.join('') || `<div class="field"><div class="v">${escapeHTML(LANG.answer.detailMissing)}</div></div>`}</div></div>
      </details>`;
  }).join('');
}

els.browseToggle.addEventListener('click', () => {
  els.browsePanel.classList.toggle('hidden');
  els.browseToggle.textContent = els.browsePanel.classList.contains('hidden') ? LANG.browse.show : LANG.browse.hide;
});
[els.level, els.uni, els.campus].forEach(el => el.addEventListener('change', renderBrowse));

loadData();
