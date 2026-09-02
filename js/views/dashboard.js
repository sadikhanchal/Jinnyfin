// ============================================================================
//  dashboard.js — the sheet's Dashboard tab, re-cut for a phone screen.
// ============================================================================
import { el, money, compact, num, MONTHS, MON3, todayISO, fmtDate } from '../util.js';
import { DB } from '../store.js';
import * as C from '../calc.js';
import { groupedBars, lineChart, barList, SERIES } from '../charts.js';
import { topbar, go } from '../app.js';
import { openTxEditor, fireTemplate, typeIcon } from './editor.js';

// Opening the app should answer "how is this month going", not "how have the
// last eight years gone" — the period starts at today and widens if you ask.
const now = new Date();
let year = now.getFullYear(), month = now.getMonth() + 1, host = null;

export async function render(root) {
  host = root;
  draw();
}
export function refresh() { if (host) draw(); }

function draw() {
  const f = { year, month };
  const tot = C.periodTotals(f);
  const nw = C.netWorth();
  const head = C.insuranceHeadline();
  const S = SERIES();

  host.innerHTML = '';
  host.append(topbar('Dashboard',
    el('button', { class: 'btn sm', onclick: () => go('insurance') }, '🛡️ Policies')));

  // ---- insurance headline (mirrors Dashboard I1 / O1) --------------------
  const alertBox = el('div', { class: 'alert ' + head.level },
    el('span', { class: 'ico' }, head.level === 'ok' ? '✓' : head.level === 'expired' ? '⛔' : '⚠'),
    // Name the one that actually expires next. When the headline is already
    // about that one, the line below names the one after it.
    (() => {
      const sub = head.level === 'soon' ? head.then : head.next;
      return el('div', {}, el('b', {}, head.text),
        sub ? el('div', { class: 'small muted' },
          `next: ${sub.label} on ${fmtDate(sub.renewal_date)} · ${sub.daysLeft} days`) : null);
    })(),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn sm ghost', onclick: () => go('insurance') }, 'View'));
  host.append(alertBox);

  // ---- period filter ------------------------------------------------------
  const ySel = el('select', {}, el('option', { value: 'All' }, 'All years'),
    ...C.yearsPresent().map(y => el('option', { value: y, selected: String(year) === String(y) }, y)));
  const mSel = el('select', {}, el('option', { value: 'All' }, 'All months'),
    ...MONTHS.map((m, i) => el('option', { value: i + 1, selected: String(month) === String(i + 1) }, m)));
  ySel.onchange = () => { year = ySel.value; draw(); };
  mSel.onchange = () => { month = mSel.value; draw(); };
  host.append(el('div', { class: 'filters' },
    el('div', { class: 'field' }, el('label', {}, 'Year'), ySel),
    el('div', { class: 'field' }, el('label', {}, 'Month'), mSel),
    el('div', { class: 'field' }, el('label', {}, ' '),
      el('button', { class: 'btn sm', onclick: () => { year = 'All'; month = 'All'; draw(); } }, 'Reset'))));

  // ---- four headline tiles ------------------------------------------------
  const tiles = el('div', { class: 'grid g4 keep2' },
    tile('💵 Total income', money(tot.incomeINR, 'INR', false), `${money(tot.incomeSAR, 'SAR', false)} earned in SAR`, 'income'),
    tile('💸 Total expenses', money(tot.expenseINR, 'INR', false), `${money(tot.expenseSAR, 'SAR', false)} spent in SAR`, 'expense'),
    tile('📊 Net savings', money(tot.netINR, 'INR', false),
      `${(tot.savingsRate * 100).toFixed(1)}% of income kept`, tot.netINR >= 0 ? '' : 'expense'),
    tile('🏦 Net worth', money(nw.total, 'INR', false), 'as of ' + fmtDate(todayISO())));
  host.append(tiles);

  // ---- income / expense by source ----------------------------------------
  const inc = C.bySource('Income', f), exp = C.bySource('Expense', f);
  const two = el('div', { class: 'grid g2', style: 'margin-top:12px' });
  two.append(sourceCard('Income by source', inc, S.income, 'income'));
  two.append(sourceCard('Expense by source', exp, S.expense, 'expense'));
  host.append(two);

  // ---- monthly in/out -----------------------------------------------------
  const chartCard = el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, year === 'All' ? 'Income vs expense · by year' : `Income vs expense · ${year}`)));
  const chartHost = el('div', {});
  chartCard.append(chartHost);
  host.append(chartCard);

  let labels, incVals, expVals;
  if (year === 'All') {
    const yi = C.yearlyTotals('Income'), ye = C.yearlyTotals('Expense');
    const years = [...new Set([...yi.map(r => r.year), ...ye.map(r => r.year)])].sort();
    labels = years.map(String);
    incVals = years.map(y => yi.find(r => r.year === y)?.equiv || 0);
    expVals = years.map(y => ye.find(r => r.year === y)?.equiv || 0);
  } else {
    labels = MON3;
    incVals = C.monthlyTotals('Income', year).map(r => r.equiv);
    expVals = C.monthlyTotals('Expense', year).map(r => r.equiv);
  }
  requestAnimationFrame(() => groupedBars(chartHost, {
    labels,
    series: [{ name: '▲ Income', color: S.income, values: incVals },
             { name: '▼ Expense', color: S.expense, values: expVals }],
  }));

  // ---- net worth trend ----------------------------------------------------
  const nwCard = el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Net worth trend'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', onclick: () => go('networth') }, 'Breakdown →')));
  const nwHost = el('div', {});
  nwCard.append(nwHost);
  host.append(nwCard);
  requestAnimationFrame(() => {
    const series = C.netWorthSeries(year === 'All' ? null : year);
    lineChart(nwHost, {
      labels: series.map(s => MON3[+s.month.slice(5, 7) - 1] + ' ' + s.month.slice(2, 4)),
      values: series.map(s => s.total), color: SERIES().s1,
    });
  });

  // ---- balances + recent --------------------------------------------------
  const bottom = el('div', { class: 'grid g2', style: 'margin-top:12px' });
  bottom.append(balancesCard());
  bottom.append(recentCard());
  host.append(bottom);
}

function tile(label, value, sub, cls = '') {
  return el('div', { class: 'card stat ' + cls },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value tnum' }, value),
    el('div', { class: 'sub' }, sub));
}

function sourceCard(title, rows, color, kind) {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, title), el('div', { class: 'spacer' }),
      el('span', { class: 'small muted' }, rows.length + ' categories')));
  const bars = el('div', {});
  card.append(bars);
  barList(bars, rows.slice(0, 10).map(r => ({
    label: r.name, value: r.equiv, color,
    sub: [r.sar ? num(r.sar, 0) + ' SAR' : null, r.inr ? '₹' + num(r.inr, 0) : null].filter(Boolean).join(' + '),
  })), { format: v => money(v, 'INR', false), onClick: r => go(kind === 'income' ? 'income' : 'expense') });
  if (rows.length > 10) card.append(el('p', { class: 'small muted', style: 'margin:8px 0 0' },
    `+ ${rows.length - 10} more · `, el('a', { href: '#/' + (kind === 'income' ? 'income' : 'expense') }, 'full report')));
  return card;
}

function balancesCard() {
  const bals = C.allAccountBalances();
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Account balances'), el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', onclick: () => go('statement') }, 'Statement →')));
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, el('th', {}, 'Account'), el('th', { class: 'n' }, 'Balance'), el('th', { class: 'n' }, '≈ INR'))));
  const tb = el('tbody');
  let totalINR = 0;
  for (const a of C.cashAccounts()) {
    const b = bals.get(a.name) || 0;
    const v = C.liveINR(b, a.currency);
    totalINR += v;
    tb.append(el('tr', { style: 'cursor:pointer', onclick: () => { location.hash = '#/statement?account=' + encodeURIComponent(a.name); } },
      el('td', {}, a.name),
      el('td', { class: 'n ' + (b < 0 ? 'neg' : '') }, money(b, a.currency)),
      el('td', { class: 'n muted' }, money(v, 'INR', false))));
  }
  tb.append(el('tr', { class: 'total' }, el('td', {}, 'Cash & bank total'), el('td', {}), el('td', { class: 'n' }, money(totalINR, 'INR', false))));
  t.append(tb);
  card.append(el('div', { class: 'table-wrap' }, t));
  return card;
}

function recentCard() {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Latest entries'), el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', onclick: () => go('transactions') }, 'All →')));
  const list = el('div', {});
  const recent = DB.transactions.slice(-12).reverse();
  for (const t of recent) {
    const isIn = Number(t.income) > 0;
    list.append(el('div', {
      class: 'tx', onclick: () => openTxEditor(t),
    },
      el('div', { class: 'av' }, typeIcon(t.type)),
      el('div', { style: 'min-width:0' },
        el('div', { class: 't1' }, t.note || t.sub || t.parent || t.type),
        el('div', { class: 't2' }, `${fmtDate(t.date)} · ${t.account}${t.parent ? ' · ' + t.parent : ''}`)),
      el('div', { class: 'amt ' + (isIn ? 'in' : 'out') },
        (isIn ? '+' : '−') + money(isIn ? t.income : t.expense, t.currency))));
  }
  if (!recent.length) list.append(el('div', { class: 'empty' },
    el('div', { class: 'big' }, '📒'), el('p', {}, 'No transactions yet.'),
    el('button', { class: 'btn primary', onclick: () => openTxEditor() }, 'Add the first one')));
  card.append(list);
  return card;
}
