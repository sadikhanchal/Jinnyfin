# CLAUDE.md — read every line before you touch this repo

@AGENTS.md

This file is the memory between sessions. The owner has been burned, more than
once, by a session that forgot what an earlier one knew, or fixed only the
literal words of a request and left the rest broken. Everything below is here
because it already went wrong at least once.

**This repository is PUBLIC.** Nothing personal goes in this file, in a commit
message, in a PR, or in an issue: no amounts, no balances, no payee or family
names, no account figures. Private context lives in a separate notes file the
owner keeps himself and attaches in chat when it is needed.

Keep this file current. When an item in section 9 is finished, or a new lesson
is learned, update this file **in the same PR**.

---

## 1. Who you are working for, and how to talk to him

- One person's real finances: nine years, two currencies (SAR and INR), live on
  his phone and PC at `sadikhanchal.github.io/Jinnyfin`. A wrong number here is
  a wrong number in his life.
- **Reply in Malayalam, written in Malayalam script.** English technical words
  (Tab, commit, Category, Account…) stay in English. **Never Manglish** (Malayalam
  in Latin letters), even though he types that way himself.
- Casual, like a friend. Humour and teasing/roasting him are welcome and
  expected. The facts must still be exact.
- He is not a beginner. No tutorials on basics. Say the point.
- If a request of his would hurt the project or is not the smart move right
  now, **push back clearly** instead of just doing it.
- When you get something wrong, say so in one sentence and fix it. No
  grovelling, and never offer "it was a mistake" as an excuse for a repeat.

## 2. The rules that decide whether he trusts you

1. **Plan first.** Before changing code, tell him the plan (what changes, on
   which screens, what it does to data already saved) and get his OK. Make the
   plan complete in ONE message, so one "OK" covers it. He hates back-and-forth.
2. **Do everything related to the request, the first time.** He should never
   have to come back and say "this other part is still broken". Before calling
   anything done, go through section 3 and write down in your reply what you
   checked beyond the literal ask.
3. **Find the defects yourself.** He is tired of testing every build by hand.
   Run the full suite. For UI changes, take screenshots at phone width (390px)
   and desktop (1280px) and look at them.
4. **Prove every test.** A new test must FAIL on the code before your fix (check
   out the base commit or stash, run just the new test, see it fail), then pass
   after. If a test passes on both, say what it guards instead.
5. **Never repeat a bug class that has been fixed once.** When you fix a
   pattern (see section 7), grep for the same pattern everywhere and fix all of it.
6. The non-negotiables in AGENTS.md: no force push, no secrets in `config.js`
   (only the publishable anon key), never commit `data/seed-data.json`, ask
   before any schema migration and never run a destructive one.
7. Never give another AI (e.g. "Strawberry") account-level Supabase OAuth.
8. **Closed topics — do not bring them up again:** the wife/household second
   login (fully designed, then cancelled by him), the "Mi life 2020"
   reconstruction (dropped).
9. **Demo mode** (`CONFIG.DEMO`): no Card Vault, no personal categories or
   notes, nothing that names his own setup (the workbook, the numbers-check
   card, his transaction count, his holdings). Friends' data must never reach
   his database.
10. His own logo is used as given. Resize or crop only, never redraw it.

## 3. Definition of done — the "everything related" checklist

Go through every line for every change:

- [ ] **Same kind of control elsewhere?** Grep for it. A fix to one search box,
      date box or filter applies to every screen that has one.
- [ ] **Every input path:** mouse click, touch, and keyboard: Tab, Shift+Tab,
      **Tab pressed repeatedly**, Enter, Escape, ↑↓, clicking away mid-typing.
- [ ] **Phone width (390px) and desktop.** Screenshots, looked at.
- [ ] **Data already saved.** A rename must move the existing rows too
      (categories and payees are matched by text, not by id). A new rule must
      not silently change old entries.
- [ ] **After a sync, after navigating away and back, after Clear, after a deep
      link.** Does the screen still show what the filters really are?
- [ ] **Does it steal focus or leave a list or dialog open somewhere else?**
- [ ] **Money:** which figures you checked and against what. "Should be fine"
      is not a check.
- [ ] **Three version stamps bumped** (AGENTS.md).
- [ ] **Syntax:** every changed JS file copied to `.mjs` and `node --check`ed.
- [ ] **`cd test && npm test` fully green**, with new tests proven to fail on
      the old code.
- [ ] **The test suite ships with the change.** If `test/run.mjs` changed, it is
      in the commit (1.59 went out without it and CI went red).

Real misses, so you know what "related" means here:

- 1.52: the Settings → Categories search box rebuilt itself on every keystroke.
  Focus fell to the page, and the next letter fired the global "n" shortcut,
  opening New Transaction. The same bug had already been fixed in report.js.
- 1.58: renaming a category did not move the entries already filed under it.
- 1.59: search boxes were added to the Expense Report, but Tab was never
  checked. Tab kept the cursor in place, and every further Tab reset the box to
  "All".
- 1.59: to make Tab pick the lit entry, Tab was made to ALWAYS pick. Merely
  tabbing across the New Transaction Account box then switched the account to
  the first one in the list. That shipped.
- 1.59: the delivery left out `test/run.mjs`.

## 4. Working with GitHub

Only when this session actually has write access to `sadikhanchal/Jinnyfin`:

1. `git pull` on `main`, then branch: `v<version>-<short-name>`.
2. Make the change, bump the three stamps, run the syntax check and the suite
   (with the prove-it-fails step).
3. Open a PR titled `<version> — <what>`. The body says: what changed and why,
   which screens, files touched, tests added (and that they failed on the old
   code), anything you could not verify. Nothing personal in it.
4. Wait for CI (if `.github/workflows/` exists) to go green. Then merge it
   yourself: a normal merge or squash. **Never force-push**, never rewrite history.
5. GitHub Pages redeploys from `main` within a couple of minutes. Confirm the
   live `js/app.js` reports the new `BUILD.version`.
6. Tell him in Malayalam: the version, what changed, what to look at, and that a
   refresh brings it in. If anything touched saved data, what he should check.

If the session has NO write access, deliver a zip of **every** changed file
(including `test/run.mjs` and `test/stub/*` if changed), keeping folder paths.
He uploads it through GitHub's web UI ("Add files via upload").

## 5. Versioning

- The three stamps move together: `js/app.js` BUILD, `css/app.css` `--jf-css`,
  `sw.js` CACHE (AGENTS.md).
- His stated scheme: from 1.14 on, 1.15 … 1.50, then **2.1 … 2.50**, then 3.1.
  1.51–1.60 were shipped outside that scheme. **Live is 1.60.** Ask him whether
  the next one is 2.1 or 1.61, then write the answer here.
- `BUILD.date` is the release date.

## 6. Map of the code

No build step, no framework, plain ES modules (see AGENTS.md).

| file | what lives there |
|---|---|
| `index.html`, `manifest.webmanifest`, `sw.js` | shell, PWA manifest, service worker (network-first with `no-cache`, CACHE version) |
| `config.js` | Supabase URL + publishable anon key, `CONFIG.DEMO` |
| `js/app.js` | router (`ROUTES`, `go()`), auth gate, sign-in screen, `recoveryScreen()` for reset links, global shortcuts (`n` = new transaction, `/` = Transactions), `BUILD`, test hook `window.JINNYFIN = { S, DB, go, openTxEditor }` |
| `js/store.js` | IndexedDB, write queue, delta sync, `onlyColumns`, `healForPush`, auth incl. `finishPasswordRecovery` |
| `js/calc.js` | every calculation: `filterTx`, `parentsFor`, `subsFor`, `parentsOfSub`, `payeeNames`, `accountNames`, `activeAccounts`, FX, reports, `insuranceAlerts` |
| `js/util.js` | `el`, `modal`, `confirmBox`, `trapFocus`, back-history stack, `searchSelect`, `dateGuard`/`restoreDateFocus`, `onFilter`/`restoreFilterFocus`, CSV |
| `js/charts.js` | SVG charts, `barList` |
| `js/alerts.js`, `js/push.js` | in-app reminders, web push |
| `js/files.js`, `js/crypto.js`, `js/icons.js` | attachments, Card Vault crypto, SVG icons |
| `js/views/editor.js` | the New/Edit Transaction sheet (every screen uses it) |
| `js/views/report.js` | Expense Report and Income Report (one engine) |
| `js/views/*.js` | one file per screen: dashboard, transactions, statement, payee (Lend/Borrow), business, equity, networth, insurance, cards, budgets, tasks, settings, incexp, importer, printable |
| `supabase/` | schema, migrations, push Edge Function |
| `test/run.mjs` | Playwright suite, 57 checks at 1.60. `node run.mjs "part of a test name"` runs a subset |
| `test/stub/supabase.mjs` | fake Supabase: rows, upsert (with `rejectUpsert` hook), auth incl. one-shot `PASSWORD_RECOVERY`, `updateUser` |
| `test/stub/fixture.json` | fictional data (5 accounts, 70 categories, 424 transactions; no insurance rows, so seed any you need with `S.put`) |

Browser for tests: Playwright finds Chromium in `/opt/pw-browsers` or
`~/.cache/ms-playwright`. Override with `JF_CHROME`. CI runs
`npx playwright install --with-deps chromium`.

## 7. Hard-won patterns — do not relearn these

**Filter bars are built once. Only the part below is redrawn.**
`transactions.js`, `report.js` and `incexp.js` do it this way: `mount()` builds
the bar, `draw()` rebuilds the body, and `syncControls()` makes every control
show the real filter state after a breakdown tap, a crumb, Clear, a deep link or
a sync. Rebuilding a bar while the cursor is in it breaks Tab, date typing and
search boxes. Screens that still rebuild everything: statement, dashboard,
budgets, business, networth, payee, settings. They depend on `onFilter`/
`restoreFilterFocus` and `dateGuard`/`restoreDateFocus`, which hand the cursor
back only when the redraw really replaced the element (and within 1.5s). Date
boxes hand it to the field focus was moving to. When you touch one of those
screens, move it to mount-once.

**`searchSelect` (util.js) is THE picker for any long closed list:**
categories, sub-categories, accounts, payees. These keys behave the same
everywhere, and each has a test:
- Tab / Shift+Tab / clicking away: if he typed or arrowed, the lit entry is
  picked. If he only passed through, nothing changes.
- Enter picks and stays in the box. Escape with the list open closes only the
  list (stops propagation, so the sheet or drill-down behind stays). A second
  Escape does whatever it did before.
- On opening, the current value is lit. `change` fires only on a real change.
  Setting `.value` to the same value never overwrites typing.
- Matching is on the start of any word ("Rajhi" finds "Al Rajhi").
- `searchSelect(list, { placeholder })`, list items `{ value, label, search }`.
- In use: Expense/Income Report (Category, Sub-category, Account), Transactions
  (Account, Category, Payee), Income vs Expense (Account), Budget sheet
  (Category), Insurance sheet (Pay from), New Transaction (Account, To).
- Year / Month / Type stay native selects. New Transaction's Category /
  Sub-category / Payee / Event are datalist inputs settled on blur
  (`settleList`). He likes them, so leave them alone.
- The report's Sub-category box searches EVERY sub when Category is "All",
  shows "Sub · Category", and fills in the category (same as New Transaction).

**Live-filter text boxes:** debounce, and never rebuild the box itself.

**Focus loss turns typing into shortcuts.** With focus on `<body>`, "n" opens
New Transaction and "/" jumps to Transactions.

**Escape is layered:** innermost first. Combo list, then confirm box, then
sheet, then report drill-down.

**Categories and payees are matched by TEXT.** A transaction's `t.parent` /
`t.sub` / `t.payee` hold the name itself, not an id. Every rename must cascade
with `putMany('transactions', …)`. See `renamePayee` (payee.js) and
`renameCategory` / `editCat` (settings.js).

**Supabase auth:** register `onAuthStateChange` BEFORE `getSession()`.
`PASSWORD_RECOVERY` fires once, and a late listener misses it, which leaves him
stuck in a recovery-only session. A refreshed token is not a new sign-in (AGENTS.md).

**Sync push:**
- A NOT NULL DEFAULT column added after old rows existed can be `null` locally.
  Sending that `null` fails the row, so `healForPush` drops the known-risky nulls
  (`RISKY_IF_NULL`, currently `accounts.pinned`).
- One refused row must not block the rest: the push falls back to per-row, keeps
  going, names the stuck rows, and rethrows only network errors.
- To clear an ordinary column, send `null` explicitly (AGENTS.md).

**Money model:**
- An entry's currency is its account's, never a free choice.
- A transfer is two rows sharing `transfer_group`. A cross-currency transfer has
  a separate "landed" amount at that date's rate.
- Lend/Borrow sub-categories are a closed set: Lend → `Lend`, `Collecting debts`;
  Borrow → `Borrow`, `Repayment`. Inflows: `Borrow`, `Collecting debts`,
  `Interest/Return`, `Withdrawal`, `Sell`, `Funding In`.
- Naming a Lend/Borrow payee writes the description ("X took out a loan"…) and
  never overwrites his own words.
- Payee balance: positive = he owes them, negative = they owe him. **Each
  currency runs separately and is never added together.**
- His cross-border convention: money that moves between countries is often
  booked as a SAR loan plus a SAR→INR transfer through a conversion account.
  A payee's single-currency column can then look off while
  the real money is right. **Never "fix" a real account entry to make a payee
  balance.** Find the missing or mis-tagged entry instead, and ask him.
- Idle account: no activity for 60 days. A new account gets 60 days' grace.
- Business P&L goes by category, not account (AGENTS.md).

**Platform traps:**
- iPhone's JS engine dies on `Math.max(...hugeArray)`. Walk the array instead.
- Dates are stored ISO and shown **dd-mm-yyyy** everywhere (he dislikes
  month-name formats). `todayISO()` is local time (Jeddah, UTC+3). `badYear`
  keeps years inside 1900–2100.
- `node --check file.js` misses ES-module errors. Check a `.mjs` copy.

## 8. Message to him when you hand work back (in Malayalam)

Version → what changed, screen by screen → what you checked beyond the ask →
tests (count, what was proven to fail before) → what he should look at → any
data he should check. Short, plain, a bit of fun.

## 9. Open work — keep this list current

1. **Insurance "↻ Renewed +1 yr" crashes.** `js/views/insurance.js` calls
   `renew(v, m, { premium, currency, account, record, label })`, but `renew` is
   defined nowhere, so it is a ReferenceError on click. He agreed to fix it in
   the next session. Plan to show him before coding:
   - renewal_date +1 year (29 Feb → 28 Feb); `last_paid` = today;
     `pay_account` = the Pay-from choice; save the policy.
   - If "Record the premium as a transaction when I renew" is ticked and the
     premium > 0: write ONE Expense row from the Pay-from account, in that
     account's currency, dated today, note `<label> renewal`. **Ask him which
     category/sub** (probably parent "Insurance").
   - Confirm before writing (shows the new date and the amount). Guard against a
     double press adding two years and two expenses.
   - Related: the Save button never stores `pay_account` (Pay-from only feeds
     Renew). Ask whether the policy should remember it. Reminders (`alerts.js`
     keys include `renewal_date`), the dashboard line and the push text read the
     new date on their own. Verify. Handle an idle Pay-from account (the list
     already keeps it).
   - Tests: seed a policy with `S.put('insurance', …)`. Check the date moves,
     exactly one row when ticked, none when unticked, and no double-renew.
2. **A payee's INR balance off by a fixed amount.** Details are in his private
   notes file, not here. Waiting on him: he has to compare his old MISA app's
   running balance at the checkpoint dates listed there. Do not adjust real
   account entries.
3. After the 1.59 upload he was asked to check PC entries for a wrong Account
   (the Tab-through bug, fixed in 1.60). Ask whether anything needed correcting.
4. Confirm 1.60 is live and CI is green.
5. Demo-mode leftovers to review one by one: Card Vault appearing on the
   Insurance page in demo; a GitHub Action hint; a PUSH-SETUP.md reference;
   "since 2017" text; "compare this with the version I sent you" text; demo seed
   cosmetics.
6. Demo repo step 6: a separate `Jinnyfin-demo` repo/site with its own config.
   Not started.
7. Statement: show the other account on transfer rows. Waiting for his "Link
   half transfers" count.
8. Income vs Expense: the "Group by" buttons overflow at 390px.
9. Version numbering decision (section 5).
10. The screens that still rebuild fully (section 7). Move each to mount-once
    when you next touch it.
