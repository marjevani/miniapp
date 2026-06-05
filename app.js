// fb-classifier Mini App — Phase 6 manual-send.
//
// O2 architecture (2026-06-04, after O1 experiment):
//
//   In Telegram Android WebView, the asynchronous Clipboard API
//   (`navigator.clipboard.writeText`) is blocked by a missing
//   `RESOURCE_CLIPBOARD_WRITE` grant in DrKLO/Telegram's
//   `BotWebViewContainer.onPermissionRequest`. Confirmed by direct
//   source-code read (deep investigation 2026-06-04 evening).
//
//   The synchronous `document.execCommand('copy')` path uses different
//   plumbing — it requires only a Chromium "transient activation" on
//   the page frame, not a permission grant. A real in-page <button>
//   click creates that activation. Telegram's MainButton tap, which
//   arrives via postMessage from the native UI, does NOT.
//
//   Verified: Rami's Android device successfully pasted the full
//   400-char Hebrew O1 test string into WhatsApp after tapping an
//   in-page <button> + execCommand('copy') on a visible textarea.
//
// Architecture in this file:
//   1. Draft display is a real <textarea readonly> (in index.html),
//      visible to the user, styled to look like a card body. Lives
//      in the DOM from page load.
//   2. Primary action is an in-page <button id="send-btn">, NOT
//      MainButton. MainButton is hidden.
//   3. Button click handler runs inside the user-gesture context:
//        a. Focus + select the textarea
//        b. document.execCommand('copy')
//        c. sendBeacon to /api/manual_send (status update, independent
//           of clipboard outcome)
//        d. tg.openLink(fb_url) + tg.close()
//
// SEC-24 hardening: this file is loaded via <script src> so the CSP
// can drop `script-src 'unsafe-inline'`. All user-facing text goes
// through textContent / textarea.value — never innerHTML.

(function () {
  'use strict';

  // ── Safe DOM-text helpers (SEC-24) ─────────────────────────────────
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
  function showError(msg) {
    clearChildren(document.body);
    const box = makeEl('div', { className: 'err-box' });
    const lines = String(msg).split('\n');
    lines.forEach(function (line, i) {
      if (i > 0) box.appendChild(makeEl('br'));
      box.appendChild(document.createTextNode(line));
    });
    document.body.appendChild(box);
  }

  // ── SDK guard ──────────────────────────────────────────────────────
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg) {
    showError('דף זה נועד להיפתח דרך טלגרם.\nחזור להתראה ולחץ על 📤 שלח ידנית.');
    return;
  }

  // ── Resolve approval context ───────────────────────────────────────
  // Telegram surfaces the BotFather `?startapp=` value as
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

  // ── Init Telegram chrome ───────────────────────────────────────────
  tg.ready();
  // 2026-06-05 UX change: respect the URL's `mode=compact` parameter
  // instead of force-expanding to full height. Compact bottom-sheet
  // keeps the primary button thumb-accessible (sitting just above
  // Telegram's tab bar) without the operator having to reach all the
  // way up the screen. Previous behavior force-expanded "to give the
  // button room" — the actual problem (the textarea taking up the
  // whole viewport) is now bounded by the more conservative
  // max-height on textarea.draft-text below. User can still swipe up
  // to expand if they want a fuller view of a long draft.
  //
  // tg.expand();   ← retired; let compact mode stand
  tg.BackButton.show();
  tg.BackButton.onClick(function () { tg.close(); });
  // O2: MainButton retired in favor of the in-page #send-btn. Hide it
  // explicitly so any cached MainButton state from previous Mini Apps
  // the user opened in this Telegram session doesn't leak into our UI.
  tg.MainButton.hide();

  // ── Wire DOM refs ─────────────────────────────────────────────────
  const ta = document.getElementById('draft-text-display');   // <textarea>
  const btn = document.getElementById('send-btn');             // <button>
  let fbUrl = '';
  let isHandled = false;

  // ── Fetch draft from backend ───────────────────────────────────────
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
      ta.value = 'טעינת הטיוטה נכשלה — ' + reason;
      btn.style.display = 'none';
      return;
    }
    ta.value = body.draft || '';
    fbUrl = body.fb_url || '';
    if (body.already_handled) {
      ta.value += '\n\n⚠ הטיוטה כבר טופלה (' +
        (body.decision || '?') + ') — הכפתור לא פעיל';
      isHandled = true;
      btn.style.display = 'none';
      return;
    }
    btn.disabled = false;
  })
  .catch(function (e) {
    console.warn('draft_view fetch failed:', e);
    ta.value = 'שגיאת רשת בטעינת הטיוטה';
    btn.style.display = 'none';
  });

  // ── Main action: in-page button click ──────────────────────────────
  // CRITICAL: this entire handler runs synchronously inside the click
  // event so the user-gesture / transient-activation context stays
  // alive across:
  //   1. document.execCommand('copy')    ← needs gesture activation
  //   2. navigator.sendBeacon            ← does not need gesture, but
  //                                        gets one anyway
  //   3. tg.openLink                     ← does not need gesture
  //   4. tg.close                        ← does not need gesture
  //
  // The order matters: copy MUST run first (before any async work)
  // because awaiting anything (including a .then()) would tear down
  // the activation context. We don't even await the sendBeacon.
  btn.addEventListener('click', function () {
    if (isHandled || btn.disabled) return;

    // Visual feedback for the duration of the click.
    btn.disabled = true;
    btn.textContent = '⏳ מעתיק…';

    // 1. Copy via execCommand on the visible textarea.
    let copied = false;
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      copied = document.execCommand('copy');
    } catch (e) {
      console.warn('execCommand threw:', e);
    }

    // 2. Status update — independent of clipboard outcome.
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

    // 3. Branch on copy outcome.
    if (copied) {
      // Happy path: open FB + close Mini App. 200ms gives the postMessage
      // chain time to reach the Telegram host before the WebView is torn
      // down (matches Sprint E timing).
      tg.openLink(fbUrl, { try_instant_view: false });
      setTimeout(function () { tg.close(); }, 200);
    } else {
      // Extremely rare given O1 proof, but defend anyway. The textarea
      // is already visible + already populated; the user can long-press
      // it and use the OS context menu to copy manually. Then re-tap.
      btn.textContent = '⚠ ההעתקה האוטומטית נכשלה — בחר טקסט והדבק ידנית';
      btn.style.background = '#dc3545';
      btn.disabled = false;
    }
  });
})();
