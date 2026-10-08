/* Vietnamese lunar calendar (âm lịch), UTC+7.
 * Algorithm: Hồ Ngọc Đức, "Computing the Vietnamese lunar calendar" (astronomical new moons
 * and solar terms, Jean Meeus formulas). Pure functions, no DOM — usable from page and worker.
 *   Lunar.fromSolar(y, m, d) -> { day, month, year, leap, yearName }
 *   Lunar.holiday(y, m, d)   -> { name, short, lunar } | null
 */
(function (g) {
  'use strict';
  const TZ = 7, PI = Math.PI, dr = PI / 180;
  const INT = Math.floor;

  function jdFromDate(dd, mm, yy) {
    const a = INT((14 - mm) / 12), y = yy + 4800 - a, m = mm + 12 * a - 3;
    let jd = dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - INT(y / 100) + INT(y / 400) - 32045;
    if (jd < 2299161) jd = dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - 32083;
    return jd;
  }
  function newMoonDay(k) {
    const T = k / 1236.85, T2 = T * T, T3 = T2 * T;
    let Jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
    Jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
    const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
    const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
    const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
    let C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
    C1 = C1 - 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(dr * 2 * Mpr);
    C1 = C1 - 0.0004 * Math.sin(dr * 3 * Mpr);
    C1 = C1 + 0.0104 * Math.sin(dr * 2 * F) - 0.0051 * Math.sin(dr * (M + Mpr));
    C1 = C1 - 0.0074 * Math.sin(dr * (M - Mpr)) + 0.0004 * Math.sin(dr * (2 * F + M));
    C1 = C1 - 0.0004 * Math.sin(dr * (2 * F - M)) - 0.0006 * Math.sin(dr * (2 * F + Mpr));
    C1 = C1 + 0.0010 * Math.sin(dr * (2 * F - Mpr)) + 0.0005 * Math.sin(dr * (2 * Mpr + M));
    const deltat = T < -11
      ? 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3
      : -0.000278 + 0.000265 * T + 0.000262 * T2;
    return INT(Jd1 + C1 - deltat + 0.5 + TZ / 24);
  }
  function sunLongitude(jdn) {
    const T = (jdn - 2451545.5 - TZ / 24) / 36525, T2 = T * T;
    const M = 357.52910 + 35999.05030 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
    const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
    let DL = (1.914600 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
    DL += (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.000290 * Math.sin(dr * 3 * M);
    let L = (L0 + DL) * dr;
    L -= PI * 2 * INT(L / (PI * 2));
    return INT(L / PI * 6);
  }
  function lunarMonth11(yy) {
    const k = INT((jdFromDate(31, 12, yy) - 2415021) / 29.530588853);
    const nm = newMoonDay(k);
    return sunLongitude(nm) >= 9 ? newMoonDay(k - 1) : nm;
  }
  function leapMonthOffset(a11) {
    const k = INT((a11 - 2415021.076998695) / 29.530588853 + 0.5);
    let last, i = 1, arc = sunLongitude(newMoonDay(k + i));
    do { last = arc; i++; arc = sunLongitude(newMoonDay(k + i)); } while (arc !== last && i < 14);
    return i - 1;
  }

  const cache = new Map();
  function fromSolar(yy, mm, dd) {
    const key = yy * 10000 + mm * 100 + dd;
    if (cache.has(key)) return cache.get(key);
    const dayNumber = jdFromDate(dd, mm, yy);
    const k = INT((dayNumber - 2415021.076998695) / 29.530588853);
    let monthStart = newMoonDay(k + 1);
    if (monthStart > dayNumber) monthStart = newMoonDay(k);
    let a11 = lunarMonth11(yy), b11 = a11, year;
    if (a11 >= monthStart) { year = yy; a11 = lunarMonth11(yy - 1); }
    else { year = yy + 1; b11 = lunarMonth11(yy + 1); }
    const day = dayNumber - monthStart + 1;
    const diff = INT((monthStart - a11) / 29);
    let leap = false, month = diff + 11;
    if (b11 - a11 > 365) {
      const lm = leapMonthOffset(a11);
      if (diff >= lm) { month = diff + 10; if (diff === lm) leap = true; }
    }
    if (month > 12) month -= 12;
    if (month >= 11 && diff < 4) year -= 1;
    const out = { day, month, year, leap, yearName: yearName(year) };
    if (cache.size > 4000) cache.clear();
    cache.set(key, out);
    return out;
  }

  const CAN = ['Giáp', 'Ất', 'Bính', 'Đinh', 'Mậu', 'Kỷ', 'Canh', 'Tân', 'Nhâm', 'Quý'];
  const CHI = ['Tý', 'Sửu', 'Dần', 'Mão', 'Thìn', 'Tỵ', 'Ngọ', 'Mùi', 'Thân', 'Dậu', 'Tuất', 'Hợi'];
  const yearName = y => `${CAN[(y + 6) % 10]} ${CHI[(y + 8) % 12]}`;

  // Holidays — Vietnamese public holidays and widely observed days.
  const SOLAR = {
    '1-1': ['Tết Dương lịch', 'New Year’s Day'],
    '2-14': ['Valentine', 'Valentine’s Day'],
    '3-8': ['Quốc tế Phụ nữ', 'International Women’s Day'],
    '4-30': ['Giải phóng miền Nam', 'Reunification Day'],
    '5-1': ['Quốc tế Lao động', 'Labour Day'],
    '6-1': ['Quốc tế Thiếu nhi', 'Children’s Day'],
    '9-2': ['Quốc khánh', 'National Day'],
    '10-20': ['Phụ nữ Việt Nam', 'Vietnamese Women’s Day'],
    '11-20': ['Nhà giáo Việt Nam', 'Teachers’ Day'],
    '12-24': ['Đêm Giáng sinh', 'Christmas Eve'],
    '12-25': ['Giáng sinh', 'Christmas Day'],
  };
  const LUNAR = {
    '1-1': ['Tết Nguyên Đán', 'Lunar New Year'],
    '1-2': ['Mùng 2 Tết', 'Lunar New Year (day 2)'],
    '1-3': ['Mùng 3 Tết', 'Lunar New Year (day 3)'],
    '1-15': ['Rằm tháng Giêng', 'Lantern Festival'],
    '3-3': ['Tết Hàn thực', 'Cold Food Festival'],
    '3-10': ['Giỗ Tổ Hùng Vương', 'Hung Kings’ Day'],
    '4-15': ['Lễ Phật Đản', 'Buddha’s Birthday'],
    '5-5': ['Tết Đoan Ngọ', 'Double Fifth Festival'],
    '7-15': ['Lễ Vu Lan', 'Ghost Festival'],
    '8-15': ['Tết Trung Thu', 'Mid-Autumn Festival'],
    '12-23': ['Ông Công Ông Táo', 'Kitchen Gods’ Day'],
  };
  const PUBLIC = new Set(['s1-1', 's4-30', 's5-1', 's9-2', 'l1-1', 'l1-2', 'l1-3', 'l3-10', 'l12-30']);

  function holiday(y, m, d) {
    const L = fromSolar(y, m, d);
    if (!L.leap) {
      // Giao thừa: the last day of the 12th lunar month (29 or 30)
      if (L.month === 12 && L.day >= 29) {
        const t = new Date(y, m - 1, d + 1), n = fromSolar(t.getFullYear(), t.getMonth() + 1, t.getDate());
        if (n.month === 1 && n.day === 1) return { name: 'Giao thừa', en: 'Lunar New Year’s Eve', lunar: true, off: true };
      }
      const l = LUNAR[`${L.month}-${L.day}`];
      if (l) return { name: l[0], en: l[1], lunar: true, off: PUBLIC.has(`l${L.month}-${L.day}`) };
    }
    const s = SOLAR[`${m}-${d}`];
    if (s) return { name: s[0], en: s[1], lunar: false, off: PUBLIC.has(`s${m}-${d}`) };
    return null;
  }

  g.Lunar = { fromSolar, holiday, yearName };
})(typeof self !== 'undefined' ? self : this);
