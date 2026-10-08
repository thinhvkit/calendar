/* Voice input + spoken answers.
 *  Voice.listen({ purpose }) -> Promise<string|null>   shows the listening sheet, resolves with what was said
 *  Voice.speak(text, lang)                                reads an answer aloud (speechSynthesis)
 * Uses the browser's built-in speech recognition (Safari: Apple, Chrome: Google). Audio goes to that
 * provider for transcription; only the resulting text is used by the calendar. When recognition isn't
 * available, callers fall back to the keyboard's dictation mic. */
(function (g) {
  'use strict';
  const SR = g.SpeechRecognition || g.webkitSpeechRecognition;
  const $ = id => document.getElementById(id);
  const LKEY = 'calendar-voice';
  const LANGS = { 'en-US': 'English', 'vi-VN': 'Tiếng Việt' };
  const st = (() => { try { return JSON.parse(localStorage.getItem(LKEY)) || {}; } catch { return {}; } })();
  const save = () => { try { localStorage.setItem(LKEY, JSON.stringify(st)); } catch {} };
  if (!LANGS[st.lang]) st.lang = /^vi\b/i.test(navigator.language || '') ? 'vi-VN' : 'en-US';
  if (st.speak == null) st.speak = true;

  const HINTS = {
    ask: { 'en-US': ['“What’s on tomorrow?”', '“Am I free this weekend?”', '“Add lunch with Mai Friday at noon”'],
           'vi-VN': ['“Ngày mai có gì?”', '“Cuối tuần này mình rảnh không?”', '“Thêm họp nhóm thứ 2 lúc 9 giờ”'] },
    add: { 'en-US': ['“Lunch with Mai tomorrow at 12:30”', '“Gym every Monday at 6:30 pm”', '“Dentist next Friday at 3”'],
           'vi-VN': ['“Ăn trưa với Mai ngày mai 12 giờ”', '“Tập gym hàng tuần thứ 3 6 giờ chiều”', '“Sinh nhật mẹ 20/10 hàng năm”'] },
  };

  let rec = null, resolveFn = null, finalText = '', interimText = '', purpose = 'ask', state = 'idle', gotSpeech = false, stopTimer = 0;

  function ui() {
    $('vcLang').querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === st.lang)));
    $('vcTitle').textContent = purpose === 'add' ? 'Say your event' : 'Ask or add by voice';
    const said = (finalText + ' ' + interimText).trim();
    $('vcText').innerHTML = said
      ? `<span class="fin">${esc(finalText)}</span> <span class="int">${esc(interimText)}</span>`
      : `<span class="ph">${state === 'error' ? '' : state === 'listening' ? 'Listening…' : 'Starting…'}</span>`;
    $('vcHints').innerHTML = said || state === 'error' ? '' : HINTS[purpose][st.lang].map(h => `<span>${esc(h)}</span>`).join('');
    $('voiceSheet').dataset.state = state;
    $('vcDone').disabled = !said;
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setError(msg) {
    state = 'error';
    $('vcErr').textContent = msg; $('vcErr').hidden = false;
    ui();
  }

  function start() {
    try { rec && rec.abort(); } catch {}
    finalText = ''; interimText = ''; gotSpeech = false; state = 'starting';
    $('vcErr').hidden = true;
    ui();
    if (!SR) { setError(noSupportMsg()); return; }
    rec = new SR();
    rec.lang = st.lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    rec.onstart = () => { state = 'listening'; ui(); };
    rec.onaudiostart = () => { state = 'listening'; ui(); };
    rec.onspeechstart = () => { gotSpeech = true; };
    rec.onresult = e => {
      let fin = '', int = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript; else int += r[0].transcript;
      }
      finalText = fin.trim(); interimText = int.trim(); gotSpeech = true;
      ui();
      // some engines never send "end" after a final result; finish shortly after one arrives
      clearTimeout(stopTimer);
      if (finalText && !interimText) stopTimer = setTimeout(() => finish(), 900);
    };
    rec.onerror = e => {
      const code = e.error || 'error';
      if (code === 'aborted') return;
      if (code === 'no-speech') return setError('I didn’t hear anything. Tap the mic and try again.');
      if (code === 'not-allowed' || code === 'service-not-allowed')
        return setError(/iPhone|iPad|iPod/.test(navigator.userAgent)
          ? 'Voice isn’t allowed yet. Allow the microphone when asked, and make sure Settings → General → Keyboard → Enable Dictation is on. You can also use the 🎤 on your keyboard.'
          : 'Microphone access is blocked. Allow the microphone for this site, or use your keyboard’s dictation.');
      if (code === 'network') return setError('Voice needs an internet connection on this device. You can still type, or use the 🎤 on your keyboard.');
      if (code === 'language-not-supported') return setError(`${LANGS[st.lang]} isn’t supported for voice on this device.`);
      setError('Voice stopped unexpectedly. Tap the mic to try again.');
    };
    rec.onend = () => {
      if (state === 'error') return;
      if (finalText || interimText) finish();
      else if (!gotSpeech) setError('I didn’t hear anything. Tap the mic and try again.');
      else { state = 'idle'; ui(); }
    };
    try { rec.start(); } catch (err) { setError('Voice couldn’t start. Tap the mic to try again.'); }
  }

  function finish(cancel) {
    clearTimeout(stopTimer);
    const text = cancel ? null : (finalText + ' ' + interimText).trim() || null;
    if (rec) { const r = rec; rec = null; r.onend = r.onerror = r.onresult = null; try { r.abort(); } catch {} }
    state = 'idle';
    const fn = resolveFn; resolveFn = null;
    if ($('voiceSheet').open) $('voiceSheet').close();
    if (fn) fn(text);
  }

  function listen(opts = {}) {
    purpose = opts.purpose || 'ask';
    if (resolveFn) finish(true);
    return new Promise(res => {
      resolveFn = res;
      const dlg = $('voiceSheet');
      $('vcPrivacy').hidden = !!st.seenPrivacy;
      if (!dlg.open) dlg.showModal();
      start();
    });
  }

  function noSupportMsg() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent)
      ? 'Voice input isn’t available here. Use the 🎤 on your keyboard instead.'
      : 'This browser doesn’t support voice input. Try Chrome, Edge or Safari, or use your keyboard’s dictation.';
  }

  /* ---------- speaking ---------- */
  let voices = [];
  const loadVoices = () => { try { voices = speechSynthesis.getVoices(); } catch {} };
  if ('speechSynthesis' in g) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  function speak(text, lang = 'en-US') {
    if (!st.speak || !('speechSynthesis' in g) || !text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 320));
      u.lang = lang;
      const v = voices.find(v => v.lang === lang && /enhanced|premium|natural|samantha|linh/i.test(v.name)) || voices.find(v => v.lang === lang) || voices.find(v => v.lang && v.lang.startsWith(lang.slice(0, 2)));
      if (v) u.voice = v;
      u.rate = 1.02;
      speechSynthesis.speak(u);
    } catch {}
  }
  const stopSpeaking = () => { try { speechSynthesis.cancel(); } catch {} };

  function wire() {
    const dlg = $('voiceSheet'); if (!dlg) return;
    $('vcLang').addEventListener('click', e => {
      const b = e.target.closest('[data-lang]'); if (!b || b.dataset.lang === st.lang) return;
      st.lang = b.dataset.lang; save(); start();
    });
    $('vcMic').onclick = () => { if (state === 'listening' && rec) { try { rec.stop(); } catch {} } else start(); };
    $('vcDone').onclick = () => finish();
    $('vcCancel').onclick = () => finish(true);
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(true); });
    dlg.addEventListener('click', e => { if (e.target === dlg) finish(true); });
    $('vcPrivacyOk').onclick = () => { st.seenPrivacy = true; save(); $('vcPrivacy').hidden = true; };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  g.Voice = {
    supported: !!SR, listen, speak, stopSpeaking,
    get lang() { return st.lang; },
    get speakOn() { return st.speak; }, set speakOn(v) { st.speak = !!v; save(); if (!v) stopSpeaking(); },
    get canSpeak() { return 'speechSynthesis' in g; },
  };
})(self);
