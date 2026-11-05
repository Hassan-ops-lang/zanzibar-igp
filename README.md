# Integrated Government Platform (IGP) + Sovereign Intelligence Platform (SIP)

*Mifumo Zinasomana. Zanzibar Moja.*

This is a self-contained web system for the Revolutionary Government of Zanzibar. It covers every feature in the
*Integrated Government* deck: digitizing manual services, the three IGP integration phases, and the SIP leadership layer.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

Requires Node.js 22.5 or later, which has built-in SQLite. There is no external database. Data is stored in `data/igp.sqlite`, and uploaded files go to `data/uploads/`.

```bash
npm run seed         # wipe and rebuild the database with reference + sample data
npm test             # end-to-end tests over real HTTP (full walkthrough, security, API, registration)
docker build -t igp . && docker run -p 3000:3000 -v igp-data:/data igp
```

All seeded accounts use the password **`Zanzibar@2026`**. You can change it with `IGP_DEFAULT_PASSWORD` before seeding.

| Role | Username(s) |
|---|---|
| Applicant (owns *Amina Spice House*) | `amina` (also `said`) |
| Front office / service desk | `zmc.desk`, `fire.desk`, `zfda.desk`, `zrb.desk`, `col.desk`, `zcsra.desk` |
| Back office officer | `zmc.officer`, `fire.officer`, `zfda.officer`, `moh.officer`, `zrb.officer`, `col.officer`, `zema.officer`, `zcsra.officer`, `bpra.officer` |
| Finance | `finance` |
| Ministry leader | `zmc.leader`, `fire.leader`, `zfda.leader`, `moh.leader`, `zrb.leader`, `col.leader`, `zema.leader`, `zcsra.leader` |
| Security services | `security` |
| Executive | `executive` |
| System administrator | `admin` |

## Feature map (deck → system)

| Deck | What is built |
|---|---|
| **Digitize**: manual services | Admin → *Services* lets you define a service: form fields, required documents, fee, service standard, routing and output document. Seven services are seeded, five of them digitized from paper and two integrated ones that were already online. Applicants submit online. Front-office staff submit paper applications on the applicant's behalf through **Assisted application**. Decisions are recorded digitally on the case timeline. |
| **Phase 1**: intra-governmental integration | Nine ministries, departments and agencies (MDAs) are seeded. **Verified records** (ZanID, business registration, TIN, tax clearance, fire certificate, land title…) are reused automatically, so applicants aren't asked for the same document twice. Admin → *Record sharing* controls which office may read which record type. **Referrals** between offices have digital outcomes. The **inter-agency REST API** (`/api/x/v1`, per-agency API keys) lets MDA systems read granted records, publish records, feed the civil and business registries, and answer referrals. |
| **Phase 2**: G2T mobile money | Each fee gets a control number. The system sends a payment push to the provider, which answers with a **callback signed with HMAC-SHA256** (`/api/payments/callback/:provider`). Payments are matched to their application, and receipts go out by SMS and as a printable page. Officers can see the payment status. Finance gets collections dashboards, **statement import and reconciliation** (matched, mismatch and unmatched exceptions), counter payments and manual reconciliation. |
| **Phase 3**: portal and workflow | Applicants can apply, track progress, respond to document requests, pay, and download their certificate. Front office checks submissions, requests documents and routes cases. Back office verifies records, makes referrals, approves or rejects, and issues the document. **One tracking reference** follows the case through every handoff. Certificates carry a QR code and verification code (public **Verify** page). An issued document becomes a verified record that other offices can reuse. |
| **SIP**: what leaders see | **Ministry leaders** see their own ministry's KPIs, service-standard breaches, cases needing action and alerts. **Security services** see risk alerts (the same document file used by different applicants, one phone shared by several identities, third-party payments, unusual application volume) and **link analysis** (identities, businesses, applications, phones and documents). A stated purpose is required and logged. The **Executive** gets one dashboard with every ministry, priority alerts, escalated matters and a **daily snapshot**. SIP stays off until phases 1–3 are live (Admin → *Rollout phases*). **All access is logged** in a hash-chained, tamper-evident audit log. |
| **Presidential walkthrough** | Covered by `test/e2e.test.js`, and you can click through it yourself; see below. |

## Walk through the business permit (slide 7)

1. **Apply.** Sign in as `amina` → *Apply for a service* → *Business licence* → *Amina Spice House*. Five verified records are reused and the address is pre-filled. Submit without the lease.
2. **Request a document.** Sign in as `zmc.desk` → open the case → *Request document* → choose the lease.
3. **Upload.** As `amina`, upload the lease on the *Action needed* card.
4. **Route.** As `zmc.desk`, choose *Check & route for review*. The Fire Service referral is created automatically.
5. **Answer the referral.** As `fire.officer`, open the case and choose *Clear*.
6. **Approve.** As `zmc.officer`, choose *Approve*. The case is now waiting for payment.
7. **Pay.** As `amina`, choose *Pay with mobile money* → *Open sandbox handset* → enter any 4-digit PIN. The signed callback marks the fee paid.
8. **Issue.** As `zmc.officer`, choose *Issue Business Licence*. `amina` can then download it, and the code verifies at `#/verify`.
9. **SIP.** As `zmc.leader` or `executive`, the completed case shows in the dashboards.

## Going live: what needs real-world connection

The software paths are complete. These parts run against built-in sandboxes until real credentials and agreements exist:

- **Mobile money.** Providers start in `sandbox` mode, served by the built-in network and handset at `#/phone`. Switch each provider to `live` in Admin → *Payment providers*, then set its HTTPS API base and callback secret. A live push is `POST {api_base}/push`, signed the same way. Adapt the request body to each telco's G2T specification if it differs.
- **SMS.** Messages are written to the `sms_outbox` table (Admin → *SMS outbox*). Connect a gateway worker that sends queued rows. Set `IGP_SMS_MODE=live` to stop the sign-up code from appearing on screen.
- **Civil and business registries.** These are seeded with sample people and businesses. In production the registry agencies push them through `POST /api/x/v1/persons` and `/businesses`.
- **Production settings.** Set `IGP_SECURE_COOKIES=1` behind HTTPS, `IGP_DISABLE_SANDBOX=1` once all providers are live, and `IGP_SAMPLE_DATA=0` to start without sample data. Back up the `data/` directory.

## Layout

```
src/server.js          app, security headers, CSRF origin check, background jobs (SIP rules each minute, daily snapshot)
src/db.js              SQLite schema
src/seed.js            reference data, staff, sample registry and case history
src/lib/workflow.js    application lifecycle and rules
src/lib/records.js     verified records + access grants (Phase 1)
src/lib/payments.js    G2T mobile money, callbacks, reconciliation (Phase 2)
src/lib/sip.js         metrics, alert rules, link analysis, snapshots (SIP)
src/lib/core.js        auth helpers, hash-chained audit log, notifications
src/routes/*.js        REST API (auth, applications, payments/finance, sip, admin, inter-agency x/v1)
public/                single-page web client (no build step)
test/e2e.test.js       end-to-end tests
```
