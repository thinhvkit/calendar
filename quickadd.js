/* Quick add: turn "Lunch with Mai tomorrow 12:30" into { title, date, time, repeat, important }.
 * English + Vietnamese. Pure function; `today` is a Date (local). Returns spans so the UI
 * can highlight what was understood. */
(function (g) {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const strip = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

  const WD = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  // Vietnamese weekdays (accent-stripped): thu 2..7, chu nhat
  const VWD = { 'thu 2': 1, 'thu hai': 1, 'thu 3': 2, 'thu ba': 2, 'thu 4': 3, 'thu tu': 3, 'thu 5': 4, 'thu nam': 4, 'thu 6': 5, 'thu sau': 5, 'thu 7': 6, 'thu bay': 6, 'chu nhat': 0, 'cn': 0 };
  const MON = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };

  function parse(input, today = new Date()) {
    const text = String(input || '');
    // work on an accent-stripped, lower-cased copy with identical length so indices line up
    let low = strip(text).toLowerCase();
    if (low.length !== text.length) low = text.toLowerCase(); // safety: fall back if lengths differ
    const used = [];           // [start, end] spans consumed
    const take = (m, idx = m.index, len = m[0].length) => { used.push([idx, idx + len]); };
    const free = (i, j) => !used.some(([a, b]) => i < b && j > a);
    const find = re => { re.lastIndex = 0; let m; while ((m = re.exec(low))) { if (free(m.index, m.index + m[0].length)) return m; if (!re.global) break; } return null; };
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const addD = n => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
    let date = null, time = '', repeat = '', important = false, allDay = false;

    // ---- importance
    let m = find(/(^|\s)(!+|!important|quan trong|gap)(?=\s|$)/g);
    if (m) { important = true; take(m, m.index + m[1].length, m[0].length - m[1].length); }

    // ---- repeat
    const REP = [
      [/\b(every ?day|daily|hang ngay|moi ngay)\b/g, 'daily'],
      [/\b(every ?week|weekly|hang tuan|moi tuan)\b/g, 'weekly'],
      [/\b(every ?month|monthly|hang thang|moi thang)\b/g, 'monthly'],
      [/\b(every ?year|yearly|annually|hang nam|moi nam)\b/g, 'yearly'],
    ];
    for (const [re, f] of REP) { m = find(re); if (m) { repeat = f; take(m); break; } }
    // "every monday" → weekly on that weekday
    m = find(/\bevery (sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\b/g);
    if (m && !repeat) { repeat = 'weekly'; take(m); const wd = WD[m[1]]; date = nextWeekday(base, wd, true); }
    m = !date && find(/\b(moi|hang) (thu [2-7]|thu (hai|ba|tu|nam|sau|bay)|chu nhat)\b/g);
    if (m) { repeat = repeat || 'weekly'; take(m); date = nextWeekday(base, VWD[m[2]], true); }

    // claim Vietnamese weekdays early so their digit ("thứ 2") isn't read as a time
    let vwd = find(/\b(thu [2-7]|thu (?:hai|ba|tu|nam|sau|bay)|chu nhat)( tuan (?:sau|toi))?\b/g);
    if (vwd && !date) { date = nextWeekday(base, VWD[vwd[1]], !!repeat, !!vwd[2]); take(vwd); }

    // ---- all day
    m = find(/\b(all ?day|ca ngay)\b/g);
    if (m) { allDay = true; take(m); }

    // ---- time: 12:30, 9am, 9.30pm, 14h, 14h30, 7 gio toi, noon, "at 5"
    const setTime = (h, min, mer, idx, len) => {
      h = +h; min = +(min || 0);
      if (mer) { mer = mer.replace(/\./g, ''); if (/^(pm|p|chieu|toi)$/.test(mer) && h < 12) h += 12; if (/^(am|a|sang)$/.test(mer) && h === 12) h = 0; if (mer === 'trua' && h < 11) h += 12; }
      if (h > 23 || min > 59) return false;
      time = `${pad(h)}:${pad(min)}`; used.push([idx, idx + len]); return true;
    };
    m = find(/\b(noon|midday|trua nay)\b/g); if (m && !time) { time = '12:00'; take(m); }
    m = !time && find(/\bmidnight\b/g); if (m) { time = '00:00'; take(m); }
    if (!time) { m = find(/\b(?:at |luc )?(\d{1,2})[:.](\d{2}) ?(am|pm|a\.m\.|p\.m\.|sang|chieu|toi)?\b/g); if (m) setTime(m[1], m[2], m[3], m.index, m[0].length); }
    if (!time) { m = find(/\b(?:at |luc )?(\d{1,2})h(\d{2})?\b ?(sang|chieu|toi|trua)?/g); if (m) setTime(m[1], m[2], m[3], m.index, m[0].length); }
    if (!time) { m = find(/\b(?:at |luc )?(\d{1,2}) ?(am|pm|a\.m\.|p\.m\.)(?=\s|$|[,.;])/g); if (m) setTime(m[1], 0, m[2], m.index, m[0].length); }
    if (!time) { m = find(/\b(?:luc )?(\d{1,2}) gio(?: (\d{1,2}))? ?(sang|chieu|toi|trua)?\b/g); if (m) setTime(m[1], m[2], m[3], m.index, m[0].length); }
    if (!time) { m = find(/\bat (\d{1,2})\b(?![\/\-.:]\d)/g); if (m) { const h = +m[1]; setTime(h < 8 ? h + 12 : h, 0, '', m.index, m[0].length); } }
    // part-of-day words → default times (only if no explicit time)
    if (!time) {
      const POD = [[/\b(tonight|this evening|toi nay)\b/g, '19:00', 0], [/\b(this morning|sang nay)\b/g, '09:00', 0], [/\b(this afternoon|chieu nay)\b/g, '15:00', 0],
        [/\b(tomorrow night|tomorrow evening|toi mai)\b/g, '19:00', 1], [/\b(tomorrow morning|sang mai)\b/g, '09:00', 1], [/\b(tomorrow afternoon|chieu mai)\b/g, '15:00', 1]];
      for (const [re, t, d] of POD) { m = find(re); if (m) { time = t; take(m); date = date || addD(d); break; } }
    }

    // ---- date
    if (!date) {
      const REL = [
        [/\b(today|hom nay)\b/g, 0], [/\b(tomorrow|tmr|tmrw|ngay mai)\b/g, 1], [/(?<=\b(?:sang|chieu|toi|trua|dem) )mai\b/g, 1],
        [/\b(day after tomorrow|ngay kia|mot)\b/g, 2], [/\b(yesterday|hom qua)\b/g, -1],
      ];
      // "day after tomorrow" must win over "tomorrow"
      REL.sort((a, b) => b[0].source.length - a[0].source.length);
      for (const [re, n] of REL) { m = find(re); if (m) { date = addD(n); take(m); break; } }
    }
    if (!date) { m = find(/\bin (\d{1,3}) (day|days|week|weeks)\b/g); if (m) { date = addD(+m[1] * (m[2][0] === 'w' ? 7 : 1)); take(m); } }
    if (!date) { m = find(/\b(\d{1,3}) (ngay|tuan) nua\b/g); if (m) { date = addD(+m[1] * (m[2] === 'tuan' ? 7 : 1)); take(m); } }
    if (!date) { m = find(/\bnext week\b|\btuan sau\b|\btuan toi\b/g); if (m) { date = nextWeekday(base, 1, true); take(m); } }
    if (!date) {
      m = find(/\b(thu [2-7]|thu (?:hai|ba|tu|nam|sau|bay)|chu nhat)( tuan (?:sau|toi))?\b/g);
      if (m) { date = nextWeekday(base, VWD[m[1]], !!repeat, !!m[2]); take(m); }
    }
    if (!date) {
      m = find(/\b(?:on |this |next )?(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?\b(?! [2-7]\b)/g);
      if (m) { const nextWord = /\bnext /.test(m[0]); date = nextWeekday(base, WD[m[1]], !!repeat, nextWord); take(m); }
    }
    if (!date) { // Oct 12, 12 Oct, October 12th
      m = find(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?\b/g)
        || find(/\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:,? (\d{4}))?\b/g);
      if (m) {
        const monFirst = isNaN(+m[1]);
        const mo = MON[monFirst ? m[1] : m[2]], d = +(monFirst ? m[2] : m[1]);
        date = resolveDMY(base, d, mo, m[3]); if (date) take(m);
      }
    }
    if (!date) { // 12/10, 12/10/2026, 12-10 (day/month — Vietnamese order); "ngay 12/10", "ngay 12"
      m = find(/\b(?:ngay )?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g);
      if (m) { const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : null; date = resolveDMY(base, +m[1], +m[2], y); if (date) take(m); }
    }
    if (!date) { m = find(/\bngay (\d{1,2})\b/g); if (m) { date = resolveDMY(base, +m[1], null); if (date) take(m); } }
    if (!date) { m = find(/\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)\b/g); if (m) { date = resolveDMY(base, +m[1], null); if (date) take(m); } }

    // ---- title = everything not consumed, tidied
    let title = '';
    for (let i = 0; i < text.length; i++) if (free(i, i + 1)) title += text[i];
    title = title.replace(/\s+(at|on|luc|vao|in)\s*$/i, '').replace(/^\s*(at|on|luc|vao)\s+/i, '')
      .replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/g, '').trim();
    if (title) title = title[0].toUpperCase() + title.slice(1);
    if (allDay) time = '';
    used.sort((a, b) => a[0] - b[0]);
    return { title, date: date ? keyOf(date) : null, time, repeat, important, spans: used };
  }

  function nextWeekday(base, wd, allowToday, skipWeek) {
    const d = new Date(base);
    let diff = (wd - d.getDay() + 7) % 7;
    if (diff === 0 && !allowToday) diff = 7;
    if (skipWeek && diff < 7) diff += (diff === 0 ? 7 : 7);
    d.setDate(d.getDate() + diff);
    return d;
  }
  function resolveDMY(base, d, mo, y) {
    if (!d || d > 31) return null;
    let yy = y ? +y : base.getFullYear();
    let month = mo || base.getMonth() + 1;
    if (month < 1 || month > 12) return null;
    let dt = new Date(yy, month - 1, d);
    if (dt.getDate() !== d) return null;                 // e.g. Feb 30
    if (!y && dt < base) {                               // past → roll forward
      if (mo) dt = new Date(yy + 1, month - 1, d);
      else { dt = new Date(yy, month, d); if (dt.getDate() !== d) return null; }
    }
    return dt;
  }

  g.QuickAdd = { parse };
})(typeof self !== 'undefined' ? self : this);
