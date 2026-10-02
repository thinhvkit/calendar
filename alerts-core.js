/* Shared alert logic — loaded by the page (assistant.js) and by the service worker
 * (periodic background sync). Pure functions, no DOM. */
(function (g) {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const startOf = (k, e) => { const d = parseKey(k); if (e.time) { const [h, m] = e.time.split(':').map(Number); d.setHours(h, m, 0, 0); } return d; };
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dowFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

  const DEFAULTS = { notify: false, leadMin: 60, impDayBefore: true, weeklyDigest: true, model: 'small' };

  /** Events that deserve attention right now.
   *  stage: 'now' (≤15 min) | 'soon' (≤ lead time) | 'heads' (important, within a day) | 'today' (important all-day today) */
  function urgentItems(days, settings, now = new Date()) {
    const S = Object.assign({}, DEFAULTS, settings || {});
    const today = keyOf(now), tomorrow = addDays(today, 1), limit = addDays(today, 2);
    const out = [];
    for (const k in days || {}) {
      if (k < today || k > limit) continue;
      for (const e of days[k].events || []) {
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
    const ws = weekStartKey(now);
    const per = [];
    let total = 0, important = 0;
    for (let i = 0; i < 7; i++) {
      const k = addDays(ws, i), evs = (days[k] && days[k].events) || [];
      per.push({ k, n: evs.length });
      total += evs.length;
      important += evs.filter(e => e.important).length;
    }
    const busiest = per.reduce((a, b) => (b.n > a.n ? b : a), per[0]);
    const parts = [`${total} event${total === 1 ? '' : 's'} this week`];
    if (busiest.n > 1) parts.push(`busiest on ${dowFmt.format(parseKey(busiest.k))}`);
    if (important) parts.push(`${important} important`);
    return { week: ws, total, important, title: 'Your week ahead', body: parts.join(' · ') };
  }

  g.CalAlerts = { DEFAULTS, urgentItems, sig, relText, notificationFor, weekStartKey, weekDigest, keyOf, parseKey, addDays };
})(self);
