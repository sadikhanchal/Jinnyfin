// ============================================================================
//  report.js — shared engine behind the Expense Report and Income Report.
//  Same filters, same four blocks as the workbook, one code path.
// ============================================================================
import { el, money, num, MONTHS, MON3, fmtDate, downloadCSV, todayISO,
  debounce, searchSelect } from '../util.js';
import { DB } from '../store.js';
import * as C from '../calc.js';
import { groupedBars, barList, SERIES } from '../charts.js';
import { topbar } from '../app.js';
import { openTxEditor } from './editor.js';

export function makeReport(kind) {
  const isIncome = kind === 'Income';
  const blank = () => ({ year: 'All', month: 'All', parent: 'All', sub: 'All', account: 'All', description: '' });
  let f = { ...blank(), year: String(new Date().getFullYear()) };
  let host = null;
  let body = null;                          // everything below the filter bar — the only part redrawn
  let ctl = null;                           // the filter bar's controls, built once per visit
  let rows = [];                            // what is on screen, for the CSV button
  let escapeOut = null;                     // set while a drill-down is open
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !escapeOut) return;
    if (document.querySelector('.modal-wrap')) return;    // a sheet is on top; it owns Esc
    if (!host || !host.isConnected) return;               // this report is not on screen
    escapeOut();
  });

  /**
   * Redraw without throwing the page back to the top.
   *
   * Every tap in the breakdown rebuilds the whole screen, and a rebuilt screen
   * starts at scroll 0 — so drilling into a category, stepping back out, or
   * touching a crumb sent the page shooting upwards and you had to scroll all
   * the way down again to carry on.
   *
   * Keeping the raw scrollY is not enough: what sits above the breakdown can
   * change height as the filter narrows (fewer months in the totals table), and
   * the card would land somewhere else anyway. So the anchor is the card
   * itself — remember how far down the window its top was, and after the redraw
   * put the new card back at exactly that height. The thumb ends up over the
   * same row it just tapped.
   */
  function redraw(anchor) {
    const before = anchor?.getBoundingClientRect().top;
    draw();
    if (before == null || !host?.isConnected) return;
    const settle = () => {
      const now = host.querySelector('.jf-bd');
      if (!now) return;
      const shift = now.getBoundingClientRect().top - before;
      if (Math.abs(shift) > 1) window.scrollTo(window.scrollX, window.scrollY + shift);
    };
    // Two frames: the first lets the new nodes lay out, the second catches the
    // bar chart, which finishes drawing a frame later and can change the height.
    requestAnimationFrame(() => { settle(); requestAnimationFrame(settle); });
  }

  /**
   * The filter bar is built ONCE and then left alone — the Transactions screen
   * has worked this way for a long time, and this is why.
   *
   * It used to be thrown away and rebuilt with everything else on every change.
   * Picking a category with Tab then destroyed the very box Tab was leaving,
   * the cursor was put back into it, the box opened its list on "All
   * categories" — and the next Tab picked that, wiping out what had just been
   * chosen. A box that is never replaced has none of that: Tab simply goes on
   * to the next field. Only the figures below are redrawn.
   */
  function mount() {
    host.innerHTML = '';
    ctl = buildControls();
    body = el('div', { class: 'report-body' });
    host.append(topbar(isIncome ? 'Income Report' : 'Expense Report',
      el('button', { class: 'btn sm', onclick: () => exportCSV(rows) }, '⬇ CSV')), ctl.bar, body);
    draw();
  }

  /** "Sub · Category" pairs travel as one value, so a sub knows whose it is. */
  const subKey = (parent, sub) => JSON.stringify([parent, sub]);
  const all = label => ({ value: 'All', search: label, label });
  /** A value that is in force must always be in its own list, or the box shows blank. */
  const keep = (list, value, label = value) =>
    (value === 'All' || list.some(o => o.value === value)) ? list : [...list, { value, search: label, label }];

  function subOptions() {
    const rowsOf = parent => DB.categories.filter(c => c.type === kind && c.sub && c.active !== false
      && (!parent || c.parent === parent));
    let list;
    if (f.parent !== 'All') {
      list = C.subsFor(kind, f.parent).map(s => ({ value: subKey(f.parent, s), search: s, label: s }));
    } else {
      // No category chosen: every sub of this type is on offer, the same as the
      // New Transaction sheet — naming "Diesel" is enough, and picking it fills
      // in the category it belongs to. The category is shown beside each one,
      // because the same sub can sit under two of them.
      const seen = new Set();
      list = [];
      for (const c of rowsOf(null)) {
        const k = subKey(c.parent, c.sub);
        if (seen.has(k)) continue;
        seen.add(k);
        list.push({ value: k, search: c.sub, label: `${c.sub} · ${c.parent}` });
      }
      list.sort((a, b) => a.label.localeCompare(b.label));
    }
    list = [all('All sub-categories'), ...list];
    return f.sub === 'All' ? list : keep(list, subKey(f.parent, f.sub), f.sub);
  }

  function buildControls() {
    // Year and month stay plain lists: a dozen entries, walked with the arrows.
    const plain = (key, opts, allLabel) => {
      const s = el('select', { 'data-fk': key }, el('option', { value: 'All' }, allLabel),
        ...opts.map(o => el('option', { value: o.v ?? o }, o.t ?? o)));
      s.addEventListener('change', () => { f[key] = s.value; draw(); });
      return s;
    };
    const year = plain('year', C.yearsPresent(), 'All years');
    const month = plain('month', MONTHS.map((m, i) => ({ v: i + 1, t: m })), 'All months');

    // Category, Sub-category and Account can run to dozens of entries, and a
    // plain <select> only jumps to one whose FIRST letter matches what was
    // just typed — so finding "Cake Business" meant remembering it starts
    // with C, not that it has "Business" in it. The search box matches any
    // word in the name, and behaves the same on every key (see searchSelect).
    const cat = searchSelect([], { placeholder: 'All categories' });
    cat.dataset.fk = 'parent';
    cat.addEventListener('change', () => { f.parent = cat.value; f.sub = 'All'; draw(); });

    const sub = searchSelect([], { placeholder: 'All sub-categories' });
    sub.dataset.fk = 'sub';
    sub.addEventListener('change', () => {
      if (sub.value === 'All') f.sub = 'All';
      else { const [p, s] = JSON.parse(sub.value); f.parent = p; f.sub = s; }
      draw();
    });

    const acct = searchSelect([], { placeholder: 'All accounts' });
    acct.dataset.fk = 'account';
    acct.addEventListener('change', () => { f.account = acct.value; draw(); });

    const description = el('input', { type: 'search', placeholder: 'Search description…', value: f.description,
      'data-fk': 'description' });
    // The box survives the redraw now, so there is no cursor to hand back —
    // the figures simply follow the typing, a beat behind it.
    description.addEventListener('input', debounce(() => {
      f.description = description.value;
      redraw(host.querySelector('.jf-bd'));
    }, 150));

    const clear = el('button', { class: 'btn sm', onclick: () => { f = blank(); description.value = ''; draw(); } }, 'Clear');

    const bar = el('div', { class: 'filters report-filters' },
      el('div', { class: 'field compact-filter' }, el('label', {}, 'Year'), year),
      el('div', { class: 'field compact-filter' }, el('label', {}, 'Month'), month),
      el('div', { class: 'field' }, el('label', {}, 'Category'), cat),
      el('div', { class: 'field' }, el('label', {}, 'Sub-category'), sub),
      el('div', { class: 'field' }, el('label', {}, 'Account'), acct),
      el('div', { class: 'field' }, el('label', {}, ' '), clear),
      el('div', { class: 'field report-description' }, el('label', {}, 'Description'), description));
    return { bar, year, month, cat, sub, acct, description };
  }

  /**
   * Make every control say what the filters actually are. A tap in the
   * breakdown, a crumb, Clear, a deep link or a sync can all change the filters
   * without anybody touching the bar, and the bar has to keep up.
   */
  function syncControls() {
    const { year, month, cat, sub, acct, description } = ctl;
    const years = C.yearsPresent().map(String);
    const listed = [...year.options].slice(1).map(o => o.value);
    if (years.join() !== listed.join() && document.activeElement !== year) {
      year.replaceChildren(el('option', { value: 'All' }, 'All years'),
        ...years.map(y => el('option', { value: y }, y)));
    }
    for (const [s, v] of [[year, f.year], [month, f.month]]) {
      s.value = String(v);
      if (s.selectedIndex < 0) s.selectedIndex = 0;
    }
    cat.setOptions(keep([all('All categories'), ...C.parentsFor(kind).map(p => ({ value: p, search: p, label: p }))], f.parent));
    cat.value = f.parent;
    sub.setOptions(subOptions());
    sub.value = f.sub === 'All' ? 'All' : subKey(f.parent, f.sub);
    acct.setOptions(keep([all('All accounts'), ...C.accountNames().map(a => ({ value: a, search: a, label: a }))], f.account));
    acct.value = f.account;
    if (document.activeElement !== description && description.value !== f.description) description.value = f.description;
  }

  function draw() {
    if (!body) return;
    syncControls();
    const S = SERIES();
    const color = isIncome ? S.income : S.expense;
    body.innerHTML = '';
    const host = body;                      // everything below lands in the body, under the bar
    const flt = { ...f, type: kind };
    rows = C.filterTx(flt);
    const totSAR = rows.reduce((s, t) => s + (t.currency === 'SAR' ? (isIncome ? +t.income : +t.expense) || 0 : 0), 0);
    const totINR = rows.reduce((s, t) => s + (t.currency !== 'SAR' ? (isIncome ? +t.income : +t.expense) || 0 : 0), 0);
    const totEq = rows.reduce((s, t) => s + (isIncome ? C.inrOf(t) : C.inrOut(t)), 0);

    // --------------------------------------------------------------- KPIs -
    host.append(el('div', { class: 'grid g4 keep2' },
      kpi('In SAR', money(totSAR, 'SAR', false)),
      kpi('In INR', money(totINR, 'INR', false)),
      kpi(isIncome ? 'Total ≈ INR' : 'Total ≈ INR', money(totEq, 'INR', false), isIncome ? 'income' : 'expense'),
      kpi('Entries', rows.length.toLocaleString('en-IN'))));

    // ------------------------------------------- monthly + yearly totals --
    const reportFilter = { parent: f.parent, sub: f.sub, account: f.account, description: f.description };
    const monthly = C.monthlyTotals(kind, f.year, reportFilter);
    const yearly = C.yearlyTotals(kind, reportFilter);

    const chartCard = el('div', { class: 'card', style: 'margin-top:12px' },
      el('div', { class: 'card-head' }, el('h3', {},
        f.year === 'All' ? 'Totals by year' : `Monthly totals — ${f.year}`)));
    const ch = el('div', {}); chartCard.append(ch); host.append(chartCard);
    requestAnimationFrame(() => groupedBars(ch, {
      labels: f.year === 'All' ? yearly.map(r => String(r.year)) : MON3,
      series: [{ name: (isIncome ? '▲ Income' : '▼ Expense') + ' (≈ INR)', color,
                 values: f.year === 'All' ? yearly.map(r => r.equiv) : monthly.map(r => r.equiv) }],
    }));

    const tables = el('div', { class: 'grid g2', style: 'margin-top:12px' });
    tables.append(tableCard(`Monthly totals — ${f.year === 'All' ? 'all years' : f.year}`,
      ['Month', 'SAR', 'INR', '≈ INR'],
      monthly.map(r => [r.month, num(r.sar), num(r.inr), num(r.equiv)]),
      ['YEAR TOTAL', num(monthly.reduce((s, r) => s + r.sar, 0)), num(monthly.reduce((s, r) => s + r.inr, 0)), num(monthly.reduce((s, r) => s + r.equiv, 0))]));
    tables.append(tableCard('Yearly totals — all years',
      ['Year', 'SAR', 'INR', '≈ INR'],
      yearly.map(r => [r.year, num(r.sar), num(r.inr), num(r.equiv)]),
      ['ALL TOTAL', num(yearly.reduce((s, r) => s + r.sar, 0)), num(yearly.reduce((s, r) => s + r.inr, 0)), num(yearly.reduce((s, r) => s + r.equiv, 0))]));
    host.append(tables);

    // ------------------------------------------------------- breakdown ----
    // Tapping a bar goes a level in. The trail across the top is how you get
    // back out again — without it, drilling in was a room with no door.
    const stepOut = () => {
      if (f.sub !== 'All') f.sub = 'All';
      else if (f.parent !== 'All') { f.parent = 'All'; f.sub = 'All'; }
      redraw(bdCard);
    };
    const crumb = (text, onto, last) => (last
      ? el('span', { class: 'crumb here' }, text)
      : el('button', { class: 'crumb', onclick: onto }, text));
    const trail = el('div', { class: 'crumbs' },
      crumb('All categories', () => { f.parent = 'All'; f.sub = 'All'; redraw(bdCard); }, f.parent === 'All'),
      ...(f.parent === 'All' ? [] : [
        el('span', { class: 'crumb-sep' }, '›'),
        crumb(f.parent, () => { f.sub = 'All'; redraw(bdCard); }, f.sub === 'All'),
      ]),
      ...(f.sub === 'All' ? [] : [
        el('span', { class: 'crumb-sep' }, '›'),
        crumb(f.sub, null, true),
      ]));

    const deep = f.parent !== 'All' || f.sub !== 'All';
    const bdCard = el('div', { class: 'card jf-bd', style: 'margin-top:12px' },
      el('div', { class: 'card-head' },
        el('h3', {}, f.sub !== 'All' ? `Inside ${f.sub}`
          : f.parent === 'All' ? 'Breakdown by category' : `Breakdown inside ${f.parent}`),
        el('div', { class: 'spacer' }),
        deep ? el('button', { class: 'btn sm', onclick: stepOut }, '← Back') : null),
      trail);
    const bd = el('div', {}); bdCard.append(bd);
    const breakdown = f.parent === 'All'
      ? C.bySource(kind, flt)
      : C.bySub(kind, f.parent, flt);
    if (!breakdown.length) {
      bd.append(el('p', { class: 'small muted', style: 'margin:6px 2px' }, 'Nothing in this period.'));
    } else barList(bd, breakdown.slice(0, 25).map(r => ({
      label: r.name, value: r.equiv, color,
      sub: [r.sar ? num(r.sar, 0) + ' SAR' : null, r.inr ? '₹' + num(r.inr, 0) : null].filter(Boolean).join(' + '),
    })), {
      format: v => money(v, 'INR', false),
      onClick: f.sub !== 'All' ? null
        : r => {
          if (f.parent === 'All') { f.parent = r.label; f.sub = 'All'; } else { f.sub = r.name || r.label; }
          redraw(bdCard);
        },
    });
    host.append(bdCard);
    escapeOut = deep ? stepOut : null;      // Esc steps back out, for a keyboard

    // ------------------------------------------------------- detail rows --
    const detCard = el('div', { class: 'card', style: 'margin-top:12px' },
      el('div', { class: 'card-head' }, el('h3', {}, `Transaction details (${rows.length.toLocaleString('en-IN')})`)));
    const t = el('table');
    t.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Date'), el('th', {}, 'Account'), el('th', {}, 'Category'), el('th', {}, 'Sub'),
      el('th', { class: 'n' }, 'SAR'), el('th', { class: 'n' }, 'INR'), el('th', {}, 'Description'))));
    const tb = el('tbody');
    for (const r of rows.slice().reverse().slice(0, 400)) {
      const amt = isIncome ? +r.income || 0 : +r.expense || 0;
      tb.append(el('tr', { style: 'cursor:pointer', onclick: () => openTxEditor(r) },
        el('td', {}, fmtDate(r.date)), el('td', {}, r.account),
        el('td', {}, r.parent || ''), el('td', {}, r.sub || ''),
        el('td', { class: 'n ' + (isIncome ? 'in' : 'out') }, r.currency === 'SAR' ? num(amt) : ''),
        el('td', { class: 'n ' + (isIncome ? 'in' : 'out') }, r.currency !== 'SAR' ? num(amt) : ''),
        el('td', { class: 'wrap' }, r.note || '')));
    }
    t.append(tb);
    detCard.append(el('div', { class: 'table-wrap', style: 'max-height:520px;overflow:auto' }, t));
    if (rows.length > 400) detCard.append(el('p', { class: 'small muted', style: 'margin:8px 0 0' },
      'Latest 400 shown · CSV has all.'));
    host.append(detCard);
  }

  function exportCSV(rows) {
    const head = ['Date', 'Account', 'Type', 'Category', 'Sub Category', 'Payee', 'Currency', 'Amount', '≈ INR', 'Description'];
    const body = rows.slice().reverse().map(r => [r.date, r.account, r.type, r.parent || '', r.sub || '', r.payee || '',
      r.currency, (isIncome ? r.income : r.expense) || 0, (isIncome ? C.inrOf(r) : C.inrOut(r)).toFixed(2), r.note || '']);
    downloadCSV(`jinnyfin-${kind.toLowerCase()}-${todayISO()}.csv`, [head, ...body]);
  }

  return {
    render: async root => {
      host = root;
      // Arrived from a tap on a category somewhere else (the dashboard's
      // "Expense by source", say). Open on that category, in the month that was
      // on screen there, and put the breakdown under the thumb instead of
      // leaving it to be scrolled to and filtered again by hand.
      const q = new URLSearchParams(location.hash.split('?')[1] || '');
      const wanted = q.get('parent');
      if (wanted) {
        // ?sub= comes from an insurance card's "History" link: straight to that
        // one sub-category, across every year it was ever paid.
        f = { ...f, parent: wanted, sub: q.get('sub') || 'All',
          year: q.get('year') || f.year, month: q.get('month') || f.month, account: 'All', description: '' };
      }
      mount();
      if (wanted) requestAnimationFrame(() =>
        host.querySelector('.jf-bd')?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    },
    // A sync landing while you are reading must not move the page either —
    // nor touch the filter bar he may be typing in: only the body is redrawn.
    refresh: () => { if (host && body?.isConnected) redraw(host.querySelector('.jf-bd')); },
  };
}

/**
 * Expense Report and Income Report are the same screen with one flag flipped,
 * so the router loads THIS module for both instead of a wrapper file each.
 * Cached per kind so filters survive when you navigate away and back.
 */
const views = {};
export function view(kind) {
  if (!views[kind]) views[kind] = makeReport(kind);
  return views[kind];
}

export function kpi(label, value, cls = '') {
  return el('div', { class: 'card tight stat ' + cls },
    el('div', { class: 'label' }, label), el('div', { class: 'value tnum', style: 'font-size:20px' }, value));
}

/**
 * The same figures twice: the full table for a wide screen, and a two-column
 * version for a phone where four money columns meant sliding sideways to reach
 * the one that matters. CSS decides which of the two is on show.
 */
export function tableCard(title, headers, rows, totalRow) {
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { class: i ? 'n' : '' }, h)))));
  const tb = el('tbody');
  for (const r of rows) tb.append(el('tr', {}, r.map((c, i) => el('td', { class: i ? 'n' : '' }, String(c)))));
  if (totalRow) tb.append(el('tr', { class: 'total' }, totalRow.map((c, i) => el('td', { class: i ? 'n' : '' }, String(c)))));
  t.append(tb);

  const last = headers.length - 1;                    // the ≈ INR column
  const sub = (r) => headers.slice(1, last)
    .map((h, i) => `${h} ${r[i + 1]}`)
    .filter((s, i) => String(r[i + 1]).replace(/[0.,]/g, '') !== '')   // hide a column of zeros
    .join('  ·  ');
  const narrow = el('table', { class: 'sum-narrow' });
  narrow.append(el('thead', {}, el('tr', {},
    el('th', {}, headers[0]), el('th', { class: 'n' }, headers[last]))));
  const ntb = el('tbody');
  const line = (r, cls) => el('tr', cls ? { class: cls } : {},
    el('td', {}, String(r[0]), sub(r) ? el('div', { class: 'small muted' }, sub(r)) : null),
    el('td', { class: 'n' }, String(r[last])));
  for (const r of rows) ntb.append(line(r));
  if (totalRow) ntb.append(line(totalRow, 'total'));
  narrow.append(ntb);

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, title)),
    el('div', { class: 'table-wrap sum-wide' }, t),
    el('div', { class: 'table-wrap sum-thin' }, narrow));
}
