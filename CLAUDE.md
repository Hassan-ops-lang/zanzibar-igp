# Zanzibar Integrated Government Platform (IGP + SIP) – project notes

Demo system built from the "Skotios – Zanzibar Integrated Government" investor deck. **Used for demos only** (no real citizens yet).
The owner works on a **Windows laptop** and is not a developer: explain in plain language, give one command per code block,
and do the technical work yourself where possible.

## Running it (Windows)
- Folder: `C:\Users\Admin\Documents\Skotios TZ\igp-sip test\zanzibar-igp-main\zanzibar-igp-main` (a git clone of
  https://github.com/Hassan-ops-lang/zanzibar-igp, branch `main`).
- PowerShell blocks `npm.ps1`: always use **`npm.cmd`** (`npm.cmd install`, `npm.cmd start`, `npm.cmd test`).
- App: `npm.cmd start` → http://localhost:3000. Needs Node.js ≥ 22.5 (uses built-in `node:sqlite`).
- Restart after code changes (stop the running `node src/server.js`, start again). Data lives in `data/` (git-ignored):
  **never delete or overwrite `data/`** – it holds the owner's accounts and SMS settings.
- `npm.cmd test` runs 5 end-to-end tests (`test/e2e.test.js`); keep them passing and add tests for new features.
- Commit and push to `main` when a change works.

## Accounts (sample data)
All seeded accounts use password `Zanzibar@2026` (override with `IGP_DEFAULT_PASSWORD` before first start):
`admin`, `executive`, `zmc.desk`, `zmc.officer`, `amina` (citizen) and others listed in README.md.
Citizens without accounts (for sign-up demos), e.g. ZanID `100031689` (born 1971-01-10), `100039608` (1966-09-21).
Admin → Civil registry lists everyone.

## Architecture
- Node + Express 5, SQLite via `node:sqlite` (`src/db.js`, schema + migrations), no build step.
- `src/routes/*` (auth, applications, payments, sip, admin, xapi = inter-agency API), `src/lib/*` (workflow, payments,
  records, sip, sms, render, core = audit/notifications/errors).
- Front end: plain JS in `public/` (`core.js` = auto-escaping `h` templates, router, modal; `views-*.js` per area).
- Security review done (Nov 2026): access control, signed payment callbacks, CSRF origin check, login lockout
  (5 tries → 5 min, in memory), hash-chained audit log. Keep new code to the same standard.

## SMS (Admin → SMS)
- Messages go to `sms_outbox`, then `src/lib/sms.js` sends them **immediately** (`kick()`), with a 5-second
  background retry round (3 attempts). Modes: `outbox` (nothing sent, sign-up code shown on screen), `android`, `beem`.
- Demo setup that works: Android phone running **SMSGate** (capcom6, sms-gate.app) in **Local server** mode,
  username `demo`. The phone shares its **hotspot**; the laptop joins it; gateway address `http://10.96.202.88:8080`
  (the hotspot's Default Gateway in `ipconfig`). On normal Wi-Fi, use the Local address the app shows instead.
- **Demo redirect**: every text goes to the owner's demo phone (entered in Settings, stored only in the database –
  never put personal phone numbers in the code or repo). While sample data is in use, real sending is refused
  without a redirect number, because sample phone numbers are made up.
- Timeouts almost always mean the gateway address is wrong for the current network or the phone is asleep.

## Still to do / ideas
- On the sign-up screen, say "Demo mode: text sent to the demo phone" while the redirect is on.
- Kiswahili language option.
- Mobile money: connect a real aggregator (AzamPay or Selcom) – currently a built-in sandbox network with a
  simulated phone at `#/phone`.
- Sample data: Amina Juma Hassan is recorded as sex "M" – should be "F".
