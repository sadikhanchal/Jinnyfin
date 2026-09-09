# Working on Jinnyfin

Read this before changing anything. It is short on purpose — every line is here
because ignoring it has already cost someone a day.

Jinnyfin is one person's real personal-finance record, live at
`sadikhanchal.github.io/Jinnyfin`, holding nine years of transactions in two
currencies. It is not a demo. A wrong number here is a wrong number in
somebody's life, and a broken commit on `main` breaks the app on their phone
within minutes.

---

## Non-negotiables

1. **Never work directly on `main`.** GitHub Pages serves the live app from it.
   Branch, then merge once the checks pass.

2. **`cd test && npm test` must be green before any merge.** Nine checks, each
   written for a bug that actually shipped. If a change breaks one, the change
   is wrong until proven otherwise — do not edit the check to make it pass.
   Adding a feature means adding a check for it.

3. **Never `git push --force`.** Nothing in this repo is worth rewriting
   history for. Without force, every past commit stays recoverable.

4. **Never put a secret in `config.js`.** The key in there now is a Supabase
   *publishable* key and is meant to be public — Row Level Security is what
   protects the data. A key starting `sb_secret_` or `service_role` bypasses
   RLS entirely and would expose every row to the internet.

5. **Never commit real financial data.** `data/seed-data.json` is the owner's
   full transaction history. It is deliberately absent from this repository and
   must stay that way. It is in `.gitignore`; do not remove that line, and do
   not "fix" the Load-workbook-data 404 by committing the file.

6. **Ask before schema migrations, and never run a destructive one.** The
   database holds the only copy of some of this. `Settings → Data → Download
   backup` first, every time.

---

## The version-stamp trap

Three files carry the version, and **all three must move together**:

| file | what to change |
|---|---|
| `js/app.js` | `export const BUILD = { version: '…' }` |
| `css/app.css` | `--jf-css: "…"` |
| `sw.js` | `const CACHE = 'jinnyfin-…'` |

Miss one and the service worker keeps serving the old file. The symptom is
maddening and misleading: you upload a fix, hard-refresh, and the app still
reports the previous version. Hours have been lost to this. Bump all three in
the same commit, always.

---

## How the app is built

No build step, no framework, no bundler. Plain ES modules loaded straight from
`index.html`. Do not introduce a bundler, TypeScript, or a framework — the
whole point is that the owner can open a file and read it.

- `js/store.js` — IndexedDB, the sync queue, delta sync to Supabase
- `js/calc.js` — every financial calculation
- `js/app.js` — shell, router, auth gate
- `js/views/*` — one file per screen
- `js/util.js` — DOM helpers, modals, the back-history stack
- `supabase/` — schema, migrations, the push Edge Function

**Local-first.** Everything renders from IndexedDB; the network is an
afterthought. Sync is a delta pull plus a queue of local writes. Two rules that
are easy to break:

- A pull re-reads the last second before the watermark on purpose, so most rows
  coming back are ones we already hold. Only rows whose server `updated_at`
  actually differs count as a change. Announcing a no-op sync as a change
  rebuilds the screen under the user's hands.
- An upsert only overwrites the columns it is handed. Clearing a field means
  writing `null` explicitly — omitting it leaves the old value alive on the
  server, and it comes back on the next pull.

**Transfers are two rows** sharing a `transfer_group`; the outgoing leg carries
`to_account`. Both legs must be written or neither. Turning a transfer into
another type must delete the partner leg and null out the links, or the same
money is counted twice.

**Never rebuild the screen while someone is typing in it.** A background sync
that redraws mid-form throws the cursor out of the box. `app.js` defers the
redraw until focus leaves the form; keep it that way.

**A refreshed auth token is not a new sign-in.** supabase-js raises `SIGNED_IN`
for the same account every time the tab becomes visible. Only a change of user
id may rebuild the shell.

---

## Money rules

- Two currencies, SAR and INR, with a per-month FX rate on each row (`fx`). USD
  converts through SAR. Never re-derive a stored rate.
- Business P&L matches on **category**, never on account. A business points at
  an income category and an expense category; failed ventures live under the
  parent `Business Loss` with a sub per venture.
- History that predates the app is reconstructed on the idle account
  `Old Transactions`, never on a live bank or cash account — a real account
  posted with old spending goes impossibly negative.
- Deletes are soft (`deleted: true`). Restore-from-backup is a **merge** by id:
  it repairs edited and deleted rows, but it does not remove rows added since
  the backup.

The original Excel workbook is **not** authoritative. Its Business P&L section
was never finished. Do not port its logic or reproduce its mistakes.

---

## What is deliberately not here

- `data/seed-data.json` — real financial data, see rule 5
- Anything that would make the Card Vault hold a real card number, CVV or PIN.
  That feature stays unused pending a security review; do not encourage filling
  it in.

---

## Before you hand work back

State plainly: which files changed, what the version went to, whether
`npm test` is green, and anything you could not verify. If a change touches
money — balances, conversions, report totals — say which figures you checked
and against what. "It should be fine" is not a check.
