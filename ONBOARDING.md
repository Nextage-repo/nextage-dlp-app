# Nextage DLP Guard — Developer Handoff / Onboarding

Everything you need to continue working on this project from a new computer.

---

## 1. What this is

An **Outlook add-in (Office.js + TypeScript)** that runs three DLP checks on every
outgoing email *before send*, and blocks / warns accordingly:

1. **Check 1 — Encryption**: external attachments must be encrypted (Excel/Word via
   CFB, PDF via `/Encrypt` trailer, HTML via the org encryptor's lock-screen markers).
2. **Check 2 — Filename**: attachment name should include the customer name (warning).
3. **Check 3 — Subject/Domain**: unknown recipient domain (warning) + subject must
   contain the customer name for known customers (block).

**Enforcement model:** hard **blocks** show "Don't Send" only. **Warnings** show a
"Send Anyway / Don't Send" prompt (via `sendModeOverride: "promptUser"`, feature-detected
for Mailbox 1.14). Internal-only emails (`@nextage.co.il`) are auto-allowed.

**חוקים (Rules):** if the subject contains an active rule expression (case-insensitive
substring, e.g. "חשבונית ספק", "AR Invoice"), Check 1 (encryption) is skipped for that
email; Checks 2 & 3 still run. Managed in `/admin`.

---

## 2. Architecture (IMPORTANT — not SharePoint)

Despite older docs mentioning SharePoint, config is stored in **PostgreSQL**, served by
an **Express server (`server.cjs`)** hosted on an **Azure Web App (App Service, Windows +
iisnode)**. The same Web App serves the built front-end (`dist/`) AND the API.

```
Outlook add-in (manifest → loads pages from Azure)
        │
        ▼
Azure Web App  "Nextage-dlp-app"   (Express: server.cjs, iisnode via web.config)
   ├── serves dist/  (taskpane.html, commands.js, taskpane.js, assets)
   ├── /api/config          (public GET — customers/advisors/exemptions/exclusions/rules)
   ├── /api/audit           (public POST — audit log)
   ├── /api/admin/*         (CRUD, Entra ID SSO + admin group membership)
   └── /admin               (knowledge-center UI, same SSO gate)
        │
        ▼
   PostgreSQL  (tables: customers, advisors, exemptions, exclusions, rules, audit_log)
```

- **`server.cjs`** = the real backend (Express + `pg`). Entry point via **`web.config`**
  (iisnode `path="server.cjs"`). It `initDB()`s tables + seeds `rules` on startup.
- Auth token in the add-in client is `"no-auth"`; `/api/config` and `/api/audit` require
  no user auth — the Outlook add-in depends on that.
- **Because those two are public, they are hardened in other ways** (see §14):
  generous per-IP rate limits, a 64 KB body cap, explicit column lists on
  `/api/config`, and server-side field validation on `/api/audit`. Do not "tidy"
  these away.
- **`/admin` and `/api/admin/*` require Entra ID sign-in** via App Service Easy Auth,
  plus membership in the `DLP-Guard-Admins` security group (`ADMIN_GROUP_ID`). There is
  no password fallback. Easy Auth strips inbound `X-MS-CLIENT-PRINCIPAL*` headers, which
  is what makes the principal trustworthy — the app must never run with App Service
  Authentication disabled.
- App Service Authentication is set to **"Allow unauthenticated access"** on purpose:
  switching it to "Require authentication" would lock the Outlook add-in out of
  `/api/config` and break every DLP check.

---

## 3. Key URLs & secrets

| Thing | Value |
|---|---|
| GitHub repo | https://github.com/Nextage-repo/nextage-dlp-app.git (moved from `nextage-stack`) |
| Azure Web App | `Nextage-dlp-app` |
| Base URL | https://nextage-dlp-app-gchqasbzeqgkccf7.westeurope-01.azurewebsites.net |
| Admin UI | `<base>/admin` (Entra ID SSO — no password) |
| Admin group | `DLP-Guard-Admins` — Object ID `ee0716e0-a233-47a1-8981-93b6d315425d` |
| App registration | `Nextage-DLP-Admin` (client secret expires ~Aug 2028 — renew or `/admin` breaks) |
| Config API | `<base>/api/config` |
| Add-in GUID | `ce4a8dba-79dd-4a0a-89e7-bf6a29f0a527` |
| Manifest version | `7.5.0.0` (SendMode="Block", Mailbox min 1.12) |

**Azure App Settings the server needs:** `AZURE_POSTGRESQL_HOST`, `_DATABASE`, `_USER`,
`_PASSWORD`, `_PORT`, and `ADMIN_GROUP_ID`. These live only in the Azure portal
(App Service → Settings → Environment variables), NOT in git.

**To grant/revoke admin access:** add or remove the user from the `DLP-Guard-Admins`
group in Entra ID. Nothing to deploy. `ADMIN_GROUP_ID` fails closed — if it is missing
or empty, nobody can reach `/admin`.

---

## 4. New-computer setup

```bash
# 1. Clone
git clone https://github.com/Nextage-repo/nextage-dlp-app.git
cd nextage-dlp-app

# 2. Install deps
npm ci

# 3. (Local dev only) trusted localhost certs so Outlook desktop loads https://localhost:3000
npm run setup-certs   # or: npx --yes office-addin-dev-certs install --machine
```

Node lives at `C:\Program Files\nodejs` — if `npm`/`node` aren't on PATH, prefix with the
full path, or add it: `$env:PATH = "C:\Program Files\nodejs;$env:PATH"`.

`gh` CLI is NOT installed; use plain `git` (Windows Credential Manager handles auth). To
push you need write access to `Nextage-repo/nextage-dlp-app`.

---

## 5. Running locally vs. Azure

Two manifests:
- **`manifest.xml`** — production, loads pages from the Azure Web App. This is what's
  deployed via Admin Center (name "Nextage DLP Guard", GUID `ce4a8dba`, v7.5.0.0).
- **`manifest.local.xml`** — dev, loads from `https://localhost:3000`.

**Local dev loop:**
```bash
npm start          # webpack dev server at https://localhost:3000 (leave running)
# sideload manifest.local.xml via https://aka.ms/olksideload
```
Local API still points at the Azure backend (`API_BASE_URL` in `src/shared/constants.ts`).

**You normally DON'T need local dev** — the add-in runs against Azure. Edit → push → it
auto-deploys.

---

## 6. Deploy flow (this is how everything ships)

Push to `main` → GitHub Action `.github/workflows/azure-deploy.yml` →
`azure/webapps-deploy` (uses repo secret `AZURE_WEBAPP_PUBLISH_PROFILE`) → Azure Web App.

```bash
npx webpack --mode production   # sanity-build locally first (optional)
git add -A && git commit -m "..." && git push origin main
```

Then the CI builds `dist/`, prunes dev deps, and deploys the whole repo (incl.
`server.cjs` + `web.config`). Deploy takes ~3–5 min. Verify:

```bash
curl -s <base>/api/config | head -c 300      # real data?
curl -s <base>/commands.js | grep -c <marker># new bundle live?
```

**Code-only changes (validators / commands.js / taskpane.js) need NO manifest re-install
and NO version bump** — they're just new JS served from Azure. Only bump `manifest.xml`
`<Version>` + re-deploy the manifest when the manifest itself changes.

⚠️ **Never let a deploy drop `server.cjs` / `web.config`** — they ARE the backend. (They
were once accidentally deleted from the repo; if `/api/config` returns dummy data or 500s,
that's the cause. `web.config` iisnode handler must point at `server.cjs`, not the old
42-line dummy `server.js`.)

---

## 7. Outlook cache (Classic on Windows)

Classic Outlook aggressively caches `commands.js`/`taskpane.js` in:
```
%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\{GUID}\
```
After a deploy, to force *your* Outlook to pull the new code: **close Outlook fully**
(check the system tray!), delete those `{...}` folders, reopen. An elevated Outlook
instance can't be killed from a normal shell — close it manually.

---

## 8. Critical gotchas (hard-won)

- **Classic Outlook `OnMessageSend` runs in a JS-only runtime** with no browser globals:
  no `window`, `sessionStorage`, `atob`, `WebSocket`.
  - Don't use `atob` — use the self-contained base64 decoder in
    `src/commands/attachment-reader.ts`.
  - Config cache falls back to in-memory (no `sessionStorage`).
  - Webpack must output ES5 with `globalObject: "this"` (already set).
- **CORS preflight fails in that runtime.** API calls from the send path must be CORS
  *simple* requests — **no `Authorization` / `Content-Type: application/json` headers**
  (they trigger a preflight the runtime can't complete → fail-open). Config GET sends no
  custom headers; audit POST uses `text/plain`. See `config.service.ts` / `audit.service.ts`.
- **`sendModeOverride: "promptUser"`** (the Send-Anyway prompt) needs Mailbox 1.14 — it's
  feature-detected in `commands.ts`; older clients just allow warnings.
- **PDF `/Encrypt` is in the trailer at EOF**, not the header — the reader decodes the
  last ~8 KB (`trailerBytes`) too.
- **Config is cached ~60 min per session.** Admin changes (customers, rules…) may lag;
  reopen the compose window to force a refresh.
- **Internal domain (`nextage.co.il`) must never be a customer domain.** Internal
  recipients are excluded from customer matching in `src/validators/shared.ts`.

---

## 9. Project layout

```
src/
  commands/commands.ts          # OnMessageSend handler (block / warn-prompt / allow) + audit
  commands/attachment-reader.ts # reads header+trailer bytes, base64 decode (no atob)
  taskpane/taskpane.ts + .html  # manual DLP panel UI
  validators/
    validators.ts               # DLPValidator.runAllChecks — orchestrates checks 1/2/3
    check1-encryption.ts        # encryption + חוקים exemption
    check2-filename.ts          # per-customer filename coverage (warning)
    check3-subject.ts           # unknown domain (warning) + subject-name (block)
    rules-exemption.ts          # findEncryptionExemption / isEncryptionExempt
    shared.ts                   # findCustomersInRecipients (skips internal), permissions
  services/
    config.service.ts           # GET /api/config (no custom headers), maps rules
    audit.service.ts            # POST /api/audit (text/plain), recordExemption
    auth.service.ts             # returns "no-auth"
  shared/constants.ts           # API_BASE_URL (Azure), INTERNAL_DOMAIN, SAFE_MODE, magic bytes
  models/*.ts                   # DLPConfig, Rule, AttachmentWithHeader, AuditEntry, ...
server.cjs                      # Express + Postgres backend (API + /admin UI + initDB/seed)
web.config                      # iisnode -> server.cjs
manifest.xml / manifest.local.xml
.github/workflows/azure-deploy.yml
scripts/build-test-plan.cjs     # regenerates DLP-Guard-Test-Plan.docx  (needs: npm i -g docx)
scripts/build-board-deck.cjs    # regenerates Nextage-DLP-Guard-Board.pptx (needs: npm i -g pptxgenjs)
tests/                          # jest unit tests
```

---

## 10. Testing & build

```bash
npm test                          # jest (all)
npx jest check1                   # single suite
npx webpack --mode production     # build dist/
node --check server.cjs           # server syntax check
```

Known pre-existing failing test: `check1` "BLOCKs with 'unverifiable' … file.zip" — the
code treats all `.zip` as encrypted (spec), so the test is stale. Unrelated to features;
fix the test (use a non-archive extension) or the spec when convenient.

---

## 11. Deliverables (regenerable)

- **`DLP-Guard-Test-Plan.docx`** — Hebrew RTL QA test plan. Rebuild:
  `NODE_PATH=$(npm root -g) node scripts/build-test-plan.cjs` (needs `npm i -g docx`).
- **`Nextage-DLP-Guard-Board.pptx`** — 4-slide Hebrew board deck. Rebuild:
  `NODE_PATH=$(npm root -g) node scripts/build-board-deck.cjs` (needs `npm i -g pptxgenjs`).
  (No PDF renderer in this env — open in Office to visually check.)

---

## 12. Managing config (no code needed)

Go to `<base>/admin` (password above). Tabs: לקוחות (customers), יועצים (advisors),
פטורים (exemptions), סיומות (exclusions), **חוקים (rules)**, לוג ביקורת (audit log).
Add/edit/delete take effect on the next config-cache refresh (≤60 min / reopen compose).
No redeploy needed.

---

## 13. Feature history (high level)

- Fixed Classic-Outlook send enforcement (CORS-simple requests; no-atob base64 decode).
- Internal emails auto-allowed; internal domain never matched as a customer.
- Check 2 warns per uncovered customer (multi-customer emails).
- Unknown domain downgraded from block → warning.
- Warnings show "Send Anyway / Don't Send" prompt (sendModeOverride, 1.14 feature-detected).
- Encryption detection extended to PDF (trailer /Encrypt) and HTML (org encryptor markers).
- **חוקים** subject-based encryption exemption (table + seed + admin CRUD + Check 1 + audit).
- Manifest: renamed (removed "(LOCAL)"), pointed to Azure, v7.5.0.0.
- Security hardening pass (Aug 2026) — see §14.
```

---

## 14. Security hardening (Aug 2026) — don't undo these

A security review produced the changes below. Each one exists for a reason that is
not obvious from the code, so the reasoning is here as well as in `server.cjs`.

| Change | Why |
|---|---|
| `POST /api/seed` **deleted** | It was unauthenticated and `TRUNCATE`d customers/advisors/exemptions/exclusions. One request could wipe the config and silently disable DLP org-wide. Never reintroduce an unauthenticated write route. |
| Daily audit purge (`AUDIT_RETENTION_DAYS`, default 90) | The `ttl` field the client sends was never read — a leftover from the original Cosmos design. Rows with senders, recipients and subjects were kept forever. |
| `ssl: { rejectUnauthorized: true }` | Was `false`: encrypted but accepted any certificate. No CA is pinned — Azure chains to roots already in Node's bundled store. |
| Explicit column lists on `/api/config` | Stops publishing operator free-text (`exemptions.reason`, `excluded_recipients.reason`/`requested_by`, `encryption_keywords.note`) that no validator reads, and makes a future column fail closed. **Keep in sync with the mapper in `src/services/config.service.ts` — that mapper is the authoritative list of what the client consumes.** |
| `/api/audit` field validation | Bodies were stringified straight into JSONB. Now: 64 KB cap, known keys only, per-field length caps, `action` pinned to a known set. |
| Split CORS | Admin routes reflect only this app's origin so a malicious page can't read admin JSON from a signed-in admin's browser. The two public routes stay `*` — they're credential-free and the send runtime can't do preflight. |
| `app.set("trust proxy", true)` | App Service terminates TLS and forwards over HTTP, so `req.protocol` was `http` and the admin CORS origin was built as `http://…` — an origin no browser sends. |
| Rate-limit key = **last** `X-Forwarded-For` entry | App Service *appends* the real peer address, so the leftmost value is client-controlled; keying on it let a caller rotate the header and evade the limit. Verified: rotating XFF behaves identically to the control run. |
| Limits are deliberately **high** (config 600/min, audit 1200/min) and `/api/config` **degrades to a cached copy instead of 429** | Everyone is behind one corporate NAT, so ~200 users share one IP, and the 60-minute client cache expires in waves. A rejected `/api/config` makes the add-in **fail open** — throttling our own users would silently disable DLP during the busiest sending hour. Measured: the old 60/min ceiling rejected 20 of 80 requests from one IP. |
| Security headers set by hand, no `helmet`/`express-rate-limit` | Runtime deps stay `express` + `pg`. A missing/pruned module crashes `server.cjs`, and a dead backend makes every add-in fail open. Not worth it for six headers. |

**Verifying after a deploy** — the DB-certificate change is the one that could break
things, and its failure mode is quiet (500 → every add-in fails open):

```bash
curl -s <base>/api/config | head -c 200        # real data => TLS + DB fine
curl -sD - -o /dev/null <base>/api/config | grep -i x-config-cache   # memo alive
```

### Output-escaping rules for the admin page (added in the second pass)

The admin page builds HTML by string concatenation, so escaping is manual and easy
to lose. Three helpers, three contexts — use the right one:

| Context | Helper | Example |
|---|---|---|
| Text inside an element | `esc(v)` | `<td>\${esc(r.name)}</td>` |
| A quoted HTML attribute | `esc(v)` | `<input value="\${esc(row?.name\|\|"")}"/>` |
| A row object inside a single-quoted handler | `attrJson(o)` | `onclick='editRow("customers",\${attrJson(r)})'` |
| A row id in a handler | `Number(v)` | `onclick='deleteRow("customers",\${Number(r.id)})'` |

`JSON.stringify` is **not** sufficient for the third case — it leaves apostrophes
intact, which closes a single-quoted attribute. `checkLabel()` falls through to
`String(n)`, so its output needs escaping too.

Config rows are admin-written but arrive via spreadsheet import, so treat them as
untrusted. `/api/admin/audit.csv` prefixes any field starting with `=`/`+`/`-`/`@`
or a tab/CR with an apostrophe, because Excel evaluates formulas even inside quoted
CSV fields and audit content is writable by *unauthenticated* callers.

**Testing the admin page:** `node --check` is not enough — it passes on a template
literal whose interpolation throws at render time (a lost `\$` escape does exactly
this). Render it for real:

```bash
PRINC=$(node -e 'console.log(Buffer.from(JSON.stringify({claims:[{typ:"preferred_username",val:"t@nextage.co.il"},{typ:"groups",val:"tg"}]})).toString("base64"))')
PORT=3995 ADMIN_GROUP_ID=tg node server.cjs &
curl -s -H "X-MS-CLIENT-PRINCIPAL: $PRINC" http://127.0.0.1:3995/admin | wc -c   # expect ~40 KB, not a redirect
```

Note `/admin` **redirects to sign-in when unauthenticated**, so any check that greps
the page for a marker without a principal header will always "fail" — that is a
broken test, not a broken deploy.

### Known open items (not fixed)

- **`DLP_UNAVAILABLE` is logged but nothing alerts on it** — nobody finds out when
  enforcement started failing open. Needs an Azure alert rule, not code.
- **12 excluded recipients are DOMAIN-scoped with 2030 expiry**, so all three checks
  are skipped for any address at those domains and no audit row is written. Policy
  decision, tracked in `DLP-Guard-Security-Spec.docx`.
