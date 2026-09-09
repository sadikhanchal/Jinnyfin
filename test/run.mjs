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
const PORT = 8974;
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
  if (cells[4] !== '1,200') throw new Error(`investment value total wrong: ${cells[4] || 'blank'}`);
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
