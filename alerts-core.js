/* Shared calendar logic — loaded by the page (app.js, assistant.js) and by the
 * service worker (background alerts). Pure functions, no DOM.
 *  - expand(): turns stored events (incl. repeating series) into dated occurrences
 *  - urgentItems() / weekDigest(): alert logic */
(function (g) {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const dayDiff = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 864e5);
  const startOf = (k, e) => { const d = parseKey(k); if (e.time) { const [h, m] = e.time.split(':').map(Number); d.setHours(h, m, 0, 0); } return d; };
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dowFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

  const DEFAULTS = { notify: false, leadMin: 60, impDayBefore: true, weeklyDigest: true, model: 'small' };

  /* ---------------- repeating events ----------------
   * A series is stored once, on its first day, with
   *   repeat: { freq: 'daily'|'weekly'|'monthly'|'yearly', until: 'YYYY-MM-DD'|'', except: ['YYYY-MM-DD', …] }
   * Monthly on the 29th–31st skips months without that day; yearly on Feb 29 skips non-leap years. */
  const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
  const MAX_OCC = 5000;

  function seriesKeys(ev, origin, start, end) {
    const r = ev.repeat, out = [];
    const last = r.until && r.until < end ? r.until : end;
    const from = start > origin ? start : origin;
    if (last < from) return out;
    const ex = r.except && r.except.length ? new Set(r.except) : null;
    const add = k => { if (k >= from && k <= last && !(ex && ex.has(k))) out.push(k); };
    const o = parseKey(origin);
    if (r.freq === 'daily' || r.freq === 'weekly') {
      const step = r.freq === 'daily' ? 1 : 7;
      const skip = Math.max(0, Math.ceil(dayDiff(origin, from) / step) * step);
      const d = new Date(o); d.setDate(d.getDate() + skip);
      for (let k = keyOf(d); k <= last && out.length < MAX_OCC; d.setDate(d.getDate() + step), k = keyOf(d)) add(k);
    } else {
      const step = r.freq === 'monthly' ? 1 : 12;
      const f = parseKey(from);
      const gap = (f.getFullYear() - o.getFullYear()) * 12 + f.getMonth() - o.getMonth();
      for (let i = Math.max(0, Math.floor(gap / step) - 1); out.length < MAX_OCC; i++) {
        const first = new Date(o.getFullYear(), o.getMonth() + i * step, 1);
        if (keyOf(first) > last) break;
        const d = new Date(o.getFullYear(), o.getMonth() + i * step, o.getDate());
        if (d.getMonth() !== first.getMonth()) continue; // e.g. the 31st in a 30-day month
        add(keyOf(d));
      }
    }
    return out;
  }

  /** All occurrences between start..end (inclusive): [{ key, ev, origin }] */
  function expand(days, start, end) {
    const out = [];
    for (const k in days || {}) {
      const evs = (days[k] && days[k].events) || [];
      for (const e of evs) {
        if (e.repeat && FREQS.includes(e.repeat.freq)) {
          if (k > end) continue;
          for (const occ of seriesKeys(e, k, start, end)) out.push({ key: occ, ev: e, origin: k });
        } else if (k >= start && k <= end) out.push({ key: k, ev: e, origin: k });
      }
    }
    return out;
  }

  /* ---------------- alerts ---------------- */
  /** Events that deserve attention right now.
   *  stage: 'now' (≤15 min) | 'soon' (≤ lead time) | 'heads' (important, within a day) | 'today' (important all-day today) */
  function urgentItems(days, settings, now = new Date()) {
    const S = Object.assign({}, DEFAULTS, settings || {});
    const today = keyOf(now), tomorrow = addDays(today, 1), limit = addDays(today, 2);
    const out = [];
    for (const { key: k, ev: e } of expand(days, today, limit)) {
      const start = startOf(k, e);
      const it = { key: k, ev: e, start, allDay: !e.time };
      if (e.time) {
        const min = (start - now) / 6e4;
        if (min < -5) continue;
        if (min <= S.leadMin) out.push(Object.assign(it, { min, stage: min <= 15 ? 'now' : 'soon' }));
        else if (e.important && S.impDayBefore && min <= 1440) out.push(Object.assign(it, { min, stage: 'heads' }));
      } else if (e.important) {
        if (k === today) out.push(Object.assign(it, { min: 0, stage: 'today' }));
        else if (k === tomorrow && S.impDayBefore) out.push(Object.assign(it, { min: (start - now) / 6e4, stage: 'heads' }));
      }
    }
    return out.sort((a, b) => a.min - b.min);
  }

  const group = st => (st === 'now' || st === 'soon') ? 'lead' : st;
  const sig = it => `${it.ev.id}|${it.key}|${it.ev.time || ''}|${group(it.stage)}`;

  function relText(it, now = new Date()) {
    const today = keyOf(now);
    if (it.allDay) return it.key === today ? 'Today · all day' : 'Tomorrow · all day';
    const t = timeFmt.format(it.start);
    const min = Math.round(it.min);
    if (min <= 0) return `Now · ${t}`;
    if (min < 60) return `In ${min} min · ${t}`;
    if (it.key === today) { const h = Math.round(min / 60); return `In ${h} h · ${t}`; }
    return `Tomorrow · ${t}`;
  }

  function notificationFor(it, now = new Date()) {
    return {
      title: it.ev.title,
      body: relText(it, now) + (it.ev.important ? ' · Important' : '') + (it.ev.desc ? `\n${it.ev.desc.slice(0, 120)}` : ''),
    };
  }

  function weekStartKey(now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return keyOf(d);
  }

  /** Short digest for the week containing `now`. */
  function weekDigest(days, now = new Date()) {
    const ws = weekStartKey(now), we = addDays(ws, 6);
    const occ = expand(days, ws, we);
    const per = Array.from({ length: 7 }, (_, i) => { const k = addDays(ws, i); return { k, n: occ.filter(o => o.key === k).length }; });
    const total = occ.length, important = occ.filter(o => o.ev.important).length;
    const busiest = per.reduce((a, b) => (b.n > a.n ? b : a), per[0]);
    const parts = [`${total} event${total === 1 ? '' : 's'} this week`];
    if (busiest.n > 1) parts.push(`busiest on ${dowFmt.format(parseKey(busiest.k))}`);
    if (important) parts.push(`${important} important`);
    return { week: ws, total, important, title: 'Your week ahead', body: parts.join(' · ') };
  }

  g.CalAlerts = { DEFAULTS, FREQS, expand, seriesKeys, urgentItems, sig, relText, notificationFor, weekStartKey, weekDigest, keyOf, parseKey, addDays, dayDiff };
})(self);
