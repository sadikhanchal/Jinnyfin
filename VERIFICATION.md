# Verification — app vs. the source workbook

The app's engine was run in a real browser against the imported ledger and every
figure compared with the original spreadsheet. **All of them match.**

Run the check on your own data any time: **Settings → Backup & import →
Numbers check** — it prints your figures beside the workbook's and flags any
difference.

> The full run, with the actual amounts, is kept out of this public repository.
> It ships in `_private/VERIFICATION-private.md` in the download.

## What was compared

| Figure | Result |
|---|---|
| Total income, all time (≈ INR, historical rates) | ✓ match |
| Total expenses, all time | ✓ match |
| Net savings | ✓ match |
| Cash & bank total | ✓ match |
| Fixed assets | ✓ match |
| Net lend / borrow position | ✓ match |
| Investments including equity | ✓ match |
| Net worth | ✓ match |
| All twelve account balances, to the paisa | ✓ 12 / 12 |
| Equity: market value, realised P&L, dividends, charges | ✓ match |

Imported: 25,074 transactions · 42 accounts · 242 category rows · 21 payees ·
120 months of exchange rates · 6 assets · 5 policies · 26 equity positions ·
94 equity trades · 6 businesses.

## The one number that reads differently, and why

The workbook's dashboard leaves the broker equity holding out of its investments
total, while its own Settings sheet includes it — the spreadsheet disagrees with
itself on that one line. Shares you own are worth something, so this app counts
them. Every other component matches the dashboard exactly, so the difference is
only ever that single holding.

## Formulas carried across

| Workbook | App |
|---|---|
| `SUMIFS(TxIncINR, TxType,"Income", …)` | `periodTotals()` |
| cash block with the live-rate conversion | `summarise().cash` |
| `(D+BL−BM)*−1` and `D+BL+BM` for savings products | investment categories: deposits + returns − withdrawals |
| tagged asset spend + pre-ledger constants | assets: tagged spend + `opening_cost` |
| `LET`/`MAP` over unsettled payees | `lendBorrowPositions()` — settled payees excluded so FX drift cannot leak in |
| the 120-month `FXMonth`/`FXRate` table | `fxFor(date)` — per-transaction historical rate |
| renewal alert block | `insuranceAlerts()` / `insuranceHeadline()` |

## Also checked in the browser

Add / edit / delete a transaction · arithmetic in the amount field · two-leg
transfers with balances restored after deletion · card vault encrypt → decrypt
round trip, wrong PIN rejected, no plaintext in the ciphertext · search and all
filters · CSV export · dark mode · mobile layout with no sideways scroll ·
service worker registered and manifest installable · behaviour when the server
cannot be reached · **zero console errors on all 14 screens**.
