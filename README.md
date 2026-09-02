# Jinnyfin

A personal-finance PWA rebuilt from `MISA Entry 06.xlsm` — installable on
phone and PC, works offline, syncs both devices through Supabase.

**Setup: [SETUP.md](SETUP.md) · Method: [VERIFICATION.md](VERIFICATION.md)**

---

## What it does

| Screen | Replaces | Notes |
|---|---|---|
| Dashboard | `Dashboard` | Income / expense / net savings / net worth, year + month filter, insurance headline, income & expense by source, in-vs-out chart, net-worth trend |
| Transactions | `Transactions` | 25,074 rows, search everything, 9 filters, add/edit/delete, CSV export |
| Account Statement | `Statement` | Opening balance → running balance → closing, per account, any period |
| Expense Report | `Expense Report` | Monthly + yearly totals, sub-category drill-down, transaction detail |
| Income Report | `Income Report` | Same shape, income side |
| Income vs Expense | `Income vs Expense` | Any period, group by category / sub / account, sorted |
| Lend / Borrow | `Payee Report` | Who owes whom, per-payee ledger with running balance |
| Business P&L | `Business P&L` | Per side-business, year by year; add more businesses in the app |
| Equity Portfolio | `Equity Portfolio` | Open + closed positions, realised P&L, dividends, charges, 94-trade ledger |
| Net Worth & Assets | `Settings` net-worth block | Full build-up, month-end trend, assets at cost **or market value** |
| Insurance & Documents | `Settings` insurance block | Also Iqama / passport / licence — anything with an expiry date |
| Settings | `Settings` | Accounts, categories, FX-rate history, reconciliation, backup, import |

Beyond the workbook: **Budgets**, **Card Vault** (encrypted), browser
**renewal notifications**, an app **PIN lock**, dark mode, CSV export from every
report, JSON backup/restore, and offline entry that syncs when the signal is back.

---

## How it is built

No build step, no npm, no framework. Plain ES modules — the files you upload
to GitHub are the files that run. That means you can open any file, read it,
and change it without a toolchain.

```
index.html            shell
config.js             ← the only file you edit (Supabase URL + key)
manifest.webmanifest  makes it installable
sw.js                 service worker: offline + notifications
css/app.css           one stylesheet, light + dark
js/
  store.js            IndexedDB + two-way delta sync with Supabase
  calc.js             every formula, translated 1:1 from the workbook
  charts.js           dependency-free SVG charts
  crypto.js           AES-256-GCM card vault + PIN hashing
  util.js             dates, money formatting, DOM helpers
  app.js              router, auth gate, screen lock
  views/*.js          one file per screen
data/seed-data.json   the workbook export (6.6 MB, imported once)
supabase/schema.sql   run once in the Supabase SQL editor
scripts/              daily expiry-check job for GitHub Actions
```

### Sync model

Every row carries `id`, `updated_at` and `deleted`. Writes go
memory → IndexedDB → a local queue → Supabase. Pulls ask for everything
changed since the last sync. Last write wins; deletes are soft so the other
device learns about them. Nothing is lost when you are offline — the queue
drains as soon as you are back.

### Currency

Balances convert at today's rate (Settings → General). Historical totals
convert at **the rate of the month the transaction happened in**, read from
the 120-month rate table lifted out of the workbook — that is what makes the
all-time figures match your sheet to the paisa.

### Security

- Row Level Security on every table: rows are readable only by the account
  that owns them. The anon key alone gets you nothing.
- Card data is encrypted in the browser (PBKDF2 250k → AES-256-GCM) with a PIN
  that is never transmitted or stored. Only the label, bank, network and last
  four digits stay readable.
- Optional app PIN so a borrowed phone cannot browse the ledger.

---

## Updating it later

Edit the file, upload it to GitHub (**Add file → Upload files**, same name,
Commit). Bump `jinnyfin-v1` in `sw.js` so installed copies pick the change up.

## Things worth knowing

- Transfers are two rows sharing a `transfer_group`, exactly like the sheet.
  Historical single-leg transfers were imported as they were, so nothing shifts.
- Four long-closed accounts are marked inactive, matching the workbook, so their
  small residual balances stay out of the cash total. Settings → Accounts lists
  them if you ever want to clear them properly.
- Investment holdings tracked by category rather than by account compute as
  deposits + returns − withdrawals.
