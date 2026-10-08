/* Calendar assistant — weekly analysis, urgent alerts, and Q&A over your events.
 *
 * Privacy: everything runs on this device.
 *  - Weekly analysis + urgent alerts: plain JavaScript, always available, offline.
 *  - Questions: instant rule-based answers, upgraded by an on-device language model
 *    (WebLLM + WebGPU) when the user opts in. Model weights are downloaded once
 *    from the Hugging Face CDN and cached; calendar data is never sent anywhere.
 */
(() => {
'use strict';

const WEBLLM = 'https://esm.run/@mlc-ai/web-llm@0.2.85';
const MODELS = {
  small:  { label: 'Small',  name: 'Qwen 2.5 · 0.5B', size: '≈280 MB', f16: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC', note: 'Fast, works on most phones' },
  better: { label: 'Better', name: 'Llama 3.2 · 1B',  size: '≈700 MB', f16: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', note: 'Smarter answers, needs more memory' },
};
const A = self.CalAlerts;
const $ = id => document.getElementById(id);
const SKEY = 'calendar-asst';
let S = Object.assign({}, A.DEFAULTS, safeJSON(localStorage.getItem(SKEY)));
let Cal;

function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() {
  localStorage.setItem(SKEY, JSON.stringify(S));
  Cal && Cal.db.set('asstSettings', S).catch(() => {});
}

/* ======================= date + data helpers ======================= */
const EN = {
  day: new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
  full: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
};
const L = {
  dayShort: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
  dayLong: new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
  dow: new Intl.DateTimeFormat(undefined, { weekday: 'long' }),
  dowS: new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
  md: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }),
  month: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }),
};
const keyOf = d => A.keyOf(d), parseKey = k => A.parseKey(k), addDays = (k, n) => A.addDays(k, n);
const todayKey = () => keyOf(new Date());
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const listJoin = arr => arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];

function item(k, e) {
  const start = parseKey(k);
  if (e.time) { const [h, m] = e.time.split(':').map(Number); start.setHours(h, m, 0, 0); }
  return { key: k, ev: e, start, allDay: !e.time };
}
const byStart = (a, b) => a.key.localeCompare(b.key) || (a.allDay === b.allDay ? (a.ev.time || '').localeCompare(b.ev.time || '') : a.allDay ? -1 : 1);
/* Every occurrence (repeating series expanded) within a window around today:
 * from the earliest stored day (≥ 2 years back) to ~13 months ahead or the last stored day. */
let itemsCache = null;
function allItems() {
  if (itemsCache) return itemsCache;
  const days = Cal.getDays(), keys = Object.keys(days).sort(), t = todayKey();
  const lo = keys[0] && keys[0] < t ? (keys[0] > addDays(t, -730) ? keys[0] : addDays(t, -730)) : addDays(t, -30);
  const hiStored = keys[keys.length - 1] || t;
  const hi = hiStored > addDays(t, 400) ? hiStored : addDays(t, 400);
  itemsCache = Cal.expand(lo, hi).map(o => item(o.key, o.ev)).sort(byStart);
  return itemsCache;
}
document.addEventListener('cal:change', () => { itemsCache = null; });
setInterval(() => { itemsCache = null; }, 60 * 60 * 1000);
const between = (items, a, b) => items.filter(i => i.key >= a && i.key <= b);
function when(i, long) {
  const d = parseKey(i.key);
  const rel = i.key === todayKey() ? 'Today' : i.key === addDays(todayKey(), 1) ? 'Tomorrow' : null;
  const day = rel || (long ? L.dayLong : L.dayShort).format(d);
  return i.allDay ? `${day} · all day` : `${day} · ${Cal.fmtTime(i.ev.time)}`;
}
function weekStart(offset = 0) { return addDays(A.weekStartKey(new Date()), offset * 7); }

/* ======================= weekly analysis ======================= */
function analyzeWeek(offset) {
  const ws = weekStart(offset), we = addDays(ws, 6);
  const items = allItems();
  const week = between(items, ws, we);
  const prev = between(items, addDays(ws, -7), addDays(ws, -1)).length;
  const next = between(items, addDays(ws, 7), addDays(ws, 13));
  const days = Cal.getDays();
  const per = Array.from({ length: 7 }, (_, i) => {
    const k = addDays(ws, i);
    return { key: k, items: week.filter(x => x.key === k), note: !!(days[k] && days[k].note) };
  });

  const conflicts = [];
  for (const d of per) {
    const timed = d.items.filter(x => !x.allDay);
    for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
      const gap = Math.abs(timed[j].start - timed[i].start) / 6e4;
      if (gap < 30) conflicts.push({ a: timed[i], b: timed[j], same: gap === 0 });
    }
  }
  const busiest = per.reduce((a, b) => (b.items.length > a.items.length ? b : a), per[0]);
  const free = per.filter(d => !d.items.length);
  const freeWeekdays = free.filter(d => { const w = parseKey(d.key).getDay(); return w >= 1 && w <= 5; });
  const important = week.filter(x => x.ev.important);
  const late = week.filter(x => !x.allDay && x.start.getHours() >= 19);
  const early = week.filter(x => !x.allDay && x.start.getHours() < 8);
  const notes = per.filter(d => d.note).length;
  const isPast = we < todayKey(), isCurrent = ws <= todayKey() && todayKey() <= we;

  // headline
  const n = week.length;
  let head;
  if (!n) head = isPast ? 'Nothing was scheduled this week.' : 'A clear week: nothing scheduled yet.';
  else {
    const tone = n >= 15 ? 'A packed week' : n >= 8 ? 'A busy week' : n >= 3 ? 'A steady week' : 'A light week';
    const diff = n - prev;
    const cmp = prev === 0 && diff > 0 ? '' : diff > 0 ? `, ${diff} more than the week before` : diff < 0 ? `, ${-diff} fewer than the week before` : ', same as the week before';
    head = `${tone}: ${plural(n, 'event')}${cmp}.`;
    if (busiest.items.length > 1) head += ` ${L.dow.format(parseKey(busiest.key))} is the busiest, with ${busiest.items.length}.`;
    if (free.length && free.length < 7) {
      const names = free.map(d => L.dow.format(parseKey(d.key)));
      head += free.length <= 3 ? ` ${listJoin(names)} ${free.length === 1 ? 'is' : 'are'} open.` : ` ${free.length} days are open.`;
    }
  }
  return { ws, we, week, per, prev, next, conflicts, busiest, free, freeWeekdays, important, late, early, notes, head, isPast, isCurrent };
}

function weekFactsText(w) {
  const lines = [];
  lines.push(`Week: ${EN.day.format(parseKey(w.ws))} to ${EN.day.format(parseKey(w.we))}. Total events: ${w.week.length} (previous week: ${w.prev}).`);
  if (w.busiest.items.length) lines.push(`Busiest day: ${EN.full.format(parseKey(w.busiest.key))} with ${w.busiest.items.length} events.`);
  if (w.free.length) lines.push(`Days with nothing scheduled: ${w.free.map(d => EN.full.format(parseKey(d.key)).split(',')[0]).join(', ')}.`);
  if (w.conflicts.length) lines.push(`Overlapping or back-to-back events: ${w.conflicts.map(c => `${c.a.ev.title} & ${c.b.ev.title} on ${EN.full.format(parseKey(c.a.key)).split(',')[0]}`).join('; ')}.`);
  if (w.important.length) lines.push(`Important: ${w.important.map(i => i.ev.title).join(', ')}.`);
  if (w.late.length) lines.push(`Evening events (after 7 PM): ${w.late.length}.`);
  return lines.join('\n');
}

/* ======================= question understanding ======================= */
const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monIdx = s => MONTHS.findIndex(m => m.startsWith(s.slice(0, 3)));
const STOP = new Set(('a an the and or but of to in on at for with by from about is are was were be been am do does did have has had i me my mine you your we our us it its this that these those there here what whats when where which who whom why how any anything some something all every much many more most less few lot lots can could would should will shall may might must please tell show give list find search look see know get let need want ' +
  'event events calendar schedule scheduled plan plans planned meeting meetings appointment appointments thing things anything happening going on coming up upcoming next last previous before after during between until till ' +
  'today tonight tomorrow yesterday week weeks weekend month months year years day days morning afternoon evening night time times date dates ' +
  'monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december ' +
  'jan feb mar apr jun jul aug sep sept oct nov dec busy busiest free available open empty important urgent priority summary summarize overview ' +
  'first earliest latest soon again still left remaining whole entire full rest than then just only also any have do dont im ive').split(/\s+/));

function rangeOf(startKey, days, label) { return { start: startKey, end: addDays(startKey, days - 1), label }; }
function parseRange(s) {
  const now = new Date(), t = todayKey();
  let m;
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) return rangeOf(t, 1, 'today');
  if (/\btomorrow\b/.test(s)) return rangeOf(addDays(t, 1), 1, 'tomorrow');
  if (/\byesterday\b/.test(s)) return rangeOf(addDays(t, -1), 1, 'yesterday');
  if ((m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) { const k = `${m[1]}-${m[2]}-${m[3]}`; return rangeOf(k, 1, `on ${L.dayLong.format(parseKey(k))}`); }
  if ((m = s.match(/\b(?:next|coming|following)\s+(\d+|few|couple(?: of)?)\s+days\b/))) {
    const n = /few/.test(m[1]) ? 3 : /couple/.test(m[1]) ? 2 : Math.min(+m[1], 90);
    return rangeOf(t, n + 1, `in the next ${n} days`);
  }
  if ((m = s.match(/\bin\s+(\d+)\s+days?\b/))) { const k = addDays(t, +m[1]); return rangeOf(k, 1, `on ${L.dayLong.format(parseKey(k))}`); }
  if (/\b(next|coming)\s+weekend\b/.test(s)) return rangeOf(addDays(weekStart(1), 5), 2, 'next weekend');
  if (/\bweekend\b/.test(s)) { const sat = addDays(weekStart(0), 5); return now.getDay() === 0 ? rangeOf(t, 1, 'this weekend') : rangeOf(sat, 2, 'this weekend'); }
  if (/\bnext week\b/.test(s)) return rangeOf(weekStart(1), 7, 'next week');
  if (/\b(last|previous|past) week\b/.test(s)) return rangeOf(weekStart(-1), 7, 'last week');
  if (/\b(this|current|the) week\b|\bweek\b/.test(s)) return rangeOf(weekStart(0), 7, 'this week');
  const monthRange = (y, mi, label) => { const a = new Date(y, mi, 1), b = new Date(y, mi + 1, 0); return { start: keyOf(a), end: keyOf(b), label }; };
  if (/\bnext month\b/.test(s)) { const d = new Date(now.getFullYear(), now.getMonth() + 1, 1); return monthRange(d.getFullYear(), d.getMonth(), `in ${L.month.format(d)}`); }
  if (/\b(last|previous) month\b/.test(s)) { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return monthRange(d.getFullYear(), d.getMonth(), `in ${L.month.format(d)}`); }
  if (/\b(this|current) month\b/.test(s)) return monthRange(now.getFullYear(), now.getMonth(), `in ${L.month.format(now)}`);
  // "oct 12", "october 12 2026", "12 october", "12th of oct"
  const md = s.match(new RegExp(`\\b${MON_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`)) ||
             s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}\\b(?:,?\\s+(\\d{4}))?`));
  if (md) {
    const monFirst = isNaN(+md[1]);
    const mi = monIdx(monFirst ? md[1] : md[2]), day = +(monFirst ? md[2] : md[1]), y = +(md[3] || now.getFullYear());
    if (mi > -1 && day >= 1 && day <= 31) { const k = keyOf(new Date(y, mi, day)); return rangeOf(k, 1, `on ${L.dayLong.format(parseKey(k))}`); }
  }
  // whole month: "in october", "october 2026" ("may" only with a clear marker)
  const mm = s.match(new RegExp(`\\b(?:in|during|for|of|across)\\s+${MON_RE}\\b(?:\\s+(\\d{4}))?`)) || s.match(new RegExp(`\\b${MON_RE}\\s+(\\d{4})\\b`)) ||
             (s.match(new RegExp(`\\b${MON_RE}\\b`)) && !/\bmay\b/.test(s) ? s.match(new RegExp(`\\b${MON_RE}\\b()`)) : null);
  if (mm) {
    const mi = monIdx(mm[1]);
    if (mi > -1) {
      let y = +(mm[2] || now.getFullYear());
      if (!mm[2] && mi < now.getMonth() - 2) y += 1;
      return monthRange(y, mi, `in ${L.month.format(new Date(y, mi, 1))}`);
    }
  }
  // weekdays: "friday", "on fri", "next friday"
  if ((m = s.match(/\b(next|this|last)?\s*(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?\b/))) {
    const wd = WD.findIndex(d => d.startsWith(m[2].slice(0, 3)));
    if (wd > -1 && (m[0].includes('day') || /\b(on|next|this|last)\s/.test(m[0] + ' ') || m[1])) {
      const mondayIdx = (wd + 6) % 7; // 0 = Monday
      let k;
      if (m[1] === 'next') k = addDays(weekStart(1), mondayIdx);
      else if (m[1] === 'last') k = addDays(weekStart(-1), mondayIdx);
      else if (m[1] === 'this') k = addDays(weekStart(0), mondayIdx);
      else k = addDays(t, (wd - now.getDay() + 7) % 7); // bare weekday = the next one (or today)
      return rangeOf(k, 1, `on ${L.dayLong.format(parseKey(k))}`);
    }
  }
  return null;
}
function keywords(s) {
  return [...new Set(s.split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

/* ---------- "add …" requests (typed or spoken) ---------- */
// Leading verbs that mean "create an event". Matched on the accent-stripped text; the same
// number of characters is cut from the original so Vietnamese accents survive in the title.
const ADD_RE = /^\s*(?:(?:hey|ok|okay|please|can you|could you|would you|i want to|i need to|let'?s)\s+)*(?:add|create|schedule|set up|new event|remind me(?: to)?|them|tao|dat lich|len lich|nhac (?:toi|minh|em|anh)(?: la)?)\s+(?:(?:an?|the|my|one|mot|1)\s+)?(?:(?:event|appointment|reminder|meeting called|event called|su kien|lich hen|lich|cuoc hen)\s+)?(?:(?:called|named|for|ten la|la)\s+)?/i;
const ADD_TAIL = /\s*(?:to|in|on|into) (?:my |the )?calendar\.?\s*$|\s*(?:vao|len) (?:lich|lich cua (?:toi|minh))\.?\s*$|\s*(?:please|giup (?:toi|minh)|nhe|nha)\.?\s*$/i;
function addIntent(q) {
  q = q.normalize('NFC');
  const s = norm(q);
  if (s.length !== q.length) return null;
  const m = s.match(ADD_RE);
  if (!m || !m[0].trim()) return implicitAdd(q, s);
  let rest = q.slice(m[0].length);
  const tail = norm(rest).match(ADD_TAIL);
  if (tail) rest = rest.slice(0, rest.length - tail[0].length);
  rest = rest.trim().replace(/[.!?]+$/, '');
  if (!rest || typeof QuickAdd === 'undefined') return null;
  // "add … " must name something; "add" alone or a pure question isn't a request
  if (/^(what|when|where|who|why|how|is|are|do|does)\b/i.test(norm(rest))) return null;
  const r = QuickAdd.parse(rest, new Date());
  if (!r.title) return null;
  return { title: r.title.slice(0, 200), date: r.date || todayKey(), time: r.time || '', repeat: r.repeat || '', important: !!r.important, guessedDate: !r.date };
}
const QUESTION_RE = /\?|^(what|whats|when|where|who|which|how|is|are|am|do|does|did|any|show|list|tell|find|search|check|should|can|could|will|would)\b|\b(gi|nao|khong|bao gio|may gio|ai|dau|xem|liet ke|ranh|ban khong|co lich|co gi|lich trinh|busy|free|busiest)\b/;
function implicitAdd(q, s) {
  if (QUESTION_RE.test(s) || typeof QuickAdd === 'undefined') return null;
  const r = QuickAdd.parse(q, new Date());
  if (!r.title || !(r.time || r.repeat) || r.title.split(/\s+/).length > 8) return null;
  return { title: r.title.slice(0, 200), date: r.date || todayKey(), time: r.time || '', repeat: r.repeat || '', important: !!r.important, guessedDate: !r.date, implicit: true };
}
function draftPills(d) {
  const p = [];
  p.push(d.date === todayKey() ? 'Today' : d.date === addDays(todayKey(), 1) ? 'Tomorrow' : L.dayShort.format(parseKey(d.date)));
  p.push(d.time ? Cal.fmtTime(d.time) : 'All day');
  if (d.repeat) p.push(Cal.repeatText(d.repeat, d.date, '').replace(/ \(.*\)$/, ''));
  return p;
}
function draftHTML(m) {
  const d = m.draft;
  const pills = draftPills(d).map(x => `<span>${esc(x)}</span>`).join('') + (d.important ? '<span class="acc">Important</span>' : '');
  if (m.added) return `<div class="draft done"><div class="d-ttl"><i style="--c:${Cal.colorOf(m.added.color)}"></i>${esc(d.title)}</div><div class="d-pills">${pills}</div>
    <div class="d-act"><span class="d-done">Added ✓</span><button class="btn subtle" data-act="draft-open" data-i="${m.i}">Open day</button><button class="btn subtle" data-act="draft-undo" data-i="${m.i}">Undo</button></div></div>`;
  if (m.undone) return `<div class="draft done"><div class="d-ttl">${esc(d.title)}</div><p class="muted">Not added.</p></div>`;
  return `<div class="draft"><p>${d.implicit ? 'Add this to your calendar?' : d.guessedDate ? 'Add this for today?' : 'Add this event?'}</p><div class="d-ttl"><i style="--c:var(--accent)"></i>${esc(d.title)}</div><div class="d-pills">${pills}</div>
    <div class="d-act"><button class="btn primary" data-act="draft-add" data-i="${m.i}">Add</button><button class="btn subtle" data-act="draft-edit" data-i="${m.i}">Edit…</button><button class="btn subtle" data-act="draft-cancel" data-i="${m.i}">${d.implicit ? 'No, search' : 'Cancel'}</button></div></div>`;
}
function draftSpeech(d) {
  const day = d.date === todayKey() ? 'today' : d.date === addDays(todayKey(), 1) ? 'tomorrow' : L.dayLong.format(parseKey(d.date));
  return `Add ${d.title}, ${day}${d.time ? ' at ' + Cal.fmtTime(d.time) : ''}${d.repeat ? ', repeating ' + d.repeat : ''}? Tap Add to confirm.`;
}

/* Build grounded context + an instant rule-based answer. */
function understand(q) {
  const s = norm(q);
  const t = todayKey(), all = allItems();
  const r = parseRange(s);
  const kws = keywords(s);
  const wantsImportant = /\b(important|urgent|priority|critical)\b/.test(s);
  const wantsBusy = /\b(busiest|heaviest|most events)\b/.test(s);
  const wantsFree = /\b(free|available|availability|nothing|empty|open|clear)\b/.test(s);
  const wantsNext = /\b(when|next|upcoming|soonest)\b/.test(s) && !r;
  const wantsSummary = /\b(summar|overview|recap|plan|look like|what'?s? (on|up|happening))/.test(s);

  const hit = i => { const hay = norm(i.ev.title + ' ' + i.ev.desc); return kws.some(w => hay.includes(w)); };
  let kwHits = kws.length ? all.filter(hit) : [];
  if (kwHits.length > 20) { const recent = kwHits.filter(i => i.key >= addDays(t, -14)); if (recent.length) kwHits = recent; }
  const days = Cal.getDays();
  const noteHits = kws.length ? Object.entries(days).filter(([, d]) => d.note && kws.some(w => norm(d.note).includes(w))).map(([k]) => k) : [];

  let items, label, scope;
  if (kws.length && !kwHits.length && noteHits.length && !r) {
    const nh = noteHits.sort();
    const html = `<p>No events match, but “${esc(kws.join(' '))}” appears in your note${nh.length > 1 ? 's' : ''}:</p><ul>${nh.slice(0, 5).map(k => `<li><strong>${esc(L.dayShort.format(parseKey(k)))}</strong>: <span class="muted">${esc(days[k].note.replace(/\s+/g, ' ').slice(0, 120))}</span></li>`).join('')}</ul>`;
    const notesText = nh.slice(0, 8).map(k => `- Note on ${EN.day.format(parseKey(k))}: ${days[k].note.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
    const now = new Date();
    const prompt = `You are the assistant inside a private calendar app. Today is ${EN.full.format(now)}.
Answer using ONLY the day notes below. Never invent anything. Be brief.

Day notes:
${notesText}`;
    return { prompt, html, sources: [] };
  }
  if (r) {
    scope = r;
    items = between(all, r.start, r.end);
    label = r.label;
    if (kwHits.length) { const f = items.filter(hit); if (f.length) items = f; }
  } else if (kwHits.length) {
    items = kwHits; label = `matching “${kws.join(' ')}”`;
  } else if (wantsImportant) {
    items = all.filter(i => i.ev.important && i.key >= t); label = 'coming up that are important';
  } else {
    scope = { start: addDays(t, -7), end: addDays(t, 30), label: 'from last week to the next 30 days' };
    items = between(all, scope.start, scope.end); label = scope.label;
  }
  if (wantsImportant && (r || kwHits.length)) items = items.filter(i => i.ev.important);

  // trim for the model's small context window: keep upcoming first
  let ctxItems = items;
  if (ctxItems.length > 50) { const up = ctxItems.filter(i => i.key >= t); ctxItems = (up.length >= 50 ? up : ctxItems.slice(-50)).slice(0, 50); }

  // day stats for a range
  let perDay = null, facts = [];
  if (scope) {
    const n = Math.round((parseKey(scope.end) - parseKey(scope.start)) / 864e5) + 1;
    if (n <= 31) {
      perDay = Array.from({ length: n }, (_, i) => { const k = addDays(scope.start, i); return { key: k, n: items.filter(x => x.key === k).length }; });
      const busiest = perDay.reduce((a, b) => (b.n > a.n ? b : a), perDay[0]);
      const free = perDay.filter(d => !d.n);
      facts.push(`Total: ${items.length} events.`);
      if (busiest.n) facts.push(`Busiest day: ${EN.full.format(parseKey(busiest.key))} (${busiest.n} events).`);
      if (n <= 14) facts.push(free.length ? `Days with nothing scheduled: ${free.map(d => EN.full.format(parseKey(d.key))).join('; ')}.` : 'Every day has at least one event.');
    }
  }
  const noteKeys = [...new Set([...(scope ? Object.keys(days).filter(k => k >= scope.start && k <= scope.end && days[k].note) : []), ...noteHits])].sort().slice(0, 8);
  const notesText = noteKeys.map(k => `- Note on ${EN.day.format(parseKey(k))}: ${days[k].note.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');

  const line = i => {
    const d = parseKey(i.key);
    const rel = i.key === t ? ' (today)' : i.key === addDays(t, 1) ? ' (tomorrow)' : i.key === addDays(t, -1) ? ' (yesterday)' : '';
    return `- ${EN.day.format(d)}${rel} · ${i.allDay ? 'all day' : Cal.fmtTime(i.ev.time)} · ${i.ev.title}${i.ev.important ? ' [important]' : ''}${i.ev.repeat ? ` [repeats ${i.ev.repeat.freq}]` : ''}${i.ev.desc ? ` — ${i.ev.desc.replace(/\s+/g, ' ').slice(0, 100)}` : ''}`;
  };
  const now = new Date();
  const prompt =
`You are the assistant inside a private calendar app. Right now it is ${EN.full.format(now)}, ${Cal.fmtTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)}.
Answer the user's question using ONLY the calendar data below. Never invent events, times or dates.
If the data doesn't contain the answer, say so plainly.
Reply with ONE or TWO short, friendly sentences (no lists — the app shows the exact event list under your reply).
Only state facts that are written in the data. Copy event names, weekdays and times exactly.

Calendar data — events ${label}:
${ctxItems.length ? ctxItems.map(line).join('\n') : '(no events)'}
${facts.length ? '\nFacts:\n' + facts.join('\n') : ''}${notesText ? '\n\nDay notes:\n' + notesText : ''}`;

  /* ---- instant answer ---- */
  const upcoming = items.filter(i => i.key > t || (i.key === t && (i.allDay || i.start >= new Date(Date.now() - 15 * 6e4))));
  const li = i => `<li><strong>${esc(i.ev.title)}</strong> <span class="muted">${esc(when(i))}</span></li>`;
  const list = arr => `<ul>${arr.slice(0, 10).map(li).join('')}</ul>${arr.length > 10 ? `<p class="muted">…and ${arr.length - 10} more.</p>` : ''}`;
  let html;
  if (wantsBusy && perDay) {
    const b = perDay.reduce((a, c) => (c.n > a.n ? c : a), perDay[0]);
    html = b.n ? `<p><strong>${esc(L.dayLong.format(parseKey(b.key)))}</strong> is the busiest ${esc(label.replace(/^in |^on /, ''))}, with ${plural(b.n, 'event')}.</p>${list(items.filter(i => i.key === b.key))}`
               : `<p>Nothing is scheduled ${esc(label)}.</p>`;
  } else if (wantsFree && perDay) {
    const free = perDay.filter(d => !d.n);
    if (perDay.length === 1) html = items.length ? `<p>Not completely — you have ${plural(items.length, 'event')} ${esc(label)}:</p>${list(items)}` : `<p>Yes, nothing is scheduled ${esc(label)}.</p>`;
    else html = free.length ? `<p>Open days ${esc(label)}: <strong>${esc(listJoin(free.map(d => L.dayShort.format(parseKey(d.key)))))}</strong>.</p>` : `<p>Every day ${esc(label)} has something scheduled.</p>`;
  } else if (/\b(am i|are we|is it) (busy|booked|free)\b/.test(s) && perDay && items.length) {
    html = `<p>${/free/.test(s) ? 'Not entirely —' : 'Yes —'} ${plural(items.length, 'event')} ${esc(label)}:</p>${list(items)}`;
  } else if (!items.length) {
    html = r ? `<p>Nothing scheduled ${esc(label)}.</p>` : kws.length ? `<p>I couldn't find any events matching “${esc(kws.join(' '))}”.</p>` : `<p>I don't see any events for that.</p>`;
    if (noteHits.length) html += `<p>It's mentioned in your note on ${esc(listJoin(noteHits.map(k => L.dayShort.format(parseKey(k)))))}.</p>`;
  } else if (wantsNext || (wantsImportant && !r)) {
    const nx = upcoming[0];
    html = nx ? `<p>${wantsImportant && !kws.length ? 'Your next important event is' : 'Next up:'} <strong>${esc(nx.ev.title)}</strong>, ${esc(when(nx, true))}.</p>${(() => { const seen = new Set([nx.ev.id]); const rest = upcoming.filter(i => !seen.has(i.ev.id) && seen.add(i.ev.id)).slice(0, 2); const yr = new Date().getFullYear(); return rest.length ? `<p class="muted">Then ${esc(listJoin(rest.map(i => `${i.ev.title} (${parseKey(i.key).getFullYear() === yr ? L.md.format(parseKey(i.key)) : L.dayShort.format(parseKey(i.key)) + ' ' + parseKey(i.key).getFullYear()})`)))}.</p>` : ''; })()}${nx.ev.repeat ? `<p class="muted">Repeats ${esc(nx.ev.repeat.freq)}.</p>` : ''}`
              : `<p>The last one was <strong>${esc(items[items.length - 1].ev.title)}</strong>, ${esc(when(items[items.length - 1], true))}. Nothing upcoming.</p>`;
  } else {
    html = `<p>${plural(items.length, 'event')} ${esc(label)}:</p>${list(items)}`;
  }
  void wantsSummary;
  return { prompt, html, sources: items.slice(0, 8), ctxItems };
}

/* ======================= on-device model ======================= */
const llm = { status: 'idle', progress: 0, text: '', engine: null, lib: null, modelId: null, busy: false, f16: false };

async function gpuInfo() {
  if (!('gpu' in navigator)) return null;
  try {
    const a = await Promise.race([navigator.gpu.requestAdapter(), new Promise(r => setTimeout(() => r(null), 4000))]);
    return a ? { f16: a.features.has('shader-f16') } : null;
  } catch { return null; }
}
async function llmCheck(force) {
  if (!force && !['idle', 'error'].includes(llm.status)) return;
  llm.status = 'checking'; updateModelCard();
  const g = await gpuInfo();
  if (!g) { llm.status = 'unsupported'; updateModelCard(); return; }
  llm.f16 = g.f16;
  llm.modelId = MODELS[S.model][g.f16 ? 'f16' : 'f32'];
  try {
    llm.lib = llm.lib || await import(WEBLLM);
    const cached = await llm.lib.hasModelInCache(llm.modelId);
    if (cached) return llmLoad();
    llm.status = 'not-downloaded';
  } catch (e) {
    llm.status = 'error'; llm.text = navigator.onLine ? 'Could not load the AI engine.' : "You're offline. Connect once to set up on-device AI.";
  }
  updateModelCard();
}
async function llmLoad() {
  llm.status = 'loading'; llm.progress = 0; llm.text = 'Starting…'; updateModelCard();
  try {
    llm.lib = llm.lib || await import(WEBLLM);
    const onProgress = r => { llm.progress = r.progress || 0; llm.text = r.text || ''; updateModelCard(); };
    try {
      llm.engine = await llm.lib.CreateWebWorkerMLCEngine(new Worker('llm-worker.js', { type: 'module' }), llm.modelId, { initProgressCallback: onProgress });
    } catch (e) {
      if (/worker/i.test(String(e && e.message))) llm.engine = await llm.lib.CreateMLCEngine(llm.modelId, { initProgressCallback: onProgress });
      else throw e;
    }
    llm.status = 'ready';
    localStorage.setItem('calendar-asst-model', llm.modelId);
  } catch (e) {
    llm.status = 'error';
    const msg = String((e && e.message) || e);
    llm.text = /memory|OOM|allocation|device lost/i.test(msg) ? 'Not enough memory on this device. Try the Small model in settings.'
      : /fetch|network|Failed to fetch/i.test(msg) ? 'Download interrupted. Check your connection and retry.' : 'Could not start the model: ' + msg.slice(0, 140);
  }
  updateModelCard();
  if ($('asstSheet').open && tab === 'week') renderAsst();
}
async function llmGenerate(messages, onText, opts = {}) {
  const stream = await llm.engine.chat.completions.create(Object.assign({ messages, stream: true, temperature: 0.1, top_p: 0.9, max_tokens: 380 }, opts));
  let out = '';
  for await (const c of stream) { out += (c.choices[0] && c.choices[0].delta && c.choices[0].delta.content) || ''; onText(out); }
  return out.trim();
}
async function llmRemove() {
  try {
    if (llm.engine) { await llm.engine.unload(); llm.engine = null; }
    llm.lib = llm.lib || await import(WEBLLM);
    for (const m of Object.values(MODELS)) for (const id of [m.f16, m.f32]) { try { await llm.lib.deleteModelAllInfoInCache(id); } catch {} }
    localStorage.removeItem('calendar-asst-model');
    llm.status = 'idle';
    Cal.toast('On-device model removed');
  } catch (e) { Cal.toast('Could not remove model'); }
  renderAsst();
}

/* Fact-check model output sentence by sentence against the calendar.
 * Drops sentences that name an event with the wrong weekday/date, call a non-important
 * event important, or name events outside the allowed set. Returns '' if nothing survives. */
const WD_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function factCheck(text, allowedItems) {
  if (!text) return '';
  const hasEvents = allowedItems.length > 0;
  const all = allItems();
  const allowedTitles = new Set(allowedItems.map(i => norm(i.ev.title)));
  const t = todayKey(), tm = addDays(t, 1);
  const sentences = text.replace(/\n+/g, ' \n ').split(/(?<=[.!?])\s+|\s\n\s/).map(s => s.trim()).filter(Boolean);
  const kept = sentences.filter(s => {
    const n = norm(s);
    const named = all.filter(i => { const ti = norm(i.ev.title); return ti.length > 2 && n.includes(ti); });
    if (named.some(i => !allowedTitles.has(norm(i.ev.title)))) return false;
    const mine = allowedItems.filter(i => named.some(x => norm(x.ev.title) === norm(i.ev.title)));
    // claims of emptiness/freedom must match the data
    if (hasEvents && /\b(not busy|you are free|you're free|nothing (is )?(scheduled|planned)|no (events|plans)|completely free)\b/.test(n)) return false;
    if (!hasEvents && /\b(you have|scheduled for|busy)\b/.test(n) && !/\bno\b|\bnothing\b|\bnot\b/.test(n)) return false;
    const nums = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const cm = n.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+events?\b/);
    if (cm && (nums[cm[1]] || +cm[1]) !== allowedItems.length) return false;
    if (!mine.length) {
      // no event named: only allow generic sentences — no stray times, weekdays, dates, or claims about importance
      if (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(n)) return false;
      if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/.test(n)) return false;
      if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(n)) return false;
      if (/\b(important|priority|critical|next)\b/.test(n)) return false;
      return true;
    }
    const wd = WD_NAMES.filter(w => new RegExp(`\\b${w}\\b`).test(n));
    // "next (important) event is X" must really be the next one
    if (/\bnext\b/.test(n)) {
      const nowMs = Date.now() - 15 * 6e4;
      const up = allowedItems.filter(i => i.key > t || (i.key === t && (i.allDay || i.start.getTime() >= nowMs)))
        .filter(i => !/\bimportant\b/.test(n) || i.ev.important).sort(byStart);
      if (up.length && !mine.some(i => norm(i.ev.title) === norm(up[0].ev.title))) return false;
    }
    if (wd.length && !mine.some(i => wd.includes(WD_NAMES[parseKey(i.key).getDay()]))) return false;
    if (/\btomorrow\b/.test(n) && !mine.some(i => i.key === tm)) return false;
    if (/\btoday\b/.test(n) && !mine.some(i => i.key === t)) return false;
    if (/\b(important|priority|critical)\b/.test(n) && !mine.some(i => i.ev.important)) return false;
    const times = [...n.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/g)].map(m => { let h = +m[1] % 12; if (m[3] === 'pm') h += 12; return `${String(h).padStart(2, '0')}:${m[2] || '00'}`; });
    if (times.length && !times.every(x => mine.some(i => i.ev.time === x))) return false;
    return true;
  });
  return kept.join(' ').trim();
}

function mdToHtml(t) {
  const lines = esc(t).split('\n');
  let html = '', inList = false;
  for (let l of lines) {
    l = l.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[.,!?])/g, '$1<em>$2</em>');
    const m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${m[1]}</li>`; }
    else { if (inList) { html += '</ul>'; inList = false; } if (l.trim()) html += `<p>${l.replace(/^#+\s*/, '')}</p>`; }
  }
  return html + (inList ? '</ul>' : '');
}

/* ======================= assistant UI ======================= */
let tab = 'week', weekOffset = 0, showSettings = false;
const chat = [];            // {role:'user'|'bot', text, html, sources, pending, ai}
const weekAI = {};          // ws -> {text, pending}

function openAssistant(t) {
  if (t) tab = t;
  showSettings = false;
  renderAsst();
  if (!$('asstSheet').open) $('asstSheet').showModal();
  if (tab === 'ask') { llmCheck(); if (!Cal.isPhone()) setTimeout(() => $('asstQ').focus(), 80); }
}

function renderAsst() {
  document.querySelectorAll('#asstSheet .tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab && !showSettings)));
  $('asstSheet').querySelector('.asst-tabs').hidden = showSettings;
  $('asstTitle').textContent = showSettings ? 'Assistant settings' : 'Assistant';
  $('asstForm').hidden = showSettings || tab !== 'ask';
  const body = $('asstBody');
  body.innerHTML = showSettings ? settingsHTML() : tab === 'week' ? weekHTML() : askHTML();
  if (!showSettings && tab === 'ask') body.scrollTop = body.scrollHeight;
}

/* ---------- week tab ---------- */
function rowHTML(i, tag, tagCls = '') {
  return `<button class="ri" data-open="${i.key}" style="--c:${Cal.colorOf(i.ev.color)}">
    <span class="dot"></span><span class="m"><b>${esc(i.ev.title)}</b><small>${esc(when(i))}</small></span>${tag ? `<span class="tag ${tagCls}">${esc(tag)}</span>` : ''}</button>`;
}
function weekHTML() {
  const w = analyzeWeek(weekOffset);
  const t = todayKey();
  const title = weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : `Week of ${L.md.format(parseKey(w.ws))}`;
  const max = Math.max(4, ...w.per.map(d => d.items.length));
  const strip = w.per.map(d => {
    const dt = parseKey(d.key);
    const bars = d.items.slice(0, 6).map(x => `<i style="--c:${Cal.colorOf(x.ev.color)}"></i>`).join('') + (d.items.length > 6 ? '<i class="more"></i>' : '');
    return `<button class="wk-day${d.key === t ? ' today' : ''}" data-open="${d.key}" aria-label="${esc(L.dayLong.format(dt))}: ${plural(d.items.length, 'event')}">
      <span class="wd">${esc(L.dowS.format(dt))}</span><span class="dn">${dt.getDate()}</span>
      <span class="wk-bars" style="--max:${max}">${bars}</span>
      <span class="cnt${d.items.length ? '' : ' zero'}">${d.items.length || '–'}</span></button>`;
  }).join('');

  const attention = [];
  for (const c of w.conflicts) attention.push(rowHTML(c.a, c.same ? `Same time as ${c.b.ev.title}` : `Close to ${c.b.ev.title}`, 'warn'));
  for (const i of w.important) if (!w.conflicts.some(c => c.a === i)) attention.push(rowHTML(i, 'Important', 'acc'));
  if (w.late.length >= 3) attention.push(`<p class="muted">${plural(w.late.length, 'evening')} booked after 7 PM, so leave room to rest.</p>`);

  const flagged = new Set([...w.conflicts.map(c => c.a), ...w.important]);
  const upcoming = w.isCurrent ? w.week.filter(i => !flagged.has(i) && (i.key > t || (i.key === t && (i.allDay || i.start > new Date())))).slice(0, 4) : [];
  const nextFirst = w.next.find(i => i.ev.important) || w.next[0];

  const ai = weekAI[w.ws];
  let aiBlock;
  if (!w.week.length) aiBlock = '';
  else if (ai && (ai.text || ai.pending)) aiBlock = `<section class="wk-ai"><div class="wk-ai-h"><span class="spark">✦</span> Summary <span class="muted">· ${ai.fallback ? 'AI draft didn’t pass the fact check, so here are the plain facts' : 'on-device AI, fact-checked'}</span></div>${ai.text ? `<div class="md">${mdToHtml(ai.text)}</div>` : '<div class="typing"><i></i><i></i><i></i></div>'}</section>`;
  else if (llm.status === 'ready') aiBlock = `<button class="btn subtle wide" data-act="week-ai"><span class="spark">✦</span> Write a summary with on-device AI</button>`;
  else if (llm.status !== 'unsupported') aiBlock = `<button class="btn subtle wide" data-act="go-ask"><span class="spark">✦</span> Turn on on-device AI for written summaries</button>`;
  else aiBlock = '';

  return `
    <div class="wk-nav">
      <button class="icon-btn" data-act="wk-prev" aria-label="Previous week"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
      <div class="wk-t"><strong>${esc(title)}</strong><span>${esc(L.md.format(parseKey(w.ws)))} – ${esc(L.md.format(parseKey(w.we)))}</span></div>
      <button class="icon-btn" data-act="wk-next" aria-label="Next week"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>
    <p class="wk-head">${esc(w.head)}</p>
    <div class="wk-strip">${strip}</div>
    ${attention.length ? `<section class="wk-sec"><h3 class="label">Needs attention</h3>${attention.join('')}</section>` : ''}
    ${upcoming.length ? `<section class="wk-sec"><h3 class="label">Still ahead this week</h3>${upcoming.map(i => rowHTML(i)).join('')}</section>` : ''}
    ${w.freeWeekdays.length && !w.isPast && w.week.length ? `<section class="wk-sec"><h3 class="label">Open weekdays</h3><div class="pills">${w.freeWeekdays.map(d => `<button class="pill" data-open="${d.key}">${esc(L.dayShort.format(parseKey(d.key)))}</button>`).join('')}</div></section>` : ''}
    ${!w.isPast ? `<section class="wk-sec"><h3 class="label">The week after</h3><p class="muted">${w.next.length ? `${plural(w.next.length, 'event')}${nextFirst ? ` · ${nextFirst.ev.important ? 'important: ' : 'first: '}<strong>${esc(nextFirst.ev.title)}</strong> on ${esc(L.dayShort.format(parseKey(nextFirst.key)))}` : ''}` : 'Nothing scheduled yet.'}</p></section>` : ''}
    ${aiBlock}`;
}
async function writeWeekSummary() {
  const w = analyzeWeek(weekOffset);
  if (llm.status !== 'ready' || llm.busy) return;
  weekAI[w.ws] = { text: '', pending: true }; renderAsst();
  // Day-by-day listing, including empty days, so a small model can't "fill in" the week.
  const dayLines = w.per.map(d => `${EN.full.format(parseKey(d.key)).split(',')[0]}: ${d.items.length ? d.items.map(i => `${i.ev.title} (${i.allDay ? 'all day' : Cal.fmtTime(i.ev.time)}${i.ev.important ? ', important' : ''})`).join('; ') : 'nothing'}`).join('\n');
  const sys = `You summarize one week of a personal calendar in exactly 2 short sentences.
Rules: mention only events that appear in the schedule below, by their exact names. Do not list every day. Do not add headings or bullet points. If an event is marked important, suggest preparing for it.`;
  const user = `Schedule:\n${dayLines}\n\nFacts:\n${weekFactsText(w)}\n\nWrite the 2-sentence summary now.`;
  const titles = new Set(w.week.map(i => norm(i.ev.title)));
  const allTitles = allItems().map(i => norm(i.ev.title)).filter(t => !titles.has(t));
  llm.busy = true;
  let out = '';
  try {
    out = await llmGenerate([{ role: 'system', content: sys }, { role: 'user', content: user }], () => {}, { max_tokens: 140, temperature: 0 });
  } catch { out = ''; }
  llm.busy = false;
  // Guardrail: reject output that mentions events from other weeks, lists days, or is too long.
  const dayDump = (out.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*:/gi) || []).length >= 3;
  const checked = dayDump ? '' : factCheck(out, w.week);
  const ok = checked.length > 20 && checked.length < 600;
  weekAI[w.ws] = { text: ok ? checked : w.head, pending: false, fallback: !ok };
  void allTitles;
  if (tab === 'week' && $('asstSheet').open) renderAsst();
}

/* ---------- ask tab ---------- */
const SUGGESTIONS = ["What's on this week?", 'When is my next important event?', 'Am I free this weekend?', 'Which day is busiest next week?', 'Add lunch with Mai tomorrow at 12:30'];
function modelCardHTML() {
  const m = MODELS[S.model];
  switch (llm.status) {
    case 'idle': case 'checking':
      return `<div class="mc compact" id="modelCard"><span class="spinner"></span>Checking on-device AI…</div>`;
    case 'unsupported':
      return `<div class="mc" id="modelCard"><h4>Quick answers</h4><p>This browser can't run on-device AI (it needs WebGPU: recent Chrome, Edge or Safari 26). You'll still get instant answers from your events.</p></div>`;
    case 'not-downloaded':
      return `<div class="mc" id="modelCard"><h4>Turn on on-device AI</h4><p>Downloads <strong>${m.name}</strong> (${m.size}) once. It runs entirely on this device, so your calendar never leaves it. Without it you still get quick answers.</p>
        <div class="mc-actions"><button class="btn primary" data-act="llm-download">Download ${m.size}</button><button class="btn subtle" data-act="settings">Model options</button></div></div>`;
    case 'loading':
      return `<div class="mc" id="modelCard"><h4>Setting up on-device AI… ${Math.round(llm.progress * 100)}%</h4><div class="progress"><i style="--p:${(llm.progress * 100).toFixed(1)}%"></i></div><p class="mc-detail">${esc(shortProgress(llm.text))}</p></div>`;
    case 'ready':
      return `<div class="mc compact ok" id="modelCard"><span class="pip"></span>On-device AI · ${esc(m.name)}</div>`;
    case 'error':
      return `<div class="mc" id="modelCard"><h4>On-device AI unavailable</h4><p>${esc(llm.text)}</p><div class="mc-actions"><button class="btn subtle" data-act="llm-retry">Try again</button><button class="btn subtle" data-act="settings">Model options</button></div></div>`;
  }
  return '';
}
function shortProgress(t) {
  if (!t) return '';
  const m = t.match(/(\d+)\s*MB/i);
  if (/Fetching|Loading model from cache/i.test(t)) return m ? `${/cache/i.test(t) ? 'Loading' : 'Downloading'} · ${m[1]} MB` : 'Downloading…';
  if (/shader|compil|GPU/i.test(t)) return 'Preparing for your GPU…';
  return t.replace(/\[.*?\]\s*/g, '').slice(0, 80);
}
function updateModelCard() {
  const el = document.getElementById('modelCard');
  if (el) el.outerHTML = modelCardHTML();
}
function msgHTML(m, i) {
  if (m.role === 'user') return `<div class="msg user">${m.voice ? '<span class="vmark" aria-label="Spoken">🎤 </span>' : ''}${esc(m.text)}</div>`;
  if (m.draft) { m.i = i; return `<div class="msg bot" data-i="${i}">${draftHTML(m)}</div>`; }
  const src = m.sources && m.sources.length && !m.pending
    ? `<div class="src">${m.sources.map(s => `<button data-open="${s.key}" style="--c:${Cal.colorOf(s.ev.color)}"><i></i>${esc(s.ev.title)} · ${esc(L.md.format(parseKey(s.key)))}</button>`).join('')}</div>` : '';
  return `<div class="msg bot" data-i="${i}">${m.pending && !m.html ? '<div class="typing"><i></i><i></i><i></i></div>' : `<div class="md">${m.html}</div>`}${src}</div>`;
}
function askHTML() {
  return `<div class="chat" id="chat">${modelCardHTML()}
    ${chat.length ? chat.map(msgHTML).join('') : `<div class="ask-empty"><p class="ask-lead">Ask anything about your events and notes.</p><div class="sugs">${SUGGESTIONS.map(s => `<button class="sug" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`}</div>`;
}
function speakHTML(html) {
  if (!window.Voice || !Voice.speakOn || Voice.lang !== 'en-US') return;
  const div = document.createElement('div'); div.innerHTML = html;
  const parts = [];
  div.querySelectorAll('p').forEach(p => { if (!p.closest('li') && !p.classList.contains('muted')) parts.push(p.textContent.trim()); });
  const lis = [...div.querySelectorAll('li')].slice(0, 3).map(li => li.textContent.replace(/\s+/g, ' ').replace(/ · /g, ', ').trim());
  if (lis.length) parts.push(lis.join('. '));
  const more = div.querySelectorAll('li').length - lis.length;
  if (more > 0) parts.push(`And ${more} more.`);
  Voice.speak(parts.join(' ').replace(/[“”]/g, '').replace(/\s*·\s*/g, ', ').replace(/\bAM\b/g, 'a.m.').replace(/\bPM\b/g, 'p.m.').replace(/\.{2,}/g, '.'));
}
function refreshMsg(i) {
  const el = $('asstBody').querySelector(`.msg.bot[data-i="${i}"]`);
  if (el) el.outerHTML = msgHTML(chat[i], i);
  const b = $('asstBody'); b.scrollTop = b.scrollHeight;
}
async function ask(q, opts = {}) {
  q = q.trim(); if (!q) return;
  if (tab !== 'ask' || showSettings) { tab = 'ask'; showSettings = false; }
  const draft = addIntent(q);
  if (draft) {
    chat.push({ role: 'user', text: q, voice: !!opts.voice });
    const m = { role: 'bot', draft, html: '' };
    chat.push(m); m.i = chat.length - 1;
    renderAsst();
    if (opts.voice && Voice.lang === 'en-US') Voice.speak(draftSpeech(draft));
    return;
  }
  const u = understand(q);
  const prevTurn = chat.length >= 2 ? chat.slice(-2) : [];
  chat.push({ role: 'user', text: q, voice: !!opts.voice });
  const useAI = llm.status === 'ready' && !llm.busy;
  const m = { role: 'bot', html: useAI ? '' : u.html, sources: u.sources, pending: useAI, ai: useAI };
  chat.push(m);
  const idx = chat.length - 1;
  renderAsst();
  if (opts.voice) speakHTML(u.html);   // read the exact answer right away; the AI line only decorates it
  if (!useAI) return;
  llm.busy = true;
  try {
    const history = prevTurn.length === 2 && prevTurn[1].raw ? [{ role: 'user', content: prevTurn[0].text }, { role: 'assistant', content: prevTurn[1].raw }] : [];
    const out = await llmGenerate([{ role: 'system', content: u.prompt }, ...history, { role: 'user', content: q }], () => {}, { max_tokens: 160 });
    const checked = factCheck(out, u.ctxItems || []);
    m.raw = checked;
    // The model's sentence is a friendly lead-in; the exact answer from the calendar always follows.
    m.html = checked && checked.length > 8
      ? `<div class="ai-line"><span class="spark">✦</span>${mdToHtml(checked)}</div><div class="facts">${u.html}</div>`
      : u.html;
  } catch { m.html = u.html; }
  llm.busy = false;
  m.pending = false;
  refreshMsg(idx);
}

/* ---------- settings ---------- */
function segHTML(name, opts, val) {
  return `<div class="seg-ctl" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${name}" data-v="${v}" aria-pressed="${String(v) === String(val)}">${esc(l)}</button>`).join('')}</div>`;
}
function settingsHTML() {
  const notifSupported = 'Notification' in window;
  const perm = notifSupported ? Notification.permission : 'unsupported';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let notifHint = '';
  if (!notifSupported) notifHint = ios && !standalone ? 'On iPhone, add Calendar to your Home Screen first (Share → Add to Home Screen), then turn this on.' : "This browser doesn't support notifications.";
  else if (perm === 'denied') notifHint = 'Notifications are blocked for this site. Allow them in your browser or system settings.';
  else notifHint = 'Alerts arrive while the app is open or was used recently. Every time you open the app, a banner also shows anything urgent.';
  const m = MODELS[S.model];
  return `
    <div class="set-group">
      <h3 class="label">Urgent alerts</h3>
      <label class="switch-row"><span>Notifications<small>${esc(notifHint)}</small></span><input type="checkbox" class="switch" data-toggle="notify" ${S.notify && perm === 'granted' ? 'checked' : ''} ${!notifSupported || perm === 'denied' ? 'disabled' : ''}></label>
      <div class="field"><span>Alert me before events</span>${segHTML('leadMin', [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours']], S.leadMin)}</div>
      <label class="switch-row"><span>Important events a day early<small>Heads-up 24 hours before anything marked Important</small></span><input type="checkbox" class="switch" data-toggle="impDayBefore" ${S.impDayBefore ? 'checked' : ''}></label>
      ${S.notify && perm === 'granted' ? '<button class="btn subtle" data-act="test-notif">Send a test notification</button>' : ''}
    </div>
    <div class="set-group">
      <h3 class="label">Voice</h3>
      <label class="switch-row"><span>Read answers aloud<small>After you ask with the 🎤, the answer is spoken (English). Recognition uses your browser's speech service; your calendar stays on this device.</small></span><input type="checkbox" class="switch" data-toggle="voiceSpeak" ${window.Voice && Voice.speakOn ? 'checked' : ''} ${window.Voice && Voice.canSpeak ? '' : 'disabled'}></label>
    </div>
    <div class="set-group">
      <h3 class="label">Weekly review</h3>
      <label class="switch-row"><span>Week-ahead digest<small>The first time you open the app each week, see a summary of the week ahead</small></span><input type="checkbox" class="switch" data-toggle="weeklyDigest" ${S.weeklyDigest ? 'checked' : ''}></label>
    </div>
    <div class="set-group">
      <h3 class="label">On-device AI model</h3>
      ${segHTML('model', Object.entries(MODELS).map(([k, v]) => [k, `${v.label} · ${v.size}`]), S.model)}
      <p class="muted">${esc(m.name)}: ${esc(m.note)}. It downloads once and runs offline, and your data stays on this device.</p>
      ${llm.status === 'ready' || localStorage.getItem('calendar-asst-model') ? '<button class="btn danger-ghost" data-act="llm-remove">Remove downloaded model</button>' : ''}
    </div>
    <button class="btn wide" data-act="settings-done">Done</button>`;
}
async function setNotify(on) {
  if (on) {
    let p = Notification.permission;
    if (p === 'default') p = await Notification.requestPermission();
    S.notify = p === 'granted';
    if (S.notify) registerPeriodicSync();
  } else S.notify = false;
  saveSettings(); renderAsst(); checkAlerts();
}
async function registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.periodicSync) return;
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state === 'granted') await reg.periodicSync.register('calendar-alerts', { minInterval: 15 * 60 * 1000 });
  } catch {}
}

/* ======================= alerts: banner + notifications ======================= */
const DKEY = 'calendar-dismissed';
function dismissed() {
  const d = safeJSON(localStorage.getItem(DKEY)), cutoff = Date.now() - 3 * 864e5;
  for (const k in d) if (d[k] < cutoff) delete d[k];
  return d;
}
function renderBanner(items) {
  const dis = dismissed();
  const list = items.filter(i => !dis[A.sig(i)]).slice(0, 3);
  const el = $('urgent');
  if (!list.length) { el.hidden = true; el.innerHTML = ''; return; }
  const now = new Date();
  el.hidden = false;
  el.innerHTML = `<span class="u-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg></span>
    <div class="u-list">${list.map(i => `<button class="u-item ${i.stage}" data-open="${i.key}"><b>${esc(i.ev.title)}</b><span>${esc(A.relText(i, now))}</span></button>`).join('')}</div>
    <button class="icon-btn u-x" aria-label="Dismiss"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  el.querySelector('.u-x').onclick = () => {
    const d = dismissed(); for (const i of list) d[A.sig(i)] = Date.now();
    localStorage.setItem(DKEY, JSON.stringify(d)); el.hidden = true;
  };
}
async function notify(title, body, tag, key) {
  const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { key } };
  try { const reg = await navigator.serviceWorker.ready; await reg.showNotification(title, opts); }
  catch { try { new Notification(title, opts); } catch {} }
}
let checking = false;
async function checkAlerts() {
  if (!Cal || checking) return;
  checking = true;
  try {
    const now = new Date();
    const items = A.urgentItems(Cal.getDays(), S, now);
    renderBanner(items);
    if (S.notify && 'Notification' in window && Notification.permission === 'granted') {
      const sent = (await Cal.db.get('notified').catch(() => null)) || {};
      let changed = false;
      for (const i of items) {
        const s = A.sig(i);
        if (sent[s]) continue;
        const n = A.notificationFor(i, now);
        await notify(n.title, n.body, s, i.key);
        sent[s] = Date.now(); changed = true;
      }
      const cutoff = Date.now() - 7 * 864e5;
      for (const k in sent) if (sent[k] < cutoff) { delete sent[k]; changed = true; }
      if (changed) await Cal.db.set('notified', sent).catch(() => {});
    }
  } finally { checking = false; }
}
async function weeklyDigest() {
  if (!S.weeklyDigest) return;
  const days = Cal.getDays();
  if (!Object.keys(days).length) return;
  const wk = A.weekStartKey(new Date());
  const last = await Cal.db.get('digestWeek').catch(() => null);
  if (last === wk) return;
  await Cal.db.set('digestWeek', wk).catch(() => {});
  if (!last) return; // first run ever: don't nag
  const d = A.weekDigest(days);
  Cal.toast(`${d.title}: ${d.body}`, 'View', () => { weekOffset = 0; openAssistant('week'); });
  if (S.notify && 'Notification' in window && Notification.permission === 'granted') notify(d.title, d.body, 'digest-' + wk, wk);
}

/* ======================= voice ======================= */
async function voiceAsk(openSheet) {
  if (!window.Voice || !Voice.supported) {
    openAssistant('ask');
    setTimeout(() => $('asstQ').focus(), 80);
    Cal.toast('Tap the 🎤 on your keyboard to dictate your question');
    return;
  }
  Voice.stopSpeaking();
  const said = await Voice.listen({ purpose: 'ask' });
  if (!said) return;
  if (openSheet || !$('asstSheet').open) openAssistant('ask');
  ask(said, { voice: true });
}
async function draftAct(kind, i) {
  const m = chat[i]; if (!m || !m.draft) return;
  const d = m.draft;
  if (kind === 'add' && !m.added) {
    const ref = await Cal.addFromDraft(d);
    m.added = { ...ref, color: localStorage.getItem('calendar-last-color') || 'persimmon' };
  } else if (kind === 'undo' && m.added) {
    await Cal.removeAdded(m.added); m.added = null; m.undone = true;
  } else if (kind === 'cancel') {
    m.undone = true;
    if (d.implicit) {   // they meant a question: answer it instead
      const q = chat[i - 1] && chat[i - 1].text;
      chat.splice(i, 1); chat.splice(i - 1, 1);
      renderAsst();
      if (q) { const u = understand(q); chat.push({ role: 'user', text: q }); chat.push({ role: 'bot', html: u.html, sources: u.sources }); renderAsst(); }
      return;
    }
  } else if (kind === 'edit') {
    $('asstSheet').close(); m.undone = true; Cal.openEditorWith(d);
  } else if (kind === 'open') {
    $('asstSheet').close(); Cal.select(d.date); return;
  }
  refreshMsg(i);
}

/* ======================= wiring ======================= */
function wire() {
  Cal.wireSheet($('asstSheet'));
  $('asstBtn').onclick = () => openAssistant();
  $('asstSettingsBtn').onclick = () => { showSettings = !showSettings; renderAsst(); };
  $('asstSheet').querySelectorAll('.tab').forEach(b => b.onclick = () => { tab = b.dataset.tab; showSettings = false; renderAsst(); if (tab === 'ask') llmCheck(); });
  $('asstForm').addEventListener('submit', e => { e.preventDefault(); const q = $('asstQ').value; $('asstQ').value = ''; ask(q); });
  $('voiceBtn').onclick = () => voiceAsk(true);
  $('asstMic').onclick = () => voiceAsk(false);

  const openDay = k => { $('asstSheet').close(); Cal.select(k); };
  $('urgent').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) Cal.select(b.dataset.open); });

  $('asstBody').addEventListener('click', e => {
    const open = e.target.closest('[data-open]'); if (open) return openDay(open.dataset.open);
    const sug = e.target.closest('[data-q]'); if (sug) return ask(sug.dataset.q);
    const set = e.target.closest('[data-set]');
    if (set) {
      const k = set.dataset.set, v = set.dataset.v;
      if (k === 'leadMin') { S.leadMin = +v; saveSettings(); checkAlerts(); }
      if (k === 'model' && S.model !== v) {
        S.model = v; saveSettings();
        if (llm.engine) { llm.engine.unload().catch(() => {}); llm.engine = null; }
        llm.status = 'idle';
      }
      return renderAsst();
    }
    const act = e.target.closest('[data-act]'); if (!act) return;
    ({
      'wk-prev': () => { weekOffset--; renderAsst(); },
      'wk-next': () => { weekOffset++; renderAsst(); },
      'week-ai': writeWeekSummary,
      'go-ask': () => { tab = 'ask'; renderAsst(); llmCheck(); },
      'llm-download': llmLoad,
      'llm-retry': () => llmCheck(true),
      'llm-remove': llmRemove,
      settings: () => { showSettings = true; renderAsst(); },
      'settings-done': () => { showSettings = false; renderAsst(); if (tab === 'ask') llmCheck(); },
      'test-notif': () => notify('Test notification', 'Alerts are working.', 'test', todayKey()),
      'draft-add': () => draftAct('add', +act.dataset.i),
      'draft-edit': () => draftAct('edit', +act.dataset.i),
      'draft-cancel': () => draftAct('cancel', +act.dataset.i),
      'draft-undo': () => draftAct('undo', +act.dataset.i),
      'draft-open': () => draftAct('open', +act.dataset.i),
    })[act.dataset.act]();
  });
  $('asstBody').addEventListener('change', e => {
    const t = e.target.closest('[data-toggle]'); if (!t) return;
    const k = t.dataset.toggle;
    if (k === 'notify') return setNotify(t.checked);
    if (k === 'voiceSpeak') { Voice.speakOn = t.checked; return; }
    S[k] = t.checked; saveSettings(); checkAlerts();
  });

  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); openAssistant(); }
    if (e.key === '/') { e.preventDefault(); openAssistant('ask'); }
    if (e.key === 'v' || e.key === 'V') { e.preventDefault(); voiceAsk(true); }
  });

  document.addEventListener('cal:change', () => { checkAlerts(); if ($('asstSheet').open && tab === 'week' && !showSettings) renderAsst(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { checkAlerts(); weeklyDigest(); } });
  setInterval(checkAlerts, 30 * 1000);
}

function init() {
  Cal = window.Cal;
  wire();
  Cal.db.set('asstSettings', S).catch(() => {});
  checkAlerts();
  setTimeout(weeklyDigest, 1200);
  if (S.notify) registerPeriodicSync();
  // warm up the model in the background if the user already downloaded it
  if (localStorage.getItem('calendar-asst-model')) setTimeout(() => llmCheck(), 2500);
  window.CalAssistant = { understand, analyzeWeek, parseRange: q => parseRange(norm(q)), open: openAssistant, ask, llm, addIntent, voiceAsk };
}
if (window.Cal && window.Cal.ready) init(); else document.addEventListener('cal:ready', init, { once: true });
})();
