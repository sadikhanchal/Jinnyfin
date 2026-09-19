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
      category: !!document.querySelector('select[data-fk="parent"]'),
      subcategory: !!document.querySelector('select[data-fk="sub"]'),
      account: !!document.querySelector('select[data-fk="account"]'),
      description: !!document.querySelector('input[data-fk="description"]'),
    })));
    await ctx.close();
  }
  const missing = reports.flatMap((r, i) => Object.entries(r).filter(([, present]) => !present).map(([key]) => `${['income', 'expense'][i]}:${key}`));
  if (missing.length) throw new Error(`missing report controls: ${missing.join(', ')}`);
  return 'all Income and Expense filters render';
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
  await page.selectOption('.modal-body select', cat);
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
  const parentNow = () => page.evaluate(() => document.querySelector('.modal-body select')?.value || '');
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
