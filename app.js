// fb-classifier Mini App — Phase 6 manual-send + Phase 9 reject-reason.
//
// TWO MODES, selected by the start_param suffix:
//   <tenant>_<id>          → manual-send (Phase 6)
//   <tenant>_<id>_reason   → reject-reason form (Phase 9, 2026-06-06)
//
// ── Manual-send (Phase 6) O2 architecture ──────────────────────────
//   In Telegram Android WebView the async Clipboard API is blocked
//   (missing RESOURCE_CLIPBOARD_WRITE grant). The sync
//   document.execCommand('copy') path works because it only needs a
//   Chromium "transient activation" from a real in-page <button> click
//   (MainButton's postMessage tap does NOT create that activation).
//   So: draft is a visible <textarea>, primary action is an in-page
//   <button>; its click handler runs copy + openLink synchronously inside
//   the gesture, then a keepalive fetch (manual_send) and closes once it
//   settles (sendBeacon-at-close was dropped on Telegram Desktop — 2026-06-14).
//
// ── Reject-reason (Phase 9, extended Phase 10 2026-07-01) ──────────
//   A simple form: radio category + free-text textarea + submit. Not
//   time-critical (no clipboard gesture constraint), so submit uses
//   fetch() with a VISIBLE success/error result. POSTs to
//   /api/reject_reason.
//   Phase 10: the ❌ דחה - שגוי (wrong-match) draft button opens this
//   form on a PENDING draft — submitting COMMITS the reject there
//   (pending → rejected + code + text). It still serves the Phase-9
//   annotate case (an already-rejected row from an old keyboard).
//   operator_choice ("לא בעיה במערכת") is no longer a category here —
//   it's the dedicated 👍 דחה - תקין button (committed via callback).
//
// SEC-24: this file is loaded via <script src> so the CSP can drop
// `script-src 'unsafe-inline'`. All user text goes through
// textContent / textarea.value / createElement — never innerHTML.

(function () {
  'use strict';

  // ── Safe DOM helpers (SEC-24) ──────────────────────────────────────
  function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function makeEl(tag, attrs, textContent) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'className') e.className = attrs[k];
        else if (k === 'style') { for (const sk in attrs.style) e.style[sk] = attrs.style[sk]; }
        else e.setAttribute(k, attrs[k]);
      }
    }
    if (textContent !== undefined) e.textContent = String(textContent);
    return e;
  }
  function showError(msg) {
    clearChildren(document.body);
    const box = makeEl('div', { className: 'err-box' });
    String(msg).split('\n').forEach(function (line, i) {
      if (i > 0) box.appendChild(makeEl('br'));
      box.appendChild(document.createTextNode(line));
    });
    document.body.appendChild(box);
  }

  // ── SDK guard ──────────────────────────────────────────────────────
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg) {
    showError('דף זה נועד להיפתח דרך טלגרם.\nחזור להתראה ולחץ על הכפתור.');
    return;
  }

  // ── Resolve approval context + MODE ────────────────────────────────
  // start_param: <tenant>_<id> (send) or <tenant>_<id>_reason (reason).
  let tenant = '', approvalId = '', mode = 'send';
  const startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
  if (startParam) {
    const m = startParam.match(/^([a-z0-9-]+)_(\d+)(?:_([a-z]+))?$/);
    if (m) { tenant = m[1]; approvalId = m[2]; if (m[3]) mode = m[3]; }
  }
  if (!tenant || !approvalId) {
    const qs = new URLSearchParams(window.location.search);
    tenant = qs.get('tenant') || '';
    approvalId = qs.get('id') || '';
    if (qs.get('mode2')) mode = qs.get('mode2');  // legacy/test override
  }
  if (!tenant || !approvalId) {
    showError('קישור לא תקין — חסרים פרטי טיוטה.\nחזור להתראה ופתח מחדש.');
    return;
  }

  // ── API base URL ──────────────────────────────────────────────────
  const apiMeta = document.querySelector('meta[name=miniapp-api-url]');
  const apiUrl = apiMeta ? apiMeta.content.trim() : '';
  if (!apiUrl) { showError('תצורה חסרה (api-url). פנה למפתח.'); return; }

  // ── Telegram chrome (shared) ───────────────────────────────────────
  tg.ready();
  function syncBottomOffset() {
    const layoutVH = document.documentElement.clientHeight || window.innerHeight || 0;
    const tgVH = tg.viewportStableHeight || tg.viewportHeight || layoutVH;
    document.documentElement.style.setProperty('--tg-bottom-offset', Math.max(0, layoutVH - tgVH) + 'px');
  }
  syncBottomOffset();
  try { tg.onEvent('viewportChanged', syncBottomOffset); } catch (e) {}
  window.addEventListener('resize', syncBottomOffset);
  tg.BackButton.show();
  tg.BackButton.onClick(function () { tg.close(); });
  tg.MainButton.hide();

  // Manual-send (send mode) opens COMPACT but blocks swipe-to-minimize so an
  // accidental swipe-down can't dismiss it mid-send (operator request
  // 2026-07-03). We do NOT expand() — the half-height compact sheet is the
  // intended lighter UX. A tap-outside can still minimize it (Telegram has no
  // API to block the backdrop tap); the short claim TTL auto-releases any
  // stray lock. disableVerticalSwipes is Bot API 7.7+ — guarded so older
  // clients no-op. reason/edit keep the default behavior.
  if (mode === 'send') {
    try {
      if (tg.isVersionAtLeast && tg.isVersionAtLeast('7.7') && tg.disableVerticalSwipes) {
        tg.disableVerticalSwipes();
      }
    } catch (e) { console.warn('send swipe-disable failed (non-fatal):', e); }
  }

  // ── Shared auth body ───────────────────────────────────────────────
  function authBody(extra) {
    const b = { id: parseInt(approvalId, 10), tenant: tenant, _auth: tg.initData || '' };
    if (extra) for (const k in extra) b[k] = extra[k];
    return b;
  }

  // ── Dispatch by mode ───────────────────────────────────────────────
  if (mode === 'reason') { initReasonMode(); }
  else if (mode === 'edit') { initEditMode(); }
  else { initSendMode(); }


  // ═══════════════════════════════════════════════════════════════════
  // MANUAL-SEND MODE (Phase 6) — preserved verbatim from the O2 design.
  // ═══════════════════════════════════════════════════════════════════
  function initSendMode() {
    document.getElementById('send-form').hidden = false;
    document.getElementById('reason-form').hidden = true;

    const ta = document.getElementById('draft-text-display');
    const btn = document.getElementById('send-btn');
    let fbUrl = '';
    let isHandled = false;

    fetch(apiUrl + '/api/draft_view', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(authBody()),
    })
    .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
    .then(function (x) {
      const status = x.status, body = x.body;
      if (status !== 200 || !body.ok) {
        ta.value = 'טעינת הטיוטה נכשלה — ' + ((body && body.reason) || 'unknown_error');
        btn.style.display = 'none';
        return;
      }
      ta.value = body.draft || '';
      fbUrl = body.fb_url || '';
      // Multi-operator lock (v18, 2026-07-03): another operator opened this
      // draft first and owns it. Don't reveal a copyable draft or a send
      // button — that's how a duplicate FB comment would happen.
      if (body.locked_by_other) {
        ta.value = '🔒 הטיוטה מטופלת כרגע על ידי מפעיל אחר';
        isHandled = true;
        btn.style.display = 'none';
        return;
      }
      if (body.already_handled) {
        ta.value += '\n\n⚠ הטיוטה כבר טופלה (' + (body.decision || '?') + ') — הכפתור לא פעיל';
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

    btn.addEventListener('click', function () {
      if (isHandled || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '⏳ מעתיק…';
      let copied = false;
      try {
        ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
        copied = document.execCommand('copy');
      } catch (e) { console.warn('execCommand threw:', e); }
      // Open FB NOW, inside the click gesture (Desktop blocks openLink after
      // an await); only when the copy worked — otherwise the operator pastes
      // manually from the textarea.
      if (copied) {
        tg.openLink(fbUrl, { try_instant_view: false });
        btn.textContent = '⏳ שולח…';
      } else {
        btn.textContent = '⚠ ההעתקה האוטומטית נכשלה — בחר טקסט והדבק ידנית';
        btn.style.background = '#dc3545';
        btn.disabled = false;
      }
      // Commit the manual-send. Was navigator.sendBeacon(...) fired the instant
      // before tg.close() — UNRELIABLE on Telegram Desktop: the POST was dropped
      // on webview teardown (amplified by VPN latency), so the backend never
      // recorded the send and the message never updated (2026-06-14). Fix: a
      // keepalive fetch (survives teardown) + close ONLY after it settles, with
      // a 2.5s fallback so a slow VPN can never hang the view.
      var settled = false;
      function onSettle() {
        if (settled) return;
        settled = true;
        if (copied) setTimeout(function () { tg.close(); }, 100);
      }
      try {
        fetch(apiUrl + '/api/manual_send', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(authBody()),
          keepalive: true,
        }).catch(function (e) { console.warn('manual_send POST failed:', e); })
          .finally(onSettle);
      } catch (e) {
        console.warn('manual_send fetch threw:', e);
        onSettle();
      }
      setTimeout(onSettle, 2500);  // fallback close — never hang on a slow VPN
    });
  }


  // ═══════════════════════════════════════════════════════════════════
  // REJECT-REASON MODE (Phase 9, 2026-06-06)
  // ═══════════════════════════════════════════════════════════════════
  function initReasonMode() {
    // 2026-06-06: the reason form has more content than manual-send
    // (radios + textarea + submit), so open EXPANDED (full height)
    // instead of the compact bottom-sheet. This also gives the
    // textarea real room — the cramped compact sheet was likely why
    // typed text wasn't reliably captured. Manual-send stays compact.
    try { tg.expand(); } catch (e) {}

    document.getElementById('send-form').hidden = true;
    const form = document.getElementById('reason-form');
    form.hidden = false;

    // Element refs FIRST (these must exist before the keyboard handlers
    // below reference them — declaring them after would hit the const
    // temporal-dead-zone and abort initReasonMode: empty radios + dead
    // submit, the 2026-06-06 bug).
    const container = document.querySelector('.container');
    const radiosEl = document.getElementById('reason-radios');
    const textEl = document.getElementById('reason-text-input');
    const submitBtn = document.getElementById('reason-submit-btn');

    // 2026-06-06 (simple static approach): everything is in normal flow.
    // When the keyboard opens, scroll the page up by the keyboard height
    // so the textarea + submit sit just above the keyboard (categories
    // scroll off the top — acceptable per operator). No position:fixed
    // anywhere (that caused a black screen in the WebView).
    function keyboardHeight() {
      const layoutVH = window.innerHeight || document.documentElement.clientHeight || 0;
      const visibleVH = (window.visualViewport && window.visualViewport.height)
                        || tg.viewportHeight || layoutVH;
      return Math.max(0, layoutVH - visibleVH);  // dynamic per device
    }

    function liftAboveKeyboard() {
      const kb = keyboardHeight();
      if (kb <= 0) return;  // keyboard not (yet) reported as covering
      // Give the page enough scrollable room below the submit button…
      if (container) container.style.paddingBottom = (kb + 24) + 'px';
      // …then nudge so the submit's bottom sits just above the keyboard.
      const rect = submitBtn.getBoundingClientRect();
      const target = (window.innerHeight || 0) - kb - 10;
      const delta = rect.bottom - target;
      if (delta > 0) window.scrollBy({ top: delta, behavior: 'smooth' });
    }

    textEl.addEventListener('focus', function () {
      // Wait for the keyboard animation + visualViewport to settle.
      setTimeout(liftAboveKeyboard, 350);
    });
    textEl.addEventListener('blur', function () {
      if (container) container.style.paddingBottom = '16px';
    });
    if (window.visualViewport) {
      // Re-run if the keyboard height changes while typing.
      window.visualViewport.addEventListener('resize', function () {
        if (document.activeElement === textEl) liftAboveKeyboard();
      });
    }

    // Category options. value "" === אחר (stored NULL server-side).
    // 2026-06-06: the authoritative list is served by the backend
    // (draft_view → reason_options, sourced from common.reject_reasons)
    // so adding/renaming a category is a one-file edit server-side and
    // this page picks it up with no JS change. This hardcoded list is
    // only a FALLBACK for an older cached page / a backend that didn't
    // send options.
    let OPTIONS = [
      { value: 'wrong_match',     label: '🎯 התאמה לא נכונה' },
      { value: 'wrong_product',   label: '📦 מוצר לא נכון' },
      { value: '',                label: '❓ אחר' },
    ];
    let selected = '';  // default אחר

    function renderRadios() {
      clearChildren(radiosEl);
      OPTIONS.forEach(function (opt) {
        const row = makeEl('label', { className: 'reason-opt' + (opt.value === selected ? ' selected' : '') });
        const radio = makeEl('input', { type: 'radio', name: 'reason' });
        radio.checked = (opt.value === selected);
        radio.addEventListener('change', function () { selected = opt.value; renderRadios(); });
        row.appendChild(radio);
        row.appendChild(makeEl('span', null, opt.label));
        radiosEl.appendChild(row);
      });
    }
    renderRadios();

    // Load current draft + pre-select existing category / free text.
    fetch(apiUrl + '/api/draft_view', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(authBody()),
    })
    .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
    .then(function (x) {
      const body = x.body || {};
      if (x.status !== 200 || !body.ok) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'טעינה נכשלה — ' + (body.reason || 'error');
        return;
      }
      // Multi-operator lock (v18, 2026-07-03): another operator owns this
      // draft. A locked row is still 'pending' (soft-lock), so it would pass
      // the ALLOWED check below and wrongly render the form — check it FIRST.
      // (The backend also refuses the commit server-side.)
      if (body.locked_by_other) {
        submitBtn.disabled = true;
        submitBtn.textContent = '🔒 מטופל על ידי מפעיל אחר';
        return;
      }
      // Phase 10 (2026-07-01): the reason form now serves TWO states —
      //   • a PENDING draft (the ❌ דחה - שגוי wrong-match button opens
      //     this form on a live draft; submitting COMMITS the reject), and
      //   • an already-REJECTED draft (Phase-9 back-compat annotate).
      // Any other (terminal) state means it was actioned elsewhere.
      var ALLOWED = ['pending', 'edit_pending', 'edit_review', 'rejected'];
      if (body.decision && ALLOWED.indexOf(body.decision) === -1) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'הטיוטה כבר טופלה (' + body.decision + ')';
        return;
      }
      // Backend-driven category list (one source of truth). Falls back
      // to the hardcoded OPTIONS above if the backend didn't send any.
      if (Array.isArray(body.reason_options) && body.reason_options.length) {
        OPTIONS = body.reason_options.map(function (o) {
          return { value: o.code || '', label: o.label };
        });
      }
      if (body.reject_reason_code) { selected = body.reject_reason_code; }
      renderRadios();
      if (body.reject_reason_text) { textEl.value = body.reject_reason_text; }
      // Phase 10 (2026-07-01): jump STRAIGHT into the free-text box so the
      // phone keyboard opens and the operator can type immediately (the
      // category radios stay tappable above; the 'focus' handler lifts the
      // box above the keyboard). Programmatic focus is allowed here because
      // the Mini App itself was opened by a user tap. Small delay lets the
      // WebView finish expanding before we focus.
      setTimeout(function () { try { textEl.focus(); } catch (e) {} }, 300);
    })
    .catch(function (e) {
      console.warn('draft_view (reason) failed:', e);
      submitBtn.disabled = true;
      submitBtn.textContent = 'שגיאת רשת';
    });

    submitBtn.addEventListener('click', function () {
      if (submitBtn.disabled) return;
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ שומר…';
      fetch(apiUrl + '/api/reject_reason', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(authBody({ reason_code: selected, reason_text: textEl.value || '' })),
      })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (x) {
        const body = x.body || {};
        if (x.status === 200 && body.ok) {
          submitBtn.textContent = '✓ נדחה ונשמר';
          submitBtn.style.background = '#28a745';
          setTimeout(function () { tg.close(); }, 250);
        } else {
          submitBtn.textContent = '⚠ שמירה נכשלה — ' + (body.reason || x.status);
          submitBtn.style.background = '#dc3545';
          submitBtn.disabled = false;
        }
      })
      .catch(function (e) {
        console.warn('reject_reason submit failed:', e);
        submitBtn.textContent = '⚠ שגיאת רשת — נסה שוב';
        submitBtn.style.background = '#dc3545';
        submitBtn.disabled = false;
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // EDIT MODE (2026-06-07) — edit the draft text in a box + Send. Replaces
  // the reply→confirm flow with one Mini App interaction. start_param
  // suffix `_edit`.
  // ═══════════════════════════════════════════════════════════════════
  function initEditMode() {
    try { tg.expand(); } catch (e) {}

    document.getElementById('send-form').hidden = true;
    const reasonForm = document.getElementById('reason-form');
    if (reasonForm) reasonForm.hidden = true;
    document.getElementById('edit-form').hidden = false;

    // Element refs FIRST (avoid the const TDZ the keyboard handlers below
    // would otherwise hit — same bug class fixed in initReasonMode).
    const container = document.querySelector('.container');
    const textEl = document.getElementById('edit-text-input');
    const submitBtn = document.getElementById('edit-submit-btn');

    // Auto-open the keyboard for edit (operator request 2026-06-07): focus
    // the textarea, cursor at end. A focus() fired too early (before the
    // Mini App's open animation + viewport settle) is ignored by some
    // Android WebViews, so we retry on a short ramp. iOS may still require
    // one tap — programmatic keyboard-open without a gesture is blocked
    // there by the platform — but the box is always immediately editable.
    function focusEnd() {
      try {
        textEl.focus();
        textEl.setSelectionRange(textEl.value.length, textEl.value.length);
      } catch (e) {}
    }

    // Keyboard-lift: scroll the page up by the keyboard height so the
    // textarea + Send stay visible (same approach as initReasonMode).
    function keyboardHeight() {
      const layoutVH = window.innerHeight || document.documentElement.clientHeight || 0;
      const visibleVH = (window.visualViewport && window.visualViewport.height)
                        || tg.viewportHeight || layoutVH;
      return Math.max(0, layoutVH - visibleVH);
    }
    function liftAboveKeyboard() {
      const kb = keyboardHeight();
      if (kb <= 0) return;
      if (container) container.style.paddingBottom = (kb + 24) + 'px';
      const rect = submitBtn.getBoundingClientRect();
      const target = (window.innerHeight || 0) - kb - 10;
      const delta = rect.bottom - target;
      if (delta > 0) window.scrollBy({ top: delta, behavior: 'smooth' });
    }
    textEl.addEventListener('focus', function () { setTimeout(liftAboveKeyboard, 350); });
    textEl.addEventListener('blur', function () {
      if (container) container.style.paddingBottom = '16px';
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        if (document.activeElement === textEl) liftAboveKeyboard();
      });
    }

    // Focus immediately (empty box) so the keyboard starts opening without
    // waiting on the network; the fetch below fills the value + re-focuses
    // with the cursor at the end.
    focusEnd();

    // Load + pre-fill the current draft (prior edit if any, else original).
    fetch(apiUrl + '/api/draft_view', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(authBody()),
    })
    .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
    .then(function (x) {
      const body = x.body || {};
      if (x.status !== 200 || !body.ok) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'טעינה נכשלה — ' + (body.reason || 'error');
        return;
      }
      textEl.value = body.edited_text || body.draft || '';
      // Multi-operator lock (v18, 2026-07-03): another operator owns this
      // draft — don't let this one edit it in parallel.
      if (body.locked_by_other) {
        textEl.value = '🔒 הטיוטה מטופלת כרגע על ידי מפעיל אחר';
        textEl.disabled = true;
        submitBtn.disabled = true;
        submitBtn.textContent = '🔒 מטופל על ידי מפעיל אחר';
        return;
      }
      if (body.already_handled) {
        textEl.disabled = true;
        submitBtn.disabled = true;
        submitBtn.textContent = 'הטיוטה כבר טופלה';
        return;
      }
      // Focus once the draft is in, then retry on a short ramp to beat the
      // open-animation / viewport-settle window that swallows an early focus.
      focusEnd();
      setTimeout(focusEnd, 150);
      setTimeout(focusEnd, 400);
    })
    .catch(function (e) {
      console.warn('draft_view (edit) failed:', e);
      submitBtn.disabled = true;
      submitBtn.textContent = 'שגיאת רשת';
    });

    submitBtn.addEventListener('click', function () {
      if (submitBtn.disabled) return;
      const text = (textEl.value || '').trim();
      if (!text) { textEl.focus(); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ שולח…';
      fetch(apiUrl + '/api/edit_send', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(authBody({ edited_text: text })),
      })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (x) {
        const body = x.body || {};
        if (x.status === 200 && body.ok) {
          submitBtn.textContent = '✓ נשלח';
          submitBtn.style.background = '#28a745';
          setTimeout(function () { tg.close(); }, 250);
        } else {
          submitBtn.textContent = '⚠ נכשל — ' + (body.reason || x.status);
          submitBtn.style.background = '#dc3545';
          submitBtn.disabled = false;
        }
      })
      .catch(function (e) {
        console.warn('edit_send failed:', e);
        submitBtn.textContent = '⚠ שגיאת רשת — נסה שוב';
        submitBtn.style.background = '#dc3545';
        submitBtn.disabled = false;
      });
    });
  }
})();
