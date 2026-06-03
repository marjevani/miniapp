# miniapp

Telegram Mini App page for fb-classifier's Phase 6 manual-send feature.

This repo is **intentionally public** and contains **zero secrets** —
every draft-specific value (draft text, FB permalink, expiry) arrives
via the URL fragment, which is set by the bot per-tap and never persists
here.

- One static HTML file. No build step. `git push` → live on GitHub Pages.
- Live at: <https://marjevani.github.io/miniapp/>
- Full design lives in the private system repo's
  `docs/PHASE6_MANUAL_SEND.md`.

The page is meaningless without being opened via a Telegram inline
keyboard `web_app` button — opening it directly in a browser shows an
"open via Telegram" message and exits.

## Security model

- **No backend in this repo.** The Mini App POSTs to a separate
  cloudflared tunnel exposing the bot's HTTP route on the operator's
  Mac. Auth is Telegram's WebApp `initData` (HMAC-SHA-256 with the bot
  token), verified server-side.
- **CSP** (in `<head>`) locks `script-src` to `https://telegram.org` +
  inline (no remote scripts allowed); `connect-src` is whitelisted to
  the tunnel hostname only.
- **No persistent state.** Page has no service worker, no localStorage,
  no IndexedDB. Each open is fresh.

## Branch protection

`main` requires linear history; no force-push, no deletion. Updates land
via direct push by the repo owner.
