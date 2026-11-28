// Intentional Browsing: content script.
//   - Delay overlay: visible-time countdown, then hold-to-continue (or a
//     puzzle for soft triggers), grace period
//   - archive.org item scan (only when the administrator enables it)
//   - Page check: adult labels, descriptions, other-language versions and
//     categories (only when the administrator enables it)

(() => {
  // The background re-injects this file into tabs that were open before the
  // extension was installed; skip if a live copy is already running here.
  if (typeof window.__intentionalBrowsingAlive === 'function' && window.__intentionalBrowsingAlive()) return;
  window.__intentionalBrowsingAlive = () => {
    try { return !!chrome.runtime.id; } catch { return false; }
  };

  const DEBUG = false;
  const debug = (...args) => { if (DEBUG) console.log('[IntentionalBrowsing]', ...args); };

  const OVERLAY_ID = 'intentional-browsing-overlay';

  // ─── archive.org flagged-item scan ────────────────────────────────────────
  // Backs up the background metadata check: some flagged items carry no
  // metadata signal, but the page itself shows a warning notice.
  function archiveFlagScan() {
    const FLAG_PATTERNS = [
      /content\s+may\s+be\s+inappropriate/i,
      /this\s+item\s+contains\s+content\s+that\s+may\s+be\s+inappropriate/i
    ];
    let triggered = false;

    function checkAndClose() {
      if (triggered) return true;
      const text = (document.body && document.body.textContent) || '';
      if (!FLAG_PATTERNS.some(re => re.test(text))) return false;
      triggered = true;
      debug('archive.org notice found, closing tab');
      try { chrome.runtime.sendMessage({ action: 'closeTab', scrub: true }); } catch {}
      return true;
    }

    if (checkAndClose()) return;
    // The notice can be rendered after first paint; watch briefly.
    const startObserver = () => {
      if (!document.body) return;
      const obs = new MutationObserver(() => {
        if (checkAndClose()) obs.disconnect();
      });
      try {
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => obs.disconnect(), 4000);
      } catch {}
    };
    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  }

  // ─── Page check (only when the administrator enables pageCheck) ───────────
  // Reports what the page says about itself: adult-content labels, its
  // description texts, its other-language versions and its categories. The background does the matching, with
  // the same keyword lists and exceptions as for URLs; the tab title is
  // checked there directly.
  const RTA_LABEL = 'rta-5042-1996-1400-1577-rta';
  const ADULT_RATING_RE = /\b(?:adult|mature|explicit|restricted)\b/;
  const DESCRIPTION_KEYS = new Set([
    'description', 'og:title', 'og:description', 'twitter:title', 'twitter:description'
  ]);

  function collectPageSignals() {
    let adultLabel = false;
    const texts = [];
    for (const m of document.querySelectorAll('meta')) {
      const key = (m.getAttribute('name') || m.getAttribute('property') ||
                   m.getAttribute('http-equiv') || '').trim().toLowerCase();
      const content = (m.getAttribute('content') || '').trim();
      if (!content) continue;
      const lower = content.toLowerCase();
      // The RTA label counts wherever it appears; "rating" values by name.
      if (lower.includes(RTA_LABEL) || (key === 'rating' && ADULT_RATING_RE.test(lower))) {
        adultLabel = true;
      }
      if (DESCRIPTION_KEYS.has(key)) texts.push(content.slice(0, 2000));
    }
    texts.push(...otherLanguageTexts(), ...categoryTexts());
    return { adultLabel, texts };
  }

  // A page in any language usually links to its own versions in other
  // languages (hreflang). The English and Dutch versions' titles and
  // addresses are checked too, so the topic is recognised whatever language
  // the page itself is in. The keyword lists are English and Dutch.
  const VERSION_LANGUAGES = /^(?:en|nl)(?:-|$)/i;
  const MAX_VERSION_LINKS = 20;

  function otherLanguageTexts() {
    const out = [];
    const links = document.querySelectorAll('a[hreflang], link[rel~="alternate"][hreflang]');
    for (const el of links) {
      if (out.length >= MAX_VERSION_LINKS * 2) break;
      if (!VERSION_LANGUAGES.test(el.getAttribute('hreflang') || '')) continue;
      const title = (el.getAttribute('title') || '').trim();
      if (title) out.push(title.slice(0, 300));
      try {
        const u = new URL(el.getAttribute('href') || '', location.href);
        if (u.origin !== location.origin || u.pathname !== location.pathname) {
          out.push(decodeURIComponent(u.pathname).slice(0, 300));
        }
      } catch {}
    }
    return out;
  }

  // Wikipedia lists the categories an article belongs to at its foot.
  const MAX_CATEGORIES = 30;

  function categoryTexts() {
    const out = [];
    for (const a of document.querySelectorAll('#catlinks li a')) {
      if (out.length >= MAX_CATEGORIES) break;
      const text = (a.textContent || '').trim();
      if (text) out.push(text.slice(0, 200));
    }
    return out;
  }

  function startPageCheck() {
    let lastSent = '';
    const report = () => {
      const signals = collectPageSignals();
      const key = JSON.stringify(signals);
      if (key === lastSent) return;
      lastSent = key;
      try {
        chrome.runtime.sendMessage({ action: 'pageSignals', signals }, () => { void chrome.runtime.lastError; });
      } catch {}
    };
    report();
    // Single-page apps rewrite <head> on navigation: check again, at most
    // twice a second.
    let timer = null;
    const obs = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; report(); }, 500);
    });
    const head = document.head || document.documentElement;
    try {
      obs.observe(head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
    } catch {}
  }

  const onArchiveItemPage =
    (location.hostname === 'archive.org' || location.hostname.endsWith('.archive.org')) &&
    /^\/details\//.test(location.pathname);
  if (/^https?:$/.test(location.protocol)) {
    try {
      chrome.runtime.sendMessage({ action: 'getContentSettings' }, (settings) => {
        void chrome.runtime.lastError;
        if (!settings) return;
        if (settings.archiveScan && onArchiveItemPage) archiveFlagScan();
        if (settings.pageCheck) startPageCheck();
      });
    } catch {}
  }

  // ─── Puzzles (soft-trigger overlay) ───────────────────────────────────────
  // A random maths or typing problem per prompt; a wrong answer gets a new one.
  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function genSquare() {
    const n = randInt(13, 28);
    return { q: `What is ${n}² ?`, a: String(n * n) };
  }
  function genSqrt() {
    const n = randInt(13, 28);
    return { q: `What is √${n * n} ?`, a: String(n) };
  }
  function genCube() {
    const n = randInt(5, 13);
    return { q: `What is ${n}³ ?`, a: String(n * n * n) };
  }
  function genCbrt() {
    const n = randInt(4, 11);
    return { q: `What is ∛${n * n * n} ?`, a: String(n) };
  }
  function genChained() {
    const a = randInt(5, 25), b = randInt(3, 14), c = randInt(2, 9);
    if (Math.random() < 0.5) {
      return { q: `${a} + ${b} × ${c} = ?`, a: String(a + b * c) };
    }
    return { q: `(${a} + ${b}) × ${c} = ?`, a: String((a + b) * c) };
  }
  function genMod() {
    const b = randInt(7, 19);
    const a = randInt(80, 400);
    return { q: `${a} mod ${b} = ?`, a: String(a % b) };
  }
  function genFactorial() {
    const n = randInt(4, 7);
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    return { q: `What is ${n}! ?`, a: String(f) };
  }
  function genLog() {
    const base = pick([2, 3, 5, 10]);
    const maxExp = base === 2 ? 10 : base === 3 ? 6 : 4;
    const exp = randInt(2, maxExp);
    return { q: `log_${base}(${Math.pow(base, exp)}) = ?`, a: String(exp) };
  }
  function genDeriv() {
    // f(x) = A x³ + B x² + C x + D; asks for f'(x0)
    const A = randInt(1, 4), B = randInt(1, 5) * (Math.random() < 0.3 ? -1 : 1),
          C = randInt(1, 9) * (Math.random() < 0.3 ? -1 : 1), D = randInt(0, 9),
          x0 = randInt(2, 5);
    const fp = 3 * A * x0 * x0 + 2 * B * x0 + C;
    const term = (k, expr) => k === 0 ? '' : (k > 0 ? ' + ' : ' − ') + Math.abs(k) + expr;
    const q = `f(x) = ${A}x³${term(B, 'x²')}${term(C, 'x')}${term(D, '')}.  What is f'(${x0}) ?`;
    return { q, a: String(fp) };
  }
  function genIntegral() {
    // ∫₀^end (a x² + b x + c) dx, coefficients chosen for an integer result
    const a = pick([3, 6, 9]), b = pick([2, 4, 6]), c = randInt(0, 9), end = pick([2, 3, 4]);
    const result = (a / 3) * end * end * end + (b / 2) * end * end + c * end;
    const cTerm = c === 0 ? '' : ` + ${c}`;
    return { q: `∫(${a}x² + ${b}x${cTerm}) dx  from 0 to ${end}  = ?`, a: String(result) };
  }
  function genSumSeries() {
    const n = randInt(8, 20);
    if (Math.random() < 0.5) {
      return { q: `Σ k from k=1 to ${n}  = ?`, a: String(n * (n + 1) / 2) };
    }
    return { q: `Σ k² from k=1 to ${n}  = ?`, a: String(n * (n + 1) * (2 * n + 1) / 6) };
  }
  function genBackward() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return { q: `Type this backwards:  ${s}`, a: s.split('').reverse().join(''), monospace: true };
  }

  const PUZZLE_GENERATORS = [
    { w: 2, fn: genSquare },
    { w: 2, fn: genSqrt },
    { w: 2, fn: genCube },
    { w: 1, fn: genCbrt },
    { w: 2, fn: genChained },
    { w: 1, fn: genMod },
    { w: 1, fn: genFactorial },
    { w: 1, fn: genLog },
    { w: 1, fn: genDeriv },
    { w: 1, fn: genIntegral },
    { w: 1, fn: genSumSeries },
    { w: 5, fn: genBackward }   // about a quarter of prompts
  ];

  function generatePuzzle() {
    const totalW = PUZZLE_GENERATORS.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * totalW;
    for (const item of PUZZLE_GENERATORS) {
      r -= item.w;
      if (r <= 0) return item.fn();
    }
    return PUZZLE_GENERATORS[0].fn();
  }

  function normalizePuzzleAnswer(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
  }

  const MONOSPACE_FONT = 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, "Courier New", monospace';

  // ─── Visibility tracking ──────────────────────────────────────────────────
  // The countdown only advances while the page is visible and its window has
  // focus.
  let windowHasFocus = !document.hidden;
  window.addEventListener('focus', () => { windowHasFocus = true; });
  window.addEventListener('blur', () => { windowHasFocus = false; });

  function isPageTrulyVisible() {
    return !document.hidden && windowHasFocus;
  }

  // ─── Messages from the background ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ status: 'ready' });
      return true;
    }
    if (request.action === 'interceptWebsite') {
      const { site, customization } = request;
      if (document.getElementById(OVERLAY_ID)) {
        sendResponse({ status: 'skipped', reason: 'overlay exists' });
        return true;
      }
      checkGracePeriod(site, (inGracePeriod) => {
        if (inGracePeriod) {
          sendResponse({ status: 'skipped', reason: 'within grace period' });
        } else {
          createAndShowOverlay(site, customization || {}, sendResponse);
        }
      });
      return true;
    }
  });

  // ─── Grace period ─────────────────────────────────────────────────────────
  /** Grace periods are keyed by the site's hostname without "www.". */
  function siteKey(site) {
    try {
      const s = /^https?:\/\//.test(site.url) ? site.url : 'https://' + site.url;
      return new URL(s).hostname.replace(/^www\./, '');
    } catch {
      return site.url;
    }
  }

  function checkGracePeriod(site, callback) {
    const key = siteKey(site);
    chrome.storage.local.get(['gracePeriods'], (result) => {
      const entry = (result.gracePeriods || {})[key];
      callback(!!entry && Date.now() < entry.expiryTime);
    });
  }

  function setGracePeriod(site) {
    const key = siteKey(site);
    const expiryTime = Date.now() + site.gracePeriod * 1000;
    chrome.storage.local.get(['gracePeriods'], (result) => {
      const gracePeriods = result.gracePeriods || {};
      gracePeriods[key] = { expiryTime };
      chrome.storage.local.set({ gracePeriods });
    });
  }

  // ─── Delay overlay ────────────────────────────────────────────────────────
  // Lives in a shadow root, so page CSS can't restyle or hide it, and sits on
  // the highest stacking level. Two phases:
  //   1. wait: a countdown that only runs while the tab is visible
  //   2. continue: a circle held down for HOLD_MS (released early, it starts
  //      over), or for soft triggers a puzzle that must be answered correctly
  const HOLD_MS = 3000;
  const DEFAULT_PANEL_OPACITY = 0.85;
  const RING_LENGTH = 364.42;   // 2π × 58, the ring's radius
  const FONT_STACK = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';

  const OVERLAY_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop {
      position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      padding: 16px; font-family: ${FONT_STACK}; color: #1C1D1F;
      background-color: #E8EEF2; background-size: cover; background-position: center;
      background-repeat: no-repeat;
    }
    .panel {
      width: min(440px, 100%); padding: 40px; border-radius: 16px;
      display: flex; flex-direction: column; align-items: center; gap: 20px; text-align: center;
      -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
      box-shadow: 0 1px 2px rgba(20, 24, 31, 0.08), 0 16px 40px rgba(20, 24, 31, 0.16);
    }
    [hidden] { display: none !important; }
    .count {
      font-size: 72px; font-weight: 600; line-height: 1; letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
    }
    .unit { margin-top: 4px; font-size: 14px; color: #4A4E55; }
    .bar { width: 100%; height: 4px; border-radius: 2px; background: #E6E6E1; overflow: hidden; }
    .fill { height: 100%; width: 0; background: #3D5A80; transition: width 0.9s linear; }
    h1 { margin: 0; font-size: 22px; font-weight: 600; line-height: 1.35; max-width: 320px; }
    .hold {
      position: relative; width: 132px; height: 132px; border-radius: 50%; border: none; padding: 0;
      background: #FFFFFF; cursor: pointer; touch-action: none; user-select: none;
      -webkit-user-select: none; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 1px 3px rgba(20, 24, 31, 0.12); font: 600 15px ${FONT_STACK}; color: #1C1D1F;
    }
    .hold:focus { outline: none; }
    .keyboard .hold:focus-visible { outline: 3px solid #3D5A80; outline-offset: 4px; }
    .hold svg { position: absolute; inset: 0; transform: rotate(-90deg); }
    .hold .label { position: relative; }
    .hold.done { background: #3D5A80; color: #FFFFFF; }
    .puzzle {
      width: 100%; padding: 16px 20px; border: 1px solid #D6D6D0; border-radius: 10px;
      background: #FFFFFF; font-size: 20px; user-select: none; -webkit-user-select: none;
    }
    .puzzle.mono { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, "Courier New", monospace; }
    .answer { width: 100%; display: flex; gap: 8px; }
    .answer input {
      flex: 1 1 auto; min-width: 0; height: 44px; padding: 0 12px; border: 1px solid #D6D6D0;
      border-radius: 8px; font: 15px ${FONT_STACK}; color: #1C1D1F; background: #FFFFFF;
    }
    .answer input.wrong { background: #FBE3E1; transition: background 0.4s; }
    .button {
      height: 44px; padding: 0 20px; border-radius: 8px; font: 500 13px ${FONT_STACK};
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    }
    .primary { border: none; background: #3D5A80; color: #FFFFFF; }
    .secondary { border: 1px solid #D6D6D0; background: #FFFFFF; color: #1C1D1F; }
    .button:focus { outline: none; }
    .keyboard .button:focus-visible, .answer input:focus-visible { outline: 3px solid #3D5A80; outline-offset: 2px; }
  `;

  const OVERLAY_HTML = `
    <div class="backdrop">
      <main class="panel" role="dialog" aria-modal="true" aria-labelledby="ib-title">
        <h1 id="ib-title" class="message" hidden></h1>
        <section class="wait">
          <div class="count" aria-live="off">0</div>
          <div class="unit">seconds</div>
        </section>
        <div class="bar wait-bar" role="progressbar" aria-label="Time waited" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="fill"></div>
        </div>
        <button type="button" class="hold" aria-label="Hold to continue" hidden>
          <svg width="132" height="132" viewBox="0 0 132 132" aria-hidden="true">
            <circle cx="66" cy="66" r="58" fill="none" stroke="#E6E6E1" stroke-width="6"></circle>
            <circle class="ring" cx="66" cy="66" r="58" fill="none" stroke="#3D5A80" stroke-width="6"
                    stroke-linecap="round" stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="${RING_LENGTH}"></circle>
          </svg>
          <span class="label">Hold</span>
        </button>
        <div class="puzzle" hidden></div>
        <form class="answer" hidden>
          <input type="text" aria-label="Your answer" placeholder="Your answer" autocomplete="off" spellcheck="false">
          <button type="submit" class="button primary">Continue</button>
        </form>
        <button type="button" class="button secondary close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>
          Close tab
        </button>
      </main>
    </div>
  `;

  function panelBackground(opacity) {
    const o = Number(opacity);
    const a = Number.isFinite(o) ? Math.min(1, Math.max(0.5, o)) : DEFAULT_PANEL_OPACITY;
    return `rgba(255, 255, 255, ${a})`;
  }

  function createAndShowOverlay(site, customization, sendResponse) {
    const softMode = !!customization.softReflect;
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 !important; ' +
      'z-index: 2147483647 !important; display: block !important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${OVERLAY_CSS}</style>${OVERLAY_HTML}`;

    // Keys typed on the overlay must not reach the page's own shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    const $ = (sel) => root.querySelector(sel);
    const backdrop = $('.backdrop');
    const panel = $('.panel');
    // Focus rings on buttons appear once the keyboard is used to move around,
    // not for the focus the overlay sets itself.
    root.addEventListener('keydown', (e) => { if (e.key === 'Tab') panel.classList.add('keyboard'); });
    const message = $('.message');
    const waitSection = $('.wait');
    const countEl = $('.count');
    const bar = $('.wait-bar');
    const fill = $('.fill');
    const holdBtn = $('.hold');
    const ring = $('.ring');
    const holdLabel = $('.hold .label');
    const puzzleEl = $('.puzzle');
    const answerForm = $('.answer');
    const answerInput = $('.answer input');
    const closeBtn = $('.close');

    // Appearance: colour or full-bleed image. Over an image the panel behind
    // the text is see-through by the chosen amount; over a colour it's solid.
    if (customization.backgroundColor) backdrop.style.backgroundColor = customization.backgroundColor;
    if (customization.backgroundImage) {
      backdrop.style.backgroundImage = `url("${customization.backgroundImage}")`;
      panel.style.background = panelBackground(customization.panelOpacity);
    } else {
      panel.style.background = '#FFFFFF';
    }

    if (softMode) {
      message.textContent = customization.reflectionMessage || 'Pause. What are you actually looking for?';
      message.hidden = false;
    } else {
      message.textContent = 'What are you here for?';
    }

    (document.body || document.documentElement).appendChild(host);

    // ── Phase 1: wait, counting only visible seconds ──
    const delay = Math.max(0, Number(site.delay) || 0);
    let waited = 0;
    let timerInterval = null;

    const renderWait = () => {
      countEl.textContent = String(Math.max(0, delay - waited));
      const pct = delay > 0 ? Math.min(100, Math.round((waited / delay) * 100)) : 100;
      fill.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(pct));
    };

    const startContinuePhase = () => {
      waitSection.hidden = true;
      bar.hidden = true;
      message.hidden = false;
      if (softMode) {
        showPuzzle(generatePuzzle());
        answerForm.hidden = false;
        answerInput.focus();
      } else {
        holdBtn.hidden = false;
        holdBtn.focus();
      }
    };

    const startWaitPhase = () => {
      renderWait();
      if (delay === 0) {
        startContinuePhase();
        return;
      }
      timerInterval = setInterval(() => {
        if (!isPageTrulyVisible()) return;
        waited++;
        renderWait();
        if (waited >= delay) {
          clearInterval(timerInterval);
          timerInterval = null;
          startContinuePhase();
        }
      }, 1000);
    };

    // ── Phase 2a: hold to continue ──
    let holding = false;
    let held = 0;
    let lastFrame = 0;
    let frame = null;
    let finished = false;

    const renderRing = () => {
      const p = Math.min(1, held / HOLD_MS);
      ring.setAttribute('stroke-dashoffset', String(RING_LENGTH * (1 - p)));
    };

    const step = (now) => {
      if (!holding) return;
      // Hidden or unfocused time doesn't count, like the countdown.
      if (isPageTrulyVisible()) held += now - lastFrame;
      lastFrame = now;
      renderRing();
      if (held >= HOLD_MS) {
        holding = false;
        finish();
        return;
      }
      frame = requestAnimationFrame(step);
    };

    const startHold = () => {
      if (holding || finished || holdBtn.hidden) return;
      holding = true;
      held = 0;
      lastFrame = performance.now();
      holdLabel.textContent = 'Keep holding';
      frame = requestAnimationFrame(step);
    };

    const stopHold = () => {
      if (!holding) return;
      holding = false;
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      held = 0;
      holdLabel.textContent = 'Hold';
      renderRing();
    };

    holdBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      try { holdBtn.setPointerCapture(e.pointerId); } catch {}
      startHold();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
      holdBtn.addEventListener(type, stopHold);
    }
    holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    const isHoldKey = (e) => e.key === ' ' || e.key === 'Enter';
    holdBtn.addEventListener('keydown', (e) => {
      if (!isHoldKey(e)) return;
      e.preventDefault();
      if (!e.repeat) startHold();
    });
    holdBtn.addEventListener('keyup', (e) => {
      if (!isHoldKey(e)) return;
      e.preventDefault();
      stopHold();
    });
    // Switching away while holding must not leave the hold running.
    window.addEventListener('blur', stopHold);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopHold(); });

    // ── Phase 2b: soft-trigger puzzle ──
    let currentPuzzle = null;
    function showPuzzle(p) {
      currentPuzzle = p;
      puzzleEl.textContent = p.q;
      puzzleEl.classList.toggle('mono', !!p.monospace);
      puzzleEl.hidden = false;
    }

    answerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (finished || !currentPuzzle) return;
      const given = normalizePuzzleAnswer(answerInput.value);
      if (!given) return;
      if (given === normalizePuzzleAnswer(currentPuzzle.a)) {
        finish();
        return;
      }
      // Wrong: flash, a new puzzle, and report it to spiral detection.
      try { chrome.runtime.sendMessage({ action: 'spiralEvent', kind: 'wrongPuzzle' }); } catch {}
      answerInput.classList.add('wrong');
      setTimeout(() => answerInput.classList.remove('wrong'), 600);
      answerInput.value = '';
      showPuzzle(generatePuzzle());
      answerInput.focus();
    });

    closeBtn.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ action: 'closeTab' }); } catch {}
    });

    // ── Done ──
    function finish() {
      if (finished) return;
      finished = true;
      if (timerInterval) clearInterval(timerInterval);
      if (!softMode) {
        holdBtn.classList.add('done');
        holdLabel.textContent = 'Done';
        if (site.gracePeriod && site.gracePeriod > 0) {
          try { setGracePeriod(site); } catch (e) { debug('setGracePeriod failed:', e); }
        }
      }
      // The overlay goes first; storage is updated after, so a storage
      // failure can never keep it on screen.
      setTimeout(() => {
        try { host.remove(); } catch {}
        // Each completed visit to a delay site raises its next delay.
        // Soft-trigger overlays use a synthetic site and change nothing.
        if (softMode) return;
        try {
          chrome.storage.sync.get(['websites'], (result) => {
            const websites = (result.websites || []).map((w) => {
              if (w.url === site.url) w.delay = (w.delay || 0) + (w.delayIncrement || 0);
              return w;
            });
            chrome.storage.sync.set({ websites });
          });
        } catch (e) {
          debug('Delay update failed:', e);
        }
      }, 400);
    }

    // Started only now that every handler above exists.
    startWaitPhase();
    sendResponse({ status: 'overlay_created' });
  }
})();
