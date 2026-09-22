// ============================================================================
//  run.mjs — drives the real app in a real browser and checks it behaves.
//
//    cd test && npm install        (once)
//    npm test                      (every time)
//
//  Each case opens the app fresh, feeds it the fixture through a fake Supabase,
//  does something a person would do, and asserts what should have happened.
//  A case exists because that exact thing broke once. Nothing is mocked inside
//  the app itself — this is the shipped code, running.
// ============================================================================
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile, readFileSync } from 'fs';
import { existsSync, readdirSync } from 'fs';
import { extname, join, resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 9212;
const STUB = readFileSync(join(ROOT, 'test/stub/supabase.mjs'), 'utf8');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test/stub/fixture.json'), 'utf8'));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

// --------------------------------------------------------------- plumbing --
function serve() {
  return new Promise(ok => {
    const s = createServer((req, res) => {
      const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      const f = p.endsWith('/') ? join(p, 'index.html') : p;
      readFile(f, (e, buf) => {
        if (e) { res.writeHead(404); return res.end('no'); }
        res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream',
          'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    s.listen(PORT, '127.0.0.1', () => ok(s));
  });
}

/** Playwright ships without a browser here; find the one already installed. */
function chromePath() {
  if (process.env.JF_CHROME) return process.env.JF_CHROME;
  for (const base of ['/opt/pw-browsers', join(process.env.HOME || '', '.cache/ms-playwright')]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      for (const rel of ['chrome-linux/chrome', 'chrome-win/chrome.exe',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(base, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;               // let Playwright use its own
}

/** A fresh app, signed in, holding the fixture, parked on `route`. */
async function open(browser, route = 'dashboard') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e.message || e)));

  // Anything that is not our own server is the CDN asking for supabase-js.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
  await page.addInitScript(rows => { globalThis.__sb = { rows, pushed: [], cb: null,
    user: { id: 'test-user', email: 'test@jinnyfin.local' },
    fire(e, s) { globalThis.__sb.cb?.(e, s === undefined ? { user: globalThis.__sb.user } : s); } };
  }, FIXTURE);

  await page.goto(`http://127.0.0.1:${PORT}/index.html#/${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__jinnyfinReady === true, null, { timeout: 30000 });
  await page.waitForFunction(() => window.JINNYFIN?.DB?.transactions?.length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

/**
 * Click a button by its exact label inside the dialog on TOP — a confirm box
 * opens over the editor, and both are `.modal`. Returns the label it clicked.
 */
const topClick = (page, labels) => page.evaluate(ls => {
  const all = [...document.querySelectorAll('.modal')];
  const top = all[all.length - 1];
  if (!top) return null;
  const b = [...top.querySelectorAll('button')].find(x => ls.includes(x.textContent.trim()));
  if (!b) return null;
  b.click();
  return b.textContent.trim();
}, labels);

/**
 * Drop a marker INSIDE the screen. A redraw empties #main, so the marker goes
 * with it — which makes "was this screen redrawn?" a question with an answer.
 * (An attribute on #main itself is no good: `host.innerHTML = ''` leaves the
 * element, and its attributes, standing.)
 */
const mark = page => page.evaluate(() => {
  const m = document.createElement('div');
  m.id = 'jf-mark'; m.style.display = 'none';
  document.querySelector('#main').append(m);
});
const survived = page => page.evaluate(() => !!document.querySelector('#main #jf-mark'));

/** The app as a stranger meets it: no session, so the sign-in screen renders. */
async function openSignedOut(browser, vp = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
  await page.addInitScript(() => {
    globalThis.__sb = { rows: {}, pushed: [], cb: null, user: null,
      fire(e, s) { globalThis.__sb.cb?.(e, s === undefined ? null : s); } };
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__jinnyfinReady === true, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

/** The app as a reset-link click loads it: Supabase already swapped the
 *  session for a recovery-only one before the page's own code ever runs. */
async function openRecovery(browser, vp = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
  await page.addInitScript(() => {
    globalThis.__sb = { rows: {}, pushed: [], cb: null,
      user: { id: 'test-user', email: 'test@jinnyfin.local' },
      recoveryOnInit: true,
      fire(e, s) { globalThis.__sb.cb?.(e, s === undefined ? { user: globalThis.__sb.user } : s); } };
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('.signin'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

// ------------------------------------------------------------------ cases --
const CASES = [];
const test = (name, fn) => CASES.push({ name, fn });

test('every screen opens without an error', async browser => {
  const routes = ['dashboard', 'transactions', 'statement', 'expense', 'income', 'incexp',
    'payee', 'business', 'equity', 'networth', 'insurance', 'cards', 'budgets', 'tasks', 'settings'];
  const { ctx, page, errors } = await open(browser);
  const empty = [], blamed = [];
  for (const r of routes) {
    const was = errors.length;
    await page.evaluate(x => window.JINNYFIN.go(x), r);
    await page.waitForTimeout(700);
    const text = await page.evaluate(() => document.querySelector('#main')?.textContent || '');
    if (text.trim().length < 40 || /Could not open/i.test(text)) empty.push(r);
    // Name the screen that produced it — an error with no screen attached is a
    // half-hour of guessing.
    for (const e of errors.slice(was)) blamed.push(`${r}: ${e.slice(0, 120)}`);
  }
  await ctx.close();
  if (blamed.length) throw new Error(blamed.slice(0, 3).join('  |  '));
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  if (empty.length) throw new Error(`blank or broken: ${empty.join(', ')}`);
  return `${routes.length} screens`;
});

test('a chart with nothing to plot draws nothing, quietly', async browser => {
  // An empty series still built the shaded area under the line, and with no
  // points that path began "L" instead of "M". The browser throws the whole
  // path away and logs an error, so the chart came out as a stray triangle.
  // Relying on some screen happening to have no data made this come and go —
  // so call the chart directly with nothing in it.
  const { ctx, page, errors } = await open(browser, 'dashboard');
  const bad = await page.evaluate(async () => {
    const m = await import('./js/charts.js');
    const host = document.createElement('div');
    host.style.cssText = 'width:640px;height:220px';
    document.body.append(host);
    m.lineChart(host, { labels: [], values: [] });
    m.groupedBars(host, { labels: [], series: [] });
    m.lineChart(host, { labels: ['a'], values: [5] });        // one point must still work
    return [...host.querySelectorAll('path')]
      .map(p => p.getAttribute('d') || '')
      .filter(d => d.trim() && !/^[Mm]/.test(d.trim()));
  });
  await page.waitForTimeout(300);
  await ctx.close();
  if (bad.length) throw new Error(`a path begins "${bad[0].trim().slice(0, 24)}…" instead of M`);
  if (errors.length) throw new Error(errors[0].slice(0, 140));
  return 'no data, no noise';
});

test('an account name in a chart tooltip stays text', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  const result = await page.evaluate(async () => {
    const { groupedBars, lineChart } = await import('./js/charts.js');
    const hostile = '<img src=x onerror="window.__jfTooltipXss=1">Rent <b>account</b>';
    const account = { ...window.JINNYFIN.DB.accounts[0], name: hostile };
    const screen = document.createElement('section');
    screen.id = 'tooltip-screen';
    const groupedHost = document.createElement('div');
    groupedHost.style.cssText = 'width:640px;height:220px';
    const lineHost = document.createElement('div');
    lineHost.style.cssText = 'width:640px;height:220px';
    screen.append(groupedHost, lineHost);
    document.querySelector('#main').append(screen);

    // The real screens use hardcoded series names. User-controlled account or
    // category names reach groupedBars through labels instead.
    groupedBars(groupedHost, {
      labels: [account.name],
      series: [{ name: 'Expense', color: '#5478ff', values: [123] }],
    });
    const bar = groupedHost.querySelector('rect[width]');
    bar.dispatchEvent(new PointerEvent('pointerenter', {
      bubbles: true, clientX: 100, clientY: 100,
    }));
    const groupedTip = document.querySelector('.tip');
    const grouped = {
      text: groupedTip?.textContent || '',
      dangerousElements: groupedTip?.querySelectorAll('img,script,iframe,object').length || 0,
      executed: window.__jfTooltipXss || 0,
    };

    lineChart(lineHost, { labels: [account.name], values: [123], color: '#5478ff' });
    const hit = lineHost.querySelector('rect[fill="transparent"]');
    hit.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: 100, clientY: 100,
    }));
    const lineTip = document.querySelector('.tip');
    return {
      hostile,
      grouped,
      line: {
        text: lineTip?.textContent || '',
        dangerousElements: lineTip?.querySelectorAll('img,script,iframe,object').length || 0,
        executed: window.__jfTooltipXss || 0,
      },
    };
  });
  await ctx.close();
  if (errors.length) throw new Error(errors[0].slice(0, 140));
  if (!result.grouped.text.includes(result.hostile))
    throw new Error('the grouped-bar label was not kept as literal tooltip text');
  if (result.grouped.dangerousElements) throw new Error('grouped-bar label became a tooltip element');
  if (result.grouped.executed) throw new Error('grouped-bar label markup executed');
  if (!result.line.text.includes(result.hostile))
    throw new Error('the line-chart label was not kept as literal tooltip text');
  if (result.line.dangerousElements) throw new Error('line-chart label became a tooltip element');
  if (result.line.executed) throw new Error('line-chart label markup executed');
  return 'grouped and line chart labels remained text';
});

test('signing out warns before discarding queued writes', async browser => {
  const { ctx, page } = await open(browser, 'transactions');
  await ctx.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false && window.JINNYFIN.S.state.online === false);
  const result = await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    const { TABLES, state, DB_NAME, DB_VERSION } = S;
    const rowId = 'signout-local-row';
    await S.put('transactions', {
      id: rowId, user_id: 'test-user', date: '2026-01-01',
      type: 'Expense', account: DB.accounts[0].name, currency: 'INR', expense: 99,
      income: 0, parent: 'Test', note: 'must survive an unconfirmed sign-out',
    });
    localStorage.setItem('jinnyfin-auth', 'live-session-token');

    const countQueue = () => new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB_NAME, DB_VERSION);
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction(['_queue'], 'readonly');
        const cr = tx.objectStore('_queue').count();
        cr.onsuccess = () => { db.close(); resolve(cr.result); };
        cr.onerror = () => reject(cr.error);
      };
    });
    const waitForPrompt = async () => {
      for (let i = 0; i < 100; i++) {
        const msg = document.querySelector('.confirm-msg')?.textContent;
        if (msg) return msg;
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error('sign-out confirmation did not appear');
    };

    const firstAttempt = import('./js/app.js').then(m => m.askSignOut());
    const warning = await waitForPrompt();
    document.querySelector('.modal-wrap .btn.ghost')?.click();
    await firstAttempt;
    const retained = {
      user: !!state.user,
      pending: state.pending,
      memoryRow: !!DB.transactions.find(r => r.id === rowId),
      queue: await countQueue(),
    };

    const secondAttempt = import('./js/app.js').then(m => m.askSignOut());
    await waitForPrompt();
    document.querySelector('.modal-wrap .btn.danger')?.click();
    await secondAttempt;
    const discardedAfterConsent = {
      user: !!state.user,
      pending: state.pending,
      memoryRow: !!DB.transactions.find(r => r.id === rowId),
      queue: await countQueue(),
      authStorage: localStorage.getItem('jinnyfin-auth'),
      serverSawAuth: window.__sb.signOutAuthStorage,
    };
    return { warning, retained, discardedAfterConsent };
  });
  await ctx.close();
  if (!/1 changes have not reached the server yet\. Signing out now deletes them from this device for good\./.test(result.warning))
    throw new Error(`the destructive warning was incomplete: "${result.warning}"`);
  if (!result.retained.user || result.retained.pending !== 1 || !result.retained.memoryRow || result.retained.queue !== 1)
    throw new Error(`unconfirmed sign-out lost queued work: ${JSON.stringify(result.retained)}`);
  if (result.discardedAfterConsent.user || result.discardedAfterConsent.pending !== 0
      || result.discardedAfterConsent.memoryRow || result.discardedAfterConsent.queue !== 0)
    throw new Error(`explicit sign-out did not clear local work: ${JSON.stringify(result.discardedAfterConsent)}`);
  if (result.discardedAfterConsent.serverSawAuth !== 'live-session-token'
      || result.discardedAfterConsent.authStorage)
    throw new Error(`server revocation/storage order was wrong: ${JSON.stringify(result.discardedAfterConsent)}`);
  return 'unsynced work retained without consent, cleared only after explicit consent';
});

test('signing out blocks a sync already in flight', async browser => {
  const { ctx, page } = await open(browser, 'transactions');
  const result = await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    const { TABLES, state, DB_NAME, DB_VERSION } = S;
    window.__sb.pullDelay = 350;
    const inFlight = S.sync({ full: true });
    for (let i = 0; i < 100 && !state.syncing; i++) await new Promise(r => setTimeout(r, 10));
    if (!state.syncing) throw new Error('sync did not enter the in-flight state');

    const signOut = S.signOut();
    await signOut;
    const immediatelyAfter = {
      rows: DB.transactions.length,
      pending: state.pending,
      lastSync: state.lastSync,
      user: state.user,
    };
    await inFlight;

    const storedTransactions = await new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB_NAME, DB_VERSION);
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction(['transactions'], 'readonly');
        const cr = tx.objectStore('transactions').count();
        cr.onsuccess = () => { db.close(); resolve(cr.result); };
        cr.onerror = () => reject(cr.error);
      };
    });
    return {
      immediatelyAfter,
      afterPull: {
        rows: DB.transactions.length,
        storedTransactions,
        lastSync: state.lastSync,
        user: state.user,
      },
      tableRows: Object.fromEntries(TABLES.map(t => [t, DB[t].length])),
    };
  });
  await ctx.close();
  if (result.immediatelyAfter.rows !== 0 || result.immediatelyAfter.lastSync !== null)
    throw new Error(`purge did not clear immediately: ${JSON.stringify(result.immediatelyAfter)}`);
  if (result.afterPull.rows !== 0 || result.afterPull.storedTransactions !== 0
      || result.afterPull.lastSync !== null || result.afterPull.user)
    throw new Error(`late sync repopulated signed-out data: ${JSON.stringify(result)}`);
  const left = Object.entries(result.tableRows).filter(([, n]) => n);
  if (left.length) throw new Error(`tables repopulated after sign-out: ${JSON.stringify(left)}`);
  return 'late pull could not restore local data';
});

test('coming back to the tab does not rebuild the screen', async browser => {
  // supabase-js re-reads its session on every hidden -> visible transition and
  // raises SIGNED_IN for the SAME account. That used to run start(), which
  // rebuilt the shell: "Loading…", and the page back at the top.
  const { ctx, page } = await open(browser, 'statement');
  await mark(page);
  await page.evaluate(() => {
    const t = document.createElement('div'); t.style.height = '3000px';
    document.querySelector('#main').append(t); window.scrollTo(0, 700);
  });
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.__sb.fire('SIGNED_IN'));
  await page.evaluate(() => window.__sb.fire('TOKEN_REFRESHED'));
  await page.waitForTimeout(900);
  const [ok, after, loading] = await Promise.all([
    survived(page), page.evaluate(() => window.scrollY),
    page.evaluate(() => /Loading/.test(document.querySelector('#main')?.textContent || '')),
  ]);
  await ctx.close();
  if (!ok) throw new Error('the screen was rebuilt');
  if (loading) throw new Error('the loading spinner came back');
  if (after !== before) throw new Error(`scroll moved ${before} -> ${after}`);
  return `scroll held at ${after}`;
});

test('signing in as someone else DOES rebuild', async browser => {
  const { ctx, page } = await open(browser, 'statement');
  await mark(page);
  await page.evaluate(() => window.__sb.fire('SIGNED_IN', { user: { id: 'a-different-person' } }));
  await page.waitForTimeout(900);
  const ok = await survived(page);
  await ctx.close();
  if (ok) throw new Error('a change of account left the old screen up');
  return 'rebuilt, as it must';
});

test('a sync that brings nothing new leaves the screen alone', async browser => {
  // The pull deliberately re-reads the last second before the watermark, so
  // most of what arrives is already held. That must not count as a change.
  const { ctx, page } = await open(browser, 'transactions');
  await mark(page);
  await page.evaluate(() => window.JINNYFIN.S.sync());
  await page.waitForTimeout(1200);
  const ok = await survived(page);
  await ctx.close();
  if (!ok) throw new Error('an empty sync rebuilt the screen');
  return 'quiet';
});

test('a sync that brings a real change redraws', async browser => {
  const { ctx, page } = await open(browser, 'transactions');
  await mark(page);
  const note = 'CHANGED-BY-TEST-' + Date.now();
  await page.evaluate(n => {
    const r = window.__sb.rows.transactions[0];
    r.note = n; r.updated_at = new Date().toISOString();
  }, note);
  await page.evaluate(() => window.JINNYFIN.S.sync());
  await page.waitForTimeout(1500);
  const landed = await page.evaluate(n =>
    window.JINNYFIN.DB.transactions.some(t => t.note === n), note);
  const stale = await survived(page);
  await ctx.close();
  if (!landed) throw new Error('a genuinely changed row never arrived');
  if (stale) throw new Error('the row changed but the screen was never redrawn');
  return 'redrawn';
});

test('an account from before the pinned column existed still syncs', async browser => {
  // pinned was added to accounts after some accounts already existed. A local
  // copy untouched since then still carries pinned: null, and sending that
  // explicit null to a NOT NULL column is a genuine Postgres error — this is
  // not a made-up shape, it is what actually reached production.
  const { ctx, page } = await open(browser, 'settings');
  const result = await page.evaluate(async () => {
    const { S } = window.JINNYFIN;
    await S.put('accounts', { id: 'stale-acct', user_id: 'test-user', name: 'Old Account', currency: 'SAR', pinned: null });
    const before = S.state.pending;
    await S.sync();
    return {
      before,
      after: S.state.pending,
      sent: window.__sb.pushed.find(p => p.table === 'accounts' && p.row.id === 'stale-acct')?.row,
    };
  });
  await ctx.close();
  if (!result.sent) throw new Error('the stale account never reached the server at all');
  if ('pinned' in result.sent) throw new Error(`an explicit null was still sent: ${JSON.stringify(result.sent)}`);
  if (result.after !== 0) throw new Error(`${result.after} item(s) still pending after a clean push`);
  return 'the historical null was dropped, not sent, and the row went through';
});

test('one row the server refuses does not block its table-mates or the next table', async browser => {
  // Before this, ANY rejected row threw out of the whole push step — every
  // other row in its chunk, every other table queued behind it, and the pull
  // that follows all stayed stuck, silently, for good. The pending count only
  // ever climbed, with nothing on screen to say why.
  const { ctx, page } = await open(browser, 'settings');
  const result = await page.evaluate(async () => {
    const { S } = window.JINNYFIN;
    window.__sb.rejectUpsert = (table, row) => (table === 'accounts' && row.name === 'POISON')
      ? 'null value in column "sort" of relation "accounts" violates not-null constraint' : null;
    await S.put('accounts', { id: 'poison-acct', user_id: 'test-user', name: 'POISON', currency: 'SAR' });
    await S.put('accounts', { id: 'clean-acct', user_id: 'test-user', name: 'Clean Account', currency: 'SAR' });
    await S.put('payees', { id: 'clean-payee', user_id: 'test-user', name: 'A Payee' });
    const pullsBefore = window.__sb.pulls?.accounts || 0;
    await S.sync({ full: true });
    return {
      pending: S.state.pending,
      cleanAcct: !!window.__sb.pushed.find(p => p.table === 'accounts' && p.row.id === 'clean-acct'),
      cleanPayee: !!window.__sb.pushed.find(p => p.table === 'payees' && p.row.id === 'clean-payee'),
      poisonSent: !!window.__sb.pushed.find(p => p.table === 'accounts' && p.row.id === 'poison-acct'),
      toast: document.querySelector('.toast')?.textContent || '',
      pulled: (window.__sb.pulls?.accounts || 0) > pullsBefore,
    };
  });
  await ctx.close();
  if (!result.cleanAcct) throw new Error('the good account in the same chunk never got through');
  if (!result.cleanPayee) throw new Error('a different table queued behind the bad row never got through');
  if (result.poisonSent) throw new Error('the row the server refuses somehow reached S.pushed as a success');
  if (result.pending !== 1) throw new Error(`expected exactly the poisoned row still pending, got ${result.pending}`);
  if (!/will not sync/i.test(result.toast)) throw new Error(`no toast named the stuck row: "${result.toast}"`);
  if (!result.pulled) throw new Error('the pull phase never ran after the push partly failed');
  return 'the good rows and the other table went through; only the refused row stayed queued, and named';
});

test('a background sync does not throw you out of a box you are typing in', async browser => {
  const { ctx, page } = await open(browser, 'settings');
  // Settings -> Reconcile, where a column of balances gets typed straight through.
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(b => b.textContent.trim() === 'Reconcile')?.click());
  await page.waitForTimeout(600);
  const box = page.locator('#main input.inline-num').first();
  await box.click();
  await box.type('1234');
  await page.evaluate(n => {
    const r = window.__sb.rows.transactions[1];
    r.note = n; r.updated_at = new Date().toISOString();
  }, 'TYPING-TEST-' + Date.now());
  await page.evaluate(() => window.JINNYFIN.S.sync());
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    cls: document.activeElement?.className,
    val: document.activeElement?.value,
  }));
  await ctx.close();
  if (state.tag !== 'INPUT' || !/inline-num/.test(state.cls || ''))
    throw new Error(`the cursor left the box — it is on ${state.tag}.${state.cls}`);
  if (state.val !== '1234') throw new Error(`what was typed was lost (got "${state.val}")`);
  return 'cursor and digits both held';
});

test('arrow keys walk a filter without losing the cursor', async browser => {
  const { ctx, page } = await open(browser, 'business');
  const year = page.locator('#main select').first();
  await year.focus();
  const first = await year.inputValue();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    val: document.activeElement?.value,
  }));
  await ctx.close();
  if (after.tag !== 'SELECT') throw new Error(`the cursor left the filter (now on ${after.tag})`);
  if (after.val === first) throw new Error('two presses moved nothing — the second was swallowed');
  return `${first} -> ${after.val}`;
});

test('duplicating one leg of a cross-currency transfer copies both legs', async browser => {
  const { ctx, page } = await open(browser, 'transactions');
  const result = await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    const outAcct = DB.accounts.find(a => a.currency === 'SAR');
    const inAcct = DB.accounts.find(a => a.currency === 'INR');
    if (!outAcct || !inAcct) throw new Error('fixture needs both SAR and INR accounts');
    const note = '__duplicate_cross_currency_fixture__';
    const group = 'grp-duplicate-cross-currency';
    await S.put('transactions', {
      id: 'dup-xfer-out', date: '2026-09-01', time: '10:00', type: 'Transfer',
      account: outAcct.name, currency: 'SAR', income: 0, expense: 55, fx: 23.6363,
      parent: 'Transfer', sub: '', payee: 'Big Ticket', note, transfer_group: group,
      to_account: inAcct.name, no: 990001,
    });
    await S.put('transactions', {
      id: 'dup-xfer-in', date: '2026-09-01', time: '10:00', type: 'Transfer',
      account: inAcct.name, currency: 'INR', income: 1300, expense: 0, fx: 23.6363,
      parent: 'Transfer', sub: '', payee: 'Big Ticket', note, transfer_group: group,
      to_account: null, no: 990002,
    });
    await S.put('transactions', { id: 'dup-xfer-marker', date: '2026-09-01', time: '10:00', type: 'Expense',
      account: outAcct.name, currency: 'SAR', income: 0, expense: 1, fx: 23.6363,
      parent: 'Test', sub: '', payee: '', note: '__duplicate_cross_currency_marker__',
      transfer_group: null, to_account: null, no: 990003 });
    return { note, out: outAcct.name, in: inAcct.name };
  });
  await page.evaluate(() => window.JINNYFIN.go('dashboard'));
  await page.waitForTimeout(250);
  await page.evaluate(() => window.JINNYFIN.go('transactions'));
  await page.waitForTimeout(400);
  const row = page.locator('.tx').filter({ hasText: result.note }).first();
  await row.locator('button[title="Duplicate to today"]').click();
  await page.waitForTimeout(500);
  const copies = await page.evaluate(note => window.JINNYFIN.DB.transactions
    .filter(t => t.note === note && t.id !== 'dup-xfer-out' && t.id !== 'dup-xfer-in'), result.note);
  await ctx.close();
  if (copies.length !== 2) throw new Error(`expected 2 copied legs, found ${copies.length}`);
  if (new Set(copies.map(t => t.transfer_group)).size !== 1 || !copies[0].transfer_group)
    throw new Error('copied legs do not share a new transfer group');
  if (!copies.some(t => t.account === result.out && t.currency === 'SAR' && +t.expense === 55))
    throw new Error('copied SAR outgoing leg is missing');
  if (!copies.some(t => t.account === result.in && t.currency === 'INR' && +t.income === 1300))
    throw new Error('copied INR incoming leg is missing');
  if (copies.some(t => t.account === '— not known —' || t.to_account === '— not known —'))
    throw new Error('a copied leg used a not-known account');
  return `${copies.length} linked legs copied`;
});

test('confirmation dialogs default to Cancel for Enter and restore focus', async browser => {
  const { ctx, page } = await open(browser, 'transactions');
  await page.evaluate(async () => {
    const anchor = document.createElement('button');
    anchor.id = 'confirm-focus-anchor'; anchor.textContent = 'Update';
    document.body.append(anchor); anchor.focus();
    const { confirmBox } = await import('./js/util.js');
    window.__confirmPromise = confirmBox('This is one side of a transfer.', 'Change it');
  });
  await page.waitForSelector('.modal-wrap .btn.danger');
  const beforeEnter = await page.evaluate(() => ({
    focused: document.activeElement?.textContent?.trim() || '',
    dialogs: document.querySelectorAll('.modal-wrap').length,
  }));
  if (beforeEnter.focused !== 'Cancel') {
    await page.keyboard.press('Escape');
    await ctx.close();
    throw new Error(`Cancel was not focused by default (focused: ${beforeEnter.focused || 'nothing'})`);
  }
  await page.keyboard.press('Enter');
  const result = await page.evaluate(async () => ({
    value: await window.__confirmPromise,
    focused: document.activeElement?.id || '',
  }));
  const dialogsAfter = await page.locator('.modal-wrap').count();
  await ctx.close();
  if (result.value !== false) throw new Error('Enter activated the destructive action instead of Cancel');
  if (dialogsAfter !== 0) throw new Error(`confirmation dialog remained open (${dialogsAfter})`);
  if (result.focused !== 'confirm-focus-anchor')
    throw new Error(`focus did not return to the underlying editor (focused: ${result.focused || 'nothing'})`);
  return 'Cancel focused, Enter cancelled, and underlying focus was restored';
});

test('Escape dismisses only the confirmation and preserves the editor modal', async browser => {
  const { ctx, page } = await open(browser, 'transactions');
  await page.evaluate(async () => {
    const { el, modal, confirmBox } = await import('./js/util.js');
    const editor = modal('Edit Transaction', el('input', { id: 'editor-focus-anchor', value: 'keep me' }));
    document.querySelector('#editor-focus-anchor').focus();
    window.__editorModal = editor;
    window.__confirmPromise = confirmBox('This is one side of a transfer.', 'Change it');
  });
  await page.waitForSelector('.modal-wrap .btn.danger');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  const state = await page.evaluate(() => ({
    dialogs: document.querySelectorAll('.modal-wrap').length,
    confirmation: !!document.querySelector('.modal-wrap .btn.danger'),
    editor: !!document.querySelector('#editor-focus-anchor'),
    focused: document.activeElement?.id || '',
  }));
  if (state.confirmation) await page.locator('.modal-wrap .btn.ghost').click();
  const result = await page.evaluate(async () => await window.__confirmPromise);
  await ctx.close();
  if (result !== false) throw new Error('Escape did not cancel the confirmation');
  if (state.confirmation) throw new Error('Escape left the confirmation dialog open');
  if (!state.editor) throw new Error('Escape closed the underlying editor modal');
  if (state.focused !== 'editor-focus-anchor')
    throw new Error(`Escape did not restore editor focus (focused: ${state.focused || 'nothing'})`);
  return 'Escape cancelled only the confirmation and restored editor focus';
});

test('backdrop and browser-back dismissals preserve the editor modal', async browser => {
  const { ctx, page } = await open(browser, 'transactions');
  await page.evaluate(async () => {
    const { el, modal, confirmBox } = await import('./js/util.js');
    const editor = modal('Edit Transaction', el('input', { id: 'dismissal-focus-anchor', value: 'keep me' }));
    document.querySelector('#dismissal-focus-anchor').focus();
    window.__editorModal = editor;
    window.__openConfirmation = () => {
      window.__confirmPromise = confirmBox('This is one side of a transfer.', 'Change it');
    };
    window.__openConfirmation();
  });
  await page.waitForSelector('.modal-wrap .btn.danger');
  const topWrap = page.locator('.modal-wrap').last();
  const bounds = await topWrap.boundingBox();
  await page.mouse.click(bounds.x + 4, bounds.y + 4);
  const backdropResult = await page.evaluate(async () => await window.__confirmPromise);
  const afterBackdrop = await page.evaluate(() => ({
    dialogs: document.querySelectorAll('.modal-wrap').length,
    editor: !!document.querySelector('#dismissal-focus-anchor'),
    focused: document.activeElement?.id || '',
  }));
  if (backdropResult !== false) throw new Error('backdrop did not cancel the confirmation');
  if (afterBackdrop.dialogs !== 1 || !afterBackdrop.editor)
    throw new Error('backdrop dismissal removed the underlying editor modal');
  if (afterBackdrop.focused !== 'dismissal-focus-anchor')
    throw new Error(`backdrop dismissal did not restore editor focus (focused: ${afterBackdrop.focused || 'nothing'})`);

  await page.evaluate(() => window.__openConfirmation());
  await page.waitForSelector('.modal-wrap .btn.danger');
  await page.goBack();
  await page.waitForTimeout(100);
  const backResult = await page.evaluate(async () => await window.__confirmPromise);
  const afterBack = await page.evaluate(() => ({
    dialogs: document.querySelectorAll('.modal-wrap').length,
    editor: !!document.querySelector('#dismissal-focus-anchor'),
    focused: document.activeElement?.id || '',
  }));
  await ctx.close();
  if (backResult !== false) throw new Error('browser-back did not cancel the confirmation');
  if (afterBack.dialogs !== 1 || !afterBack.editor)
    throw new Error('browser-back dismissal removed the underlying editor modal');
  if (afterBack.focused !== 'dismissal-focus-anchor')
    throw new Error(`browser-back dismissal did not restore editor focus (focused: ${afterBack.focused || 'nothing'})`);
  return 'backdrop and browser-back preserved the editor modal and focus';
});

test('Income Report description search filters totals, chart data, and details', async browser => {
  const { ctx, page } = await open(browser, 'income');
  const initial = await page.evaluate(() => ({
    entries: document.querySelector('.stat:nth-child(4) .value')?.textContent.trim(),
    details: document.querySelector('.jf-bd + .card h3')?.textContent.trim(),
  }));
  const search = page.locator('input[data-fk="description"]');
  await search.fill('House Warming Contribution');
  await page.waitForTimeout(250);
  const filtered = await page.evaluate(() => ({
    entries: document.querySelector('.stat:nth-child(4) .value')?.textContent.trim(),
    details: document.querySelector('.jf-bd + .card h3')?.textContent.trim(),
    detailRows: document.querySelectorAll('.jf-bd + .card tbody tr').length,
    body: document.querySelector('#main')?.textContent || '',
  }));
  await ctx.close();
  if (!initial.entries || initial.entries === '0') throw new Error('income fixture did not load');
  if (filtered.entries !== '1') throw new Error(`description search did not filter entries: ${filtered.entries || 'missing'}`);
  if (filtered.details !== 'Transaction details (1)') throw new Error(`detail count did not filter: ${filtered.details || 'missing'}`);
  if (filtered.detailRows !== 1) throw new Error(`filtered detail rows were not limited to one: ${filtered.detailRows}`);
  if (!filtered.body.includes('House Warming Contribution')) throw new Error('matching description is missing from filtered details');
  return 'one matching income row across report outputs';
});

test('Income and Expense reports render all filter controls', async browser => {
  const reports = [];
  for (const route of ['income', 'expense']) {
    const { ctx, page } = await open(browser, route);
    reports.push(await page.evaluate(() => ({
      year: !!document.querySelector('select[data-fk="year"]'),
      month: !!document.querySelector('select[data-fk="month"]'),
      // Category / Sub-category / Account are the word-search combo box, not
      // a plain select — data-fk sits on its wrapping div.
      category: !!document.querySelector('[data-fk="parent"] input'),
      subcategory: !!document.querySelector('[data-fk="sub"] input'),
      account: !!document.querySelector('[data-fk="account"] input'),
      description: !!document.querySelector('input[data-fk="description"]'),
    })));
    await ctx.close();
  }
  const missing = reports.flatMap((r, i) => Object.entries(r).filter(([, present]) => !present).map(([key]) => `${['income', 'expense'][i]}:${key}`));
  if (missing.length) throw new Error(`missing report controls: ${missing.join(', ')}`);
  return 'all Income and Expense filters render';
});

test('the report Category filter finds a category by any word in its name', async browser => {
  // A plain <select> only jumps to an option starting with the letter just
  // typed — "Business" did nothing for "Cake Business" because the B is not
  // the first letter. The search combo matches on the start of ANY word.
  const { ctx, page, errors } = await open(browser, 'expense');
  const box = page.locator('[data-fk="parent"] input');
  await box.click();
  await box.fill('Business');
  await page.waitForTimeout(200);
  const options = await page.evaluate(() => [...document.querySelectorAll('.combo-opt')].map(o => o.textContent));
  if (!options.some(o => o.includes('Cake Business'))) {
    await ctx.close(); throw new Error(`typing "Business" did not offer Cake Business: ${options.join(', ')}`); }
  await page.evaluate(() => document.querySelector('.combo-opt')?.click());
  await page.waitForTimeout(300);
  const heading = await page.evaluate(() => document.querySelector('.jf-bd h3')?.textContent || '');
  await ctx.close();
  if (heading !== 'Breakdown inside Cake Business') throw new Error(`picking the match did not filter: "${heading}"`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'typing "Business" finds and selects "Cake Business"';
});

test('Tab picks the highlighted account, the same as Enter', async browser => {
  // Typing "Fed" narrowed the Account field to the Fed accounts and highlighted
  // one — but tabbing on to the next field without pressing Enter first threw
  // that away and silently filled in whatever account was there before.
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.openTxEditor());
  await page.waitForTimeout(500);
  const acctInput = page.locator('.modal-body .field .combo input').first();
  await acctInput.click();
  await acctInput.fill('Fed');
  await page.waitForTimeout(200);
  const highlighted = await page.evaluate(() => document.querySelector('.combo-opt.hi')?.textContent || '');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  const value = await acctInput.inputValue();
  await ctx.close();
  if (!highlighted.startsWith('Fed')) throw new Error(`nothing was highlighted to Tab onto: "${highlighted}"`);
  if (value !== highlighted) throw new Error(`Tab left "${value}", expected the highlighted "${highlighted}"`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `Tab picked "${value}"`;
});

test('switching off Lend/Borrow clears the payee, and coming back restores it', async browser => {
  // The Payee box is shared with every other type's "Payee / tag" field.
  // Typing a loan's payee and switching to Expense used to leave that name
  // sitting there — and it belongs to neither the Expense row nor, once you
  // switch on, whichever type comes after it.
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.openTxEditor(null, { type: 'Lend/Borrow' }));
  await page.waitForTimeout(500);
  const payeeVal = () => page.evaluate(() =>
    [...document.querySelectorAll('.modal-body input')].find(i => i.placeholder === 'Who?')?.value || '');
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.modal-body input')].find(i => i.placeholder === 'Who?');
    p.focus(); p.value = 'Test Friend';
  });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  if (await payeeVal() !== 'Test Friend') { await ctx.close(); throw new Error('payee did not take the typed name'); }

  await page.click('.type-pick button[data-ty="Expense"]');
  await page.waitForTimeout(300);
  const onExpense = await payeeVal();

  await page.click('.type-pick button[data-ty="Lend/Borrow"]');
  await page.waitForTimeout(300);
  const backOnLB = await payeeVal();
  await ctx.close();
  if (onExpense) throw new Error(`switching to Expense still showed the Lend/Borrow payee: "${onExpense}"`);
  if (backOnLB !== 'Test Friend') throw new Error(`coming back to Lend/Borrow lost the payee: "${backOnLB}"`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'payee stays out of other types, and comes back on Lend/Borrow';
});

// ---- search boxes: every key, every screen (1.60) --------------------------
/** Where the keyboard is: the field's label (or a button's text). */
const focusLabel = page => page.evaluate(() => {
  const a = document.activeElement;
  const lab = a?.closest('.field')?.querySelector('label')?.textContent?.trim();
  return lab || a?.textContent?.trim() || a?.tagName || '';
});
/** What a search box reads, and what it holds, by its data-fk. */
const boxShows = (page, fk) => page.evaluate(k => document.querySelector(`[data-fk="${k}"] input`)?.value ?? null, fk);
const listOpen = page => page.evaluate(() => [...document.querySelectorAll('.combo-list')].some(m => !m.hidden));
const bdHeading = page => page.evaluate(() => document.querySelector('.jf-bd h3')?.textContent || '');
const tab = async (page, keys = 'Tab') => { await page.keyboard.press(keys); await page.waitForTimeout(250); };

test('report search box: type, Tab — the pick stays and the cursor moves on; more Tabs change nothing', async browser => {
  // Typing in Category and pressing Tab kept the cursor in the same box, and
  // every further Tab put "All categories" back — the page rebuilt the box Tab
  // was leaving, and the rebuilt box opened on "All" and picked it.
  const { ctx, page, errors } = await open(browser, 'expense');
  await page.locator('[data-fk="parent"] input').click();
  await page.keyboard.type('Business');
  await page.waitForTimeout(150);
  await tab(page);
  const at1 = await focusLabel(page);
  const shows1 = await boxShows(page, 'parent');
  const head1 = await bdHeading(page);
  await tab(page);                                        // Sub-category → Account
  const at2 = await focusLabel(page);
  await tab(page);                                        // → Clear
  await tab(page, 'Shift+Tab'); await tab(page, 'Shift+Tab'); await tab(page, 'Shift+Tab');
  const back = await focusLabel(page);
  await tab(page); await tab(page);
  const shows2 = await boxShows(page, 'parent');
  const head2 = await bdHeading(page);
  // Only the box the cursor is in may have its list open (it opens on focus).
  const strays = await page.evaluate(() => [...document.querySelectorAll('.combo')]
    .filter(c => !c.querySelector('.combo-list').hidden && !c.contains(document.activeElement)).length);
  await ctx.close();
  if (shows1 !== 'Cake Business') throw new Error(`after Tab the box reads "${shows1}"`);
  if (head1 !== 'Breakdown inside Cake Business') throw new Error(`the pick did not filter: "${head1}"`);
  if (at1 !== 'Sub-category') throw new Error(`Tab left the cursor on "${at1}", not the next box`);
  if (at2 !== 'Account') throw new Error(`the second Tab went to "${at2}"`);
  if (back !== 'Category') throw new Error(`Shift+Tab ×3 came back to "${back}"`);
  if (shows2 !== 'Cake Business' || head2 !== head1) throw new Error(`passing through with Tab changed it to "${shows2}" / "${head2}"`);
  if (strays) throw new Error(`${strays} list(s) left hanging open on boxes the cursor has left`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'Category → Sub → Account → Clear and back: "Cake Business" held throughout';
});

test('report search box: Enter picks and closes; Escape shuts only the list, then steps out', async browser => {
  const { ctx, page, errors } = await open(browser, 'expense');
  await page.locator('[data-fk="parent"] input').click();
  await page.keyboard.type('Business');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const e = { open: await listOpen(page), shows: await boxShows(page, 'parent'), at: await focusLabel(page), head: await bdHeading(page) };
  await tab(page);                                        // nothing typed since Enter: moves on, changes nothing
  const afterTab = { at: await focusLabel(page), shows: await boxShows(page, 'parent') };
  await page.locator('[data-fk="account"] input').click();
  await page.waitForTimeout(150);
  const opened = await listOpen(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const esc1 = { open: await listOpen(page), head: await bdHeading(page), at: await focusLabel(page) };
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const esc2 = { head: await bdHeading(page), shows: await boxShows(page, 'parent') };
  await ctx.close();
  if (e.open || e.shows !== 'Cake Business' || e.at !== 'Category' || e.head !== 'Breakdown inside Cake Business')
    throw new Error(`Enter: ${JSON.stringify(e)}`);
  if (afterTab.at !== 'Sub-category' || afterTab.shows !== 'Cake Business') throw new Error(`Tab after Enter: ${JSON.stringify(afterTab)}`);
  if (!opened) throw new Error('the Account list did not open on focus');
  if (esc1.open || esc1.head !== 'Breakdown inside Cake Business' || esc1.at !== 'Account')
    throw new Error(`Escape with the list open did more than close it: ${JSON.stringify(esc1)}`);
  if (esc2.head !== 'Breakdown by category' || esc2.shows !== 'All categories')
    throw new Error(`the second Escape did not step out, or the box did not follow: ${JSON.stringify(esc2)}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'Enter keeps it; Tab moves on; Esc #1 closes the list, Esc #2 steps out and the box follows';
});

test('report Sub-category box finds a sub under any category and fills in the category', async browser => {
  const { ctx, page, errors } = await open(browser, 'expense');
  const pick = await page.evaluate(() => {
    const C = window.JINNYFIN.DB.categories.filter(c => c.type === 'Expense' && c.sub && c.active !== false);
    const words = s => s.toLowerCase().split(/\s+/).filter(Boolean);
    // a sub no other sub could be mistaken for when typed in full
    for (const c of C) {
      const w = words(c.sub);
      const rivals = C.filter(o => o !== c && w.every(x => words(o.sub).some(p => p.startsWith(x))));
      if (!rivals.length && C.filter(o => o.sub === c.sub).length === 1) return { parent: c.parent, sub: c.sub };
    }
    return null;
  });
  if (!pick) { await ctx.close(); throw new Error('fixture has no unambiguous sub-category'); }
  await page.selectOption('[data-fk="year"]', 'All');
  await page.waitForTimeout(200);
  await page.locator('[data-fk="sub"] input').click();
  await page.keyboard.type(pick.sub);
  await page.waitForTimeout(150);
  const lit = await page.evaluate(() => document.querySelector('.combo-opt.hi')?.textContent || '');
  await tab(page);
  const got = { cat: await boxShows(page, 'parent'), sub: await boxShows(page, 'sub'), head: await bdHeading(page), at: await focusLabel(page) };
  await ctx.close();
  if (lit !== `${pick.sub} · ${pick.parent}`) throw new Error(`typing "${pick.sub}" lit "${lit}"`);
  if (got.cat !== pick.parent) throw new Error(`the category box reads "${got.cat}", expected "${pick.parent}"`);
  if (got.sub !== pick.sub) throw new Error(`the sub box reads "${got.sub}"`);
  if (got.head !== `Inside ${pick.sub}`) throw new Error(`not filtered to the sub: "${got.head}"`);
  if (got.at !== 'Account') throw new Error(`Tab went to "${got.at}"`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `"${pick.sub}" → ${pick.parent} filled in`;
});

test('report boxes follow a tap in the breakdown, and Clear empties every one', async browser => {
  const { ctx, page, errors } = await open(browser, 'expense');
  await page.selectOption('[data-fk="year"]', 'All');
  await page.waitForTimeout(250);
  const tapped = await page.evaluate(() => {
    const row = document.querySelector('.jf-bd .bar-row');
    const name = row?.querySelector('.lab span')?.firstChild?.textContent?.trim();
    row?.click();
    return name;
  });
  await page.waitForTimeout(300);
  const followed = await boxShows(page, 'parent');
  await page.locator('[data-fk="account"] input').click();
  await page.keyboard.type('Rajhi');
  await tab(page);
  const acct = await boxShows(page, 'account');
  await page.evaluate(() => [...document.querySelectorAll('#main button')].find(b => b.textContent.trim() === 'Clear')?.click());
  await page.waitForTimeout(300);
  const cleared = { cat: await boxShows(page, 'parent'), sub: await boxShows(page, 'sub'), acct: await boxShows(page, 'account'),
    year: await page.locator('[data-fk="year"]').inputValue(), head: await bdHeading(page) };
  await ctx.close();
  if (!tapped || followed !== tapped) throw new Error(`tapped "${tapped}", the box reads "${followed}"`);
  if (acct !== 'Al Rajhi') throw new Error(`Account box reads "${acct}"`);
  if (cleared.cat !== 'All categories' || cleared.sub !== 'All sub-categories' || cleared.acct !== 'All accounts'
    || cleared.year !== 'All' || cleared.head !== 'Breakdown by category') throw new Error(`Clear left: ${JSON.stringify(cleared)}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `tap "${tapped}" → box follows; Clear resets all`;
});

test('Transactions filters: type a word, Tab — kept, filtered, and the cursor moves on', async browser => {
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.locator('[data-fk="account"] input').click();
  await page.keyboard.type('NRO');
  await tab(page);
  const r = { at: await focusLabel(page), shows: await boxShows(page, 'account'),
    count: await page.evaluate(() => document.querySelector('.tx-results .stat .value')?.textContent.trim()),
    want: await page.evaluate(() => window.JINNYFIN.DB.transactions.filter(t => !t.deleted && t.account === 'Fed Bank NRO').length) };
  await tab(page);                                        // through Category untouched
  const again = await boxShows(page, 'account');
  const cat = await boxShows(page, 'parent');
  await ctx.close();
  if (r.shows !== 'Fed Bank NRO') throw new Error(`the Account box reads "${r.shows}"`);
  if (r.at !== 'Category') throw new Error(`Tab went to "${r.at}"`);
  if (r.count !== r.want.toLocaleString('en-IN')) throw new Error(`${r.count} entries shown, ${r.want} on Fed Bank NRO`);
  if (again !== 'Fed Bank NRO' || cat !== 'All categories') throw new Error(`passing through changed things: ${again} / ${cat}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `"NRO" → Fed Bank NRO, ${r.count} entries, cursor on Category`;
});

// ------------------------------------------------ 2.2: unlinked transfers --
const typeOptions = page => page.evaluate(() => [...document.querySelectorAll('select[data-fk="type"] option')].map(o => o.value));
const entriesShown = page => page.evaluate(() => document.querySelector('.tx-results .stat .value')?.textContent.trim());
const unlinkedIn = (page, account) => page.evaluate(a => window.JINNYFIN.DB.transactions
  .filter(t => !t.deleted && t.type === 'Transfer' && !t.transfer_group && (!a || t.account === a)).length, account);

test('Transactions: "Half transfers" lists only transfers missing their other half, and a fixed one drops out', async browser => {
  const { ctx, page, errors } = await open(browser, 'transactions');
  const opts = await typeOptions(page);
  if (!opts.includes('Half transfers')) { await ctx.close(); throw new Error(`the Type box has no "Half transfers": ${opts.join(', ')}`); }
  await page.selectOption('select[data-fk="type"]', 'Half transfers');
  await page.waitForTimeout(300);
  const all = { shown: await entriesShown(page), want: await unlinkedIn(page) };
  // …and it combines with the other filters.
  await page.locator('[data-fk="account"] input').click();
  await page.keyboard.type('NRO');
  await tab(page);
  const nro = { shown: await entriesShown(page), want: await unlinkedIn(page, 'Fed Bank NRO') };
  // Fix one the way he would: open it, name the account it went to, Update.
  await page.locator('.tx-results .tx').filter({ has: page.locator('.amt.out') }).first().click();
  await page.waitForSelector('.modal');
  await page.waitForTimeout(500);                          // let the sheet fill its account lists
  await page.evaluate(() => {
    const m = [...document.querySelectorAll('.modal')].pop();
    const f = [...m.querySelectorAll('.field')].find(x => x.querySelector('label')?.textContent.trim() === 'To account');
    f.querySelector('input').focus();
  });
  await page.keyboard.type('Cash at Home');
  await tab(page);
  const toShows = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.modal')].pop();
    return [...m.querySelectorAll('.field')].find(x => x.querySelector('label')?.textContent.trim() === 'To account')?.querySelector('input')?.value;
  });
  if (!String(toShows).startsWith('Cash at Home')) { await ctx.close(); throw new Error(`the To box reads "${toShows}" after typing Cash at Home + Tab`); }
  await topClick(page, ['Update']);
  // "Create it" is asked only when no partner is found — wait for either that
  // question or the sheet closing, rather than guessing how long it takes.
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150);
    if (await topClick(page, ['Create it'])) continue;
    if (!(await page.evaluate(() => document.querySelectorAll('.modal').length))) break;
  }
  await page.waitForTimeout(500);
  const after = { shown: await entriesShown(page), want: await unlinkedIn(page, 'Fed Bank NRO'),
    type: await page.evaluate(() => document.querySelector('select[data-fk="type"]').value),
    open: await page.evaluate(() => document.querySelectorAll('.modal').length),
    openText: await page.evaluate(() => [...document.querySelectorAll('.modal')].map(m => m.innerText.replace(/\s+/g, ' ').slice(0, 300)).join(' || ')) };
  await ctx.close();
  if (all.shown !== all.want.toLocaleString('en-IN')) throw new Error(`${all.shown} shown, ${all.want} unlinked transfers exist`);
  if (nro.shown !== String(nro.want) || nro.want < 2) throw new Error(`with Fed Bank NRO: ${nro.shown} shown, ${nro.want} expected`);
  if (after.open) throw new Error('the sheet stayed open: ' + after.openText);
  if (after.want !== nro.want - 1 || after.shown !== String(after.want)) throw new Error(`after fixing one: ${after.shown} shown, ${after.want} left (was ${nro.want})`);
  if (after.type !== 'Half transfers') throw new Error(`fixing a row reset the filter to "${after.type}"`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${all.want} unlinked; ${nro.want} on Fed Bank NRO → ${after.want} after one was fixed, filter kept`;
});

test('Transactions: the "Half transfers" option is gone once none are left', async browser => {
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.selectOption('select[data-fk="type"]', 'Half transfers');
  await page.waitForTimeout(300);
  // Every last one gets its other half — as if he had finished the clean-up.
  await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    await S.putMany('transactions', DB.transactions.filter(t => t.type === 'Transfer' && !t.transfer_group)
      .map(t => ({ ...t, transfer_group: 'grp-' + t.id })));
  });
  await page.waitForTimeout(700);
  const during = { opts: await typeOptions(page), shown: await entriesShown(page),
    type: await page.evaluate(() => document.querySelector('select[data-fk="type"]').value) };
  await page.evaluate(() => window.JINNYFIN.go('dashboard'));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.JINNYFIN.go('transactions'));
  await page.waitForTimeout(600);
  const later = { opts: await typeOptions(page), shown: await entriesShown(page),
    type: await page.evaluate(() => document.querySelector('select[data-fk="type"]').value),
    all: await page.evaluate(() => window.JINNYFIN.DB.transactions.filter(t => !t.deleted).length) };
  await ctx.close();
  // While it is still the filter in force the box must not go blank…
  if (during.type !== 'Half transfers' || during.shown !== '0') throw new Error(`right after the last fix: ${JSON.stringify(during)}`);
  // …but on the next visit it has no reason to exist.
  if (later.opts.includes('Half transfers')) throw new Error('the option is still offered with nothing left to fix');
  if (later.type !== 'All' || later.shown !== later.all.toLocaleString('en-IN')) throw new Error(`coming back: ${JSON.stringify(later)}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'kept while in force (0 shown), gone on the next visit, filter back to All';
});

// ------------------------------------------------------ 2.3: text diet --
const settingsTab = async (page, label) => {
  await page.evaluate(l => [...document.querySelectorAll('#main .seg button')].find(b => b.textContent.trim().startsWith(l))?.click(), label);
  await page.waitForTimeout(400);
};
const mainText = page => page.evaluate(() => document.querySelector('#main').innerText);

test('lean screens: nothing-to-do cards stay away and dropped hints are gone', async browser => {
  const { ctx, page, errors } = await open(browser, 'insurance');
  const ins = await mainText(page);
  await page.evaluate(() => window.JINNYFIN.go('settings')); await page.waitForTimeout(600);
  const gen = await mainText(page);
  // Finish every clean-up the Data tab offers, mark the import done, then look.
  await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    await S.putMany('transactions', DB.transactions.filter(t => t.type === 'Transfer' && (!t.transfer_group || !t.parent))
      .map(t => ({ ...t, transfer_group: t.transfer_group || 'grp-' + t.id, parent: t.parent || 'Transfer' })));
    await S.setSettings({ seeded: '2026-08-31' });
  });
  await page.waitForTimeout(500);
  await settingsTab(page, 'Backup');
  const data = await mainText(page);
  await settingsTab(page, 'Data check');
  const check = await page.evaluate(() => ({ text: document.querySelector('#main').innerText,
    clean: [...document.querySelectorAll('#main .chip')].filter(c => /clean/.test(c.textContent)).length }));
  await ctx.close();
  const bad = [];
  if (/ATM Cards/i.test(ins)) bad.push('Insurance shows an empty ATM Cards section');
  if (/GitHub Action/.test(ins)) bad.push('Insurance still offers the GitHub Action e-mail');
  if (/version I sent you/.test(gen)) bad.push('"compare this with the version I sent you" is back');
  if (/Stylesheet:/.test(gen)) bad.push('the stylesheet line shows although it matches');
  if (/If it is behind/.test(gen)) bad.push('the Force update paragraph is back');
  if (/Import from the Excel workbook/i.test(data)) bad.push('the import card shows after the import');
  if (/Tidy up/i.test(data)) bad.push('Tidy up shows with nothing to tidy');
  if (/Numbers check/i.test(data)) bad.push('Numbers check is still there');
  if (!/Backup/i.test(data)) bad.push('the Backup card went missing');
  if (check.clean) bad.push(`${check.clean} clean Data check groups still shown`);
  if (/Nothing here is wrong on its own/.test(check.text)) bad.push('the Data check explainer is back');
  if (bad.length) throw new Error(bad.join('; '));
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'empty ATM section, import, Tidy up, clean checks, version chatter: all out of the way';
});

test('the account sheet has no Bank says box, and saving it keeps the reconciled figure', async browser => {
  const { ctx, page, errors } = await open(browser, 'settings');
  await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    const a = DB.accounts.find(x => x.name === 'Fed Bank NRO');
    await S.put('accounts', { ...a, stated_balance: 12345.67 });
  });
  await settingsTab(page, 'Accounts');
  await page.evaluate(() => [...document.querySelectorAll('#main tr')].find(r => r.textContent.includes('Fed Bank NRO'))?.click());
  await page.waitForSelector('.modal');
  const labels = await page.evaluate(() => [...document.querySelector('.modal').querySelectorAll('label')].map(l => l.textContent.trim()));
  const hints = await page.evaluate(() => document.querySelector('.modal').innerText);
  await topClick(page, ['Save']);
  await page.waitForTimeout(500);
  const kept = await page.evaluate(() => window.JINNYFIN.DB.accounts.find(x => x.name === 'Fed Bank NRO')?.stated_balance);
  await ctx.close();
  if (labels.some(l => /Bank says/i.test(l))) throw new Error('the Bank says box is still on the account sheet');
  if (/60 days|does not already carry it/.test(hints)) throw new Error('an account-sheet hint is back');
  if (kept !== 12345.67) throw new Error(`saving the account changed the reconciled figure to ${kept}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'no Bank says box, no hints, 12,345.67 kept after Save';
});

// --------------------------------------- 2.3: statement, chart, payees --
test('PC statement: Time and From / To columns, in the CSV too — the phone list stays as it was', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  // Tie one Fed Bank NRI transfer to a partner on Cash at Home, as if fixed.
  const seed = await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    const out = DB.transactions.find(t => t.account === 'Fed Bank NRI' && t.type === 'Transfer' && !t.transfer_group && +t.expense > 0);
    const back = DB.transactions.find(t => t.account === 'Fed Bank NRI' && t.type === 'Transfer' && !t.transfer_group && +t.income > 0);
    await S.putMany('transactions', [
      { ...out, transfer_group: 'grp-st-1', time: '14:05' },
      { ...out, id: 'tx-st-in', no: 990101, account: 'Cash at Home', currency: 'INR', income: out.expense, expense: 0, transfer_group: 'grp-st-1', to_account: null },
      { ...back, transfer_group: 'grp-st-2', time: '09:30' },
      { ...back, id: 'tx-st-out', no: 990102, account: 'Fed Bank NRO', currency: 'INR', income: 0, expense: back.income, transfer_group: 'grp-st-2', to_account: 'Fed Bank NRI' },
    ]);
    return { out: out.id, back: back.id };
  });
  await page.evaluate(() => window.JINNYFIN.go('statement?account=' + encodeURIComponent('Fed Bank NRI')));
  await page.waitForTimeout(900);
  const head = await page.evaluate(() => [...document.querySelectorAll('.stmt-table th')].map(th => th.textContent.trim()));
  const cells = await page.evaluate(() => [...document.querySelectorAll('.stmt-table tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim())));
  const find = pred => cells.find(pred);
  const outRow = find(c => c[1] === '2:05 PM'), inRow = find(c => c[1] === '9:30 AM');
  const loan = find(c => c[2].includes('Lend') && c[4] === 'Farooq');
  const loose = find(c => c[2].includes('Transfer') && c[4] === 'not linked');
  const phoneHasTime = await page.evaluate(() => /2:05 PM|→ Cash at Home/.test(document.querySelector('.stmt-list')?.textContent || ''));
  const [dl] = await Promise.all([page.waitForEvent('download'),
    page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '⬇ CSV')?.click())]);
  const csv = readFileSync(await dl.path(), 'utf8');
  await ctx.close();
  const want = ['Date', 'Time', 'Type', 'Category', 'From / To', 'Description', 'In', 'Out', 'Balance'];
  if (head.join('|') !== want.join('|')) throw new Error(`columns: ${head.join(', ')}`);
  if (!outRow || outRow[4] !== '→ Cash at Home') throw new Error(`money that left: ${JSON.stringify(outRow)}`);
  if (!inRow || inRow[4] !== '← Fed Bank NRO') throw new Error(`money that arrived: ${JSON.stringify(inRow)}`);
  if (!loan) throw new Error('a Lend/Borrow row does not show its payee');
  if (!loose) throw new Error('an unlinked transfer is not marked "not linked"');
  if (phoneHasTime) throw new Error('the phone list picked up the PC-only detail');
  if (!/Date,Time,Type,Category,Sub,From \/ To,Description,In,Out,Balance/.test(csv.replace(/"/g, ''))) throw new Error('the CSV header lacks Time / From / To');
  if (!/2:05 PM.*To Cash at Home/.test(csv.replace(/"/g, ''))) throw new Error('the CSV row lacks the time or the other account');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return '2:05 PM → Cash at Home · 9:30 AM ← Fed Bank NRO · payee Farooq · "not linked" · CSV carries both';
});

test('Income vs Expense: one green and one red bar per year, per month once a year is picked', async browser => {
  const { ctx, page, errors } = await open(browser, 'incexp');
  const read = () => page.evaluate(() => {
    const svg = document.querySelector('.ie-chart svg');
    const labels = [...svg.querySelectorAll('text')].filter(t => t.getAttribute('text-anchor') === 'middle').map(t => t.textContent);
    const fills = [...svg.querySelectorAll('rect')].map(r => r.getAttribute('fill'));
    return { labels, bars: fills.length, colours: [...new Set(fills)].length,
      title: document.querySelector('.ie-chart')?.closest('.card')?.querySelector('h3')?.textContent };
  });
  const sums = (f, by) => page.evaluate(async ([f, by]) => {
    const C = await import('/js/calc.js');
    const rows = C.incExpByPeriod(f, by);
    const tot = C.incomeVsExpense(f);
    return { n: rows.length, inc: rows.reduce((s, r) => s + r.income, 0), exp: rows.reduce((s, r) => s + r.expense, 0),
      kInc: tot.income.equiv, kExp: tot.expense.equiv };
  }, [f, by]);
  await page.selectOption('select[data-fk="year"]', 'All'); await page.waitForTimeout(700);
  const all = { chart: await read(), sum: await sums({}, 'year') };
  const year = await page.evaluate(() => [...document.querySelectorAll('select[data-fk="year"] option')].map(o => o.value).filter(v => v !== 'All').sort().pop());
  if (!year) { const h = await page.evaluate(() => document.querySelector('select[data-fk="year"]')?.outerHTML.slice(0, 300)); await ctx.close(); throw new Error('no year to pick: ' + h); }
  await page.selectOption('select[data-fk="year"]', year); await page.waitForTimeout(700);
  const yr = await read();
  await page.selectOption('select[data-fk="month"]', '3'); await page.waitForTimeout(700);
  const mon = await read();
  // A From–To range: its months, or its years once it runs past two years.
  const range = async (a, b) => {
    await page.locator('input[data-dk="from"]').fill(a);
    await page.locator('input[data-dk="to"]').fill(b);
    await page.locator('[data-fk="account"] input').click();      // leaving the date box commits it
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    return read();
  };
  const short = await range('2025-01-01', '2025-03-31');
  const long = await range('2019-01-01', '2025-12-31');
  await ctx.close();
  if (short.labels.join(',') !== 'Jan,Feb,Mar') throw new Error(`a three-month range: ${JSON.stringify(short)}`);
  if (long.labels[0] !== '2019' || long.labels.at(-1) !== '2025') throw new Error(`a seven-year range: ${JSON.stringify(long)}`);
  if (all.chart.labels.length !== all.sum.n || all.chart.bars !== 2 * all.sum.n) throw new Error(`all years: ${JSON.stringify(all)}`);
  if (all.chart.colours !== 2) throw new Error('the bars are not two colours');
  if (Math.abs(all.sum.inc - all.sum.kInc) > 1 || Math.abs(all.sum.exp - all.sum.kExp) > 1) throw new Error(`the chart does not add up to the totals: ${JSON.stringify(all.sum)}`);
  if (yr.labels.join(',') !== 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec' || yr.bars !== 24) throw new Error(`${year}: ${JSON.stringify(yr)}`);
  if (mon.labels.length !== 12) throw new Error(`with a month picked: ${JSON.stringify(mon)}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${all.sum.n} years × 2 bars, adding up to the totals; ${year}: Jan–Dec × 2; a month picked keeps the year`;
});

test('Income vs Expense on a phone: Group by and Sort show every button', async browser => {
  const { ctx, page, errors } = await open(browser, 'incexp');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => [...document.querySelectorAll('#main .filters .seg')].map(s => ({
    hidden: s.scrollWidth - s.clientWidth, right: Math.round(s.getBoundingClientRect().right) })));
  await ctx.close();
  if (r.length !== 2) throw new Error(`found ${r.length} button rows`);
  if (r.some(x => x.hidden > 1 || x.right > 390)) throw new Error(`buttons cut off: ${JSON.stringify(r)}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'Category · Sub · Account and Biggest · A–Z all in view at 390px';
});

test('Lend / Borrow: nameless entries can be found and named, and no new one can be saved without a payee', async browser => {
  const { ctx, page, errors } = await open(browser, 'payee');
  const count = () => page.evaluate(() => window.JINNYFIN.DB.transactions.filter(t => t.type === 'Lend/Borrow' && !t.payee).length);
  const before = await count();
  const link = await page.evaluate(() => [...document.querySelectorAll('#main a')].find(a => a.textContent.trim() === 'Show them')?.getAttribute('href'));
  await page.evaluate(() => [...document.querySelectorAll('#main a')].find(a => a.textContent.trim() === 'Show them')?.click());
  await page.waitForTimeout(900);
  const group = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#main .card')].find(x => /no payee/i.test(x.querySelector('h3')?.textContent || ''));
    return c ? { rows: c.querySelectorAll('.check-row').length, chip: c.querySelector('.chip')?.textContent } : null;
  });
  // A new Lend/Borrow with no payee is refused.
  await page.evaluate(() => window.JINNYFIN.openTxEditor(null, { type: 'Lend/Borrow' }));
  await page.waitForSelector('.modal');
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === 'Lend/Borrow' || b.textContent.includes('Lend/'))?.click());
  await page.locator('.modal input[inputmode="decimal"], .modal .amount-in input').first().fill('500');
  const saved0 = await page.evaluate(() => window.JINNYFIN.DB.transactions.length);
  await topClick(page, ['Save']);
  await page.waitForTimeout(500);
  const refused = { still: await page.evaluate(() => document.querySelectorAll('.modal').length), n: await page.evaluate(() => window.JINNYFIN.DB.transactions.length),
    focus: await page.evaluate(() => document.activeElement?.getAttribute('placeholder')) };
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  // Naming them all makes the group and the alert go away.
  await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    await S.putMany('transactions', DB.transactions.filter(t => t.type === 'Lend/Borrow' && !t.payee).map(t => ({ ...t, payee: 'Test Friend' })));
  });
  await page.evaluate(() => window.JINNYFIN.go('settings?tab=check')); await page.waitForTimeout(700);
  const groupAfter = await page.evaluate(() => [...document.querySelectorAll('#main .card h3')].some(h => /no payee/i.test(h.textContent)));
  await page.evaluate(() => window.JINNYFIN.go('payee')); await page.waitForTimeout(700);
  const alertAfter = await page.evaluate(() => [...document.querySelectorAll('#main a')].some(a => a.textContent.trim() === 'Show them'));
  await ctx.close();
  if (!before) throw new Error('the fixture has no nameless entries to test with');
  if (link !== '#/settings?tab=check') throw new Error(`the alert links to ${link}`);
  if (!group || group.chip !== `${before} to look at`) throw new Error(`Data check group: ${JSON.stringify(group)} (want ${before})`);
  if (!refused.still || refused.n !== saved0 || refused.focus !== 'Who?') throw new Error(`saved without a payee: ${JSON.stringify(refused)}`);
  if (groupAfter || alertAfter) throw new Error('named entries still flagged');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${before} nameless → listed in Data check; save refused with the cursor on Payee; all named → both gone`;
});

test('Income vs Expense: the Account box keeps a From–To range, and Tab moves on', async browser => {
  const { ctx, page, errors } = await open(browser, 'incexp');
  const from = page.locator('input[data-dk="from"]');
  await from.fill('2024-01-01');
  await page.locator('[data-fk="account"] input').click();          // leaving the date box commits it
  await page.waitForTimeout(300);
  await page.keyboard.type('Rajhi');
  await tab(page);
  const r = { from: await from.inputValue(), shows: await boxShows(page, 'account'), at: await focusLabel(page),
    label: await page.evaluate(() => document.querySelector('#main .small.muted')?.textContent || '') };
  await ctx.close();
  if (r.shows !== 'Al Rajhi') throw new Error(`the Account box reads "${r.shows}"`);
  if (r.from !== '2024-01-01' || !r.label.startsWith('01-01-2024')) throw new Error(`picking an account wiped the range: ${JSON.stringify(r)}`);
  if (r.at !== 'Group by') throw new Error(`Tab went to "${r.at}"`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'range kept, Al Rajhi picked, cursor on Group by';
});

test('New Transaction: tabbing THROUGH the Account box leaves the account alone', async browser => {
  // 1.59 made Tab pick the lit entry — and on focus the lit entry was simply
  // the first in the list, so merely tabbing across put that account on the row.
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.openTxEditor(null, { account: 'Fed Bank NRO' }));
  await page.waitForTimeout(500);
  const acct = page.locator('.modal-body .field .combo input').first();
  const before = await acct.inputValue();
  await tab(page); await tab(page);                       // Amount → Account → Date
  const after = await acct.inputValue();
  const at = await focusLabel(page);
  await ctx.close();
  if (!before.startsWith('Fed Bank NRO')) throw new Error(`the preset did not apply: "${before}"`);
  if (after !== before) throw new Error(`tabbing through changed the account to "${after}"`);
  if (at !== 'Date') throw new Error(`two Tabs from Amount landed on "${at}"`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `"${after}" untouched`;
});

test('New Transaction Account box: arrow + Tab picks, typing + clicking away picks, Escape shuts only the list', async browser => {
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.openTxEditor(null, { account: 'Al Rajhi' }));
  await page.waitForTimeout(500);
  const acct = page.locator('.modal-body .field .combo input').first();
  await acct.click();
  await page.keyboard.press('ArrowDown');
  const lit = await page.evaluate(() => document.querySelector('.combo-opt.hi')?.textContent || '');
  await tab(page);
  const arrowed = await acct.inputValue();

  await acct.click();
  await page.keyboard.type('NRO');
  await page.locator('.modal-body input[placeholder="Description"]').click();
  await page.waitForTimeout(250);
  const clicked = await acct.inputValue();

  await acct.click();
  await page.waitForTimeout(150);
  const opened = await listOpen(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const sheetAfterEsc = await page.evaluate(() => !!document.querySelector('.modal-wrap'));
  const listAfterEsc = await listOpen(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const sheetAfter2 = await page.evaluate(() => !!document.querySelector('.modal-wrap'));
  await ctx.close();
  if (!lit || lit.startsWith('Al Rajhi')) throw new Error(`↓ from Al Rajhi lit "${lit}" — the list should open on the current one`);
  if (arrowed !== lit) throw new Error(`↓ then Tab left "${arrowed}", expected "${lit}"`);
  if (clicked !== 'Fed Bank NRO · INR') throw new Error(`typing "NRO" and clicking away left "${clicked}"`);
  if (!opened) throw new Error('the list did not open on focus');
  if (!sheetAfterEsc || listAfterEsc) throw new Error(`Escape with the list open: sheet ${sheetAfterEsc}, list ${listAfterEsc}`);
  if (sheetAfter2) throw new Error('with the list closed, Escape should close the sheet as before');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `↓+Tab → ${arrowed}; "NRO"+click → ${clicked}; Esc closes list, then sheet`;
});

test('the budget Category box finds a category by any word, and Tab moves on', async browser => {
  const { ctx, page, errors } = await open(browser, 'budgets');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /\+ Budget/.test(b.textContent))?.click());
  await page.waitForTimeout(400);
  const box = page.locator('.modal-body .combo input').first();
  await box.click();
  await page.keyboard.type('Transport');
  await tab(page);
  const r = { shows: await box.inputValue(), value: await page.evaluate(() => document.querySelector('.modal-body .combo')?.value),
    at: await focusLabel(page) };
  await ctx.close();
  if (r.value !== 'Auto & Transport' || r.shows !== 'Auto & Transport') throw new Error(`"Transport" gave ${JSON.stringify(r)}`);
  if (r.at !== 'Sub-category') throw new Error(`Tab went to "${r.at}"`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return '"Transport" → Auto & Transport, cursor on Sub-category';
});

test('a filter changed on one screen does not pull the cursor into the next screen', async browser => {
  const { ctx, page, errors } = await open(browser, 'transactions');
  const years = await page.evaluate(() => [...document.querySelector('select[data-fk="year"]').options].map(o => o.value));
  await page.selectOption('select[data-fk="year"]', years[1]);
  await page.waitForTimeout(250);
  await page.evaluate(() => window.JINNYFIN.go('dashboard'));
  await page.waitForTimeout(700);
  const where = await page.evaluate(() => ({ tag: document.activeElement?.tagName, fk: document.activeElement?.dataset?.fk || '' }));
  await ctx.close();
  if (where.tag === 'SELECT' || where.tag === 'INPUT') throw new Error(`the dashboard opened with the cursor in its ${where.fk || where.tag} box`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'dashboard opened with nothing focused';
});

test('leaving a changed date box for the next one lands there, not back in the same one', async browser => {
  // Statement rebuilds its bar on every change; the cursor used to be handed
  // back to the box Tab had just left.
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.go('statement?account=' + encodeURIComponent('Al Rajhi')));
  await page.waitForTimeout(700);
  // As Safari and the iPhone do it: the date box says nothing until it is
  // left, so the change lands on leaving it — and redraws the bar.
  await page.locator('input[data-dk="from"]').focus();
  await page.evaluate(() => { document.querySelector('input[data-dk="from"]').value = '2024-01-01'; });
  // Tab inside a date box walks its day/month/year parts first, so move on
  // the way the last Tab does: straight to the To box.
  await page.locator('input[data-dk="to"]').focus();
  await page.waitForTimeout(400);
  const where = await page.evaluate(() => ({ dk: document.activeElement?.dataset?.dk || '', tag: document.activeElement?.tagName,
    from: document.querySelector('input[data-dk="from"]')?.value }));
  await ctx.close();
  if (where.from !== '2024-01-01') throw new Error(`the date did not take: ${where.from}`);
  if (where.dk !== 'to') throw new Error(`moving from From to To landed on ${where.dk || where.tag}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'From → To, after the redraw';
});

// ---- insurance & documents (2.1) -------------------------------------------
/**
 * Fictional policies and past premiums, dated from today so the checks mean the
 * same thing whenever they run. Mirrors the owner's real situation without any
 * of his data: one card per sub-category, one entry filed under the wrong one
 * (Shield's premium under Accident Cover), a monthly subscription paid by
 * someone else, and a sub-category with payments but no card.
 */
const seedInsurance = page => page.evaluate(async () => {
  const { S } = window.JINNYFIN;
  const C = await import('/js/calc.js');
  const U = await import('/js/util.js');
  const today = U.todayISO();
  const day = n => U.addDays(today, n);
  const subs = ['Car Insurance', 'Health Insurance', 'Accident Cover', 'Shield Raksha', 'Micro Cover', 'Welfare Fund'];
  await S.putMany('categories', subs.map(sub => ({ id: 'ins-cat-' + sub.replace(/\W/g, ''), type: 'Expense', parent: 'Insurance', sub, active: true })));
  let no = 900000;
  const tx = (id, date, sub, amt, note, account = 'Fed Bank NRI') => ({ id, no: ++no, date, time: '10:00', type: 'Expense',
    account, currency: C.currencyOf(account) || 'INR', income: 0, expense: amt, parent: 'Insurance', sub, note, fx: C.fxFor(date),
    transfer_group: null, to_account: null, payee: null, event: null });
  await S.putMany('transactions', [
    tx('ins-t-car', day(-350), 'Car Insurance', 3200, 'Sedan Co car policy renewed'),
    tx('ins-t-health', day(-355), 'Health Insurance', 22000, 'CarePlus health renewed upto next year'),
    tx('ins-t-acc', day(-130), 'Accident Cover', 865, 'SafeLife accident cover renewed'),
    tx('ins-t-shield', day(-200), 'Accident Cover', 661, 'Shield Raksha premium for the year', 'Cash at Home'),
    tx('ins-t-micro', day(-120), 'Micro Cover', 20, 'Micro cover yearly'),
    tx('ins-t-fund1', day(-40), 'Welfare Fund', 350, 'Fund office paid the monthly subscription'),
    tx('ins-t-fund2', day(-10), 'Welfare Fund', 350, 'Fund office paid the monthly subscription'),
  ]);
  const card = (id, label, policy, renewal, extra = {}) => ({ id, label, policy, policy_no: '', renewal_date: renewal,
    premium: 0, currency: 'INR', notify_days: 30, kind: 'insurance', note: '', files: [], ...extra });
  await S.putMany('insurance', [
    card('ins-c-car', 'Car', 'Sedan Co', day(105)),
    card('ins-c-health', 'Health', 'CarePlus', day(12)),
    card('ins-c-acc', 'Accident', 'SafeLife', day(230)),
    card('ins-c-shield', 'Shield', 'Shield Raksha', day(178)),
    card('ins-c-pass', 'Passport', 'Passport office', day(-41), { kind: 'document' }),
    card('ins-c-iqama', 'Iqama', 'Jawazat', day(23), { kind: 'document' }),
  ]);
  return { today };
});
const insPage = async page => { await page.evaluate(() => window.JINNYFIN.go('insurance')); await page.waitForTimeout(600); };
const card = (page, label) => page.evaluate(l => {
  const b = [...document.querySelectorAll('#main .card b')].find(x => x.textContent === l);
  return b ? b.closest('.card').textContent.replace(/\s+/g, ' ') : null;
}, label);
const clickIn = (page, label, text) => page.evaluate(([l, t]) => {
  const c = [...document.querySelectorAll('#main .card b')].find(x => x.textContent === l)?.closest('.card');
  const b = c && [...c.querySelectorAll('button, a')].find(x => x.textContent.trim().startsWith(t));
  if (b) b.click(); return !!b;
}, [label, text]);
const row = (page, id) => page.evaluate(i => window.JINNYFIN.DB.insurance.find(x => x.id === i), id);
const newTx = (page, before) => page.evaluate(ids => window.JINNYFIN.DB.transactions.filter(t => !ids.includes(t.id)), before);
const txIds = page => page.evaluate(() => window.JINNYFIN.DB.transactions.map(t => t.id));
const link = (page, id, sub, extra = {}) => page.evaluate(([i, s, x]) => {
  const r = window.JINNYFIN.DB.insurance.find(y => y.id === i);
  return window.JINNYFIN.S.put('insurance', { ...r, parent: 'Insurance', sub: s, ...x });
}, [id, sub, extra]);

test('terms add up by the calendar: 29 Feb, month ends, years and months together', async browser => {
  const { ctx, page } = await open(browser, 'dashboard');
  const r = await page.evaluate(async () => {
    const C = await import('/js/calc.js');
    return [C.addTerm('2024-02-29', 12), C.addTerm('2026-01-31', 1), C.addTerm('2026-10-03', -12),
      C.addTerm('2026-10-03', 18), C.addTerm('2026-12-15', 1), C.termLabel(18), C.termLabel(0), C.termOf({}), C.termOf({ term_months: 0 })];
  });
  await ctx.close();
  const want = ['2025-02-28', '2026-02-28', '2025-10-03', '2028-04-03', '2027-01-15', '1 year 6 months', null, 12, 0];
  if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(`got ${JSON.stringify(r)}, want ${JSON.stringify(want)}`);
  return want.slice(0, 5).join(' · ');
});

test('insurance: the link screen suggests each policy its own sub, and offers the misfiled entry', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  await seedInsurance(page);
  await insPage(page);
  const banner = await page.evaluate(() => [...document.querySelectorAll('#main .alert')].map(a => a.textContent).join(' | '));
  await page.evaluate(() => [...document.querySelectorAll('#main button')].find(b => b.textContent.trim() === 'Link them')?.click());
  await page.waitForTimeout(400);
  const picks = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.modal .link-row')].map(r =>
    [r.querySelector('b').textContent, r.querySelector('.combo').value])));
  const offer = await page.evaluate(() => [...document.querySelectorAll('.modal .link-moves label')].map(l => l.textContent));
  const loose = await page.evaluate(() => [...document.querySelectorAll('.modal h4 ~ .row')].map(r => r.textContent));
  // take the offered move, keep the "use the last payment" ticks
  await page.evaluate(() => document.querySelector('.modal .link-moves input')?.click());
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Save links')?.click());
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    cards: Object.fromEntries(window.JINNYFIN.DB.insurance.filter(p => p.kind !== 'document').map(p => [p.label, [p.parent, p.sub, p.premium, p.pay_account, p.last_paid ? 'paid' : '']])),
    shieldEntry: window.JINNYFIN.DB.transactions.find(t => t.id === 'ins-t-shield')?.sub,
  }));
  const shieldCard = await card(page, 'Shield');
  await ctx.close();
  if (!/4 policies are not linked/.test(banner)) throw new Error(`no banner for the unlinked policies: ${banner}`);
  const want = { Car: 'Car Insurance', Health: 'Health Insurance', Accident: 'Accident Cover', Shield: 'Shield Raksha' };
  for (const [k, v] of Object.entries(want)) if (picks[k] !== v) throw new Error(`${k} was offered “${picks[k]}”, expected “${v}”`);
  if (offer.length !== 1 || !/Shield Raksha premium/.test(offer[0])) throw new Error(`move offer: ${JSON.stringify(offer)}`);
  if (!loose.some(t => t.includes('Micro Cover')) || !loose.some(t => t.includes('Welfare Fund')))
    throw new Error(`sub-categories with payments but no card were not listed: ${JSON.stringify(loose)}`);
  if (after.shieldEntry !== 'Shield Raksha') throw new Error(`the ticked entry was not moved: ${after.shieldEntry}`);
  const h = after.cards.Health;
  if (h[0] !== 'Insurance' || h[1] !== 'Health Insurance' || h[2] !== 22000 || h[3] !== 'Fed Bank NRI' || h[4] !== 'paid')
    throw new Error(`Health after linking: ${JSON.stringify(h)}`);
  if (after.cards.Shield[2] !== 661 || after.cards.Shield[3] !== 'Cash at Home') throw new Error(`Shield did not take the moved payment: ${JSON.stringify(after.cards.Shield)}`);
  if (!/Insurance › Shield Raksha/.test(shieldCard) || !/History \(1\)/.test(shieldCard)) throw new Error(`Shield card: ${shieldCard}`);
  if (/Mark renewed/.test(shieldCard)) throw new Error('an old payment was offered as a new renewal');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'four right suggestions, one move offered and made, premiums filled, loose subs listed';
});

test('Renew files one Expense entry under the card’s sub and moves the date by its term — and Undo takes both back', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  const { today } = await seedInsurance(page);
  await link(page, 'ins-c-health', 'Health Insurance', { premium: 22000, currency: 'INR', pay_account: 'Fed Bank NRI' });
  await insPage(page);
  const before = await txIds(page);
  const old = (await row(page, 'ins-c-health')).renewal_date;
  if (!(await clickIn(page, 'Health', '↻ Renew'))) { await ctx.close(); throw new Error('no Renew button on a card 12 days from due'); }
  await page.waitForTimeout(400);
  const sheet = await page.evaluate(() => ({
    date: document.querySelector('.modal input[type=date]')?.value,
    note: [...document.querySelectorAll('.modal input')].find(i => /renewed upto/.test(i.value))?.value || '',
    amount: document.querySelector('.modal input[type=number]')?.value,
  }));
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Renew')?.click());
  await page.waitForTimeout(500);
  const added = await newTx(page, before);
  const cardNow = await row(page, 'ins-c-health');
  const shown = await card(page, 'Health');
  await page.evaluate(() => [...document.querySelectorAll('.toast-action')].pop()?.click());
  await page.waitForTimeout(500);
  const undone = { added: (await newTx(page, before)).length, date: (await row(page, 'ins-c-health')).renewal_date };
  await ctx.close();
  const C = { addTerm: (d, n) => { const [y, m, dd] = d.split('-').map(Number); const t = y * 12 + m - 1 + n;
    const ny = Math.floor(t / 12), nm = t - ny * 12 + 1; const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`; } };
  const want = C.addTerm(old, 12);
  if (sheet.date !== want) throw new Error(`the sheet offered ${sheet.date}, expected ${want}`);
  if (!sheet.note.includes('Health (CarePlus) renewed upto')) throw new Error(`description: “${sheet.note}”`);
  if (sheet.amount !== '22000') throw new Error(`amount started at ${sheet.amount}`);
  if (added.length !== 1) throw new Error(`${added.length} entries written, expected exactly 1`);
  const t = added[0];
  const bad = Object.entries({ type: 'Expense', parent: 'Insurance', sub: 'Health Insurance', expense: 22000, account: 'Fed Bank NRI',
    currency: 'INR', date: today, income: 0 }).filter(([k, v]) => t[k] !== v);
  if (bad.length) throw new Error(`the entry is wrong: ${bad.map(([k, v]) => `${k}=${t[k]} (want ${v})`).join(', ')}`);
  if (cardNow.renewal_date !== want || cardNow.last_paid !== today) throw new Error(`card after renew: ${cardNow.renewal_date} / ${cardNow.last_paid}`);
  if (!/✓/.test(shown) || /↻ Renew/.test(shown)) throw new Error(`card still looks due: ${shown}`);
  if (undone.added !== 0 || undone.date !== old) throw new Error(`Undo left ${undone.added} entries and date ${undone.date}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${old} → ${want}, one ₹22,000 entry under Insurance › Health Insurance; Undo reverted both`;
});

test('Renew without recording writes nothing; renewing again within 30 days asks first', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  await seedInsurance(page);
  await link(page, 'ins-c-health', 'Health Insurance', { premium: 22000, currency: 'INR', pay_account: 'Fed Bank NRI' });
  await insPage(page);
  const before = await txIds(page);
  await clickIn(page, 'Health', '↻ Renew');
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('.modal label')].find(l => /Record the premium/.test(l.textContent))?.querySelector('input').click());
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Renew')?.click());
  await page.waitForTimeout(500);
  const added = (await newTx(page, before)).length;
  // open it again straight away from the edit sheet
  await page.evaluate(() => [...document.querySelectorAll('#main .card b')].find(x => x.textContent === 'Health')?.click());
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Renew'))?.click());
  await page.waitForTimeout(500);
  const asked = await page.evaluate(() => [...document.querySelectorAll('.modal')].pop()?.textContent || '');
  await ctx.close();
  if (added) throw new Error(`${added} entries written with the tick off`);
  if (!/already renewed on/.test(asked)) throw new Error(`a second renew was not questioned: ${asked.slice(0, 120)}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'tick off → no entry; second press → “already renewed on …”';
});

test('a card that follows its payments is due a term after the last one, and saves that date', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  const { today } = await seedInsurance(page);
  await page.evaluate(() => window.JINNYFIN.S.put('insurance', { id: 'ins-c-fund', label: 'Welfare fund', policy: 'Paid by the fund office',
    renewal_date: '2020-01-01', premium: 350, currency: 'INR', notify_days: 7, kind: 'insurance', parent: 'Insurance',
    sub: 'Welfare Fund', term_months: 1, due_mode: 'payments', reminders_off: true, files: [] }));
  await page.waitForTimeout(1500);                      // the roll runs a beat after the data settles
  await insPage(page);
  const saved = (await row(page, 'ins-c-fund')).renewal_date;
  const shown = await card(page, 'Welfare fund');
  const want = await page.evaluate(async t => (await import('/js/calc.js')).addTerm((await import('/js/util.js')).addDays(t, -10), 1), today);
  await ctx.close();
  if (saved !== want) throw new Error(`stored due date ${saved}, expected ${want} (last payment + 1 month)`);
  if (!/✓/.test(shown) || !/due date follows payments/.test(shown) || !/🔕 reminders off/.test(shown)) throw new Error(`card: ${shown}`);
  if (/↻ Renew/.test(shown)) throw new Error('a payment-following card offered Renew');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `due ${want}, saved on the card; ✓ with reminders off`;
});

test('reminders off: the card keeps its ⛔, but nothing else announces it', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  await seedInsurance(page);
  const pass = await row(page, 'ins-c-pass');
  await page.evaluate(r => window.JINNYFIN.S.put('insurance', { ...r, reminders_off: true }), pass);
  await insPage(page);
  const r = await page.evaluate(() => ({
    head: document.querySelector('#main .alert')?.textContent || '',
    expired: [...document.querySelectorAll('#main .stat')].find(k => /Already expired/i.test(k.textContent))?.querySelector('.value')?.textContent,
  }));
  const shown = await card(page, 'Passport');
  const alerts = await page.evaluate(async () => (await import('/js/alerts.js')).collect?.({ all: true })?.map(a => a.title) ?? null);
  await page.evaluate(() => window.JINNYFIN.go('dashboard'));
  await page.waitForTimeout(500);
  const dash = await page.evaluate(() => document.querySelector('#main')?.textContent || '');
  await ctx.close();
  if (/Passport/.test(r.head)) throw new Error(`the headline still names it: ${r.head}`);
  if (r.expired !== '0') throw new Error(`still counted as expired: ${r.expired}`);
  if (!/⛔/.test(shown) || !/🔕 reminders off/.test(shown)) throw new Error(`card lost its mark: ${shown}`);
  if (alerts && alerts.some(t => /Passport/.test(t))) throw new Error(`still in the reminders: ${alerts.join(' | ')}`);
  if (/EXPIRED: Passport/.test(dash)) throw new Error('the dashboard still announces it');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'headline, count, reminders and dashboard quiet; card shows ⛔ 🔕';
});

test('a premium entered through New Transaction offers to mark the card renewed, and records nothing new', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  const { today } = await seedInsurance(page);
  await link(page, 'ins-c-health', 'Health Insurance', { premium: 22000, currency: 'INR', pay_account: 'Fed Bank NRI', last_paid: '2020-01-01' });
  await page.evaluate(async t => {
    const C = await import('/js/calc.js');
    await window.JINNYFIN.S.put('transactions', { id: 'ins-t-health-new', no: 999999, date: t, time: '09:00', type: 'Expense',
      account: 'Fed Bank NRI', currency: 'INR', income: 0, expense: 23000, parent: 'Insurance', sub: 'Health Insurance',
      note: 'paid at the branch', fx: C.fxFor(t) });
  }, today);
  await insPage(page);
  const offered = await card(page, 'Health');
  const before = await txIds(page);
  await clickIn(page, 'Health', 'Mark renewed');
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Renew')?.click());
  await page.waitForTimeout(500);
  const r = await row(page, 'ins-c-health');
  const added = (await newTx(page, before)).length;
  const shown = await card(page, 'Health');
  await ctx.close();
  if (!/₹23,000.00 paid on/.test(offered)) throw new Error(`no offer on the card: ${offered}`);
  if (added) throw new Error(`${added} new entries — the payment was already in the ledger`);
  if (r.last_paid !== today) throw new Error(`last paid ${r.last_paid}`);
  if (/Mark renewed/.test(shown)) throw new Error('the offer stayed after it was taken');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `offer shown, date moved to ${r.renewal_date}, no duplicate entry`;
});

test('Renew paying from an account in another currency re-states the amount', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  await seedInsurance(page);
  await link(page, 'ins-c-health', 'Health Insurance', { premium: 22000, currency: 'INR', pay_account: 'Fed Bank NRI' });
  await insPage(page);
  await clickIn(page, 'Health', '↻ Renew');
  await page.waitForTimeout(400);
  const acct = page.locator('.modal .field').filter({ hasText: 'Paid from' }).locator('.combo input');
  await acct.click();
  await page.keyboard.type('Rajhi');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ amount: +document.querySelector('.modal input[type=number]').value,
    hint: document.querySelector('.modal .hint:not(:empty)')?.textContent || '', tag: [...document.querySelectorAll('.modal .small.muted')].map(x => x.textContent).join(' ') }));
  const expect = await page.evaluate(async () => (await import('/js/calc.js')).convertAmount(22000, 'INR', 'SAR', (await import('/js/util.js')).todayISO()));
  await ctx.close();
  if (Math.abs(r.amount - Math.round(expect * 100) / 100) > 0.01) throw new Error(`amount ${r.amount}, expected about ${expect}`);
  if (!/SAR/.test(r.tag)) throw new Error('the amount does not say SAR');
  if (!/is about/.test(r.hint)) throw new Error(`no conversion note: ${r.hint}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `₹22,000 → SR ${r.amount}`;
});

test('the card sheet keeps Pay from, links a new sub it creates, and refuses a sub another card has', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  await seedInsurance(page);
  await link(page, 'ins-c-acc', 'Accident Cover');
  await insPage(page);
  const openCard = l => page.evaluate(x => [...document.querySelectorAll('#main .card b')].find(b => b.textContent === x)?.click(), l);
  const boxIn = label => page.locator('.modal .field').filter({ hasText: label }).locator('.combo input').first();
  await openCard('Shield'); await page.waitForTimeout(400);
  await boxIn('Pay from').click(); await page.keyboard.type('Home'); await page.keyboard.press('Tab');
  await boxIn('Expense category').click(); await page.keyboard.type('Insurance'); await page.keyboard.press('Tab');
  await page.keyboard.type('Shield Plus'); await page.waitForTimeout(150);
  const offered = await page.evaluate(() => document.querySelector('.combo-list:not([hidden]) .combo-opt.hi')?.textContent || '');
  await page.keyboard.press('Tab');
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Save')?.click());
  await page.waitForTimeout(400);
  const asked = await page.evaluate(() => [...document.querySelectorAll('.modal')].pop()?.textContent || '');
  await topClick(page, ['Add it']);
  await page.waitForTimeout(500);
  const saved = await row(page, 'ins-c-shield');
  const cat = await page.evaluate(() => window.JINNYFIN.DB.categories.some(c => c.type === 'Expense' && c.parent === 'Insurance' && c.sub === 'Shield Plus'));
  // Car tries to take Accident's sub
  await openCard('Car'); await page.waitForTimeout(400);
  await boxIn('Expense category').click(); await page.keyboard.type('Insurance'); await page.keyboard.press('Tab');
  await page.keyboard.type('Accident Cover'); await page.keyboard.press('Tab');
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Save')?.click());
  await page.waitForTimeout(400);
  const refused = await page.evaluate(() => ({ toast: document.querySelector('#toasts')?.textContent || '', open: !!document.querySelector('.modal') }));
  const car = await row(page, 'ins-c-car');
  await ctx.close();
  if (offered !== '＋ Add “Shield Plus”') throw new Error(`typing a new name lit “${offered}”`);
  if (!/Add the sub-category “Shield Plus” under Insurance/.test(asked)) throw new Error(`no question before creating it: ${asked.slice(0, 100)}`);
  if (saved.pay_account !== 'Cash at Home' || saved.sub !== 'Shield Plus' || saved.parent !== 'Insurance') throw new Error(`saved ${JSON.stringify([saved.pay_account, saved.parent, saved.sub])}`);
  if (!cat) throw new Error('the new sub-category was not created');
  if (!/Accident.*already uses/.test(refused.toast) || !refused.open || car.sub) throw new Error(`a second card took the same sub: ${refused.toast} / ${car.sub}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'Pay from kept; “Shield Plus” created after asking; Car refused Accident’s sub';
});

test('Renews every: years and months together, and no fixed term asks for the date', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  await seedInsurance(page);
  const iq = await row(page, 'ins-c-iqama'), pass = await row(page, 'ins-c-pass');
  await page.evaluate(([a, b]) => window.JINNYFIN.S.putMany('insurance', [{ ...a, term_months: 18 }, { ...b, term_months: 0 }]), [iq, pass]);
  await insPage(page);
  await clickIn(page, 'Iqama', '↻ Renew'); await page.waitForTimeout(400);
  const d18 = await page.evaluate(() => document.querySelector('.modal input[type=date]').value);
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await clickIn(page, 'Passport', '↻ Renew'); await page.waitForTimeout(400);
  const d0 = await page.evaluate(() => document.querySelector('.modal input[type=date]').value);
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Renew')?.click());
  await page.waitForTimeout(300);
  const refused = await page.evaluate(() => ({ open: !!document.querySelector('.modal'), toast: document.querySelector('#toasts')?.textContent || '' }));
  const card18 = await card(page, 'Iqama');
  await ctx.close();
  const want = await (async () => { const [y, m, d] = iq.renewal_date.split('-').map(Number); const t = y * 12 + m - 1 + 18; const ny = Math.floor(t / 12), nm = t - ny * 12 + 1;
    return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, new Date(Date.UTC(ny, nm, 0)).getUTCDate())).padStart(2, '0')}`; })();
  if (d18 !== want) throw new Error(`18 months from ${iq.renewal_date} was offered as ${d18}, expected ${want}`);
  if (d0 !== '') throw new Error(`a card with no fixed term suggested ${d0}`);
  if (!refused.open || !/Set the new date/.test(refused.toast)) throw new Error('renewed with no date');
  if (!/every 1 year 6 months/.test(card18)) throw new Error(`card: ${card18}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `+18 months → ${d18}; no fixed term → date required`;
});

test('History on a card opens the Expense Report on that sub, every year', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  await seedInsurance(page);
  await link(page, 'ins-c-car', 'Car Insurance');
  await insPage(page);
  await clickIn(page, 'Car', 'History');
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => ({ head: document.querySelector('.jf-bd h3')?.textContent, year: document.querySelector('[data-fk="year"]')?.value,
    sub: document.querySelector('[data-fk="sub"] input')?.value, hash: location.hash }));
  await ctx.close();
  if (r.head !== 'Inside Car Insurance' || r.year !== 'All' || r.sub !== 'Car Insurance') throw new Error(`landed on ${JSON.stringify(r)}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${r.hash}`;
});

test('renaming a category or sub also moves the budgets, business setups and cards that name it', async browser => {
  const { ctx, page, errors } = await open(browser, 'settings');
  await seedInsurance(page);
  await link(page, 'ins-c-health', 'Health Insurance');
  await page.evaluate(() => window.JINNYFIN.S.put('budgets', { id: 'b-health', parent: 'Insurance', sub: 'Health Insurance', amount: 2000, currency: 'INR', period: 'monthly' }));
  await page.evaluate(() => window.JINNYFIN.go('settings'));
  await page.waitForTimeout(500);
  const goCats = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Categories')?.click());
  await goCats(); await page.waitForTimeout(400);
  // 1) the sub, through its chip
  await page.locator('input[data-fk="cat-search"]').fill('Health Insurance');
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('#main .chip')].find(c => c.textContent.startsWith('Health Insurance'))?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => { const i = [...document.querySelectorAll('.modal input')][1]; i.value = 'Family Health'; });
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Save')?.click());
  await page.waitForTimeout(500);
  const afterSub = await page.evaluate(() => ({ card: window.JINNYFIN.DB.insurance.find(x => x.id === 'ins-c-health').sub,
    budget: window.JINNYFIN.DB.budgets.find(x => x.id === 'b-health').sub }));
  // 2) a whole category that a business points at — the Expense one
  await page.locator('input[data-fk="cat-search"]').fill('');
  await page.waitForTimeout(400);
  const expenseCard = () => [...document.querySelectorAll('#main .card')].find(c => /Expense —/.test(c.querySelector('.card-head h3')?.textContent || ''));
  await page.evaluate(sel => { const c = eval(sel)(); if (c && !c.querySelector('b')) c.querySelector('.card-head').click(); }, `(${expenseCard})`);
  await page.waitForTimeout(400);
  const hit = await page.evaluate(sel => {
    const sec = eval(sel)();
    const b = sec && [...sec.querySelectorAll('b')].find(x => x.textContent.trim() === 'Cake Business');
    if (b) b.click(); return !!b;
  }, `(${expenseCard})`);
  if (!hit) { await ctx.close(); throw new Error('could not find the Expense “Cake Business” to rename'); }
  await page.waitForTimeout(300);
  await page.fill('.modal input[type=text]', 'Cake Plans');
  await page.click('.modal .btn.primary');
  await page.waitForTimeout(600);
  const biz = await page.evaluate(() => window.JINNYFIN.DB.businesses.find(b => b.id === 'biz-0611'));
  await ctx.close();
  if (afterSub.card !== 'Family Health' || afterSub.budget !== 'Family Health') throw new Error(`sub rename left ${JSON.stringify(afterSub)}`);
  if (biz.expense_parent !== 'Cake Plans' || biz.income_parent !== 'Cake Business')
    throw new Error(`the Expense rename should move only the expense side: ${biz.expense_parent} / ${biz.income_parent}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'sub → card + budget; Expense “Cake Business” → the business’s expense side';
});

test('deleting a sub-category an insurance card is linked to says so, and offers to archive instead', async browser => {
  const { ctx, page, errors } = await open(browser, 'settings');
  await seedInsurance(page);
  await link(page, 'ins-c-shield', 'Shield Raksha');
  await page.evaluate(() => window.JINNYFIN.go('settings'));
  await page.waitForTimeout(500);
  await page.evaluate(() => [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === 'Categories')?.click());
  await page.waitForTimeout(400);
  await page.locator('input[data-fk="cat-search"]').fill('Shield Raksha');
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('#main .chip')].find(c => c.textContent.startsWith('Shield Raksha'))?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Delete')?.click());
  await page.waitForTimeout(300);
  const asked = await page.evaluate(() => [...document.querySelectorAll('.modal')].pop()?.textContent || '');
  await topClick(page, ['Cancel']);
  await page.waitForTimeout(200);
  const still = await page.evaluate(() => window.JINNYFIN.DB.categories.some(c => c.parent === 'Insurance' && c.sub === 'Shield Raksha'));
  await ctx.close();
  if (!/1 insurance card/.test(asked) || !/Archive it/.test(asked)) throw new Error(`no warning about the card: ${asked.slice(0, 160)}`);
  if (!still) throw new Error('the sub-category was deleted anyway');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'warned: used by 1 insurance card; archive offered';
});

test('the server push skips cards whose reminders are off', async () => {
  // The phone is woken by the Edge Function, which reads the table itself —
  // muting only inside the app would still ring. It cannot run here (Deno),
  // so hold the rule in place: the check must stay in the policy loop.
  const src = readFileSync(join(ROOT, 'supabase/functions/jinnyfin-push/index.ts'), 'utf8');
  const loop = src.slice(src.indexOf("db.from('insurance')"), src.indexOf("db.from('cards')"));
  if (!/if \(p\.reminders_off\) continue;/.test(loop)) throw new Error('jinnyfin-push no longer skips muted cards');
  return 'reminders_off is checked in the policy loop';
});

test('the Annual premium counts a year of each premium, by its term', async browser => {
  const { ctx, page, errors } = await open(browser, 'dashboard');
  await seedInsurance(page);
  const h = await row(page, 'ins-c-health'), c = await row(page, 'ins-c-car');
  await page.evaluate(([a, b]) => window.JINNYFIN.S.putMany('insurance', [{ ...a, premium: 5828, currency: 'INR', term_months: 3 },
    { ...b, premium: 3200, currency: 'INR', term_months: 12 }]), [h, c]);
  await insPage(page);
  const v = await page.evaluate(() => [...document.querySelectorAll('#main .stat')].find(k => /Annual premium/i.test(k.textContent))?.querySelector('.value')?.textContent);
  await ctx.close();
  if (v !== '₹26,512') throw new Error(`annual premium ${v}, expected ₹26,512 (5,828 × 4 + 3,200)`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return v;
});

test('Investments & savings totals show deposits, returns, and value', async browser => {
  const { ctx, page } = await open(browser, 'networth');
  const fixture = await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    const parent = '__Net Worth Totals__';
    const account = DB.accounts.find(a => !a.deleted);
    if (!account) throw new Error('fixture has no account');
    await S.put('categories', { id: 'networth-category-total', type: 'Investment', parent, sub: null,
      active: true, deleted: false });
    const base = { date: '2026-09-09', time: '09:00', type: 'Investment', account: account.name,
      currency: account.currency || 'INR', fx: 1, parent, transfer_group: null, to_account: null,
      income: 0, expense: 0, note: '__networth_totals__' };
    await S.put('transactions', { ...base, id: 'networth-deposit-total', sub: 'Deposit', expense: 1000 });
    await S.put('transactions', { ...base, id: 'networth-return-total', sub: 'Interest/Return', income: 200 });
    return { parent };
  });
  await page.evaluate(() => window.JINNYFIN.go('networth'));
  await page.waitForTimeout(400);
  const cells = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')]
      .find(c => c.querySelector('h3')?.textContent.includes('Investments & savings'));
    return [...(card?.querySelector('tr.total')?.children || [])].map(c => c.textContent.trim());
  });
  await ctx.close();
  if (cells[0] !== 'TOTAL') throw new Error('Investments & savings total row is missing');
  if (cells[2] !== '1,000') throw new Error(`deposit total missing or wrong: ${cells[2] || 'blank'}`);
  if (cells[3] !== '200') throw new Error(`return total missing or wrong: ${cells[3] || 'blank'}`);
  if (cells[5] !== '1,200') throw new Error(`investment value total wrong: ${cells[5] || 'blank'}`);
  return 'deposits 1,000 · returns 200 · value 1,200';
});

test('a transfer changed to an expense takes its other half', async browser => {
  // Editing one side of a transfer into an Expense used to leave the other side
  // standing — the same money counted twice — and the converted row kept its
  // transfer_group, so deleting either one took both.
  const { ctx, page } = await open(browser, 'transactions');
  const accts = await page.evaluate(async () => {
    const { S, DB } = window.JINNYFIN;
    const a = DB.accounts[0].name, b = DB.accounts.find(x => x.currency === DB.accounts[0].currency && x.name !== DB.accounts[0].name).name;
    const base = { date: '2024-05-05', time: '10:00', type: 'Transfer', currency: DB.accounts[0].currency,
      fx: 20, parent: 'Transfer', transfer_group: 'grp-test-1', note: 'test pair' };
    await S.put('transactions', { ...base, id: 'tst-out', account: a, expense: 100, income: 0, to_account: b });
    await S.put('transactions', { ...base, id: 'tst-in', account: b, income: 100, expense: 0 });
    return { a, b };
  });

  // Now do it the way a person does: open the row, press Expense, name a
  // category, press Update, and say yes to whatever it asks.
  page.on('dialog', d => d.accept());
  await page.evaluate(() => window.JINNYFIN.openTxEditor(
    window.JINNYFIN.DB.transactions.find(t => t.id === 'tst-out')));
  await page.waitForTimeout(500);
  await page.click('.type-pick button[data-ty="Expense"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.modal input')];
    const parent = inputs.find(i => i.getAttribute('list')?.includes('parent') || i.placeholder === 'Category')
      || inputs.find(i => i.getAttribute('list'));
    parent.value = 'Business Loss';
    parent.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await topClick(page, ['Update']);
  await page.waitForTimeout(500);
  // Whatever it asks — "add this category?", "remove the other half?" — say yes.
  // Only ever inside the dialog on top, and only on an exact label: 'Add it' is
  // a different button that lives in the category field itself.
  for (let i = 0; i < 4; i++) {
    const c = await topClick(page, ['Add', 'Change it', 'Yes, do it']);
    if (process.env.JF_DEBUG) console.log('      clicked:', c, '| url:', page.url(), '| modals:', await page.evaluate(()=>document.querySelectorAll('.modal').length));
    if (!c) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(600);
  if (await page.evaluate(() => typeof window.JINNYFIN === 'undefined'))
    throw new Error('the page navigated away in the middle of the edit');

  const left = await page.evaluate(() => {
    const out = window.JINNYFIN.DB.transactions.find(t => t.id === 'tst-out');
    return {
      converted: out?.type,
      stillLinked: !!(out?.transfer_group || out?.to_account),
      partnerLeft: !!window.JINNYFIN.DB.transactions.find(t => t.id === 'tst-in'),
    };
  });
  await ctx.close();
  if (left.converted !== 'Expense') throw new Error(`the row did not become an Expense (it is ${left.converted})`);
  if (left.partnerLeft) throw new Error('the other half is still there — the money is counted twice');
  if (left.stillLinked) throw new Error('the converted row kept its transfer link');
  return `${accts.a} -> ${accts.b}, converted cleanly`;
});

test('a date filters as it is typed, without losing the caret', async browser => {
  // Two things at once, because they are one bug. The filter bar used to be
  // rebuilt on every keystroke: that threw the caret back to the FIRST segment
  // — type 11, pause, type 28 and you got 2026-02-08 — and it is also why the
  // results could not follow the typing. The bar is built once now; only the
  // list below it is redrawn.
  const { ctx, page } = await open(browser, 'transactions');
  const box = () => page.locator('.filters input[type=date]').first();
  const rows = () => page.evaluate(() => document.querySelectorAll('.tx').length);
  const sameNode = () => page.evaluate(() => {
    const i = document.querySelector('.filters input[type=date]');
    const same = window.__dateNode ? window.__dateNode === i : true;
    window.__dateNode = i; return same;
  });
  await sameNode();
  const before = await rows();

  // An empty box starts on its first segment, so the caret's position is known.
  // Type a month, stop long enough for any redraw to have happened, then carry
  // on. If the box survived, the rest lands where it was aimed.
  await box().click();
  await page.keyboard.type('11');
  await page.waitForTimeout(800);
  if (!await sameNode()) { await ctx.close(); throw new Error('the box was replaced during the pause'); }
  await page.keyboard.type('282024');
  await page.waitForTimeout(700);

  const got = await box().inputValue();
  const live = await rows();
  const held = await sameNode();
  await ctx.close();
  if (!held) throw new Error('the box was replaced while being typed in');
  if (got !== '2024-11-28') throw new Error(`the digits landed in the wrong segment: ${got}`);
  // No Tab, no Enter, no click away — the list must already have followed.
  if (live === before) throw new Error('results did not follow the typing');
  return `live results (${before} -> ${live}), caret held through a pause`;
});

test('a year nobody meant never reaches a filter or a saved row', async browser => {
  const { ctx, page } = await open(browser, 'transactions');
  // 1. a filter box puts back what is really in force
  const box = page.locator('.filters input[type=date]').first();
  await box.click(); await page.keyboard.press('Home');
  await page.keyboard.type('02202323');
  await page.locator('h1').first().click();
  await page.waitForTimeout(600);
  const left = await page.locator('.filters input[type=date]').first().inputValue();
  if (left) throw new Error(`the filter kept a year-2323 date: ${left}`);

  // 2. the editor refuses to save one
  const before = await page.evaluate(() => window.JINNYFIN.DB.transactions.length);
  await page.evaluate(() => window.JINNYFIN.openTxEditor());
  await page.waitForTimeout(500);
  await page.locator('.modal .amount-in').first().fill('55');
  const d = page.locator('.modal input[type=date]').first();
  await d.click(); await page.keyboard.press('Home'); await page.keyboard.type('01012323');
  await page.evaluate(() => {
    const i = [...document.querySelectorAll('.modal input')].find(x => x.getAttribute('list')?.includes('parent'));
    if (i) { i.value = 'Food and Dining'; i.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === 'Save')?.click());
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({
    n: window.JINNYFIN.DB.transactions.length,
    weird: window.JINNYFIN.DB.transactions.filter(t => t.date && (+t.date.slice(0, 4) > 2100 || +t.date.slice(0, 4) < 1900)).length,
  }));
  await ctx.close();
  if (after.weird) throw new Error(`${after.weird} row(s) saved outside 1900-2100`);
  if (after.n !== before) throw new Error('a row was saved when the date should have blocked it');
  return 'filter reverted, save blocked';
});

test('click opens a row, long press picks it', async browser => {
  // Both gestures, on a mouse. A timer on mousedown got this wrong: half a
  // second is nothing with a mouse, so resting on the button while reading
  // dropped the screen into selection mode. The hold is judged at the release
  // instead, so one press does exactly one thing.
  const { ctx, page } = await open(browser, 'transactions');
  const state = () => page.evaluate(() => ({
    picking: !!document.querySelector('.pick'), editor: !!document.querySelector('.modal') }));
  const press = async ms => {
    const b = await page.locator('.tx').first().boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await page.waitForTimeout(ms); await page.mouse.up();
    await page.waitForTimeout(450);
  };

  await press(80);                       // an ordinary click
  let st = await state();
  if (st.picking) { await ctx.close(); throw new Error('a quick click fell into selection mode'); }
  if (!st.editor) { await ctx.close(); throw new Error('a quick click did not open the row'); }
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  await press(900);                      // a deliberate hold
  st = await state();
  if (!st.picking) { await ctx.close(); throw new Error('a long press did not pick the row'); }
  if (st.editor) { await ctx.close(); throw new Error('a long press also opened the editor'); }
  const ticked = await page.evaluate(() => document.querySelectorAll('.pick:checked').length);
  if (!ticked) { await ctx.close(); throw new Error('the row it was held on was not ticked'); }

  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  if (await page.evaluate(() => !!document.querySelector('.pick'))) {
    await ctx.close(); throw new Error('Escape did not leave selection mode'); }

  await page.locator('.tx').first().click({ button: 'right' });   // right-click still picks
  await page.waitForTimeout(400);
  const viaRight = await page.evaluate(() => !!document.querySelector('.pick'));
  await ctx.close();
  if (!viaRight) throw new Error('right-click no longer starts selection');
  return 'click opens, hold picks, Escape leaves, right-click picks';
});

test('a payee can be renamed across its entries, and merged only after a second yes', async browser => {
  // Payees had no rename at all: a typo lived on every row it was typed into.
  // Renaming moves every entry; typing a name that already exists is a merge,
  // and a merge must never ride in on the rename confirm — it asks by itself.
  const { ctx, page, errors } = await open(browser, 'payee');
  const count = name => page.evaluate(n => window.JINNYFIN.DB.transactions
    .filter(t => t.payee === n && !t.deleted).length, name);
  const openRename = async name => {
    await page.evaluate(() => {
      const cb = [...document.querySelectorAll('.card-head input[type=checkbox]')][0];
      if (cb && !cb.checked) cb.click();
    });
    await page.waitForTimeout(300);
    const hit = await page.evaluate(n => {
      const b = [...document.querySelectorAll('button[title]')].find(x => x.title === `Rename ${n}`);
      if (!b) return false;
      b.click(); return true;
    }, name);
    if (!hit) { await ctx.close(); throw new Error(`no rename control for ${name}`); }
    await page.waitForTimeout(250);
  };
  const typeName = async v => {
    await page.fill('.modal-body input[type=text]', v);
    await topClick(page, ['Save']);
    await page.waitForTimeout(250);
  };
  const dialogText = () => page.evaluate(() => {
    const all = [...document.querySelectorAll('.modal')];
    return all[all.length - 1]?.textContent || '';
  });

  if (await count('Farooq') !== 1) { await ctx.close(); throw new Error('fixture changed: Farooq'); }
  const yahiyaWas = await count('Yahiya SAR');

  // 1. a plain rename happens only after the confirm, and moves every entry
  await openRename('Farooq');
  await typeName('Farooq Ali');
  if (!/Rename .*Farooq.* on 1 entries\?/.test(await dialogText())) {
    await ctx.close(); throw new Error('the rename confirm did not say how many entries move'); }
  await topClick(page, ['Cancel']);
  await page.waitForTimeout(250);
  if (await count('Farooq Ali')) { await ctx.close(); throw new Error('Cancel renamed it anyway'); }
  await topClick(page, ['Save']);
  await page.waitForTimeout(250);
  await topClick(page, ['Yes, rename']);
  await page.waitForTimeout(400);
  if (await count('Farooq') !== 0 || await count('Farooq Ali') !== 1) {
    await ctx.close(); throw new Error('the rename did not move the entry'); }

  // 2. typing a name that already exists asks a second, different question —
  //    and answering it with Cancel leaves both payees exactly as they were.
  //    (Whichever name the row carries now: the stub syncs the fixture back.)
  const live = await count('Farooq Ali') ? 'Farooq Ali' : 'Farooq';
  await openRename(live);
  await typeName('Yahiya SAR');
  const ask = await dialogText();
  if (!/merge/i.test(ask) || !/Yahiya SAR/.test(ask)) {
    await ctx.close(); throw new Error(`no merge confirmation: ${ask.slice(0, 140)}`); }
  await topClick(page, ['Cancel']);
  await page.waitForTimeout(250);
  if (await count('Yahiya SAR') !== yahiyaWas) {
    await ctx.close(); throw new Error('Cancel merged them anyway'); }

  // 3. and merges only when that question is answered
  await topClick(page, ['Save']);
  await page.waitForTimeout(250);
  await topClick(page, ['Yes, merge them']);
  await page.waitForTimeout(400);
  const after = await count('Yahiya SAR');
  const left = await count(live);
  await ctx.close();
  if (left !== 0) throw new Error('the merged-away payee still has entries');
  if (after !== yahiyaWas + 1) throw new Error(`merged total is ${after}, expected ${yahiyaWas + 1}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'rename moves every entry; merge needs its own yes';
});

test('a payee ledger splits into two sides that still add up', async browser => {
  // One person can owe you money while you owe him money. Each half is a whole
  // debt — lent/collected on one side, borrowed/repaid on the other — and must
  // be readable, totalled and printable by itself. What it must never do is
  // invent a number: the two closing balances still make the net one.
  const { ctx, page, errors } = await open(browser, 'payee');
  const pick = async name => {
    await page.evaluate(n => {
      const td = [...document.querySelectorAll('tbody td')].find(x => x.textContent.trim().startsWith(n));
      td?.closest('tr')?.click();
    }, name);
    await page.waitForTimeout(500);
  };
  const chip = async label => {
    const hit = await page.evaluate(l => {
      const b = [...document.querySelectorAll('#payee-ledger button')].find(x => x.textContent.includes(l));
      if (!b) return false; b.click(); return true;
    }, label);
    if (!hit) { await ctx.close(); throw new Error(`no "${label}" chip`); }
    await page.waitForTimeout(450);
  };
  // What the ledger table on screen is actually showing: its kinds and its
  // last balance — read off the DOM, because the screen is the deliverable.
  const shown = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#payee-ledger tbody tr')];
    const cells = r => [...r.querySelectorAll('td')].map(c => c.textContent.trim());
    return { kinds: rows.map(r => cells(r)[2]).filter(Boolean),
      count: rows.length,
      closing: [...document.querySelectorAll('#payee-ledger .kpi')]
        .map(k => k.textContent).filter(t => /Closing/.test(t))[0] || '' };
  });

  // The fixture's payee is lent-to only. Give him one borrowing too, in the
  // live DB, so the split has something to split — a person who owes you AND
  // is owed by you is exactly the case this screen exists for.
  await page.evaluate(() => {
    const t = window.JINNYFIN.DB.transactions.find(x => x.payee === 'Yahiya SAR');
    window.JINNYFIN.DB.transactions.push({ ...t, id: 'test-borrow-1', date: '2026-01-05',
      parent: 'Borrow', sub: 'Borrow', income: 400, expense: 0, note: 'test borrowing' });
    window.JINNYFIN.go('payee');
  });
  await page.waitForTimeout(600);

  await pick('Yahiya SAR');
  const all = await shown();
  if (!all.count) { await ctx.close(); throw new Error('the ledger did not open'); }
  if (!all.kinds.some(k => /Lend/i.test(k))) { await ctx.close(); throw new Error('fixture changed: no Lend rows'); }

  await chip('They owe me');
  const lend = await shown();
  if (!lend.count) { await ctx.close(); throw new Error('the lend side came up empty'); }
  if (lend.kinds.some(k => /Borrow|Repay/i.test(k))) {
    await ctx.close(); throw new Error(`a borrow row survived the lend filter: ${lend.kinds.join(', ')}`); }

  await chip('I owe them');
  const borrow = await shown();
  if (borrow.kinds.some(k => /Lend|Collect/i.test(k))) {
    await ctx.close(); throw new Error(`a lend row survived the borrow filter: ${borrow.kinds.join(', ')}`); }
  if (lend.count + borrow.count !== all.count) {
    await ctx.close();
    throw new Error(`${lend.count} + ${borrow.count} rows do not make the ${all.count} the whole ledger shows`); }

  // The arithmetic: each side's closing, and the two together against the net.
  const sums = await page.evaluate(() => {
    const rows = window.JINNYFIN.DB.transactions
      .filter(t => t.type === 'Lend/Borrow' && t.payee === 'Yahiya SAR' && !t.deleted);
    const half = r => {
      const s = `${r.parent || ''} ${r.sub || ''}`.toLowerCase();
      return /lend|collect/.test(s) ? 'lend' : /borrow|repay/.test(s) ? 'borrow' : 'other';
    };
    const net = a => a.reduce((n, r) => n + (+r.income || 0) - (+r.expense || 0), 0);
    return { all: net(rows), lend: net(rows.filter(r => half(r) === 'lend')),
      borrow: net(rows.filter(r => half(r) === 'borrow')),
      other: rows.filter(r => half(r) === 'other').length };
  });
  await ctx.close();
  if (sums.other) throw new Error('fixture changed: unlabelled Lend/Borrow rows');
  if (Math.abs((sums.lend + sums.borrow) - sums.all) > 0.005) {
    throw new Error(`the two sides close at ${sums.lend} + ${sums.borrow}, the whole at ${sums.all}`); }
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${all.count} rows split ${lend.count}/${borrow.count}, balances still reconcile`;
});

test('picking a currency leaves only that currency in the payee statement', async browser => {
  // A payee lent riyals and rupees has two debts that must never be added. The
  // picker shows one of them at a time — and shows itself only when there are
  // two, because one currency is not a question.
  const { ctx, page, errors } = await open(browser, 'payee');
  const seed = async () => page.evaluate(() => {
    const t = window.JINNYFIN.DB.transactions.find(x => x.payee === 'Yahiya SAR');
    window.JINNYFIN.DB.transactions.push({ ...t, id: 'test-inr-1', date: '2026-01-06',
      currency: 'INR', parent: 'Lend', sub: 'Lend', income: 0, expense: 900, note: 'rupee loan' });
    window.JINNYFIN.go('payee');
  });
  const pick = async name => {
    await page.evaluate(n => {
      const td = [...document.querySelectorAll('tbody td')].find(x => x.textContent.trim().startsWith(n));
      td?.closest('tr')?.click();
    }, name);
    await page.waitForTimeout(500);
  };
  const picker = () => page.evaluate(() => {
    const sel = document.querySelector('#payee-ledger select');
    return sel ? [...sel.options].map(o => o.value) : null;
  });
  const rowCurrencies = () => page.evaluate(() => {
    const head = [...document.querySelectorAll('#payee-ledger thead th')].map(h => h.textContent.trim());
    const i = head.indexOf('Cur');
    if (i < 0) return null;                       // one currency: the column is gone
    return [...new Set([...document.querySelectorAll('#payee-ledger tbody tr')]
      .map(r => r.querySelectorAll('td')[i]?.textContent.trim()).filter(Boolean))];
  });
  const rowCount = () => page.evaluate(() =>
    document.querySelectorAll('#payee-ledger tbody tr').length);

  await pick('Yahiya SAR');
  if (await picker()) { await ctx.close(); throw new Error('a one-currency payee was offered a currency picker'); }

  await seed();
  await page.waitForTimeout(600);
  await pick('Yahiya SAR');
  const opts = await picker();
  if (!opts || !opts.includes('SAR') || !opts.includes('INR')) {
    await ctx.close(); throw new Error(`the picker did not offer both currencies: ${opts}`); }
  const both = await rowCount();
  if ((await rowCurrencies() || []).length !== 2) {
    await ctx.close(); throw new Error('the unfiltered ledger is not showing both currencies'); }

  await page.selectOption('#payee-ledger select', 'INR');
  await page.waitForTimeout(500);
  const inrRows = await rowCount();
  if (await rowCurrencies() !== null) {
    await ctx.close(); throw new Error('the Cur column stayed after narrowing to one currency'); }
  if (inrRows !== 1) { await ctx.close(); throw new Error(`INR shows ${inrRows} rows, expected 1`); }
  const inrText = await page.evaluate(() => document.querySelector('#payee-ledger tbody').textContent);
  if (!/rupee loan/.test(inrText)) { await ctx.close(); throw new Error('the INR row is not the rupee one'); }

  await page.selectOption('#payee-ledger select', 'SAR');
  await page.waitForTimeout(500);
  const sarRows = await rowCount();
  const sarText = await page.evaluate(() => document.querySelector('#payee-ledger tbody').textContent);
  await ctx.close();
  if (/rupee loan/.test(sarText)) throw new Error('a rupee row survived the SAR filter');
  if (sarRows + inrRows !== both) {
    throw new Error(`${sarRows} + ${inrRows} rows do not make the ${both} shown unfiltered`); }
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `picker appears only when needed; ${both} rows split ${sarRows} SAR / ${inrRows} INR`;
});

test('Tab runs the editor in order and never leaves it', async browser => {
  // Tab used to walk out of an open sheet and into the page behind it, so the
  // next Enter pressed a button nobody could see. And a date box swallowed
  // three Tabs of its own — its segments are reached by typing, not by Tab.
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.openTxEditor());
  await page.waitForTimeout(500);
  const where = () => page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return 'nothing';
    const inModal = !!a.closest('.modal');
    const field = a.closest('.field')?.querySelector('label')?.textContent?.trim();
    return `${inModal ? '' : 'OUTSIDE:'}${field || a.textContent?.trim() || a.type || a.tagName}`;
  });
  const seen = [];
  for (let i = 0; i < 14; i++) { seen.push(await where()); await page.keyboard.press('Tab'); await page.waitForTimeout(90); }
  const outside = seen.filter(x => x.startsWith('OUTSIDE:'));
  if (outside.length) { await ctx.close(); throw new Error(`focus left the sheet: ${outside[0]} (${seen.join(' → ')})`); }
  if (seen[0] !== 'Amount') { await ctx.close(); throw new Error(`the sheet did not open on Amount: ${seen[0]}`); }
  // Every stop is a different field: a date or time box is one stop, not three.
  const runs = seen.filter((x, i) => i && x === seen[i - 1]);
  if (runs.length) { await ctx.close(); throw new Error(`Tab stayed inside one box: ${runs[0]}`); }
  // and it comes back round to where it started
  if (!seen.slice(1).includes('Amount')) {
    await ctx.close(); throw new Error(`Tab never wrapped back to Amount: ${seen.join(' → ')}`); }
  const order = seen.slice(0, seen.indexOf('Amount', 1));
  await ctx.close();
  const want = ['Amount', 'Account', 'Date', 'Time', 'Category', 'Sub-category', 'Description'];
  for (let i = 0; i < want.length; i++) {
    if (order[i] !== want[i]) throw new Error(`stop ${i + 1} is ${order[i]}, expected ${want[i]} (${order.join(' → ')})`);
  }
  // Payee and Event are for the pointer on an ordinary entry — they are not
  // worth a Tab each on every one of the other forty-nine.
  const stray = order.filter(x => /Payee|Event/.test(x));
  if (stray.length) throw new Error(`${stray.join(' and ')} should not be in the Tab run for an Expense`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return order.join(' → ') + ' → (loops)';
});

test('on a Lend/Borrow the payee keeps its place in the Tab run', async browser => {
  // Skipping Payee is right for a shop receipt and wrong here: on a loan the
  // payee is the entry. Whoever it is owed to has to be reachable by keyboard.
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.openTxEditor(null, { type: 'Lend/Borrow' }));
  await page.waitForTimeout(500);
  const seen = [];
  for (let i = 0; i < 12; i++) {
    seen.push(await page.evaluate(() => {
      const a = document.activeElement;
      return a?.closest('.field')?.querySelector('label')?.textContent?.trim()
        || a?.textContent?.trim() || a?.tagName || 'nothing';
    }));
    await page.keyboard.press('Tab'); await page.waitForTimeout(90);
  }
  await ctx.close();
  if (!seen.includes('Payee')) throw new Error(`Payee is not in the run: ${seen.join(' → ')}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return seen.slice(0, seen.indexOf('Amount', 1) || 9).join(' → ');
});

test('one category cannot hold two budgets for the same period', async browser => {
  // Three budgets on Food and Dining made one ₹4,831 of spending read as
  // ₹14,493 in the total at the top — and a figure at the top of a screen is
  // the one people believe.
  const { ctx, page, errors } = await open(browser, 'budgets');
  const totals = () => page.evaluate(() => [...document.querySelectorAll('.kpi')]
    .map(k => k.textContent.replace(/\s+/g, ' ').trim()));
  const seed = n => page.evaluate(count => {
    const t = window.JINNYFIN.DB.transactions.find(x => x.type === 'Expense' && x.parent);
    window.JINNYFIN.DB.budgets = [];
    for (let i = 0; i < count; i++) {
      window.JINNYFIN.DB.budgets.push({ id: 'test-b' + i, parent: t.parent, sub: null,
        amount: 400, currency: 'INR', period: 'monthly', updated_at: `2026-01-0${i + 1}` });
    }
    window.JINNYFIN.go('dashboard');
    return t.parent;
  }, n).then(async parent => {
    await page.waitForTimeout(250);
    await page.evaluate(() => window.JINNYFIN.go('budgets'));
    return parent;
  });

  const cat = await seed(1);
  await page.waitForTimeout(700);
  const one = await totals();
  await seed(3);
  await page.waitForTimeout(700);
  const three = await totals();
  if (JSON.stringify(one) !== JSON.stringify(three)) {
    await ctx.close();
    throw new Error(`the same spending counted differently: ${one.join(' | ')}  vs  ${three.join(' | ')}`); }

  // and the page offers to clear the repeats it found
  const offered = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => /Remove the repeats/i.test(x.textContent));
    if (!a) return false; a.click(); return true;
  });
  if (!offered) { await ctx.close(); throw new Error('no offer to remove the repeated budgets'); }
  await page.waitForTimeout(350);
  await topClick(page, ['Remove them']);
  await page.waitForTimeout(600);
  const left = await page.evaluate(() => window.JINNYFIN.DB.budgets.length);
  if (left !== 1) { await ctx.close(); throw new Error(`${left} budgets left, expected 1`); }

  // a second one cannot be made by hand either
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(b => /\+ Budget/.test(b.textContent))?.click());
  await page.waitForTimeout(350);
  // The Category box is a search box now: type the name, Enter picks it.
  const catBox = page.locator('.modal-body .combo input').first();
  await catBox.click();
  await catBox.fill(cat);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.fill('.modal-body input[type=number]', '999');
  await topClick(page, ['Save']);
  await page.waitForTimeout(400);
  const asked = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.modal')];
    return all[all.length - 1]?.textContent || '';
  });
  await topClick(page, ['Cancel']);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.JINNYFIN.DB.budgets.length);
  await ctx.close();
  if (!/already has a/i.test(asked)) throw new Error(`a duplicate was accepted quietly: ${asked.slice(0, 120)}`);
  if (after !== 1) throw new Error(`${after} budgets after cancelling the duplicate, expected 1`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'totals count each spend once; a repeat is refused and the old ones can be cleared';
});

test('the statement menu entry, pressed twice, goes back to the account list', async browser => {
  const { ctx, page, errors } = await open(browser, 'statement');
  const openAccount = async () => {
    await page.evaluate(() => {
      const td = [...document.querySelectorAll('tbody td')][0];
      td?.closest('tr')?.click();
    });
    await page.waitForTimeout(600);
  };
  // The URL is not the answer: the menu navigates to a bare #/statement either
  // way. What matters is what is on screen — the list, or one account's sheet.
  const onList = () => page.evaluate(() =>
    !document.querySelector('#main button')?.textContent?.includes('All accounts')
    && !!document.querySelector('#main tbody tr'));
  const navClick = async () => {
    const hit = await page.evaluate(() => {
      const b = document.querySelector('[data-route="statement"]');
      if (!b) return false; b.click(); return true;
    });
    if (!hit) { await ctx.close(); throw new Error('no statement entry in the menu'); }
    await page.waitForTimeout(700);
  };

  if (!await onList()) { await ctx.close(); throw new Error('the statement did not open on the account list'); }
  await openAccount();
  if (await onList()) { await ctx.close(); throw new Error('clicking an account did not open its statement'); }
  await navClick();
  const back = await onList();
  await ctx.close();
  if (!back) throw new Error('pressing the statement entry again did not return to the account list');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'a second press on the open screen is “← All accounts”';
});

test('the category list opens closed, and its search finds a name', async browser => {
  // Six types and a hundred names, all open at once, meant the browser's own
  // find was the only way through.
  const { ctx, page, errors } = await open(browser, 'settings');
  await page.evaluate(() => [...document.querySelectorAll('.seg button')]
    .find(b => b.textContent.trim() === 'Categories')?.click());
  await page.waitForTimeout(600);
  const names = () => page.evaluate(() =>
    [...document.querySelectorAll('.card b')].map(b => b.textContent.trim()));
  const shut = await names();
  if (shut.length) { await ctx.close(); throw new Error(`the list opened expanded: ${shut.slice(0, 4).join(', ')}`); }

  const heads = await page.evaluate(() =>
    [...document.querySelectorAll('.card-head h3')].map(h => h.textContent.trim()));
  if (!heads.length) { await ctx.close(); throw new Error('no type cards at all'); }
  await page.evaluate(() => document.querySelector('.card-head')?.click());
  await page.waitForTimeout(400);
  const opened = await names();
  if (!opened.length) { await ctx.close(); throw new Error('clicking a type card did not open it'); }

  const want = opened[Math.min(1, opened.length - 1)];
  await page.fill('input[type=search]', want);
  await page.waitForTimeout(450);
  const found = await names();
  await ctx.close();
  if (!found.includes(want)) throw new Error(`searching for ${want} did not find it`);
  if (found.length > opened.length) throw new Error('the search widened the list instead of narrowing it');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${heads.length} types, closed; search found ${want}`;
});

test('typing in the category search box does not lose focus mid-word', async browser => {
  // draw() rebuilds the whole tab on every keystroke, search box included. The
  // old input's focus — thrown to the page itself when the new one replaces it
  // — meant the very next letter typed was read as a shortcut instead of text:
  // "n" opens a new transaction, "/" jumps to Transactions. Typing "insurance"
  // used to pop a blank transaction editor open right after its second letter.
  const { ctx, page, errors } = await open(browser, 'settings');
  await page.evaluate(() => [...document.querySelectorAll('.seg button')]
    .find(b => b.textContent.trim() === 'Categories')?.click());
  await page.waitForTimeout(400);
  await page.locator('input[type=search]').pressSequentially('insurance', { delay: 200 });
  await page.waitForTimeout(500);
  const modalOpen = await page.evaluate(() => !!document.querySelector('.modal'));
  const typed = await page.evaluate(() => document.querySelector('input[type=search]')?.value);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('type') === 'search');
  await ctx.close();
  if (modalOpen) throw new Error('typing into the search box opened another window (a global shortcut fired)');
  if (typed !== 'insurance') throw new Error(`the box reads "${typed}", not the full word typed`);
  if (!focused) throw new Error('focus left the search box during typing');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'typed "insurance" letter by letter with focus held throughout, no shortcut fired';
});

test('renaming a category from its name moves every sub and entry with it', async browser => {
  // A category is only ever a name string on a transaction, not a row those
  // transactions point at — so a rename that touched just the category record
  // left every entry already filed under the old name stuck there, invisible
  // to the new one, forever.
  const { ctx, page, errors } = await open(browser, 'settings');
  await page.evaluate(() => [...document.querySelectorAll('.seg button')]
    .find(b => b.textContent.trim() === 'Categories')?.click());
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('.card-head')].forEach(h => h.click()));
  await page.waitForTimeout(400);

  const target = await page.evaluate(() => {
    const { DB } = window.JINNYFIN;
    const c = DB.categories.find(x => !x.sub
      && DB.transactions.some(t => !t.deleted && t.type === x.type && t.parent === x.parent));
    if (!c) return null;
    return { type: c.type, parent: c.parent,
      count: DB.transactions.filter(t => !t.deleted && t.type === c.type && t.parent === c.parent).length,
      catRows: DB.categories.filter(x => x.type === c.type && x.parent === c.parent).length };
  });
  if (!target) { await ctx.close(); throw new Error('no fixture category with existing entries to rename'); }

  const newName = target.parent + ' RENAMED';
  const clicked = await page.evaluate(name => {
    const b = [...document.querySelectorAll('.card b')].find(x => x.textContent.trim() === name);
    if (!b) return false;
    b.click();
    return true;
  }, target.parent);
  if (!clicked) { await ctx.close(); throw new Error(`could not find "${target.parent}" in the list to click`); }
  await page.waitForTimeout(300);
  await page.fill('.modal input[type=text]', newName);
  await page.click('.modal .btn.primary');
  await page.waitForTimeout(400);

  const after = await page.evaluate(([type, oldName, newName]) => {
    const { DB } = window.JINNYFIN;
    return {
      oldTx: DB.transactions.filter(t => !t.deleted && t.type === type && t.parent === oldName).length,
      newTx: DB.transactions.filter(t => !t.deleted && t.type === type && t.parent === newName).length,
      oldCats: DB.categories.filter(x => x.type === type && x.parent === oldName).length,
      newCats: DB.categories.filter(x => x.type === type && x.parent === newName).length,
    };
  }, [target.type, target.parent, newName]);
  await ctx.close();
  if (after.oldTx !== 0) throw new Error(`${after.oldTx} entries are still stuck under the old name`);
  if (after.newTx !== target.count) throw new Error(`expected ${target.count} entries under the new name, found ${after.newTx}`);
  if (after.oldCats !== 0) throw new Error(`${after.oldCats} category row(s) still stuck under the old name`);
  if (after.newCats !== target.catRows) throw new Error(`expected ${target.catRows} category row(s) moved, found ${after.newCats}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${target.count} entries and ${target.catRows} category row(s) moved from "${target.parent}" to the new name`;
});

test('a loan entry opens on Lend and writes its own description', async browser => {
  // Nine Lend/Borrow entries in ten are a loan, and every one of them used to
  // open on Borrow and need the same sentence typed by hand.
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.openTxEditor(null, { type: 'Lend/Borrow' }));
  await page.waitForTimeout(500);
  const pick = () => page.evaluate(() => [...document.querySelectorAll('.modal-body select')]
    .map(s => s.value));
  const note = () => page.evaluate(() =>
    [...document.querySelectorAll('.modal-body input')]
      .find(i => i.placeholder === 'Description')?.value || '');
  const typePayee = async name => {
    await page.evaluate(n => {
      const p = [...document.querySelectorAll('.modal-body input')].find(i => i.placeholder === 'Who?');
      p.focus(); p.value = n;
    }, name);
    await page.keyboard.press('Tab');       // leaving the box is what settles it
    await page.waitForTimeout(350);
  };
  const setSub = async value => {
    await page.evaluate(v => {
      const sels = [...document.querySelectorAll('.modal-body select')];
      const s = sels[1];
      s.value = v; s.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await page.waitForTimeout(300);
  };

  const [cat, sb] = await pick();
  if (cat !== 'Lend' || sb !== 'Lend') {
    await ctx.close(); throw new Error(`opened on ${cat} · ${sb}, expected Lend · Lend`); }

  await typePayee('Mustafa');
  if (await note() !== 'Mustafa took out a loan') {
    await ctx.close(); throw new Error(`Lend · Lend wrote: “${await note()}”`); }

  await setSub('Collecting debts');
  if (await note() !== 'Mustafa repaid money') {
    await ctx.close(); throw new Error(`Lend · Collecting debts wrote: “${await note()}”`); }

  // his own words are never overwritten
  await page.evaluate(() => {
    const n = [...document.querySelectorAll('.modal-body input')].find(i => i.placeholder === 'Description');
    n.value = 'for the car repair'; n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await setSub('Lend');
  await typePayee('Mustafa');
  const mine = await note();
  await ctx.close();
  if (mine !== 'for the car repair') throw new Error(`it overwrote what he typed: “${mine}”`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'opens on Lend · Lend; the line follows the payee and the sub, and stops at his own words';
});

test('the type row is one Tab stop, walked with the arrow keys', async browser => {
  const { ctx, page, errors } = await open(browser, 'transactions');
  await page.evaluate(() => window.JINNYFIN.openTxEditor());
  await page.waitForTimeout(500);
  const active = () => page.evaluate(() => {
    const a = document.activeElement;
    return { type: a?.dataset?.ty || '', label: a?.closest('.field')?.querySelector('label')?.textContent?.trim() || '' };
  });
  // Shift+Tab out of the Amount box lands on the row, on the type in force
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(200);
  let at = await active();
  if (!at.type) { await ctx.close(); throw new Error(`Shift+Tab from Amount went to ${at.label || 'nowhere'}`); }
  const first = at.type;

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(350);
  at = await active();
  if (!at.type || at.type === first) {
    await ctx.close(); throw new Error('the right arrow did not move along the row'); }
  const second = at.type;
  const changed = await page.evaluate(t => {
    const on = document.querySelector('.type-pick .on');
    return on?.dataset?.ty === t;
  }, second);
  if (!changed) { await ctx.close(); throw new Error('the arrow moved the focus but not the choice'); }

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(350);
  if ((await active()).type !== first) {
    await ctx.close(); throw new Error('the left arrow did not come back'); }

  // and Tab off the row goes into the sheet, not through five more buttons
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  const landed = await active();
  await ctx.close();
  if (landed.label !== 'Amount') throw new Error(`Tab off the type row went to ${landed.label || landed.type}`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `one stop; ← → walk ${first} ↔ ${second}; Tab returns to Amount`;
});

test('a budget sub-category fills in its own category', async browser => {
  // The sub is what he remembers; which parent it hangs under is the app's job.
  const { ctx, page, errors } = await open(browser, 'budgets');
  const known = await page.evaluate(() => {
    const c = window.JINNYFIN.DB.categories.find(x => x.type === 'Expense' && x.sub
      && window.JINNYFIN.DB.categories.filter(y => y.type === 'Expense' && y.sub === x.sub).length === 1);
    return c ? { parent: c.parent, sub: c.sub } : null;
  });
  if (!known) { await ctx.close(); throw new Error('fixture has no sub belonging to exactly one category'); }

  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(b => /\+ Budget/.test(b.textContent))?.click());
  await page.waitForTimeout(400);
  const parentNow = () => page.evaluate(() => document.querySelector('.modal-body .combo')?.value || '');
  if (await parentNow()) { await ctx.close(); throw new Error('the new-budget sheet did not open empty'); }

  await page.evaluate(sub => {
    const i = [...document.querySelectorAll('.modal-body input')].find(x => x.getAttribute('list'));
    i.focus(); i.value = sub; i.dispatchEvent(new Event('change', { bubbles: true }));
  }, known.sub);
  await page.waitForTimeout(400);
  const got = await parentNow();
  await ctx.close();
  if (got !== known.parent) throw new Error(`typing “${known.sub}” set the category to “${got}”, expected “${known.parent}”`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `${known.sub} → ${known.parent}`;
});

test('the sign-in screen says what the app is, and can send a reset link', async browser => {
  // This is the one screen a stranger sees before anything else — a demo link,
  // a store listing, a new phone. It used to be a bare card with two boxes.
  const { ctx, page, errors } = await openSignedOut(browser);
  const said = () => page.evaluate(() => document.querySelector('#root')?.textContent || '');
  const text = await said();
  for (const want of ['Jinnyfin', 'Sign in', 'Forgot your password?']) {
    if (!text.includes(want)) { await ctx.close(); throw new Error(`the screen never says “${want}”`); }
  }
  // nothing that dates itself or names two currencies out of the world's list
  for (const no of ['Nine years', 'SAR and INR']) {
    if (text.includes(no)) { await ctx.close(); throw new Error(`“${no}” is still on the sign-in screen`); }
  }
  const gold = await page.evaluate(() => !!document.querySelector('#root .btn.gold'));
  if (!gold) { await ctx.close(); throw new Error('the Sign in button is not the gold one'); }

  // show / hide actually changes the box
  const pwType = () => page.evaluate(() => document.querySelector('#root input[type=password], #root .pw input')?.type);
  if (await pwType() !== 'password') { await ctx.close(); throw new Error('the password box does not start hidden'); }
  await page.click('#root .peek');
  await page.waitForTimeout(150);
  if (await pwType() !== 'text') { await ctx.close(); throw new Error('“show” did not reveal the password'); }
  await page.click('#root .peek');
  await page.waitForTimeout(150);
  if (await pwType() !== 'password') { await ctx.close(); throw new Error('“hide” did not cover it again'); }

  // a reset asked for with no address must not go anywhere
  await page.fill('#root input[type=email]', '');
  await page.click('#root .linkbtn');
  await page.waitForTimeout(300);
  let sent = await page.evaluate(() => globalThis.__sb.resetFor);
  if (sent) { await ctx.close(); throw new Error(`a reset was sent to “${sent}” with the box empty`); }
  if (!/email address first/i.test(await said())) {
    await ctx.close(); throw new Error('it did not ask for the address'); }

  // and with one, it goes to exactly that address
  await page.fill('#root input[type=email]', 'sadikh@example.com');
  await page.click('#root .linkbtn');
  await page.waitForTimeout(500);
  sent = await page.evaluate(() => globalThis.__sb.resetFor);
  const told = await said();
  await ctx.close();
  if (sent !== 'sadikh@example.com') throw new Error(`the reset went to “${sent}”`);
  if (!told.includes('sadikh@example.com')) throw new Error('it did not say where the link was sent');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'named, gold, show/hide works, reset link goes to the address typed';
});

test('the sign-in screen fits a phone without a sideways scroll', async browser => {
  const { ctx, page, errors } = await openSignedOut(browser, { width: 360, height: 740 });
  const m = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    band: document.querySelector('.signin .art')?.getBoundingClientRect().height || 0,
    formVisible: (() => {
      const b = document.querySelector('#root .btn.gold')?.getBoundingClientRect();
      return !!b && b.top < window.innerHeight && b.width > 200;
    })(),
  }));
  await ctx.close();
  if (m.over > 1) throw new Error(`${m.over}px of sideways scroll on a 360px screen`);
  if (m.band > 420) throw new Error(`the brand band eats ${Math.round(m.band)}px of a 740px screen`);
  if (!m.formVisible) throw new Error('the Sign in button is not on screen without scrolling');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `band ${Math.round(m.band)}px, no sideways scroll, button in view`;
});

test('the sign-in screen fills the width, split evenly on a desktop', async browser => {
  // #root is a flex row (the app shell's own layout), and a lone child with no
  // explicit size shrinks to its content — which left a bare strip down the
  // right edge at every width, on the phone screen and the desktop screen alike.
  const { ctx, page, errors } = await openSignedOut(browser, { width: 1280, height: 800 });
  const m = await page.evaluate(() => {
    const rect = s => document.querySelector(s)?.getBoundingClientRect();
    const root = rect('#root'), signin = rect('.signin'), art = rect('.art'), side = rect('.side');
    return { vw: innerWidth, rootW: root?.width, signinW: signin?.width, artW: art?.width, sideW: side?.width };
  });
  await ctx.close();
  if (!m.signinW || Math.abs(m.signinW - m.vw) > 2) {
    throw new Error(`the sign-in page is ${Math.round(m.signinW || 0)}px wide on a ${m.vw}px screen`); }
  const ratio = m.artW / (m.artW + m.sideW);
  if (Math.abs(ratio - 0.5) > 0.05) {
    throw new Error(`the two panes split ${Math.round(ratio * 100)}/${Math.round((1 - ratio) * 100)}, not close to 50/50`); }
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return `full width at ${m.vw}px, panes ${Math.round(ratio * 100)}/${Math.round((1 - ratio) * 100)}`;
});

test('a reset-link visit lands on a set-new-password screen, not the dashboard', async browser => {
  // The bug this guards: Supabase delivers PASSWORD_RECOVERY as part of the
  // very same check getSession() awaits, to whoever is already listening at
  // that moment. A listener attached after awaiting getSession() — the old
  // order — would never see it, and the visitor would land silently signed
  // in on the ordinary dashboard with no way to actually set a password.
  const { ctx, page, errors } = await openRecovery(browser);
  const text = await page.evaluate(() => document.querySelector('#root')?.textContent || '');
  const onMain = await page.evaluate(() => !!document.querySelector('#main'));
  await ctx.close();
  if (onMain) throw new Error('the dashboard rendered instead of the recovery screen');
  if (!text.includes('Set a new password')) throw new Error(`the screen did not ask for a new password (saw: ${text.slice(0, 80)})`);
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'PASSWORD_RECOVERY caught before getSession() could swallow it';
});

test('a reset link rejects a short or mismatched password before saving anything', async browser => {
  const { ctx, page, errors } = await openRecovery(browser);
  const said = () => page.evaluate(() => document.querySelector('.signin .said')?.textContent || '');

  await page.fill('.signin input[placeholder="New password"]', 'abc');
  await page.fill('.signin input[placeholder="Confirm new password"]', 'abc');
  await page.click('.signin .btn.gold');
  await page.waitForTimeout(200);
  if (!/6 characters/.test(await said())) { await ctx.close(); throw new Error('a 3-character password was not rejected'); }

  await page.fill('.signin input[placeholder="New password"]', 'correcthorse');
  await page.fill('.signin input[placeholder="Confirm new password"]', 'correcthorsE');
  await page.click('.signin .btn.gold');
  await page.waitForTimeout(200);
  const mismatch = await said();
  const saved = await page.evaluate(() => globalThis.__sb.updatedPassword);
  const onMain = await page.evaluate(() => !!document.querySelector('#main'));
  await ctx.close();
  if (!/do not match/.test(mismatch)) throw new Error(`mismatched passwords were not caught (said: “${mismatch}”)`);
  if (saved) throw new Error('a password reached the server despite the mismatch');
  if (onMain) throw new Error('the app moved on despite the mismatch');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'short and mismatched passwords both refused, nothing sent';
});

test('setting a new password after a reset link signs you straight in', async browser => {
  const { ctx, page, errors } = await openRecovery(browser);
  await page.fill('.signin input[placeholder="New password"]', 'a-brand-new-password');
  await page.fill('.signin input[placeholder="Confirm new password"]', 'a-brand-new-password');
  await page.click('.signin .btn.gold');
  await page.waitForFunction(() => !!document.querySelector('#main'), null, { timeout: 10000 });
  const saved = await page.evaluate(() => globalThis.__sb.updatedPassword);
  const stillOnRecovery = await page.evaluate(() => !!document.querySelector('.signin'));
  await ctx.close();
  if (saved !== 'a-brand-new-password') throw new Error(`the server received “${saved}”, not the typed password`);
  if (stillOnRecovery) throw new Error('the recovery screen is still showing after a successful save');
  if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
  return 'password saved, app moved straight to the dashboard';
});

// ------------------------------------------------------------------- run ---
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const server = await serve();
const browser = await chromium.launch({ executablePath: chromePath() });
const version = JSON.parse(JSON.stringify(
  /version: '([\d.]+)'/.exec(readFileSync(join(ROOT, 'js/app.js'), 'utf8'))?.[1] || '?'));

console.log(`\n  Jinnyfin ${version} — ${CASES.length} checks\n`);
let failed = 0;
for (const c of CASES) {
  if (only.length && !only.some(o => c.name.includes(o))) continue;
  const t0 = Date.now();
  try {
    const note = await c.fn(browser);
    console.log(`  ✓ ${c.name}${note ? `  — ${note}` : ''}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${c.name}\n      ${e.message}`);
  }
}
await browser.close();
server.close();
console.log(failed ? `\n  ${failed} FAILED\n` : '\n  all good\n');
process.exit(failed ? 1 : 0);
