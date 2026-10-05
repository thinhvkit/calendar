/* Calendar — events + daily notes, offline-first PWA.
 *
 * Data ownership
 *  - Everything is stored on the user's device (IndexedDB, with persistent-storage
 *    requested so the browser doesn't evict it). Nothing is sent to any server.
 *  - Back up: exports a JSON file. On phones this opens the share sheet
 *    (save to Files / iCloud / Drive); on desktop it downloads.
 *  - Restore: loads a backup file (replaces current data, with undo).
 *  - Desktop Chrome/Edge: optionally link a file on disk that is rewritten
 *    automatically after every change.
 */
(() => {
'use strict';

/* ---------------- constants ---------------- */
const COLORS = [
  { id: 'persimmon', name: 'Persimmon', v: '#d9572e' },
  { id: 'ochre',     name: 'Ochre',     v: '#c9921b' },
  { id: 'sage',      name: 'Sage',      v: '#4d9466' },
  { id: 'teal',      name: 'Teal',      v: '#2a8f95' },
  { id: 'ocean',     name: 'Ocean',     v: '#3d6fd1' },
  { id: 'plum',      name: 'Plum',      v: '#9354b8' },
  { id: 'slate',     name: 'Slate',     v: '#6c7480' },
];
const colorOf = id => (COLORS.find(c => c.id === id || c.v === id) || COLORS[0]).v;
const BACKUP_NUDGE_DAYS = 7;
const CAN_LINK_FILE = 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
const FILE_TYPES = [{ description: 'Calendar backup', accept: { 'application/json': ['.json'] } }];
const $ = id => document.getElementById(id);

/* ---------------- state ---------------- */
let days = {};                 // { 'YYYY-MM-DD': { note, events:[{id,title,time,desc,color,important,repeat?}], photos:[{id,…}] } }
let meta = { lastBackup: null, lastChange: null };
let linkedHandle = null;       // FileSystemFileHandle when a file is linked (desktop Chrome)
let linkedState = 'none';      // none | ok | needs-permission | error
let view = startOfMonth(new Date());
let selected = keyOf(new Date());
let editing = null;            // { key (occurrence day), origin (stored day), id } or null for new
const X = self.CalAlerts;      // shared logic: repeat expansion, alerts

/* ---------------- tiny IndexedDB wrapper ---------------- */
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('calendar-pwa', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode);
      const out = fn(t.objectStore('kv'));
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)),
    del: k => tx('readwrite', s => s.delete(k)),
    keys: () => tx('readonly', s => s.getAllKeys()),
  };
})();

let useLocalStorageFallback = false;
async function persist() {
  clean();
  meta.lastChange = new Date().toISOString();
  try {
    if (useLocalStorageFallback) throw 0;
    await db.set('days', days);
    await db.set('meta', meta);
  } catch {
    useLocalStorageFallback = true;
    localStorage.setItem('calendar-pwa', JSON.stringify({ days, meta }));
  }
  broadcast();
  scheduleLinkedWrite();
  renderBadge();
  document.dispatchEvent(new Event('cal:change'));
}

async function loadAll() {
  try {
    days = (await db.get('days')) || {};
    meta = Object.assign(meta, (await db.get('meta')) || {});
    linkedHandle = CAN_LINK_FILE ? (await db.get('linkedHandle')) || null : null;
  } catch {
    useLocalStorageFallback = true;
    try { const s = JSON.parse(localStorage.getItem('calendar-pwa')); if (s) { days = s.days || {}; meta = Object.assign(meta, s.meta); } } catch {}
  }
  // migrate earlier versions of this app (localStorage)
  if (!Object.keys(days).length) {
    for (const k of ['simple-calendar-cache-v2', 'simple-calendar-v1']) {
      try {
        const raw = JSON.parse(localStorage.getItem(k));
        const d = raw && (raw.days || raw);
        if (d && typeof d === 'object' && Object.keys(d).length) { days = normalize(d); await persist(); break; }
      } catch {}
    }
  }
  days = normalize(days);
}

function normalize(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v) continue;
    out[k] = {
      note: typeof v.note === 'string' ? v.note : '',
      events: Array.isArray(v.events) ? v.events.filter(e => e && e.title).map(e => {
        const ev = { id: String(e.id || uid()), title: String(e.title), time: e.time || '', desc: e.desc || '', color: e.color || COLORS[0].id, important: !!e.important };
        if (e.main) ev.main = true;
        if (e.repeat && X.FREQS.includes(e.repeat.freq)) {
          ev.repeat = { freq: e.repeat.freq, until: /^\d{4}-\d{2}-\d{2}$/.test(e.repeat.until || '') ? e.repeat.until : '', except: Array.isArray(e.repeat.except) ? e.repeat.except.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)) : [] };
        }
        return ev;
      }) : [],
      photos: Array.isArray(v.photos) ? v.photos.filter(ph => ph && ph.id).map(ph => ({
        id: String(ph.id), type: ph.type || 'image/jpeg', size: +ph.size || 0, w: +ph.w || 0, h: +ph.h || 0, taken: ph.taken || '', added: ph.added || '', name: ph.name || '',
      })) : [],
    };
  }
  return out;
}
function clean() {
  for (const k in days) {
    const d = days[k];
    if (d.photos && !d.photos.length) delete d.photos;
    if (!d.note && !d.events.length && !(d.photos && d.photos.length)) delete days[k];
  }
}

/* Ask the browser to keep our storage even under pressure (esp. iOS/Safari). */
async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

/* Cross-tab sync */
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('calendar-pwa') : null;
function broadcast() { channel && channel.postMessage('changed'); }
if (channel) channel.onmessage = async () => { await loadAll(); renderAll(); document.dispatchEvent(new Event('cal:change')); };

/* ---------------- dates ---------------- */
function keyOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); }
const fmt = {
  month: new Intl.DateTimeFormat(undefined, { month: 'long' }),
  dow: new Intl.DateTimeFormat(undefined, { weekday: 'long' }),
  dowShort: new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
  date: new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }),
  dateYear: new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }),
  full: new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
};
const uses12h = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 !== false;
function fmtTime(t, short) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (!uses12h) return t;
  const ap = h < 12 ? 'am' : 'pm', hh = ((h + 11) % 12) + 1;
  if (short) return m ? `${hh}:${String(m).padStart(2, '0')}${ap[0]}` : `${hh}${ap[0]}`;
  return `${hh}:${String(m).padStart(2, '0')} ${ap.toUpperCase()}`;
}
function relDay(k) {
  const diff = Math.round((parseKey(k) - parseKey(keyOf(new Date()))) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return '';
}
function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : fmt.dateYear.format(new Date(iso));
}

/* ---------------- helpers ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayOf = k => days[k] || (days[k] = { note: '', events: [] });
const peek = k => days[k] || { note: '', events: [] };
const sorted = evs => [...evs].sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title));
const isPhone = () => matchMedia('(max-width: 760px)').matches;
const counts = () => {
  let e = 0, n = 0, p = 0, bytes = 0;
  for (const d of Object.values(days)) {
    e += d.events.length; if (d.note) n++;
    if (d.photos) { p += d.photos.length; for (const ph of d.photos) bytes += ph.size || 0; }
  }
  return { events: e, notes: n, photos: p, bytes };
};
const anyData = () => { const c = counts(); return c.events + c.notes + c.photos > 0; };
const fmtBytes = b => b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;

/* Occurrences of all events (repeating series expanded) for a range, grouped by day. */
function occByDay(start, end) {
  const map = {};
  for (const o of X.expand(days, start, end)) (map[o.key] = map[o.key] || []).push(o);
  for (const k in map) map[k].sort((a, b) => (a.ev.time || '').localeCompare(b.ev.time || '') || a.ev.title.localeCompare(b.ev.title));
  return map;
}
/* The day's "main" event colors the whole day. Explicit pick wins; important ones break ties. */
function mainOf(evs) {
  const m = evs.filter(e => e.main);
  return m.find(e => e.important) || m[0] || null;
}
const findEvent = (origin, id) => (days[origin] && days[origin].events.find(e => e.id === id)) || null;
const ORD = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
function repeatText(freq, dateKey, until) {
  if (!freq) return '';
  const d = parseKey(dateKey);
  let t = freq === 'daily' ? 'Every day'
    : freq === 'weekly' ? `Every ${fmt.dow.format(d)}`
    : freq === 'monthly' ? `Every month on the ${ORD(d.getDate())}${d.getDate() > 28 ? ' (skips shorter months)' : ''}`
    : `Every year on ${fmt.date.format(d)}${d.getMonth() === 1 && d.getDate() === 29 ? ' (leap years)' : ''}`;
  if (until) t += `, until ${fmt.dateYear.format(parseKey(until))}`;
  return t;
}
const REPEAT_ICON = '<svg class="rep-ic" viewBox="0 0 24 24" aria-label="Repeats"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>';

/* ---------------- render: header + month ---------------- */
function renderWeekdays() {
  const base = new Date(2024, 0, 1); // a Monday
  $('weekdays').innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base); d.setDate(1 + i);
    const label = isPhone() ? fmt.dowShort.format(d).slice(0, 1) : fmt.dowShort.format(d);
    return `<span class="${i >= 5 ? 'we' : ''}">${esc(label)}</span>`;
  }).join('');
}

function renderMonth() {
  $('mMonth').textContent = fmt.month.format(view);
  $('mYear').textContent = view.getFullYear();
  $('mYear').classList.toggle('this-year', view.getFullYear() === new Date().getFullYear());
  document.title = `${fmt.month.format(view)} ${view.getFullYear()} · Calendar`;

  const offset = (view.getDay() + 6) % 7;
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const rows = Math.ceil((offset + daysInMonth) / 7);
  const grid = $('grid');
  grid.style.setProperty('--rows', rows);
  const start = new Date(view); start.setDate(1 - offset);
  const today = keyOf(new Date());
  const maxChips = rows > 5 ? 2 : 3;
  const end = new Date(start); end.setDate(start.getDate() + rows * 7 - 1);
  const occ = occByDay(keyOf(start), keyOf(end));

  let html = '';
  for (let i = 0; i < rows * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = keyOf(d), info = peek(k), evs = (occ[k] || []).map(o => o.ev);
    const nPhotos = (info.photos || []).length;
    const cls = ['cell'];
    if (d.getMonth() !== view.getMonth()) cls.push('out');
    if (i % 7 >= 5) cls.push('we');
    if (k === today) cls.push('today');
    if (k === selected) cls.push('selected');
    const main = mainOf(evs);
    if (main) cls.push('filled');

    const shown = evs.length > maxChips + 1 ? evs.slice(0, maxChips) : evs.slice(0, maxChips + 1);
    const chips = shown.map(e => e.time
      ? `<span class="chip timed${e.important ? ' imp' : ''}" style="--c:${colorOf(e.color)}"><span class="t">${esc(fmtTime(e.time, true))}</span><span class="x">${esc(e.title)}</span></span>`
      : `<span class="chip allday${e.important ? ' imp' : ''}" style="--c:${colorOf(e.color)}"><span class="x">${esc(e.title)}</span></span>`).join('');
    const more = evs.length > shown.length ? `<span class="more">+${evs.length - shown.length} more</span>` : '';
    const dots = evs.slice(0, 3).map(e => `<i style="--c:${colorOf(e.color)}"></i>`).join('') + ((info.note || nPhotos) && evs.length < 3 ? '<i class="note"></i>' : '');
    const label = `${fmt.full.format(d)}${evs.length ? `, ${evs.length} event${evs.length > 1 ? 's' : ''}` : ''}${info.note ? ', has note' : ''}${nPhotos ? `, ${nPhotos} photo${nPhotos > 1 ? 's' : ''}` : ''}`;
    const marks = (nPhotos ? `<span class="photo-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.8-4.8a1.5 1.5 0 0 0-2.1 0L5 19"/></svg>${nPhotos > 1 ? nPhotos : ''}</span>` : '') +
      (info.note ? '<span class="note-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>' : '');

    html += `<button class="${cls.join(' ')}"${main ? ` style="--day:${colorOf(main.color)}"` : ''} data-k="${k}" aria-label="${esc(main ? `${label}, main event ${main.title}` : label)}" ${k === selected ? 'aria-current="date"' : ''} tabindex="${k === selected ? 0 : -1}">
      <span class="head"><span class="n">${d.getDate()}</span>${marks ? `<span class="marks">${marks}</span>` : ''}</span>
      <span class="chips">${chips}${more}</span>
      <span class="dots" aria-hidden="true">${dots}</span>
    </button>`;
  }
  grid.innerHTML = html;
}

/* ---------------- render: day panel ---------------- */
function renderDay() {
  const d = parseKey(selected), info = peek(selected);
  $('dDow').textContent = fmt.dow.format(d);
  $('dRel').textContent = relDay(selected);
  $('dDate').textContent = d.getFullYear() === new Date().getFullYear() ? fmt.date.format(d) : fmt.dateYear.format(d);

  const occ = occByDay(selected, selected)[selected] || [];
  const main = mainOf(occ.map(o => o.ev));
  const panel = document.querySelector('.day');
  panel.classList.toggle('filled', !!main);
  if (main) panel.style.setProperty('--day', colorOf(main.color)); else panel.style.removeProperty('--day');
  $('events').innerHTML = occ.length
    ? occ.map(({ ev: e, origin }) => `<li><button class="ev" data-id="${esc(e.id)}" data-origin="${origin}" style="--c:${colorOf(e.color)}">
        <span class="ev-time">${e.time ? esc(fmtTime(e.time)) : 'All day'}</span>
        <span class="ev-main"><span class="ev-dot"></span><span><span class="ev-title">${esc(e.title)}</span>${e.important ? '<span class="imp-tag">Important</span>' : ''}${e === main ? '<span class="day-tag">Day color</span>' : ''}${e.repeat ? `<span class="ev-rep">${REPEAT_ICON}${esc(repeatText(e.repeat.freq, origin, e.repeat.until))}</span>` : ''}${e.desc ? `<span class="ev-desc">${esc(e.desc)}</span>` : ''}</span></span>
      </button></li>`).join('')
    : `<li class="empty">Nothing scheduled. <button type="button" data-add>Add an event</button></li>`;
  renderPhotos();

  const note = $('note');
  if (document.activeElement !== note) note.value = info.note;
  $('noteStatus').textContent = '';
}

function renderBadge() {
  const hasData = anyData();
  const stale = !meta.lastBackup || (meta.lastChange && meta.lastChange > meta.lastBackup &&
    (Date.now() - new Date(meta.lastBackup)) / 864e5 > BACKUP_NUDGE_DAYS);
  const linkedOk = linkedHandle && linkedState === 'ok';
  $('dataBadge').hidden = !(hasData && stale && !linkedOk) && linkedState !== 'error';
}

function renderAll() { renderWeekdays(); renderMonth(); renderDay(); renderBadge(); }

/* ---------------- selection & navigation ---------------- */
function select(k, { focus = false } = {}) {
  selected = k;
  const d = parseKey(k);
  if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) view = startOfMonth(d);
  renderMonth(); renderDay();
  if (focus) { const el = $('grid').querySelector(`[data-k="${k}"]`); el && el.focus({ preventScroll: true }); }
}
function shiftMonth(n) {
  const d = parseKey(selected);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  select(keyOf(target));
}

/* ---------------- event editor ---------------- */
let repFreq = '';
function setRepeat(freq) {
  repFreq = freq || '';
  $('repeatCtl').querySelectorAll('[data-rep]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rep === repFreq)));
  $('repeatMore').hidden = !repFreq;
  syncRepeatSummary();
}
function syncRepeatSummary() {
  const date = $('evDate').value || selected;
  $('repeatSum').textContent = repeatText(repFreq, date, '');
  $('evUntil').min = date;
  $('clearUntil').hidden = !$('evUntil').value;
}
function openEditor(id = null, origin = null) {
  const form = $('eventForm');
  form.reset();
  const ev = id ? findEvent(origin || selected, id) : null;
  editing = ev ? { key: selected, origin: origin || selected, id } : null;
  $('evSheetTitle').textContent = ev ? (ev.repeat ? 'Edit repeating event' : 'Edit event') : 'New event';
  $('evDelete').hidden = !ev;
  $('evTitle').value = ev ? ev.title : '';
  $('evDate').value = selected;
  $('evTime').value = ev ? ev.time : '';
  $('evAllDay').checked = ev ? !ev.time : false;
  $('evImportant').checked = ev ? !!ev.important : false;
  $('evMain').checked = ev ? !!ev.main : false;
  $('evDesc').value = ev ? ev.desc : '';
  const color = ev ? ev.color : (localStorage.getItem('calendar-last-color') || COLORS[0].id);
  const radio = form.querySelector(`input[name="color"][value="${COLORS.some(c => c.id === color) ? color : COLORS[0].id}"]`);
  if (radio) radio.checked = true;
  $('evUntil').value = ev && ev.repeat ? ev.repeat.until || '' : '';
  setRepeat(ev && ev.repeat ? ev.repeat.freq : '');
  $('mainRow').style.setProperty('--day', colorOf(radio ? radio.value : COLORS[0].id));
  syncAllDay();
  $('eventSheet').showModal();
  if (!isPhone() || !ev) setTimeout(() => $('evTitle').focus(), 60);
}
function syncAllDay() {
  const on = $('evAllDay').checked;
  $('evTime').disabled = on;
  $('evTimeField').classList.toggle('is-disabled', on);
}
/* Which occurrences does an edit/delete of a repeating event apply to? */
function askScope(verb, ev, occKey) {
  return new Promise(res => {
    const dlg = $('scopeSheet');
    $('scopeTitle').textContent = verb === 'delete' ? 'Delete repeating event' : 'Save repeating event';
    $('scopeText').textContent = `“${ev.title}” ${repeatText(ev.repeat.freq, occKey, '').replace(/^Every/, 'repeats every').replace(/ \(.*\)$/, '')}. ${verb === 'delete' ? 'Delete' : 'Apply changes to'}:`;
    dlg.querySelector('[value="future"]').hidden = false;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => res(['one', 'future', 'all'].includes(dlg.returnValue) ? dlg.returnValue : null), { once: true });
    dlg.showModal();
  });
}
const snapshot = () => JSON.parse(JSON.stringify(days));
function removeFromDay(k, id) {
  const d = days[k]; if (!d) return null;
  const i = d.events.findIndex(x => x.id === id);
  return i > -1 ? d.events.splice(i, 1)[0] : null;
}

async function saveEditor(e) {
  e.preventDefault();
  const title = $('evTitle').value.trim();
  if (!title) { $('evTitle').focus(); return; }
  const date = $('evDate').value || selected;
  const until = repFreq && $('evUntil').value ? $('evUntil').value : '';
  if (until && until < date) { toast('The end date must be after the start date'); $('evUntil').focus(); return; }
  const color = ($('eventForm').querySelector('input[name="color"]:checked') || {}).value || COLORS[0].id;
  localStorage.setItem('calendar-last-color', color);
  const data = { title, time: $('evAllDay').checked ? '' : $('evTime').value, desc: $('evDesc').value.trim(), color, important: $('evImportant').checked };
  if ($('evMain').checked) data.main = true;
  const newRepeat = repFreq ? { freq: repFreq, until, except: [] } : null;
  const withRepeat = (obj, rep) => { const o = { ...obj }; if (rep) o.repeat = rep; else delete o.repeat; if (!data.main) delete o.main; return o; };
  // one main event per day: picking this one un-picks other one-off events on that day
  if (data.main) for (const other of dayOf(date).events) if (!other.repeat && (!editing || other.id !== editing.id)) delete other.main;

  let msg = 'Event added';
  const before = snapshot();
  if (!editing) {
    dayOf(date).events.push(withRepeat({ id: uid(), ...data }, newRepeat));
    if (newRepeat) msg = 'Repeating event added';
  } else {
    const { key: occKey, origin, id } = editing;
    const ev = findEvent(origin, id);
    if (!ev) { $('eventSheet').close(); return; }
    if (!ev.repeat) {
      removeFromDay(origin, id);
      dayOf(date).events.push(withRepeat({ ...ev, ...data }, newRepeat));
      msg = 'Event updated';
    } else {
      const scope = await askScope('save', ev, occKey);
      if (!scope) return;                                    // keep the editor open
      if (scope === 'all' || (scope === 'future' && occKey === origin)) {
        // shift the whole series by however far this occurrence moved
        const newOrigin = addDays(origin, X.dayDiff(occKey, date));
        removeFromDay(origin, id);
        const rep = newRepeat ? { ...newRepeat, except: (ev.repeat.except || []).map(x => addDays(x, X.dayDiff(occKey, date))) } : null;
        dayOf(newOrigin).events.push(withRepeat({ ...ev, ...data }, rep));
        msg = 'All events updated';
      } else if (scope === 'one') {
        ev.repeat.except = [...new Set([...(ev.repeat.except || []), occKey])];
        dayOf(date).events.push(withRepeat({ id: uid(), ...data }, null));
        msg = 'This event updated';
      } else { // future
        ev.repeat.until = addDays(occKey, -1);
        ev.repeat.except = (ev.repeat.except || []).filter(x => x < occKey);
        dayOf(date).events.push(withRepeat({ id: uid(), ...data }, newRepeat || null));
        msg = 'This and following events updated';
      }
    }
  }
  $('eventSheet').close();
  await persist();
  select(date);
  toast(msg, editing ? 'Undo' : undefined, editing ? async () => { days = before; await persist(); renderMonth(); renderDay(); } : undefined);
}

async function deleteEvent(occKey, origin, id) {
  const ev = findEvent(origin, id);
  if (!ev) return;
  const before = snapshot();
  let msg = `Deleted “${ev.title}”`;
  if (ev.repeat) {
    const scope = await askScope('delete', ev, occKey);
    if (!scope) return;
    if (scope === 'all' || (scope === 'future' && occKey === origin)) { removeFromDay(origin, id); msg = `Deleted all “${ev.title}” events`; }
    else if (scope === 'one') ev.repeat.except = [...new Set([...(ev.repeat.except || []), occKey])];
    else { ev.repeat.until = addDays(occKey, -1); msg = `Deleted “${ev.title}” from ${fmt.date.format(parseKey(occKey))} on`; }
  } else removeFromDay(origin, id);
  await persist(); renderMonth(); renderDay();
  toast(msg, 'Undo', async () => { days = before; await persist(); renderMonth(); renderDay(); });
}

/* ---------------- note autosave ---------------- */
let noteTimer;
function onNoteInput() {
  clearTimeout(noteTimer);
  const k = selected, v = $('note').value;
  $('noteStatus').textContent = 'Editing…';
  noteTimer = setTimeout(async () => {
    dayOf(k).note = v.trimEnd() ? v : '';
    await persist();
    renderMonth();
    if (k === selected) {
      $('noteStatus').textContent = 'Saved';
      setTimeout(() => { if ($('noteStatus').textContent === 'Saved') $('noteStatus').textContent = ''; }, 1500);
    }
  }, 450);
}
function flushNote() {
  if (!noteTimer) return;
  clearTimeout(noteTimer); noteTimer = null;
  const v = $('note').value;
  if (peek(selected).note !== v) { dayOf(selected).note = v.trimEnd() ? v : ''; persist(); }
}

/* ---------------- photos ----------------
 * Web apps can't keep a link to a file in the phone's photo library (browsers never expose
 * gallery paths), so each photo is copied into the app's private storage (IndexedDB) and
 * attached to a day. "Save to Photos" exports it back to the library via the share sheet.
 *   kv 'p:<id>' → original Blob     kv 't:<id>' → ~480px JPEG thumbnail (made lazily) */
const MAX_PHOTO_BYTES = 12e6, MAX_PHOTO_SIDE = 4096;
const thumbURLs = new Map();
const photoDB = {
  full: id => db.get('p:' + id),
  put: (id, blob) => db.set('p:' + id, blob),
  thumb: async id => {
    let t = await db.get('t:' + id).catch(() => null);
    if (t) return t;
    const full = await db.get('p:' + id).catch(() => null);
    if (!full) return null;
    t = await resizeImage(full, 480, 0.78).catch(() => null);
    if (t) await db.set('t:' + id, t.blob).catch(() => {});
    return t ? t.blob : null;
  },
};
async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch {
    return await new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(u); res(img); };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Unsupported image')); };
      img.src = u;
    });
  }
}
async function resizeImage(blob, maxSide, quality) {
  const img = await decode(blob);
  const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  if (img.close) img.close();
  const out = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  return { blob: out, w, h, w0, h0 };
}
/* EXIF DateTimeOriginal from a JPEG (first 256 KB) → 'YYYY-MM-DDTHH:MM' or '' */
async function exifTaken(file) {
  try {
    const buf = new DataView(await file.slice(0, 262144).arrayBuffer());
    if (buf.getUint16(0) !== 0xFFD8) return '';
    let o = 2;
    while (o + 4 < buf.byteLength) {
      const marker = buf.getUint16(o), len = buf.getUint16(o + 2);
      if (marker === 0xFFE1 && buf.getUint32(o + 4) === 0x45786966) {
        const t = o + 10, le = buf.getUint16(t) === 0x4949;
        const u16 = p => buf.getUint16(p, le), u32 = p => buf.getUint32(p, le);
        const ifd = (start, tag) => { const n = u16(start); for (let i = 0; i < n; i++) { const e = start + 2 + i * 12; if (u16(e) === tag) return e; } return 0; };
        const ptr = ifd(t + u32(t + 4), 0x8769); if (!ptr) return '';
        const ent = ifd(t + u32(ptr + 8), 0x9003) || ifd(t + u32(ptr + 8), 0x9004); if (!ent) return '';
        const at = t + u32(ent + 8);
        let s = ''; for (let i = 0; i < 19; i++) s += String.fromCharCode(buf.getUint8(at + i));
        const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/);
        return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : '';
      }
      if ((marker & 0xFF00) !== 0xFF00) break;
      o += 2 + len;
    }
  } catch {}
  return '';
}

async function addPhotos(files, source) {
  files = [...files].filter(f => f && (/^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(f.name)));
  if (!files.length) return;
  const dayKey = selected;
  const added = [];
  const otherDays = new Set();
  toast(files.length > 1 ? `Adding ${files.length} photos…` : 'Adding photo…');
  for (const f of files) {
    const id = uid();
    let blob = f, w = 0, h = 0;
    try {
      const big = f.size > MAX_PHOTO_BYTES;
      const r = await resizeImage(f, big ? MAX_PHOTO_SIDE : 480, big ? 0.88 : 0.78);
      w = r.w0; h = r.h0;
      if (big) { blob = r.blob; w = r.w; h = r.h; }
      else await db.set('t:' + id, r.blob);
    } catch { /* undecodable here (e.g. HEIC on desktop Chrome): keep the original, show a placeholder */ }
    const taken = await exifTaken(f);
    await photoDB.put(id, blob);
    const meta = { id, type: blob.type || f.type || 'image/jpeg', size: blob.size, w, h, taken, added: new Date().toISOString(), name: f.name || '' };
    added.push(meta);
    if (source === 'library' && taken && taken.slice(0, 10) !== dayKey) otherDays.add(taken.slice(0, 10));
  }
  const d = dayOf(dayKey);
  d.photos = [...(d.photos || []), ...added];
  await persist();
  renderMonth(); renderDay();
  const label = `${added.length} photo${added.length > 1 ? 's' : ''} added to ${relDay(dayKey) || fmt.date.format(parseKey(dayKey))}`;
  if (otherDays.size === 1 && added.length === 1) {
    const k = [...otherDays][0];
    toast(`Taken on ${fmt.date.format(parseKey(k))}`, 'Move there', () => movePhotos(dayKey, added.map(p => p.id), k));
  } else if (otherDays.size && added.length > 1) {
    toast(label + ' · some were taken on other days', 'Sort by date', () => sortPhotosByTaken(dayKey, added.map(p => p.id)));
  } else toast(label);
}
async function movePhotos(fromKey, ids, toKey) {
  const from = dayOf(fromKey), moving = (from.photos || []).filter(p => ids.includes(p.id));
  from.photos = (from.photos || []).filter(p => !ids.includes(p.id));
  const to = dayOf(toKey); to.photos = [...(to.photos || []), ...moving];
  await persist(); select(toKey);
  toast(`Moved to ${fmt.date.format(parseKey(toKey))}`);
}
async function sortPhotosByTaken(fromKey, ids) {
  const from = dayOf(fromKey);
  const keep = [], moved = {};
  for (const p of from.photos || []) {
    const k = ids.includes(p.id) && p.taken ? p.taken.slice(0, 10) : fromKey;
    if (k === fromKey) keep.push(p); else (moved[k] = moved[k] || []).push(p);
  }
  from.photos = keep;
  for (const k in moved) { const d = dayOf(k); d.photos = [...(d.photos || []), ...moved[k]]; }
  await persist(); renderMonth(); renderDay();
  toast(`Moved to ${Object.keys(moved).length} day${Object.keys(moved).length > 1 ? 's' : ''}, by date taken`);
}

async function thumbURL(id) {
  if (thumbURLs.has(id)) return thumbURLs.get(id);
  const b = await photoDB.thumb(id);
  const u = b ? URL.createObjectURL(b) : '';
  thumbURLs.set(id, u);
  return u;
}
function renderPhotos() {
  const list = peek(selected).photos || [];
  $('photoCount').textContent = list.length ? String(list.length) : '';
  const box = $('photos');
  box.classList.toggle('empty', !list.length);
  box.innerHTML = list.length
    ? list.map((p, i) => `<button class="ph" data-i="${i}" aria-label="Photo ${i + 1} of ${list.length}"><img alt="" data-id="${esc(p.id)}" decoding="async"></button>`).join('')
    : '<p class="ph-empty">Snap a photo or pick from your library to keep it with this day.</p>';
  const key = selected;
  box.querySelectorAll('img[data-id]').forEach(async img => {
    const u = await thumbURL(img.dataset.id);
    if (key !== selected) return;
    if (u) { img.src = u; img.onload = () => img.classList.add('in'); }
    else img.parentElement.classList.add('ph-na');
  });
}

/* Viewer */
let vList = [], vIdx = 0, vURL = '';
async function openViewer(i) {
  vList = peek(selected).photos || []; vIdx = i;
  $('viewer').showModal();
  document.documentElement.classList.add('viewer-open');
  await showViewerPhoto();
}
async function showViewerPhoto() {
  const p = vList[vIdx]; if (!p) { $('viewer').close(); return; }
  $('vCount').textContent = vList.length > 1 ? `${vIdx + 1} / ${vList.length}` : '';
  $('vDate').textContent = p.taken ? `${fmt.dateYear.format(parseKey(p.taken.slice(0, 10)))}` : fmt.dateYear.format(parseKey(selected));
  const t = p.taken ? fmtTime(p.taken.slice(11, 16)) : '';
  $('vInfo').textContent = [t, p.w ? `${p.w}×${p.h}` : '', p.size ? fmtBytes(p.size) : ''].filter(Boolean).join(' · ');
  $('vPrev').hidden = vIdx === 0; $('vNext').hidden = vIdx >= vList.length - 1;
  const img = $('vImg');
  img.classList.remove('in');
  const thumb = await thumbURL(p.id);
  if (thumb) img.src = thumb;
  const full = await photoDB.full(p.id).catch(() => null);
  if (vList[vIdx] !== p) return;
  if (vURL) URL.revokeObjectURL(vURL);
  vURL = full ? URL.createObjectURL(full) : '';
  if (vURL) { const pre = new Image(); pre.onload = () => { if (vList[vIdx] === p) { img.src = vURL; img.classList.add('in'); } }; pre.onerror = () => img.classList.add('in'); pre.src = vURL; }
  img.classList.add('in');
}
function closeViewer() {
  document.documentElement.classList.remove('viewer-open');
  if (vURL) { URL.revokeObjectURL(vURL); vURL = ''; }
  $('vImg').removeAttribute('src');
}
async function savePhoto() {
  const p = vList[vIdx]; if (!p) return;
  const blob = await photoDB.full(p.id).catch(() => null); if (!blob) return;
  const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const file = new File([blob], p.name || `calendar-${selected}-${vIdx + 1}.${ext}`, { type: blob.type || 'image/jpeg' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && (isPhone() || 'ontouchstart' in window)) {
      await navigator.share({ files: [file] });
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Photo downloaded');
    }
  } catch (e) { if (e && e.name !== 'AbortError') toast('Could not export photo'); }
}
async function removePhoto() {
  const p = vList[vIdx]; if (!p) return;
  const key = selected, d = dayOf(key), at = (d.photos || []).findIndex(x => x.id === p.id);
  if (at < 0) return;
  d.photos.splice(at, 1);
  await persist();
  vList = d.photos || [];
  if (!vList.length) $('viewer').close(); else { vIdx = Math.min(vIdx, vList.length - 1); showViewerPhoto(); }
  renderMonth(); renderDay();
  scheduleGC();
  toast('Photo removed', 'Undo', async () => { cancelGC(); const dd = dayOf(key); dd.photos = dd.photos || []; dd.photos.splice(at, 0, p); await persist(); renderMonth(); renderDay(); });
}

/* Delete photo blobs no longer referenced by any day (after undo windows have passed). */
let gcTimer;
function scheduleGC(ms = 8000) { clearTimeout(gcTimer); gcTimer = setTimeout(gcPhotos, ms); }
function cancelGC() { clearTimeout(gcTimer); }
async function gcPhotos() {
  try {
    const live = new Set();
    for (const d of Object.values(days)) for (const p of d.photos || []) live.add(p.id);
    for (const k of await db.keys()) {
      if (typeof k !== 'string' || !/^[pt]:/.test(k)) continue;
      const id = k.slice(2);
      if (!live.has(id)) { await db.del(k); if (thumbURLs.has(id)) { URL.revokeObjectURL(thumbURLs.get(id)); thumbURLs.delete(id); } }
    }
  } catch {}
}

function wirePhotos() {
  $('cameraInput').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; addPhotos(f, 'camera'); });
  $('libraryInput').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; addPhotos(f, 'library'); });
  $('photos').addEventListener('click', e => { const b = e.target.closest('.ph'); if (b) openViewer(+b.dataset.i); });
  const v = $('viewer');
  v.addEventListener('close', closeViewer);
  v.addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('vStage')) v.close(); });
  $('vPrev').onclick = () => { if (vIdx > 0) { vIdx--; showViewerPhoto(); } };
  $('vNext').onclick = () => { if (vIdx < vList.length - 1) { vIdx++; showViewerPhoto(); } };
  $('vSave').onclick = savePhoto;
  $('vDelete').onclick = removePhoto;
  $('vSaveLabel').textContent = isPhone() || 'ontouchstart' in window ? 'Save to Photos' : 'Download';
  v.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') $('vPrev').click(); if (e.key === 'ArrowRight') $('vNext').click(); });
  let sx = null;
  $('vStage').addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  $('vStage').addEventListener('touchend', e => {
    if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (Math.abs(dx) > 50) (dx < 0 ? $('vNext') : $('vPrev')).click();
  });
  // drag & drop photos onto the day panel (desktop)
  const panel = document.querySelector('.day');
  panel.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); panel.classList.add('drop'); } });
  panel.addEventListener('dragleave', e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop'); });
  panel.addEventListener('drop', e => { e.preventDefault(); panel.classList.remove('drop'); addPhotos(e.dataTransfer.files, 'library'); });
}

/* ---------------- backup / restore ---------------- */
/* Backup format v4: { app, version, exported, days, photos?: { id: dataURL } }
 * Photos are embedded only in full backups; the auto-saved linked file keeps text data only. */
function backupJSON() {
  clean();
  return JSON.stringify({ app: 'calendar', version: 4, exported: new Date().toISOString(), days }, null, 2);
}
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function dataURLToBlob(u) { return (await fetch(u)).blob(); }
async function buildBackup(includePhotos) {
  clean();
  const out = { app: 'calendar', version: 4, exported: new Date().toISOString(), days };
  if (includePhotos) {
    out.photos = {};
    for (const d of Object.values(days)) for (const p of d.photos || []) {
      const b = await photoDB.full(p.id).catch(() => null);
      if (b) out.photos[p.id] = await blobToDataURL(b);
    }
  }
  return JSON.stringify(out);
}
function parseBackup(text) {
  const obj = JSON.parse(text);
  const d = obj && (obj.days || ((obj.app || obj.version) ? null : obj));
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('This file is not a calendar backup.');
  const out = normalize(d);
  Object.defineProperty(out, '__photos', { value: obj.photos && typeof obj.photos === 'object' ? obj.photos : {}, enumerable: false });
  return out;
}
/* Write embedded photos to storage; drop photo entries whose image isn't available. */
async function importPhotos(incoming) {
  const blobs = incoming.__photos || {};
  let missing = 0;
  for (const d of Object.values(incoming)) {
    if (!d.photos) continue;
    const keep = [];
    for (const p of d.photos) {
      if (blobs[p.id]) { try { await photoDB.put(p.id, await dataURLToBlob(blobs[p.id])); keep.push(p); continue; } catch {} }
      if (await photoDB.full(p.id).catch(() => null)) keep.push(p); else missing++;
    }
    d.photos = keep;
  }
  return missing;
}
function backupName() { return `calendar-backup-${keyOf(new Date())}.json`; }

async function doBackup() {
  const withPhotos = counts().photos > 0 && (!$('bkPhotos') || $('bkPhotos').checked);
  if (withPhotos) toast('Preparing backup…');
  const json = await buildBackup(withPhotos);
  const file = new File([json], backupName(), { type: 'application/json' });
  try {
    // phones/tablets: native share sheet → Files, iCloud Drive, Google Drive, AirDrop, email…
    if (isPhone() && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Calendar backup' });
    } else if (CAN_LINK_FILE) {
      const h = await showSaveFilePicker({ suggestedName: file.name, types: FILE_TYPES });
      const w = await h.createWritable(); await w.write(json); await w.close();
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('Backup failed: ' + (e.message || e)); return;
  }
  meta.lastBackup = new Date().toISOString();
  await saveMeta();
  renderBadge(); renderDataSheet();
  toast('Backup saved');
}
async function saveMeta() {
  try { if (useLocalStorageFallback) throw 0; await db.set('meta', meta); }
  catch { localStorage.setItem('calendar-pwa', JSON.stringify({ days, meta })); }
}

async function restoreFrom(text, label) {
  let incoming;
  try { incoming = parseBackup(text); } catch (e) { toast(e.message || 'Could not read that file.'); return; }
  const n = Object.values(incoming).reduce((s, d) => s + d.events.length, 0);
  const notes = Object.values(incoming).filter(d => d.note).length;
  const photos = Object.values(incoming).reduce((s, d) => s + (d.photos || []).length, 0);
  const ok = await ask('Restore this backup?',
    `${label ? `“${label}” has ` : 'It has '}${n} event${n === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}${photos ? ` and ${photos} photo${photos === 1 ? '' : 's'}` : ''}. It will replace what's currently in the calendar.`, 'Restore');
  if (!ok) return;
  const missing = await importPhotos(incoming);
  const before = days;
  days = incoming;
  await persist(); renderAll(); renderDataSheet();
  scheduleGC(10000);
  toast(missing ? `Backup restored · ${missing} photo${missing > 1 ? 's' : ''} weren't in the file` : 'Backup restored', 'Undo', async () => { cancelGC(); days = before; await persist(); renderAll(); renderDataSheet(); });
}

/* ---------------- linked file (desktop Chrome / Edge) ---------------- */
async function linkNewFile() {
  try {
    const h = await showSaveFilePicker({ suggestedName: 'calendar-data.json', types: FILE_TYPES });
    await attachFile(h);
    await writeLinked();
    toast('File linked — changes save to it automatically');
  } catch (e) { if (e.name !== 'AbortError') toast('Could not link file: ' + e.message); }
}
async function linkExistingFile() {
  try {
    const [h] = await showOpenFilePicker({ types: FILE_TYPES });
    const text = await (await h.getFile()).text();
    if (text.trim()) {
      let incoming;
      try { incoming = parseBackup(text); } catch (e) { toast(e.message); return; }
      await importPhotos(incoming);
      const hasLocal = Object.keys(days).length > 0;
      const ok = !hasLocal || await ask('Load data from this file?',
        `The calendar will show the contents of “${h.name}”. What's in the calendar now will be replaced (back it up first if you need it).`, 'Load file');
      if (!ok) return;
      days = incoming;
    }
    await attachFile(h);
    await persist();
    renderAll();
    toast(`Linked “${h.name}”`);
  } catch (e) { if (e.name !== 'AbortError') toast('Could not open file: ' + e.message); }
}
async function attachFile(h) {
  if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission was not granted');
  linkedHandle = h; linkedState = 'ok';
  try { await db.set('linkedHandle', h); } catch {}
  renderBadge(); renderDataSheet();
}
async function unlinkFile() {
  linkedHandle = null; linkedState = 'none';
  try { await db.del('linkedHandle'); } catch {}
  renderBadge(); renderDataSheet();
  toast('File unlinked — your data is still in the app');
}
async function reconnectFile() {
  if (!linkedHandle) return;
  try {
    if ((await linkedHandle.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
    linkedState = 'ok';
    await writeLinked();
    toast('Reconnected');
  } catch (e) { linkedState = 'error'; toast('Could not reconnect: ' + e.message); }
  renderBadge(); renderDataSheet();
}
let linkTimer;
function scheduleLinkedWrite() {
  if (!linkedHandle || linkedState !== 'ok') return;
  clearTimeout(linkTimer);
  linkTimer = setTimeout(writeLinked, 400);
}
async function writeLinked() {
  if (!linkedHandle) return;
  try {
    const w = await linkedHandle.createWritable();
    await w.write(backupJSON()); await w.close();
    linkedState = 'ok';
    meta.lastFileWrite = new Date().toISOString();
    await saveMeta();
  } catch (e) {
    linkedState = e && e.name === 'NotAllowedError' ? 'needs-permission' : 'error';
  }
  renderBadge();
  if ($('dataSheet').open) renderDataSheet();
}
async function checkLinkedPermission() {
  if (!linkedHandle) return;
  try {
    const p = await linkedHandle.queryPermission({ mode: 'readwrite' });
    linkedState = p === 'granted' ? 'ok' : 'needs-permission';
  } catch { linkedState = 'error'; }
}

/* ---------------- data sheet ---------------- */
async function renderDataSheet() {
  const body = $('dataBody');
  if (!body) return;
  const { events, notes, photos, bytes } = counts();
  const has = events + notes + photos > 0;
  let persisted = null;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch {}

  const backupStatus = !has
    ? { cls: '', text: 'Nothing to back up yet.' }
    : !meta.lastBackup
      ? { cls: 'warn', text: 'Not backed up yet. Save a copy somewhere you trust.' }
      : meta.lastChange > meta.lastBackup
        ? { cls: 'warn', text: `Last backup ${ago(meta.lastBackup)} — there are newer changes.` }
        : { cls: 'ok', text: `Backed up ${ago(meta.lastBackup)}. Up to date.` };

  let fileSection = '';
  if (CAN_LINK_FILE && !isPhone()) {
    if (linkedHandle) {
      const st = linkedState === 'ok'
        ? { cls: 'ok', text: `Saving automatically${meta.lastFileWrite ? ` · last write ${ago(meta.lastFileWrite)}` : ''}` }
        : linkedState === 'needs-permission'
          ? { cls: 'warn', text: 'The browser needs your permission again to write to this file.' }
          : { cls: 'warn', text: 'Could not write to the file. It may have been moved or deleted.' };
      fileSection = `<section class="ds">
        <div class="ds-head"><h3>Linked file</h3></div>
        <p class="file-name">${esc(linkedHandle.name)}</p>
        <div class="status ${st.cls}"><span class="pip"></span><span>${st.text}</span></div>
        <div class="ds-actions">
          ${linkedState !== 'ok' ? '<button class="btn primary" data-act="reconnect">Reconnect</button>' : ''}
          <button class="btn subtle" data-act="unlink">Unlink</button>
        </div>
      </section>`;
    } else {
      fileSection = `<section class="ds">
        <div class="ds-head"><h3>Linked file</h3><span class="meta">Optional</span></div>
        <p>Keep a JSON file on your computer — in Documents, iCloud Drive or Dropbox — that updates every time you make a change.${photos ? ' Photos are kept out of it to keep it small. Use Download backup for those.' : ''}</p>
        <div class="ds-actions">
          <button class="btn subtle" data-act="link-new">Create file…</button>
          <button class="btn subtle" data-act="link-open">Use existing…</button>
        </div>
      </section>`;
    }
  }

  body.innerHTML = `
    <section class="ds">
      <div class="ds-stats">
        <div><strong>${events}</strong><span>event${events === 1 ? '' : 's'}</span></div>
        <div><strong>${notes}</strong><span>note${notes === 1 ? '' : 's'}</span></div>
        <div><strong>${photos}</strong><span>photo${photos === 1 ? '' : 's'}${photos ? ` · ${fmtBytes(bytes)}` : ''}</span></div>
      </div>
      <p>Stored privately on this device${persisted ? ' and protected from automatic clean-up' : ''}. Nothing is uploaded anywhere.</p>
    </section>
    <section class="ds">
      <div class="ds-head"><h3>Backup</h3></div>
      <div class="status ${backupStatus.cls}"><span class="pip"></span><span>${backupStatus.text}</span></div>
      <div class="ds-actions">
        <button class="btn primary" data-act="backup" ${!has ? 'disabled' : ''}>${isPhone() ? 'Back up…' : 'Download backup'}</button>
        <button class="btn" data-act="restore">Restore…</button>
      </div>
      ${photos ? `<label class="check-row"><input type="checkbox" id="bkPhotos" checked><span>Include photos <span class="meta">(${fmtBytes(bytes * 1.37)} file)</span></span></label>` : ''}
      <p class="meta">${isPhone() ? 'Saves a .json file via the share sheet — to Files, iCloud, Drive or anywhere else. ' : ''}Restore replaces the calendar with a backup file (you can undo).</p>
    </section>
    ${fileSection}
    <section class="ds">
      <div class="ds-head"><h3>Erase</h3></div>
      <p>Remove all events, notes and photos from this device.</p>
      <div class="ds-actions"><button class="btn danger-ghost" data-act="erase" ${!has ? 'disabled' : ''}>Erase all data…</button></div>
    </section>`;
}

async function eraseAll() {
  const ok = await ask('Erase everything?', 'All events, notes and photos will be removed from this device. Make sure you have a backup.', 'Erase', true);
  if (!ok) return;
  const before = days;
  days = {};
  await persist(); renderAll(); renderDataSheet();
  scheduleGC(7000);
  toast('All data erased', 'Undo', async () => { cancelGC(); days = before; await persist(); renderAll(); renderDataSheet(); });
}

/* ---------------- dialogs, toast ---------------- */
function ask(title, text, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    const dlg = $('askSheet');
    $('askTitle').textContent = title;
    $('askText').textContent = text;
    const ok = $('askOk');
    ok.textContent = okLabel;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    dlg.returnValue = '';
    dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  if (actionLabel) t.querySelector('button').onclick = () => { t.classList.remove('show'); action(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 6000 : 2400);
}

/* Close sheets: [data-close], backdrop click, swipe-down on phones */
function wireSheet(dlg) {
  dlg.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) dlg.close();
    else if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    }
  });
  let y0 = null;
  dlg.addEventListener('touchstart', e => { y0 = (dlg.scrollTop <= 0 && e.target.closest('.sheet-head, .grabber')) ? e.touches[0].clientY : null; }, { passive: true });
  dlg.addEventListener('touchmove', e => {
    if (y0 == null) return;
    const dy = Math.max(0, e.touches[0].clientY - y0);
    dlg.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  dlg.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    dlg.style.transform = '';
    y0 = null;
    if (dy > 90) dlg.close();
  });
}

/* ---------------- wire up ---------------- */
function wire() {
  // swatches
  $('swatches').innerHTML = COLORS.map(c =>
    `<label class="swatch" title="${c.name}"><input type="radio" name="color" value="${c.id}" aria-label="${c.name}"><span style="--c:${c.v}"></span></label>`).join('');

  $('prevBtn').onclick = () => shiftMonth(-1);
  $('nextBtn').onclick = () => shiftMonth(1);
  $('todayBtn').onclick = () => select(keyOf(new Date()));
  $('addBtn').onclick = () => openEditor();
  $('fab').onclick = () => openEditor();
  $('dataBtn').onclick = async () => { await renderDataSheet(); $('dataSheet').showModal(); };

  $('grid').addEventListener('click', e => {
    const c = e.target.closest('.cell'); if (!c) return;
    if (c.dataset.k === selected && !isPhone()) { openEditor(); return; }   // click selected day again = new event
    select(c.dataset.k);
  });
  $('grid').addEventListener('dblclick', e => { const c = e.target.closest('.cell'); if (c) { select(c.dataset.k); openEditor(); } });

  // swipe left/right on the month grid (phones)
  let sx = null, sy = 0;
  $('grid').addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  $('grid').addEventListener('touchend', e => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { view = startOfMonth(new Date(view.getFullYear(), view.getMonth() + (dx < 0 ? 1 : -1), 1)); renderMonth(); }
  });

  $('events').addEventListener('click', e => {
    if (e.target.closest('[data-add]')) { openEditor(); return; }
    const b = e.target.closest('.ev'); if (b) openEditor(b.dataset.id, b.dataset.origin);
  });

  $('note').addEventListener('input', onNoteInput);
  $('note').addEventListener('blur', flushNote);

  $('evAllDay').addEventListener('change', syncAllDay);
  $('eventForm').addEventListener('submit', saveEditor);
  $('evDelete').onclick = () => { const ed = editing; $('eventSheet').close(); if (ed) deleteEvent(ed.key, ed.origin, ed.id); };
  const syncMainSwatch = () => { const c = ($('eventForm').querySelector('input[name="color"]:checked') || {}).value; $('mainRow').style.setProperty('--day', colorOf(c)); };
  $('swatches').addEventListener('change', syncMainSwatch);
  $('eventSheet').addEventListener('toggle', syncMainSwatch);
  $('repeatCtl').addEventListener('click', e => { const b = e.target.closest('[data-rep]'); if (b) setRepeat(b.dataset.rep); });
  $('evDate').addEventListener('change', syncRepeatSummary);
  $('evUntil').addEventListener('change', syncRepeatSummary);
  $('clearUntil').onclick = () => { $('evUntil').value = ''; syncRepeatSummary(); };
  wirePhotos();

  $('dataBody').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    ({
      backup: doBackup,
      restore: () => $('restoreInput').click(),
      'link-new': linkNewFile,
      'link-open': linkExistingFile,
      unlink: unlinkFile,
      reconnect: reconnectFile,
      erase: eraseAll,
    })[b.dataset.act]();
  });
  $('restoreInput').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) restoreFrom(await f.text(), f.name);
  });

  ['eventSheet', 'dataSheet', 'askSheet', 'scopeSheet'].forEach(id => wireSheet($(id)));

  // keyboard
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const inGrid = document.activeElement && document.activeElement.classList.contains('cell');
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in moves) { e.preventDefault(); select(addDays(selected, moves[e.key]), { focus: true }); }
    else if (e.key === 'PageUp') { e.preventDefault(); shiftMonth(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); shiftMonth(1); }
    else if (e.key === 't' || e.key === 'T') select(keyOf(new Date()), { focus: inGrid });
    else if (e.key === 'n' || e.key === 'N' || (e.key === 'Enter' && inGrid)) { e.preventDefault(); openEditor(); }
  });

  // responsive weekday labels
  matchMedia('(max-width: 760px)').addEventListener('change', () => { renderWeekdays(); renderDataSheet(); });

  // keep "today" correct if the app stays open overnight / comes back from background
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') flushNote();
    else { await checkLinkedPermission(); renderMonth(); renderDay(); renderBadge(); }
  });
  window.addEventListener('pagehide', flushNote);
}

/* ---------------- public API (used by assistant.js) ---------------- */
window.Cal = {
  getDays: () => days, db, keyOf, parseKey, addDays, fmt, fmtTime, colorOf, esc, toast, isPhone, wireSheet, sorted, repeatText,
  expand: (a, b) => X.expand(days, a, b),
  select: (k) => select(k), openEditor: (k, id, origin) => { if (k) select(k); openEditor(id || null, origin || null); },
  ready: false,
};

/* ---------------- start ---------------- */
async function start() {
  wire();
  await loadAll();
  await checkLinkedPermission();
  const qDay = new URLSearchParams(location.search).get('day');
  if (qDay && /^\d{4}-\d{2}-\d{2}$/.test(qDay)) { selected = qDay; view = startOfMonth(parseKey(qDay)); history.replaceState(null, '', location.pathname); }
  renderAll();
  requestPersistence();
  scheduleGC(15000);
  window.Cal.ready = true;
  document.dispatchEvent(new Event('cal:ready'));
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'open-day') select(e.data.key); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
start();
})();
