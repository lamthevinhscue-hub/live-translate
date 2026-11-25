/* =====================================================================
   Live Translate – Dịch hội thoại trực tiếp hai chiều
   Kiến trúc: [Âm thanh] → [Nhận diện giọng nói + phát hiện ngôn ngữ]
              → [Dịch văn bản sang ngôn ngữ còn lại] → [Hiển thị]
   ===================================================================== */
'use strict';

/* ---------- 1. Danh mục ngôn ngữ ---------- */
const LANGS = {
  vi: { name: 'Tiếng Việt',        flag: '🇻🇳', speech: 'vi-VN', g: 'vi',    az: 'vi',      en: 'Vietnamese' },
  en: { name: 'English',           flag: '🇬🇧', speech: 'en-US', g: 'en',    az: 'en',      en: 'English' },
  zh: { name: '中文 (Tiếng Hoa)',   flag: '🇨🇳', speech: 'zh-CN', g: 'zh-CN', az: 'zh-Hans', en: 'Simplified Chinese (Mandarin)' },
  ja: { name: '日本語 (Tiếng Nhật)', flag: '🇯🇵', speech: 'ja-JP', g: 'ja',    az: 'ja',      en: 'Japanese' },
  ko: { name: '한국어 (Tiếng Hàn)',  flag: '🇰🇷', speech: 'ko-KR', g: 'ko',    az: 'ko',      en: 'Korean' },
  de: { name: 'Deutsch (Tiếng Đức)', flag: '🇩🇪', speech: 'de-DE', g: 'de',    az: 'de',      en: 'German' },
  fr: { name: 'Français (Tiếng Pháp)', flag: '🇫🇷', speech: 'fr-FR', g: 'fr',  az: 'fr',      en: 'French' },
};
const SDK_URLS = [
  'https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@latest/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js',
  'https://aka.ms/csspeech/jsbrowserpackageraw',
];

/* ---------- 2. Cài đặt (lưu trong localStorage) ---------- */
const DEFAULTS = {
  langA: 'vi', langB: 'en', engine: 'webspeech', source: 'mic', viewMode: 'chat',
  fontSize: 28, showOrig: true, theme: 'dark',
  azKey: '', azRegion: 'southeastasia', silenceMs: 600,
  trProvider: 'google', liveTr: '1', trKey: '', trRegion: '', oaKey: '', oaModel: 'gpt-5.4-mini',
  context: '', glossary: '', micId: '', maxItems: 200,
  direction: 'two', engineChosen: false,
  stageTitle: '', stageLines: 8, stageBg: '#2b2f9e', stageFg: '#f3eea0',
};
const store = {
  get() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('liveTranslate.v1') || '{}') }; } catch { return { ...DEFAULTS }; } },
  set(v) { try { localStorage.setItem('liveTranslate.v1', JSON.stringify(v)); } catch { /* bỏ qua */ } },
};
let cfg = store.get();
if (!cfg.azKey && cfg.engine === 'azure') cfg.engine = 'webspeech';
// Đã có khóa Azure và người dùng chưa tự chọn công cụ -> dùng Azure làm mặc định
if (cfg.azKey && cfg.azRegion && !cfg.engineChosen) cfg.engine = 'azure';

/* ---------- 3. Trạng thái ---------- */
const state = {
  running: false, entries: [], live: null, seq: 0,
  speaker: 'A',              // dùng cho chế độ Web Speech
  lastSrc: null,             // ngôn ngữ của người nói gần nhất
  engine: null,              // đối tượng engine đang chạy
  streams: [], audioCtx: null, wakeLock: null,
  cache: new Map(),
  sessionStart: null,        // thời điểm bắt đầu phiên đầu tiên (cho biên bản)
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const langKeyA = () => cfg.langA;
const langKeyB = () => cfg.langB;
const otherOf = (k) => (k === cfg.langA ? cfg.langB : cfg.langA);
const oneWay = () => cfg.direction === 'one';

/* ---------- 4. Thông báo & trạng thái ---------- */
let toastTimer;
function toast(msg, isErr = false, ms = 4500) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}
function setStatus(text, kind = '') {
  $('stText').textContent = text;
  $('stDot').className = 'dot' + (kind ? ' ' + kind : '');
}

/* ---------- 5. Đoán ngôn ngữ theo chữ viết (dự phòng) ---------- */
function guessByScript(text) {
  const t = text || '';
  const pick = (k) => (k === cfg.langA || k === cfg.langB ? k : null);
  if (/[가-힯ᄀ-ᇿ]/.test(t)) return pick('ko');
  if (/[぀-ヿ]/.test(t)) return pick('ja') || pick('zh');
  if (/[一-鿿]/.test(t)) return pick('zh') || pick('ja');
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(t)) return pick('vi');
  if (/[äöüß]/i.test(t)) return pick('de');
  if (/[çéèêëîïœàùûÿ]/i.test(t)) return pick('fr');
  return null;
}
function mapLocale(locale, text) {
  const l = (locale || '').toLowerCase();
  for (const k of [cfg.langA, cfg.langB]) {
    if (l && (l === LANGS[k].speech.toLowerCase() || l.startsWith(k))) return k;
  }
  return guessByScript(text) || state.lastSrc || cfg.langA;
}

/* ---------- 6. Dịch văn bản ---------- */
function glossaryLines() {
  return (cfg.glossary || '').split('\n').map((s) => s.trim()).filter(Boolean);
}
async function translate(text, from, to, { partial = false } = {}) {
  if (!text.trim() || from === to) return text;
  const key = `${cfg.trProvider}|${from}|${to}|${text}`;
  if (state.cache.has(key)) return state.cache.get(key);
  const chain = [cfg.trProvider, 'google', 'mymemory'].filter((v, i, a) => a.indexOf(v) === i);
  let lastErr;
  for (const p of chain) {
    try {
      let out;
      if (p === 'openai') out = await trOpenAI(text, from, to, partial);
      else if (p === 'azure') out = await trAzure(text, from, to);
      else if (p === 'google') out = await trGoogle(text, from, to);
      else out = await trMyMemory(text, from, to);
      if (out && out.trim()) {
        if (state.cache.size > 2000) state.cache.clear();
        state.cache.set(key, out.trim());
        $('stProvider').textContent = 'Dịch: ' + ({ openai: 'OpenAI', azure: 'Azure Translator', google: 'Google', mymemory: 'MyMemory' }[p]);
        return out.trim();
      }
    } catch (e) { lastErr = e; if (p === 'openai' && !cfg.oaKey) continue; if (p === 'azure' && !cfg.trKey) continue; console.warn('Dịch lỗi qua', p, e); }
  }
  throw lastErr || new Error('Không dịch được');
}
async function trGoogle(text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + `&sl=${LANGS[from].g}&tl=${LANGS[to].g}&q=${encodeURIComponent(text)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Google HTTP ' + r.status);
  const d = await r.json();
  return (d[0] || []).map((x) => x[0]).join('');
}
async function trMyMemory(text, from, to) {
  const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${LANGS[from].g}|${LANGS[to].g}`);
  if (!r.ok) throw new Error('MyMemory HTTP ' + r.status);
  const d = await r.json();
  return d?.responseData?.translatedText || '';
}
async function trAzure(text, from, to) {
  if (!cfg.trKey) throw new Error('Chưa nhập Azure Translator key');
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': cfg.trKey };
  if (cfg.trRegion) headers['Ocp-Apim-Subscription-Region'] = cfg.trRegion;
  const r = await fetch(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${LANGS[from].az}&to=${LANGS[to].az}`,
    { method: 'POST', headers, body: JSON.stringify([{ Text: text }]) });
  if (!r.ok) throw new Error('Azure Translator HTTP ' + r.status);
  const d = await r.json();
  return d?.[0]?.translations?.[0]?.text || '';
}
async function trOpenAI(text, from, to, partial) {
  if (!cfg.oaKey) throw new Error('Chưa nhập OpenAI API key');
  const recent = state.entries.filter((e) => e.final).slice(-4)
    .map((e) => `[${LANGS[e.src].en}] ${e.original}`).join('\n');
  const gl = glossaryLines();
  const sys = [
    `You are a professional simultaneous interpreter. Translate the user's utterance from ${LANGS[from].en} into ${LANGS[to].en}.`,
    'Output ONLY the translation, no quotes, no notes. Keep numbers, amounts, dates, names and acronyms exact.',
    'Use natural, polite business register. The text comes from live speech recognition and may contain recognition errors or be an unfinished sentence: translate the intended meaning faithfully without adding content.',
    cfg.context ? `Meeting context: ${cfg.context}` : '',
    gl.length ? `Glossary / proper nouns (use these renderings):\n${gl.join('\n')}` : '',
    recent ? `Recent conversation for context (do not translate):\n${recent}` : '',
  ].filter(Boolean).join('\n\n');
  const model = (cfg.oaModel || 'gpt-4o-mini').trim();
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: text }];
  const limit = partial ? 300 : 800;
  // Model suy luận (GPT-5.x, o-series) không nhận temperature/max_tokens; tắt suy luận để dịch nhanh
  const reasoning = /^(gpt-5|o\d)/i.test(model);
  const bodies = reasoning
    ? [
      { model, messages, max_completion_tokens: limit, reasoning_effort: 'none' },
      { model, messages, max_completion_tokens: limit, reasoning_effort: 'minimal' },
      { model, messages, max_completion_tokens: limit },
    ]
    : [{ model, messages, temperature: 0.2, max_tokens: limit }];
  let lastErr;
  for (const body of bodies) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.oaKey },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const d = await r.json();
      return d?.choices?.[0]?.message?.content || '';
    }
    const msg = (await r.text()).slice(0, 200);
    lastErr = new Error('OpenAI HTTP ' + r.status + ' ' + msg);
    // Chỉ thử cấu hình kế tiếp khi lỗi do tham số không được hỗ trợ
    if (r.status !== 400 || !/reasoning|parameter|unsupported/i.test(msg)) break;
  }
  throw lastErr;
}

/* ---------- 7. Xử lý kết quả nhận diện ---------- */
let liveTimer = null;
function onPartial(text, src) {
  if (!text) return;
  if (oneWay()) src = cfg.langA;
  if (!state.live) {
    state.live = { id: ++state.seq, src, tgt: otherOf(src), original: '', translation: '', final: false, time: new Date(), trSeq: 0 };
  }
  const L = state.live;
  L.src = src; L.tgt = otherOf(src); L.original = text;
  $('stLang').textContent = `Đang nói: ${LANGS[src].flag} ${LANGS[src].name}`;
  scheduleRender();
  if (cfg.liveTr === '1') {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => runTranslate(L, true), 450);
  }
}
function onFinal(text, src) {
  clearTimeout(liveTimer);
  if (oneWay()) src = cfg.langA;
  if (!text || !text.trim()) { state.live = null; scheduleRender(); return; }
  const L = state.live || { id: ++state.seq, time: new Date(), trSeq: 0 };
  Object.assign(L, { src, tgt: otherOf(src), original: text.trim(), final: true });
  state.live = null;
  state.entries.push(L);
  state.lastSrc = src;
  L.t0 = performance.now();
  scheduleRender();
  runTranslate(L, false);
}
async function runTranslate(entry, partial) {
  const mySeq = ++entry.trSeq;
  const text = entry.original;
  try {
    const out = await translate(text, entry.src, entry.tgt, { partial });
    if (mySeq !== entry.trSeq) return;          // đã có yêu cầu dịch mới hơn
    entry.translation = out;
    if (!partial && entry.t0) $('stLatency').textContent = `Độ trễ dịch: ${Math.round(performance.now() - entry.t0)} ms`;
    scheduleRender();
  } catch (e) {
    if (!partial) { entry.translation = '⚠ ' + (e.message || 'Lỗi dịch'); scheduleRender(); }
  }
}

/* ---------- 8. Hiển thị ---------- */
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}
function nearBottom(el) { return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120; }
function timeStr(d) { return d.toLocaleTimeString('vi-VN', { hour12: false }); }
function textIn(entry, lang) {
  if (entry.src === lang) return { text: entry.original, own: true };
  return { text: entry.translation || '…', own: false };
}
function render() {
  const main = $('main');
  const list = state.entries.slice(-cfg.maxItems);
  if (state.live) list.push(state.live);
  const scrollers = [...main.querySelectorAll('.view, .col')];
  const stick = scrollers.map(nearBottom);

  if (cfg.viewMode === 'stage') { renderStage(list); return; }
  if (!list.length) {
    const tip = oneWay()
      ? `Dịch một chiều: mọi lời nói bằng <b>${esc(LANGS[cfg.langA].name)}</b> được dịch sang <b>${esc(LANGS[cfg.langB].name)}</b> – phù hợp thuyết trình, hội thảo.`
      : cfg.engine === 'webspeech'
        ? 'Chế độ miễn phí: bấm <b>Người nói A/B</b> (hoặc phím <b>Space</b>) trước khi mỗi bên nói.'
        : 'Ứng dụng tự nhận biết người nói đang dùng ngôn ngữ nào và dịch sang ngôn ngữ còn lại.';
    main.innerHTML = `<div class="view"><div class="empty">Chọn hai ngôn ngữ, sau đó bấm <b>▶ Bắt đầu</b>.<br>
      ${LANGS[cfg.langA].flag} <b>${esc(LANGS[cfg.langA].name)}</b> ⇄ ${LANGS[cfg.langB].flag} <b>${esc(LANGS[cfg.langB].name)}</b><br>${tip}</div></div>`;
    return;
  }

  if (cfg.viewMode === 'chat') {
    main.innerHTML = '<div class="view">' + list.map((e) => `
      <div class="msg ${e.src === cfg.langB ? 'side-b' : ''} ${e.final ? '' : 'live'}">
        <div class="meta"><span>${timeStr(e.time)}</span><span>${LANGS[e.src].flag} → ${LANGS[e.tgt].flag}</span></div>
        <div class="tr">${esc(e.translation || (e.final ? '…' : ''))}</div>
        <div class="orig">${esc(e.original)}</div>
      </div>`).join('') + '</div>';
  } else {
    const col = (lang, extra = '') => {
      const L = LANGS[lang];
      return `<div class="col ${extra}"><h3>${L.flag} Hiển thị bằng ${esc(L.name)}</h3>` + list.map((e) => {
        const t = textIn(e, lang);
        if (t.own && !cfg.showOrig) return '';
        return `<div class="line ${t.own ? 'own' : ''} from-${e.src === cfg.langA ? 'a' : 'b'} ${e.final ? '' : 'live'}">${esc(t.text)}</div>`;
      }).join('') + '</div>';
    };
    main.innerHTML = cfg.viewMode === 'split'
      ? `<div class="split">${col(cfg.langA)}${col(cfg.langB)}</div>`
      : `<div class="face">${col(cfg.langB, 'top')}${col(cfg.langA)}</div>`;
  }
  const newScrollers = [...main.querySelectorAll('.view, .col')];
  newScrollers.forEach((el, i) => {
    const isTop = el.classList.contains('top');
    if (stick[i] ?? true) el.scrollTop = isTop ? el.scrollHeight : el.scrollHeight;
  });
}

/* Phụ đề sân khấu: hai cột chữ chạy liền, cột trái lời gốc, cột phải bản dịch */
function renderStage(list) {
  const main = $('main');
  let stage = main.querySelector('.stage');
  if (!stage) {
    main.innerHTML = `<div class="stage"><div class="stage-banner"></div>
      <div class="stage-cols"><div class="stage-col" id="stOrig"></div><div class="stage-col" id="stTr"></div></div></div>`;
    stage = main.querySelector('.stage');
  }
  stage.style.setProperty('--sbg', cfg.stageBg);
  stage.style.setProperty('--sfg', cfg.stageFg);
  stage.style.setProperty('--slines', cfg.stageLines);
  stage.querySelector('.stage-banner').textContent = cfg.stageTitle || '';
  const recent = list.slice(-40);
  const build = (pick) => {
    let html = '', prev = null, open = false;
    for (const e of recent) {
      const t = pick(e);
      if (!t) continue;
      if (prev !== e.src) { html += (open ? '</p>' : '') + '<p>'; open = true; }
      html += `<span class="${e.final ? '' : 'live'}">${esc(t)} </span>`;
      prev = e.src;
    }
    return html + (open ? '</p>' : '');
  };
  const set = (el, html) => {
    if (el.innerHTML === html) return;
    el.innerHTML = html;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  if (!recent.length) {
    $('stOrig').innerHTML = `<p style="opacity:.6">${esc(LANGS[cfg.langA].name)} – lời nói gốc sẽ hiển thị tại đây</p>`;
    $('stTr').innerHTML = `<p style="opacity:.6">${esc(LANGS[cfg.langB].name)} – bản dịch sẽ hiển thị tại đây</p>`;
    return;
  }
  set($('stOrig'), build((e) => e.original));
  set($('stTr'), build((e) => e.translation));
}

/* ---------- 9. Âm thanh: micro / âm thanh tab / trộn ---------- */
async function getMic() {
  const s = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: cfg.micId ? { exact: cfg.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  state.streams.push(s);
  return s;
}
async function getTabAudio() {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  state.streams.push(s);
  s.getVideoTracks().forEach((t) => t.stop());     // chỉ cần âm thanh
  if (!s.getAudioTracks().length) throw new Error('Chưa chia sẻ âm thanh. Khi chọn tab/màn hình, hãy tích ô “Chia sẻ âm thanh”.');
  s.getAudioTracks()[0].addEventListener('ended', () => { if (state.running) { toast('Đã dừng chia sẻ âm thanh.'); stop(); } });
  return new MediaStream(s.getAudioTracks());
}
async function getAudioStream() {
  if (cfg.source === 'mic') return getMic();
  if (cfg.source === 'tab') return getTabAudio();
  const [tab, mic] = [await getTabAudio(), await getMic()];
  const ctx = ensureCtx();
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(tab).connect(dest);
  ctx.createMediaStreamSource(mic).connect(dest);
  return dest.stream;
}
function ensureCtx() {
  if (!state.audioCtx || state.audioCtx.state === 'closed') state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioCtx;
}
let meterRAF;
function startMeter(stream) {
  try {
    const ctx = ensureCtx();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const bar = document.querySelector('#meter i');
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      bar.style.width = Math.min(100, peak * 1.6) + '%';
      meterRAF = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) { console.warn(e); }
}
function releaseAudio() {
  cancelAnimationFrame(meterRAF);
  const bar = document.querySelector('#meter i'); if (bar) bar.style.width = '0';
  state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  state.streams = [];
  if (state.audioCtx) { state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
}

/* ---------- 10. Engine 1: Azure Speech (tự phát hiện ngôn ngữ liên tục) ---------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Không tải được ' + src));
    document.head.appendChild(s);
  });
}
async function ensureSDK() {
  if (window.SpeechSDK) return window.SpeechSDK;
  for (const u of SDK_URLS) { try { await loadScript(u); if (window.SpeechSDK) return window.SpeechSDK; } catch (e) { console.warn(e); } }
  throw new Error('Không tải được Azure Speech SDK (kiểm tra kết nối Internet).');
}
async function startAzure() {
  if (!cfg.azKey || !cfg.azRegion) { openSettings(); throw new Error('Vui lòng nhập Azure Speech key và region.'); }
  const S = await ensureSDK();
  const stream = await getAudioStream();
  startMeter(stream);

  const sc = oneWay()
    ? S.SpeechConfig.fromSubscription(cfg.azKey.trim(), cfg.azRegion.trim())
    : S.SpeechConfig.fromEndpoint(new URL(`wss://${cfg.azRegion.trim()}.stt.speech.microsoft.com/speech/universal/v2`), cfg.azKey.trim());
  if (oneWay()) sc.speechRecognitionLanguage = LANGS[cfg.langA].speech;
  else sc.setProperty(S.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
  if (S.PropertyId.Speech_SegmentationSilenceTimeoutMs !== undefined) {
    sc.setProperty(S.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(cfg.silenceMs || 600));
  }
  try { sc.setProfanity(S.ProfanityOption.Raw); } catch { /* bỏ qua */ }
  const audio = S.AudioConfig.fromStreamInput(stream);
  const rec = oneWay()
    ? new S.SpeechRecognizer(sc, audio)
    : S.SpeechRecognizer.FromConfig(sc, S.AutoDetectSourceLanguageConfig.fromLanguages([LANGS[cfg.langA].speech, LANGS[cfg.langB].speech]), audio);

  try {
    const pl = S.PhraseListGrammar.fromRecognizer(rec);
    glossaryLines().forEach((l) => pl.addPhrase(l.split('=')[0].trim()));
  } catch { /* phrase list không bắt buộc */ }

  const detect = (result) => {
    try { const r = S.AutoDetectSourceLanguageResult.fromResult(result); if (r && r.language) return r.language; } catch { /* */ }
    try { return result.properties.getProperty(S.PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult); } catch { return ''; }
  };
  rec.recognizing = (_, e) => onPartial(e.result.text, mapLocale(detect(e.result), e.result.text));
  rec.recognized = (_, e) => {
    if (e.result.reason === S.ResultReason.RecognizedSpeech) onFinal(e.result.text, mapLocale(detect(e.result), e.result.text));
  };
  rec.canceled = (_, e) => {
    if (e.reason === S.CancellationReason.Error) {
      toast('Azure Speech báo lỗi: ' + (e.errorDetails || e.errorCode) + '. Kiểm tra key/region.', true, 8000);
      setStatus('Lỗi kết nối Azure', 'err');
      stop();
    }
  };
  await new Promise((res, rej) => rec.startContinuousRecognitionAsync(res, (err) => rej(new Error(err))));
  return {
    stop: () => new Promise((res) => rec.stopContinuousRecognitionAsync(() => { rec.close(); res(); }, () => { try { rec.close(); } catch { /* */ } res(); })),
  };
}

/* ---------- 11. Engine 2: Web Speech API (miễn phí, chọn người nói thủ công) ---------- */
async function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error('Trình duyệt không hỗ trợ Web Speech API. Hãy dùng Google Chrome hoặc Microsoft Edge.');
  if (cfg.source !== 'mic') toast('Chế độ miễn phí chỉ nghe từ micro mặc định. Muốn dịch âm thanh họp online, hãy dùng Azure Speech.', false, 7000);
  try { startMeter(await getMic()); } catch (e) { throw new Error('Không truy cập được micro: ' + e.message); }

  let rec = null, alive = true, restartTimer;
  const create = () => {
    rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.lang = LANGS[currentSpeakerLang()].speech;
    rec.onresult = (ev) => {
      const src = currentSpeakerLang();
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) onFinal(r[0].transcript, src); else interim += r[0].transcript;
      }
      if (interim) onPartial(interim, src);
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { toast('Trình duyệt chặn micro. Hãy cho phép micro rồi thử lại.', true); stop(); }
      else if (ev.error === 'network') toast('Lỗi mạng khi nhận diện giọng nói – đang thử kết nối lại…', true);
    };
    rec.onend = () => {
      if (state.live) onFinal(state.live.original, state.live.src);   // chốt câu dở dang
      if (alive && state.running) { clearTimeout(restartTimer); restartTimer = setTimeout(() => { try { create(); rec.start(); } catch (e) { console.warn(e); } }, 120); }
    };
  };
  create(); rec.start();
  return {
    switchLang: () => { try { rec.stop(); } catch { /* onend sẽ khởi động lại với ngôn ngữ mới */ } },
    stop: async () => { alive = false; clearTimeout(restartTimer); try { rec.stop(); } catch { /* */ } },
  };
}
function currentSpeakerLang() { return (oneWay() || state.speaker === 'A') ? cfg.langA : cfg.langB; }
function setSpeaker(s) {
  if (state.speaker === s) return;
  state.speaker = s;
  updateSpeakerBar();
  if (state.running && state.engine?.switchLang) state.engine.switchLang();
}
function updateSpeakerBar() {
  $('speakerBar').classList.toggle('show', cfg.engine === 'webspeech' && !oneWay());
  $('spkA').textContent = `${LANGS[cfg.langA].flag} Người nói A – ${LANGS[cfg.langA].name}`;
  $('spkB').textContent = `${LANGS[cfg.langB].flag} Người nói B – ${LANGS[cfg.langB].name}`;
  $('spkA').classList.toggle('active', state.speaker === 'A');
  $('spkB').classList.toggle('active', state.speaker === 'B');
}

/* ---------- 12. Bắt đầu / Dừng ---------- */
async function start() {
  if (cfg.langA === cfg.langB) { toast('Hai ngôn ngữ phải khác nhau.', true); return; }
  if (!window.isSecureContext) toast('Nên mở ứng dụng qua http://localhost (chạy file Chay_ung_dung.bat) để trình duyệt cho phép dùng micro.', true, 8000);
  setStatus('Đang kết nối…');
  $('startBtn').disabled = true;
  try {
    state.running = true;
    state.engine = cfg.engine === 'azure' ? await startAzure() : await startWebSpeech();
    if (!state.sessionStart) state.sessionStart = new Date();
    setStatus(oneWay() ? `Đang nghe – dịch một chiều ${cfg.langA.toUpperCase()} → ${cfg.langB.toUpperCase()}`
      : cfg.engine === 'azure' ? 'Đang nghe – tự nhận diện ngôn ngữ' : 'Đang nghe – chế độ miễn phí', 'on');
    $('startBtn').textContent = '■ Dừng';
    $('startBtn').classList.add('running');
    try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* không bắt buộc */ }
  } catch (e) {
    state.running = false; state.engine = null; releaseAudio();
    setStatus('Chưa chạy', 'err');
    toast(e.message || String(e), true, 8000);
  } finally { $('startBtn').disabled = false; }
}
async function stop() {
  if (!state.running) return;
  state.running = false;
  const eng = state.engine; state.engine = null;
  try { await eng?.stop(); } catch { /* */ }
  if (state.live) onFinal(state.live.original, state.live.src);
  releaseAudio();
  try { await state.wakeLock?.release(); } catch { /* */ }
  setStatus('Đã dừng');
  $('startBtn').textContent = '▶ Bắt đầu';
  $('startBtn').classList.remove('running');
}
async function restartIfRunning() { if (state.running) { await stop(); await start(); } }

/* ---------- 13. Xuất biên bản ---------- */
function exportTxt() {
  if (!state.entries.length) { toast('Chưa có nội dung để xuất.'); return; }
  const d = new Date();
  const lines = [
    'BIÊN BẢN HỘI THOẠI CÓ DỊCH TỰ ĐỘNG',
    `Thời gian xuất: ${d.toLocaleString('vi-VN')}`,
    `Cặp ngôn ngữ: ${LANGS[cfg.langA].name} ⇄ ${LANGS[cfg.langB].name}`,
    cfg.context ? `Bối cảnh: ${cfg.context}` : '',
    '='.repeat(60), '',
  ].filter((x) => x !== '');
  state.entries.forEach((e) => {
    lines.push(`[${timeStr(e.time)}] ${e.src.toUpperCase()} → ${e.tgt.toUpperCase()}`);
    lines.push(`  Gốc : ${e.original}`);
    lines.push(`  Dịch: ${e.translation}`);
    lines.push('');
  });
  const pad = (n) => String(n).padStart(2, '0');
  const name = `BienBan_Dich_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- 14. Cài đặt ---------- */
const FIELDS = ['azKey', 'azRegion', 'silenceMs', 'trProvider', 'liveTr', 'trKey', 'trRegion', 'oaKey', 'oaModel', 'context', 'glossary', 'maxItems',
  'stageTitle', 'stageLines', 'stageBg', 'stageFg'];
async function openSettings() {
  // Model OpenAI đã lưu nhưng không có trong danh sách -> thêm vào để không mất lựa chọn
  if (cfg.oaModel && ![...$('oaModel').options].some((o) => o.value === cfg.oaModel)) {
    $('oaModel').add(new Option(cfg.oaModel, cfg.oaModel));
  }
  FIELDS.forEach((f) => { $(f).value = cfg[f] ?? ''; });
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    $('micSel').innerHTML = '<option value="">Mặc định của hệ thống</option>' +
      devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Micro ' + (i + 1))}</option>`).join('');
    $('micSel').value = cfg.micId || '';
  } catch { /* */ }
  $('settings').showModal();
}
function readSettings() {
  const hadAzure = !!cfg.azKey;
  FIELDS.forEach((f) => { cfg[f] = $(f).value.trim(); });
  cfg.stageLines = Math.min(20, Math.max(3, parseInt(cfg.stageLines, 10) || 8));
  if (cfg.oaKey && !cfg.oaKey.startsWith('sk-')) {
    toast(cfg.oaKey === cfg.azKey
      ? '⚠ Ô OpenAI API key đang chứa khóa Azure. Khóa OpenAI phải bắt đầu bằng "sk-".'
      : '⚠ Khóa OpenAI không hợp lệ: khóa đúng phải bắt đầu bằng "sk-".', true, 9000);
  }
  if (!hadAzure && cfg.azKey && cfg.azRegion && !cfg.engineChosen) {
    cfg.engine = 'azure'; $('engine').value = 'azure'; updateSpeakerBar();
    toast('Đã có khóa Azure: chuyển sang chế độ tự nhận diện ngôn ngữ.');
  }
  cfg.silenceMs = Math.min(3000, Math.max(200, parseInt(cfg.silenceMs, 10) || 600));
  cfg.maxItems = Math.min(1000, Math.max(20, parseInt(cfg.maxItems, 10) || 200));
  cfg.micId = $('micSel').value;
  store.set(cfg);
  state.cache.clear();
}

/* ---------- 14b. Kết thúc phiên & lưu hồ sơ lập biên bản họp (BBH) ---------- */
const BBH_FIELDS = ['bbLoai', 'bbVeViec', 'bbDiaDiem', 'bbVTB', 'bbDoiTac', 'bbChuTri', 'bbThuKy', 'bbGhiChu'];
const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('liveTranslate', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); },
};
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const ymd = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
function khongDau(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}
async function openBBH() {
  if (state.running) await stop();
  if (!state.entries.length) { toast('Chưa có nội dung hội thoại để lập biên bản.', true); return; }
  const first = state.entries[0].time, last = state.entries[state.entries.length - 1].time;
  const prev = (() => { try { return JSON.parse(localStorage.getItem('liveTranslate.bbh') || '{}'); } catch { return {}; } })();
  BBH_FIELDS.forEach((f) => { $(f).value = prev[f] ?? ''; });
  if (!$('bbLoai').value) $('bbLoai').value = 'khach_hang';
  $('bbVeViec').value = prev.bbVeViec && prev._ngay === ymd(first) ? prev.bbVeViec : '';
  $('bbNgay').value = `${first.getFullYear()}-${pad2(first.getMonth() + 1)}-${pad2(first.getDate())}`;
  $('bbGioBD').value = hhmm(state.sessionStart && state.sessionStart < first ? state.sessionStart : first);
  $('bbGioKT').value = hhmm(last);
  // Biên bản luôn có tiếng Việt; ngôn ngữ thứ hai mặc định là ngôn ngữ còn lại của cặp
  const others = [cfg.langA, cfg.langB].filter((k) => k !== 'vi');
  $('bbSongNgu').innerHTML = Object.entries(LANGS).filter(([k]) => k !== 'vi')
    .map(([k, v]) => `<option value="${k}">Tiếng Việt + ${esc(v.name)}</option>`).join('') + '<option value="">Chỉ tiếng Việt</option>';
  $('bbSongNgu').value = others[0] ?? 'en';
  const nVi = state.entries.filter((e) => e.src === 'vi').length;
  $('bbhSummary').innerHTML = `Phiên họp có <b>${state.entries.length}</b> câu (${nVi} câu nói tiếng Việt), từ ${hhmm(first)} đến ${hhmm(last)}. `
    + 'Ứng dụng sẽ lưu bản ghi song ngữ và thông tin dưới đây vào thư mục cuộc họp; sau đó Claude lập biên bản theo khuôn Tạo BBH.'
    + (![cfg.langA, cfg.langB].includes('vi') ? '<br><b>Lưu ý:</b> cặp ngôn ngữ không có tiếng Việt, biên bản sẽ được dịch sang tiếng Việt khi lập.' : '');
  await showFolderInfo();
  $('bbhDlg').showModal();
}
async function showFolderInfo() {
  const h = await idb.get('bbhRoot').catch(() => null);
  const can = 'showDirectoryPicker' in window;
  $('bbhFolderInfo').innerHTML = !can
    ? 'Trình duyệt này không hỗ trợ ghi thẳng vào thư mục. Hãy dùng nút <b>⬇ Tải hồ sơ về máy</b> rồi chép vào thư mục biên bản.'
    : h ? `Thư mục gốc: <b>${esc(h.name)}</b>. Hồ sơ sẽ được lưu vào thư mục con <b>${esc(folderName())}</b>.`
      : 'Chưa chọn thư mục gốc. Bấm nút bên dưới và chọn thư mục <b>2026_Cac BBH DNL</b> (chỉ cần chọn một lần).';
  $('bbhPickBtn').style.display = can ? '' : 'none';
}
function folderName() {
  const d = $('bbNgay').value ? $('bbNgay').value.replaceAll('-', '') : ymd(new Date());
  const topic = khongDau($('bbVeViec').value).slice(0, 45) || 'Phien dich truc tiep';
  return `${d}_${topic}`;
}
async function pickBBHRoot() {
  try {
    const h = await window.showDirectoryPicker({ id: 'bbhRoot', mode: 'readwrite' });
    await idb.set('bbhRoot', h);
    await showFolderInfo();
  } catch (e) { if (e.name !== 'AbortError') toast('Không chọn được thư mục: ' + e.message, true); }
}
function buildPackage() {
  const [y, m, d] = ($('bbNgay').value || '').split('-');
  const song = $('bbSongNgu').value;
  const stamp = `${ymd(new Date())}_${hhmm(new Date()).replace(':', '')}`;
  const meta = {
    nguon: 'Live Translate', phien_ban_ho_so: 1, tao_luc: new Date().toISOString(),
    loai: $('bbLoai').value, ve_viec: $('bbVeViec').value.trim(),
    ngay_hop: d ? `${d}/${m}/${y}` : '', gio_bat_dau: $('bbGioBD').value, gio_ket_thuc: $('bbGioKT').value,
    dia_diem: $('bbDiaDiem').value.trim(), thanh_phan_vietinbank: $('bbVTB').value.trim(),
    thanh_phan_doi_tac: $('bbDoiTac').value.trim(), chu_tri: $('bbChuTri').value.trim(), thu_ky: $('bbThuKy').value.trim(),
    ghi_chu_cho_nguoi_lap: $('bbGhiChu').value.trim(),
    song_ngu: song || null, ngon_ngu_bien_ban: song ? ['vi', song] : ['vi'],
    cap_ngon_ngu_phien_dich: [cfg.langA, cfg.langB], che_do: oneWay() ? 'mot_chieu' : 'hai_chieu',
    cong_cu_nhan_dien: cfg.engine === 'azure' ? 'Azure Speech' : 'Web Speech (trình duyệt)',
    dich_vu_dich: { google: 'Google Translate', azure: 'Azure Translator', openai: 'OpenAI ' + (cfg.oaModel || '') }[cfg.trProvider],
    boi_canh: cfg.context || '', thuat_ngu: glossaryLines(),
    so_cau: state.entries.length,
  };
  const ban_ghi = state.entries.map((e) => ({
    gio: timeStr(e.time), ngon_ngu_noi: e.src, ngon_ngu_dich: e.tgt, loi_noi: e.original, ban_dich: e.translation,
  }));
  const json = JSON.stringify({ ...meta, ban_ghi }, null, 2);
  const txt = [
    'BẢN GHI PHIÊN DỊCH TRỰC TIẾP (LIVE TRANSLATE)',
    `Về việc: ${meta.ve_viec || '(chưa nhập)'}`,
    `Ngày: ${meta.ngay_hop}  ·  ${meta.gio_bat_dau} – ${meta.gio_ket_thuc}  ·  Địa điểm: ${meta.dia_diem || '(chưa nhập)'}`,
    `Cặp ngôn ngữ: ${LANGS[cfg.langA].name} ⇄ ${LANGS[cfg.langB].name}  ·  ${meta.cong_cu_nhan_dien}  ·  Dịch: ${meta.dich_vu_dich}`,
    '='.repeat(70), '',
    ...state.entries.flatMap((e) => [`[${timeStr(e.time)}] (${e.src.toUpperCase()} → ${e.tgt.toUpperCase()})`, `  Gốc : ${e.original}`, `  Dịch: ${e.translation}`, '']),
  ].join('\r\n');
  const lang2 = song ? LANGS[song].name : '';
  const req = [
    '# Yêu cầu lập biên bản họp',
    '',
    `- **Thư mục cuộc họp:** ${folderName()}`,
    `- **Loại biên bản:** ${meta.loai}`,
    `- **Song ngữ:** ${song ? `Tiếng Việt + ${lang2} (khóa JSON \`"song_ngu": "${song}"\`, trình bày xen kẽ)` : 'Chỉ tiếng Việt'}`,
    `- **Nguồn:** hồ sơ phiên dịch Live Translate \`phien_dich_${stamp}.json\` (đã có lời nói gốc và bản dịch tức thời, không cần chép lời lại).`,
    '',
    'Câu lệnh gửi Claude:',
    '',
    `> Tạo BBH${song ? ' song ngữ' : ''} cho cuộc họp trong thư mục "${folderName()}" từ hồ sơ phiên dịch Live Translate.`,
    '',
  ].join('\r\n');
  return { stamp, files: [
    [`phien_dich_${stamp}.json`, json, 'application/json'],
    [`Ban ghi song ngu_${stamp}.txt`, '\ufeff' + txt, 'text/plain'],
    ['YEU_CAU_TAO_BBH.md', '\ufeff' + req, 'text/markdown'],
  ] };
}
async function saveBBH(download) {
  if (!$('bbVeViec').value.trim()) { toast('Vui lòng nhập Chủ đề (Về việc) của cuộc họp.', true); $('bbVeViec').focus(); return; }
  const keep = {}; BBH_FIELDS.forEach((f) => { keep[f] = $(f).value; }); keep._ngay = ($('bbNgay').value || '').replaceAll('-', '');
  try { localStorage.setItem('liveTranslate.bbh', JSON.stringify(keep)); } catch { /* */ }
  const pkg = buildPackage();
  const folder = folderName();
  if (download || !('showDirectoryPicker' in window)) {
    for (const [name, content, type] of pkg.files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
      a.download = name; a.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    finishBBH(folder, false);
    return;
  }
  try {
    let root = await idb.get('bbhRoot').catch(() => null);
    if (!root) { await pickBBHRoot(); root = await idb.get('bbhRoot'); if (!root) return; }
    if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted'
      && (await root.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Chưa được cấp quyền ghi vào thư mục.');
    const dir = await root.getDirectoryHandle(folder, { create: true });
    for (const [name, content] of pkg.files) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(content); await w.close();
    }
    finishBBH(`${root.name}\\${folder}`, true);
  } catch (e) { toast('Không lưu được vào thư mục: ' + e.message + '. Hãy dùng “Tải hồ sơ về máy”.', true, 9000); }
}
function finishBBH(where, saved) {
  $('bbhDlg').close();
  const cmd = `Tạo BBH${$('bbSongNgu').value ? ' song ngữ' : ''} cho cuộc họp trong thư mục "${where.split('\\').pop()}" từ hồ sơ phiên dịch Live Translate.`;
  try { navigator.clipboard.writeText(cmd).catch(() => {}); } catch { /* */ }
  toast((saved ? `✔ Đã lưu hồ sơ vào ${where}.` : '✔ Đã tải hồ sơ về máy – hãy chép 3 tệp vào thư mục cuộc họp.')
    + ' Câu lệnh lập biên bản đã được sao chép, chỉ cần dán vào Claude.', false, 12000);
}

/* ---------- 14c. Xuất / nhập cấu hình mã hóa (chuyển sang iPad, điện thoại, máy khác) ---------- */
const KEY_FIELDS = ['azKey', 'trKey', 'oaKey'];
const b64 = { enc: (u8) => btoa(String.fromCharCode(...u8)), dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptCfg(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iter = 250000;
  const key = await deriveKey(pass, salt, iter);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return { app: 'live-translate', loai: 'cau-hinh-ma-hoa', v: 1, kdf: 'PBKDF2-SHA256', iter, cipher: 'AES-256-GCM',
    tao_luc: new Date().toISOString(), salt: b64.enc(salt), iv: b64.enc(iv), data: b64.enc(data) };
}
async function decryptCfg(file, pass) {
  if (file.app !== 'live-translate' || !file.data) throw new Error('Tệp không phải tệp cấu hình Live Translate.');
  const key = await deriveKey(pass, b64.dec(file.salt), file.iter || 250000);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(file.iv) }, key, b64.dec(file.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Error('Sai mật khẩu hoặc tệp đã bị thay đổi.'); }
}
let cfgMode = 'export';
function openCfgDlg(mode) {
  if (!window.isSecureContext || !crypto?.subtle) { toast('Cần mở ứng dụng qua https hoặc localhost để dùng tính năng này.', true); return; }
  cfgMode = mode;
  const exp = mode === 'export';
  $('cfgTitle').textContent = exp ? '📤 Xuất cấu hình' : '📥 Nhập cấu hình';
  $('cfgNote').innerHTML = exp
    ? 'Toàn bộ cài đặt (ngôn ngữ, thuật ngữ, giao diện và các khóa API nếu chọn) được <b>mã hóa AES-256 bằng mật khẩu</b> rồi lưu thành tệp. Gửi tệp sang iPad, điện thoại (AirDrop, email, Zalo…) và nhập lại bằng đúng mật khẩu. Không gửi mật khẩu cùng kênh với tệp.'
    : 'Chọn tệp cấu hình đã xuất từ máy khác và nhập mật khẩu. Cài đặt hiện tại trên máy này sẽ được thay thế (trừ thiết bị micro).';
  $('cfgFileRow').style.display = exp ? 'none' : '';
  $('cfgPass2Row').style.display = exp ? '' : 'none';
  $('cfgKeysRow').style.display = exp ? '' : 'none';
  $('cfgGoBtn').textContent = exp ? 'Xuất tệp' : 'Nhập cấu hình';
  $('cfgPass').value = ''; $('cfgPass2').value = ''; $('cfgFile').value = '';
  $('cfgDlg').showModal();
}
async function runCfg() {
  const pass = $('cfgPass').value;
  try {
    if (cfgMode === 'export') {
      if (pass.length < 8) throw new Error('Mật khẩu cần tối thiểu 8 ký tự.');
      if (pass !== $('cfgPass2').value) throw new Error('Hai lần nhập mật khẩu không khớp.');
      readSettings();
      const obj = { ...cfg }; delete obj.micId;
      if ($('cfgKeys').value !== '1') KEY_FIELDS.forEach((k) => delete obj[k]);
      const out = await encryptCfg(obj, pass);
      const d = new Date();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
      a.download = `LiveTranslate_cau_hinh_${ymd(d)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      $('cfgDlg').close();
      toast('✔ Đã xuất tệp cấu hình mã hóa. Hãy nhớ mật khẩu – không thể khôi phục nếu quên.', false, 9000);
    } else {
      const f = $('cfgFile').files[0];
      if (!f) throw new Error('Chưa chọn tệp cấu hình.');
      if (!pass) throw new Error('Chưa nhập mật khẩu.');
      const obj = await decryptCfg(JSON.parse(await f.text()), pass);
      const keepMic = cfg.micId;
      cfg = { ...DEFAULTS, ...cfg, ...obj, micId: keepMic };
      store.set(cfg); state.cache.clear();
      fillLangSelects(); applyLook(); render();
      $('cfgDlg').close();
      if ($('settings').open) await openSettings();
      toast('✔ Đã nhập cấu hình thành công.' + (obj.azKey || obj.oaKey ? ' Các khóa API đã sẵn sàng.' : ''), false, 8000);
    }
  } catch (e) { toast('✖ ' + (e.message || e), true, 8000); }
}

/* ---------- 15. Khởi tạo giao diện ---------- */
function fillLangSelects() {
  const opts = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v.flag} ${esc(v.name)}</option>`).join('');
  $('langA').innerHTML = opts; $('langB').innerHTML = opts;
  $('langA').value = cfg.langA; $('langB').value = cfg.langB;
}
function applyLook() {
  document.documentElement.style.setProperty('--fs', cfg.fontSize + 'px');
  document.body.classList.toggle('hide-orig', !cfg.showOrig);
  document.body.classList.toggle('light', cfg.theme === 'light');
  $('engine').value = cfg.engine; $('source').value = cfg.source; $('viewMode').value = cfg.viewMode;
  $('direction').value = cfg.direction;
  updateSpeakerBar();
}
function save() { store.set(cfg); }

function bind() {
  $('startBtn').onclick = () => (state.running ? stop() : start());
  $('langA').onchange = () => { cfg.langA = $('langA').value; save(); updateSpeakerBar(); scheduleRender(); restartIfRunning(); };
  $('langB').onchange = () => { cfg.langB = $('langB').value; save(); updateSpeakerBar(); scheduleRender(); restartIfRunning(); };
  $('swapBtn').onclick = () => { [cfg.langA, cfg.langB] = [cfg.langB, cfg.langA]; fillLangSelects(); save(); updateSpeakerBar(); scheduleRender(); restartIfRunning(); };
  $('direction').onchange = () => { cfg.direction = $('direction').value; save(); updateSpeakerBar(); scheduleRender(); restartIfRunning(); };
  $('engine').onchange = () => { cfg.engine = $('engine').value; cfg.engineChosen = true; save(); updateSpeakerBar(); scheduleRender(); restartIfRunning(); };
  $('source').onchange = () => { cfg.source = $('source').value; save(); restartIfRunning(); };
  $('viewMode').onchange = () => { cfg.viewMode = $('viewMode').value; save(); $('main').innerHTML = ''; render(); };
  $('fontUp').onclick = () => { cfg.fontSize = Math.min(72, cfg.fontSize + 2); save(); applyLook(); };
  $('fontDown').onclick = () => { cfg.fontSize = Math.max(14, cfg.fontSize - 2); save(); applyLook(); };
  $('origBtn').onclick = () => { cfg.showOrig = !cfg.showOrig; save(); applyLook(); render(); };
  $('themeBtn').onclick = () => { cfg.theme = cfg.theme === 'light' ? 'dark' : 'light'; save(); applyLook(); };
  $('fullBtn').onclick = () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    const el = cfg.viewMode === 'stage' ? $('main') : document.documentElement;
    el.requestFullscreen().catch(() => {});
  };
  $('bbhBtn').onclick = openBBH;
  $('bbhPickBtn').onclick = pickBBHRoot;
  $('bbVeViec').oninput = () => showFolderInfo();
  $('bbNgay').onchange = () => showFolderInfo();
  $('bbhSaveBtn').onclick = () => saveBBH(false);
  $('bbhDownloadBtn').onclick = () => saveBBH(true);
  $('exportBtn').onclick = exportTxt;
  $('clearBtn').onclick = () => { if (!state.entries.length || confirmClear()) { state.entries = []; state.live = null; state.sessionStart = null; render(); } };
  $('settingsBtn').onclick = openSettings;
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
  $('saveBtn').onclick = () => { readSettings(); $('settings').close(); toast('Đã lưu cài đặt.'); render(); restartIfRunning(); };
  $('testBtn').onclick = async () => {
    readSettings();
    try {
      const sample = { vi: 'Xin chào, rất vui được gặp anh chị.', en: 'Hello, nice to meet you.', zh: '你好，很高兴见到你。', ja: 'こんにちは、お会いできて嬉しいです。', ko: '안녕하세요, 만나서 반갑습니다.', de: 'Hallo, schön Sie kennenzulernen.', fr: 'Bonjour, ravi de vous rencontrer.' }[cfg.langA];
      const t0 = performance.now();
      const out = await translate(sample, cfg.langA, cfg.langB);
      toast(`✔ ${sample} → ${out}  (${Math.round(performance.now() - t0)} ms)`, false, 8000);
    } catch (e) { toast('✖ ' + e.message, true, 8000); }
  };
  $('cfgExportBtn').onclick = () => openCfgDlg('export');
  $('cfgImportBtn').onclick = () => openCfgDlg('import');
  $('cfgGoBtn').onclick = runCfg;
  $('spkA').onclick = () => setSpeaker('A');
  $('spkB').onclick = () => setSpeaker('B');
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (cfg.engine !== 'webspeech' || oneWay()) return;
    if (e.code === 'Space') { e.preventDefault(); setSpeaker(state.speaker === 'A' ? 'B' : 'A'); }
    if (e.key === '1') setSpeaker('A');
    if (e.key === '2') setSpeaker('B');
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.running) { try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* */ } }
  });
}
function confirmClear() { return window.confirm('Xóa toàn bộ nội dung hội thoại hiện tại? (Nên xuất biên bản trước khi xóa)'); }

fillLangSelects();
applyLook();
bind();
render();

// Cài như ứng dụng (PWA): lưu bộ khung giao diện để mở nhanh, kể cả khi mạng chập chờn
if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
