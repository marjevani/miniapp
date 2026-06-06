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
//   <button>, click handler runs copy + sendBeacon + openLink + close
//   synchronously inside the gesture context.
//
// ── Reject-reason (Phase 9) ────────────────────────────────────────
//   A simple form: radio category + free-text textarea + submit. Not
//   time-critical (no clipboard gesture constraint), so submit uses
//   fetch() with a VISIBLE success/error result. POSTs to
//   /api/reject_reason which annotates the already-rejected approval.
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

  // ── Shared auth body ───────────────────────────────────────────────
  function authBody(extra) {
    const b = { id: parseInt(approvalId, 10), tenant: tenant, _auth: tg.initData || '' };
    if (extra) for (const k in extra) b[k] = extra[k];
    return b;
  }

  // ── Dispatch by mode ───────────────────────────────────────────────
  if (mode === 'reason') { initReasonMode(); } else { initSendMode(); }


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
      try {
        const blob = new Blob([JSON.stringify(authBody())], { type: 'text/plain' });
        if (!navigator.sendBeacon(apiUrl + '/api/manual_send', blob)) console.warn('sendBeacon rejected');
      } catch (e) { console.warn('sendBeacon threw:', e); }
      if (copied) {
        tg.openLink(fbUrl, { try_instant_view: false });
        setTimeout(function () { tg.close(); }, 200);
      } else {
        btn.textContent = '⚠ ההעתקה האוטומטית נכשלה — בחר טקסט והדבק ידנית';
        btn.style.background = '#dc3545';
        btn.disabled = false;
      }
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
    // Reason mode's submit is static (in-flow), so drop the big bottom
    // padding that the send mode reserves for its fixed 170px button.
    const container = document.querySelector('.container');
    if (container) container.style.paddingBottom = '16px';

    const radiosEl = document.getElementById('reason-radios');
    const textEl = document.getElementById('reason-text-input');
    const submitBtn = document.getElementById('reason-submit-btn');

    // 2026-06-06: the soft keyboard was covering the textarea + the
    // (formerly fixed) submit button. Two fixes: (a) the submit button
    // is static in reason mode (CSS #reason-submit-btn — flows at the
    // end of the form, so the page scrolls instead of a fixed element
    // fighting the keyboard); (b) on focus, scroll the textarea into
    // the centre of the visible area above the keyboard.
    textEl.addEventListener('focus', function () {
      setTimeout(function () {
        try { textEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      }, 300);
    });

    // Category options. value "" === אחר (stored NULL server-side).
    const OPTIONS = [
      { value: 'wrong_match',     label: '🎯 התאמה לא נכונה' },
      { value: 'wrong_product',   label: '📦 מוצר לא נכון' },
      { value: 'operator_choice', label: '🤷 לא בעיה במערכת' },
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
      if (body.decision && body.decision !== 'rejected') {
        // The draft isn't rejected (e.g. cancelled back to pending).
        submitBtn.disabled = true;
        submitBtn.textContent = 'הטיוטה כבר לא במצב "נדחה"';
        return;
      }
      if (body.reject_reason_code) { selected = body.reject_reason_code; renderRadios(); }
      if (body.reject_reason_text) { textEl.value = body.reject_reason_text; }
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
          submitBtn.textContent = '✓ נשמר';
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
})();
