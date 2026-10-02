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
let days = {};                 // { 'YYYY-MM-DD': { note, events:[{id,title,time,desc,color}] } }
let meta = { lastBackup: null, lastChange: null };
let linkedHandle = null;       // FileSystemFileHandle when a file is linked (desktop Chrome)
let linkedState = 'none';      // none | ok | needs-permission | error
let view = startOfMonth(new Date());
let selected = keyOf(new Date());
let editing = null;            // { key, id } or null for new

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
      events: Array.isArray(v.events) ? v.events.filter(e => e && e.title).map(e => ({
        id: String(e.id || uid()), title: String(e.title), time: e.time || '', desc: e.desc || '', color: e.color || COLORS[0].id,
      })) : [],
    };
  }
  return out;
}
function clean() { for (const k in days) if (!days[k].note && !days[k].events.length) delete days[k]; }

/* Ask the browser to keep our storage even under pressure (esp. iOS/Safari). */
async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

/* Cross-tab sync */
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('calendar-pwa') : null;
function broadcast() { channel && channel.postMessage('changed'); }
if (channel) channel.onmessage = async () => { await loadAll(); renderAll(); };

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
  let e = 0, n = 0;
  for (const d of Object.values(days)) { e += d.events.length; if (d.note) n++; }
  return { events: e, notes: n };
};

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
  document.title = `${fmt.month.format(view)} ${view.getFullYear()} · Calendar`;

  const offset = (view.getDay() + 6) % 7;
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const rows = Math.ceil((offset + daysInMonth) / 7);
  const grid = $('grid');
  grid.style.setProperty('--rows', rows);
  const start = new Date(view); start.setDate(1 - offset);
  const today = keyOf(new Date());
  const maxChips = rows > 5 ? 2 : 3;

  let html = '';
  for (let i = 0; i < rows * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = keyOf(d), info = peek(k), evs = sorted(info.events);
    const cls = ['cell'];
    if (d.getMonth() !== view.getMonth()) cls.push('out');
    if (i % 7 >= 5) cls.push('we');
    if (k === today) cls.push('today');
    if (k === selected) cls.push('selected');

    const shown = evs.length > maxChips + 1 ? evs.slice(0, maxChips) : evs.slice(0, maxChips + 1);
    const chips = shown.map(e => e.time
      ? `<span class="chip timed" style="--c:${colorOf(e.color)}"><span class="t">${esc(fmtTime(e.time, true))}</span><span class="x">${esc(e.title)}</span></span>`
      : `<span class="chip allday" style="--c:${colorOf(e.color)}"><span class="x">${esc(e.title)}</span></span>`).join('');
    const more = evs.length > shown.length ? `<span class="more">+${evs.length - shown.length} more</span>` : '';
    const dots = evs.slice(0, 3).map(e => `<i style="--c:${colorOf(e.color)}"></i>`).join('') + (info.note && evs.length < 3 ? '<i class="note"></i>' : '');
    const label = `${fmt.full.format(d)}${evs.length ? `, ${evs.length} event${evs.length > 1 ? 's' : ''}` : ''}${info.note ? ', has note' : ''}`;

    html += `<button class="${cls.join(' ')}" data-k="${k}" aria-label="${esc(label)}" ${k === selected ? 'aria-current="date"' : ''} tabindex="${k === selected ? 0 : -1}">
      <span class="head"><span class="n">${d.getDate()}</span>${info.note ? '<span class="note-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>' : ''}</span>
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

  const evs = sorted(info.events);
  $('events').innerHTML = evs.length
    ? evs.map(e => `<li><button class="ev" data-id="${esc(e.id)}" style="--c:${colorOf(e.color)}">
        <span class="ev-time">${e.time ? esc(fmtTime(e.time)) : 'All day'}</span>
        <span class="ev-main"><span class="ev-dot"></span><span><span class="ev-title">${esc(e.title)}</span>${e.desc ? `<span class="ev-desc">${esc(e.desc)}</span>` : ''}</span></span>
      </button></li>`).join('')
    : `<li class="empty">Nothing scheduled. <button type="button" data-add>Add an event</button></li>`;

  const note = $('note');
  if (document.activeElement !== note) note.value = info.note;
  $('noteStatus').textContent = '';
}

function renderBadge() {
  const { events, notes } = counts();
  const hasData = events + notes > 0;
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
function openEditor(id = null) {
  const form = $('eventForm');
  form.reset();
  editing = id ? { key: selected, id } : null;
  const ev = id ? peek(selected).events.find(e => e.id === id) : null;
  $('evSheetTitle').textContent = ev ? 'Edit event' : 'New event';
  $('evDelete').hidden = !ev;
  $('evTitle').value = ev ? ev.title : '';
  $('evDate').value = selected;
  $('evTime').value = ev ? ev.time : '';
  $('evAllDay').checked = ev ? !ev.time : false;
  $('evDesc').value = ev ? ev.desc : '';
  const color = ev ? ev.color : (localStorage.getItem('calendar-last-color') || COLORS[0].id);
  const radio = form.querySelector(`input[name="color"][value="${COLORS.some(c => c.id === color) ? color : COLORS[0].id}"]`);
  if (radio) radio.checked = true;
  syncAllDay();
  $('eventSheet').showModal();
  if (!isPhone() || !ev) setTimeout(() => $('evTitle').focus(), 60);
}
function syncAllDay() {
  const on = $('evAllDay').checked;
  $('evTime').disabled = on;
  $('evTimeField').classList.toggle('is-disabled', on);
}
async function saveEditor(e) {
  e.preventDefault();
  const title = $('evTitle').value.trim();
  if (!title) { $('evTitle').focus(); return; }
  const date = $('evDate').value || selected;
  const color = ($('eventForm').querySelector('input[name="color"]:checked') || {}).value || COLORS[0].id;
  localStorage.setItem('calendar-last-color', color);
  const data = { title, time: $('evAllDay').checked ? '' : $('evTime').value, desc: $('evDesc').value.trim(), color };

  if (editing) {
    const src = dayOf(editing.key);
    const i = src.events.findIndex(x => x.id === editing.id);
    if (i > -1) {
      const ev = Object.assign(src.events[i], data);
      if (date !== editing.key) { src.events.splice(i, 1); dayOf(date).events.push(ev); }
    }
  } else {
    dayOf(date).events.push({ id: uid(), ...data });
  }
  $('eventSheet').close();
  await persist();
  select(date);
  toast(editing ? 'Event updated' : 'Event added');
}
async function deleteEvent(k, id) {
  const d = dayOf(k), i = d.events.findIndex(x => x.id === id);
  if (i < 0) return;
  const [removed] = d.events.splice(i, 1);
  await persist(); renderMonth(); renderDay();
  toast(`Deleted “${removed.title}”`, 'Undo', async () => {
    dayOf(k).events.splice(i, 0, removed);
    await persist(); renderMonth(); renderDay();
  });
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

/* ---------------- backup / restore ---------------- */
function backupJSON() {
  clean();
  return JSON.stringify({ app: 'calendar', version: 3, exported: new Date().toISOString(), days }, null, 2);
}
function parseBackup(text) {
  const obj = JSON.parse(text);
  const d = obj && (obj.days || ((obj.app || obj.version) ? null : obj));
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('This file is not a calendar backup.');
  return normalize(d);
}
function backupName() { return `calendar-backup-${keyOf(new Date())}.json`; }

async function doBackup() {
  const json = backupJSON();
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
  const ok = await ask('Restore this backup?',
    `${label ? `“${label}” has ` : 'It has '}${n} event${n === 1 ? '' : 's'} and ${notes} note${notes === 1 ? '' : 's'}. It will replace what's currently in the calendar.`, 'Restore');
  if (!ok) return;
  const before = days;
  days = incoming;
  await persist(); renderAll(); renderDataSheet();
  toast('Backup restored', 'Undo', async () => { days = before; await persist(); renderAll(); renderDataSheet(); });
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
  const { events, notes } = counts();
  let persisted = null;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch {}

  const backupStatus = !events && !notes
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
        <p>Keep a JSON file on your computer — in Documents, iCloud Drive or Dropbox — that updates every time you make a change.</p>
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
      </div>
      <p>Stored privately on this device${persisted ? ' and protected from automatic clean-up' : ''}. Nothing is uploaded anywhere.</p>
    </section>
    <section class="ds">
      <div class="ds-head"><h3>Backup</h3></div>
      <div class="status ${backupStatus.cls}"><span class="pip"></span><span>${backupStatus.text}</span></div>
      <div class="ds-actions">
        <button class="btn primary" data-act="backup" ${!events && !notes ? 'disabled' : ''}>${isPhone() ? 'Back up…' : 'Download backup'}</button>
        <button class="btn" data-act="restore">Restore…</button>
      </div>
      <p class="meta">${isPhone() ? 'Saves a .json file via the share sheet — to Files, iCloud, Drive or anywhere else. ' : ''}Restore replaces the calendar with a backup file (you can undo).</p>
    </section>
    ${fileSection}
    <section class="ds">
      <div class="ds-head"><h3>Erase</h3></div>
      <p>Remove all events and notes from this device.</p>
      <div class="ds-actions"><button class="btn danger-ghost" data-act="erase" ${!events && !notes ? 'disabled' : ''}>Erase all data…</button></div>
    </section>`;
}

async function eraseAll() {
  const ok = await ask('Erase everything?', 'All events and notes will be removed from this device. Make sure you have a backup.', 'Erase', true);
  if (!ok) return;
  const before = days;
  days = {};
  await persist(); renderAll(); renderDataSheet();
  toast('All data erased', 'Undo', async () => { days = before; await persist(); renderAll(); renderDataSheet(); });
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
    const b = e.target.closest('.ev'); if (b) openEditor(b.dataset.id);
  });

  $('note').addEventListener('input', onNoteInput);
  $('note').addEventListener('blur', flushNote);

  $('evAllDay').addEventListener('change', syncAllDay);
  $('eventForm').addEventListener('submit', saveEditor);
  $('evDelete').onclick = () => { const ed = editing; $('eventSheet').close(); if (ed) deleteEvent(ed.key, ed.id); };

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

  ['eventSheet', 'dataSheet', 'askSheet'].forEach(id => wireSheet($(id)));

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

/* ---------------- start ---------------- */
async function start() {
  wire();
  await loadAll();
  await checkLinkedPermission();
  renderAll();
  requestPersistence();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
start();
})();
