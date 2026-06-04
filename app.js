// fb-classifier Mini App — Phase 6 manual-send.
//
// Lives as a separate file (extracted from index.html SEC-24 hardening,
// 2026-06-04) so the CSP can drop `script-src 'unsafe-inline'` — XSS
// payloads injected via a future bug can no longer execute.
//
// Public API surface: none. Reads start_param + initData from
// window.Telegram.WebApp, fetches draft from backend, wires MainButton.

(function () {
  'use strict';

  // ── Safe DOM-text helpers (SEC-24 hardening) ───────────────────────
  // All user-facing text MUST go through these — no innerHTML anywhere
  // in this file. textContent escapes special chars; setting innerHTML
  // with backend-supplied data is the XSS sink we removed.
  function setText(el, txt) { el.textContent = String(txt); }
  function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function makeEl(tag, attrs, textContent) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'className') e.className = attrs[k];
        else if (k === 'style') {
          for (const sk in attrs.style) e.style[sk] = attrs.style[sk];
        } else e.setAttribute(k, attrs[k]);
      }
    }
    if (textContent !== undefined) e.textContent = String(textContent);
    return e;
  }
  function showError(htmlSafeMessage) {
    // Replaces body content with a single .err-box div containing
    // a TEXT NODE only — no innerHTML, no HTML interpretation.
    clearChildren(document.body);
    const box = makeEl('div', { className: 'err-box' });
    // Allow simple <br> by splitting on a sentinel. Caller passes only
    // strings made of fixed app text — no backend-supplied content.
    const lines = String(htmlSafeMessage).split('\n');
    lines.forEach(function (line, i) {
      if (i > 0) box.appendChild(makeEl('br'));
      box.appendChild(document.createTextNode(line));
    });
    document.body.appendChild(box);
  }
  function showHandledNote(decision) {
    // Append a "<br><br><i>already handled</i>" note to the draft
    // display safely (no innerHTML += pattern).
    const display = document.getElementById('draft-text-display');
    display.appendChild(makeEl('br'));
    display.appendChild(makeEl('br'));
    const note = makeEl('i', { style: { color: '#888' } });
    note.textContent =
      '⚠ הטיוטה כבר טופלה (' + String(decision || '?') + ') — הכפתור לא פעיל';
    display.appendChild(note);
  }

  // ── SDK presence guard ─────────────────────────────────────────────
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg) {
    showError('דף זה נועד להיפתח דרך טלגרם.\nחזור להתראה ולחץ על 📤 שלח ידנית.');
    return;
  }

  // ── Resolve approval context ───────────────────────────────────────
  // Option A: Telegram surfaces the BotFather `?startapp=` value as
  // tg.initDataUnsafe.start_param. Legacy fallback: ?tenant=&id=
  // query string from pre-Sprint-E demo URLs.
  let tenant = '', approvalId = '';
  const startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
  if (startParam) {
    const m = startParam.match(/^([a-z0-9-]+)_(\d+)$/);
    if (m) { tenant = m[1]; approvalId = m[2]; }
  }
  if (!tenant || !approvalId) {
    const qs = new URLSearchParams(window.location.search);
    tenant = qs.get('tenant') || '';
    approvalId = qs.get('id') || '';
  }
  if (!tenant || !approvalId) {
    showError('קישור לא תקין — חסרים פרטי טיוטה.\nחזור להתראה ופתח מחדש.');
    return;
  }

  // ── API base URL ──────────────────────────────────────────────────
  const apiMeta = document.querySelector('meta[name=miniapp-api-url]');
  const apiUrl = apiMeta ? apiMeta.content.trim() : '';
  if (!apiUrl) {
    showError('תצורה חסרה (api-url). פנה למפתח.');
    return;
  }

  tg.ready();
  tg.BackButton.show();
  tg.BackButton.onClick(function () { tg.close(); });

  const display = document.getElementById('draft-text-display');
  setText(display, 'טוען טיוטה…');

  // L1 (2026-06-04): MainButton appears IMMEDIATELY on page load with
  // the click handler attached. Operators don't have to wait for the
  // backend's /api/draft_view response before they can tap. If they
  // tap before the draft arrives, we queue the action and auto-fire
  // it the moment the draft loads. Cuts perceived "time-until-tappable"
  // from ~2-3s to ~50ms (Co-operator Rami feedback 2026-06-04: "5-6s
  // before the button became tappable").
  let draftText = '', fbUrl = '';
  let isReady = false;        // true once draft_view returned successfully
  let pendingTap = false;     // true if user tapped while loading
  let isHandled = false;      // true if draft was already_handled (terminal)

  tg.MainButton.setText('📤 שלח ידנית');
  tg.MainButton.showProgress(false);  // visual: "I'm loading the draft"
  tg.MainButton.show();
  tg.MainButton.onClick(function () {
    if (isHandled) {
      return;  // shouldn't be reachable — hide() should have fired
    }
    if (isReady) {
      handleManualSend();
    } else {
      // User tapped while we're still loading. Queue the action and
      // remember it; fire as soon as draft_view returns. MainButton
      // already shows the spinner from page load, so visual feedback
      // is consistent.
      pendingTap = true;
    }
  });

  fetch(apiUrl + '/api/draft_view', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      id: parseInt(approvalId, 10),
      tenant: tenant,
      _auth: tg.initData || '',
    }),
  })
  .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
  .then(function (x) {
    const status = x.status, body = x.body;
    if (status !== 200 || !body.ok) {
      const reason = (body && body.reason) || 'unknown_error';
      // SEC-24: build the error DOM safely — no innerHTML.
      clearChildren(display);
      const i = makeEl('i');
      i.textContent = 'טעינת הטיוטה נכשלה — ' + reason;
      display.appendChild(i);
      tg.MainButton.hide();
      return;
    }
    draftText = body.draft || '';
    fbUrl = body.fb_url || '';
    setText(display, draftText);  // safe — textContent
    if (body.already_handled) {
      showHandledNote(body.decision);  // safe — uses appendChild/textContent
      isHandled = true;
      tg.MainButton.hide();
      return;
    }
    tg.MainButton.hideProgress();
    isReady = true;
    // L1: if the user already tapped while we were loading, fire NOW.
    if (pendingTap) {
      handleManualSend();
    }
  })
  .catch(function (e) {
    console.warn('draft_view fetch failed:', e);
    clearChildren(display);
    const i = makeEl('i', null, 'שגיאת רשת בטעינת הטיוטה');
    display.appendChild(i);
    tg.MainButton.hide();
  });

  // ── Main action ────────────────────────────────────────────────────
  // CRITICAL ORDERING for clipboard reliability (co-operator feedback
  // 2026-06-04): clipboard write MUST execute synchronously inside the
  // user-gesture handler — Promise chains break the gesture context on
  // mobile WebViews (especially iOS), causing silent clipboard-write
  // failures. We do the synchronous textarea+execCommand path FIRST
  // (universally supported, always works inside a real click handler),
  // then we ALSO fire the async Clipboard API path as belt-and-braces
  // (more reliable on modern desktop / Android).
  function handleManualSend() {
    tg.MainButton.showProgress(false);

    // === STEP 1: clipboard, synchronous, inside the gesture ===
    // textarea + execCommand('copy') — deprecated but universally
    // supported inside a user-gesture handler. Doing this FIRST and
    // SYNCHRONOUSLY is the load-bearing fix.
    let syncCopyOk = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = draftText;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, draftText.length);
      syncCopyOk = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {
      console.warn('sync copy threw:', e);
    }

    // Belt-and-braces: also fire the async Clipboard API (no await).
    // Some browsers prefer this path; if it works it's a no-op for the
    // already-copied state. If it fails, the sync path above already
    // succeeded (in most cases).
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(draftText).catch(function (e) {
          if (!syncCopyOk) {
            console.warn('clipboard write failed in both paths:', e);
          }
        });
      }
    } catch (e) { /* ignore — sync path may have succeeded */ }

    // === STEP 2: sendBeacon to backend ===
    try {
      const payload = JSON.stringify({
        id: parseInt(approvalId, 10),
        tenant: tenant,
        _auth: tg.initData || '',
      });
      const blob = new Blob([payload], { type: 'text/plain' });
      const queued = navigator.sendBeacon(apiUrl + '/api/manual_send', blob);
      if (!queued) console.warn('sendBeacon rejected by user-agent');
    } catch (e) {
      console.warn('sendBeacon threw:', e);
    }

    // === STEP 3: open FB + close Mini App ===
    // No Promise wait — we did the clipboard sync above so there's
    // nothing to await. Closing 200ms after openLink gives the
    // postMessage time to reach the Telegram host before the WebView
    // is destroyed (matches v10 testing).
    tg.openLink(fbUrl, { try_instant_view: false });
    setTimeout(function () { tg.close(); }, 200);
  }
})();
