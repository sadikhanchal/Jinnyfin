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
