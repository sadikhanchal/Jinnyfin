// ============================================================================
//  equity.js — Geojit equity portfolio: open positions, realised P&L, dividends.
// ============================================================================
import { el, money, num, fmtDate, modal, toast, confirmBox, downloadCSV, todayISO } from '../util.js';
import { DB, put, remove } from '../store.js';
import * as C from '../calc.js';
import { barList, SERIES } from '../charts.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';

let host = null;

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

function draw() {
  const S = SERIES();
  host.innerHTML = '';
  const s = C.equitySummary();
  host.append(topbar('Equity Portfolio',
    el('button', { class: 'btn sm', onclick: () => editPos() }, '+ Position'),
    el('button', { class: 'btn sm', onclick: exportCSV }, '⬇ CSV')));

  host.append(el('div', { class: 'grid g4 keep2' },
    kpi('Invested cost', money(s.invested, 'INR', false)),
    kpi('Market value', money(s.marketValue, 'INR', false)),
    kpi('Unrealised P&L', money(s.unrealised, 'INR', false), s.unrealised >= 0 ? 'income' : 'expense'),
    kpi('Return %', (s.unrealisedPct * 100).toFixed(1) + '%', s.unrealised >= 0 ? 'income' : 'expense')));

  host.append(el('div', { class: 'grid g4 keep2', style: 'margin-top:12px' },
    kpi('Realised P&L', money(s.realised, 'INR', false), s.realised >= 0 ? 'income' : 'expense'),
    kpi('Dividends', money(s.dividends, 'INR', false), 'income'),
    kpi('Charges & taxes', money(s.charges, 'INR', false), 'expense'),
    kpi('NET TOTAL RETURN', money(s.netReturn, 'INR', false), s.netReturn >= 0 ? 'income' : 'expense')));

  // ------------------------------------------------------- open positions -
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, el('th', {}, 'Symbol'), el('th', {}, 'Company'),
    el('th', { class: 'n' }, 'Qty'), el('th', { class: 'n' }, 'Avg cost'), el('th', { class: 'n' }, 'Invested'),
    el('th', { class: 'n' }, 'Price'), el('th', { class: 'n' }, 'Market value'),
    el('th', { class: 'n' }, 'P&L'), el('th', { class: 'n' }, 'Return %'))));
  const tb = el('tbody');
  for (const p of s.open) {
    const inv = (+p.qty || 0) * (+p.avg_cost || 0), mv = (+p.qty || 0) * (+p.price || 0);
    const pl = mv - inv;
    tb.append(el('tr', { style: 'cursor:pointer', onclick: () => editPos(p) },
      el('td', {}, el('b', {}, p.symbol)), el('td', {}, p.company || ''),
      el('td', { class: 'n' }, num(p.qty, 0)), el('td', { class: 'n' }, num(p.avg_cost)),
      el('td', { class: 'n' }, num(inv, 0)), el('td', { class: 'n' }, num(p.price)),
      el('td', { class: 'n' }, num(mv, 0)),
      el('td', { class: 'n ' + (pl >= 0 ? 'pos' : 'neg') }, num(pl, 0)),
      el('td', { class: 'n ' + (pl >= 0 ? 'pos' : 'neg') }, inv ? (pl / inv * 100).toFixed(1) + '%' : '–')));
  }
  tb.append(el('tr', { class: 'total' }, el('td', {}, 'TOTAL'), el('td', {}),
    el('td', { class: 'n' }, num(s.qty, 0)), el('td', {}), el('td', { class: 'n' }, num(s.invested, 0)),
    el('td', {}), el('td', { class: 'n' }, num(s.marketValue, 0)),
    el('td', { class: 'n' }, num(s.unrealised, 0)), el('td', { class: 'n' }, (s.unrealisedPct * 100).toFixed(1) + '%')));
  t.append(tb);
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Open positions'), el('div', { class: 'spacer' }),
      el('span', { class: 'small muted' }, 'priced ' + (s.open[0]?.price_date ? fmtDate(s.open[0].price_date) : 'manually'))),
    el('div', { class: 'table-wrap' }, t)));

  // --------------------------------------------------------- closed lots --
  const winners = s.closed.filter(p => (+p.realised || 0) > 0).sort((a, b) => b.realised - a.realised).slice(0, 8);
  const losers = s.closed.filter(p => (+p.realised || 0) < 0).sort((a, b) => a.realised - b.realised).slice(0, 8);
  const two = el('div', { class: 'grid g2', style: 'margin-top:12px' });
  const w = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, '▲ Best closed trades')));
  const wl = el('div', {}); w.append(wl);
  barList(wl, winners.map(p => ({ label: p.symbol, value: +p.realised, color: S.income, sub: p.company })), { format: v => money(v, 'INR', false) });
  const l = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, '▼ Worst closed trades')));
  const ll = el('div', {}); l.append(ll);
  barList(ll, losers.map(p => ({ label: p.symbol, value: Math.abs(+p.realised), color: S.expense, sub: p.company })), { format: v => '−' + money(v, 'INR', false) });
  two.append(w, l);
  host.append(two);

  const ct = el('table');
  ct.append(el('thead', {}, el('tr', {}, el('th', {}, 'Symbol'), el('th', {}, 'Company'),
    el('th', { class: 'n' }, 'Buy qty'), el('th', { class: 'n' }, 'Buy value'),
    el('th', { class: 'n' }, 'Sell qty'), el('th', { class: 'n' }, 'Sell value'),
    el('th', { class: 'n' }, 'Realised P&L'), el('th', { class: 'n' }, 'Return %'), el('th', { class: 'n' }, 'Dividends'))));
  const ctb = el('tbody');
  for (const p of s.closed.sort((a, b) => (b.realised || 0) - (a.realised || 0))) {
    ctb.append(el('tr', { style: 'cursor:pointer', onclick: () => editPos(p) },
      el('td', {}, el('b', {}, p.symbol)), el('td', {}, p.company || ''),
      el('td', { class: 'n' }, num(p.buy_qty, 0)), el('td', { class: 'n' }, num(p.buy_value, 0)),
      el('td', { class: 'n' }, num(p.sell_qty, 0)), el('td', { class: 'n' }, num(p.sell_value, 0)),
      el('td', { class: 'n ' + ((+p.realised || 0) >= 0 ? 'pos' : 'neg') }, num(p.realised, 0)),
      el('td', { class: 'n' }, p.buy_value ? ((+p.realised / +p.buy_value) * 100).toFixed(1) + '%' : '–'),
      el('td', { class: 'n' }, p.dividends ? num(p.dividends, 0) : '–')));
  }
  ct.append(ctb);
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, `Closed positions (${s.closed.length})`)),
    el('div', { class: 'table-wrap', style: 'max-height:60vh;overflow:auto' }, ct)));

  // ------------------------------------------------------- trade ledger ---
  const trades = [...DB.equity_trades].sort((a, b) => (a.date < b.date ? 1 : -1));
  if (trades.length) {
    const lt = el('table');
    lt.append(el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Symbol'),
      el('th', {}, 'Exchange'), el('th', {}, 'Action'), el('th', { class: 'n' }, 'Qty'),
      el('th', { class: 'n' }, 'Rate'), el('th', { class: 'n' }, 'Value'), el('th', {}, 'Source'))));
    const ltb = el('tbody');
    for (const t of trades) {
      ltb.append(el('tr', {}, el('td', {}, fmtDate(t.date)), el('td', {}, el('b', {}, t.symbol)),
        el('td', { class: 'muted small' }, t.exchange || ''),
        el('td', { style: `color:${t.action === 'Sell' ? S.income : S.s1}` }, t.action || ''),
        el('td', { class: 'n' }, num(t.qty, 0)), el('td', { class: 'n' }, num(t.rate)),
        el('td', { class: 'n' }, num(t.value, 0)), el('td', { class: 'muted small' }, t.source || '')));
    }
    lt.append(ltb);
    host.append(el('div', { class: 'card', style: 'margin-top:12px' },
      el('div', { class: 'card-head' }, el('h3', {}, `Trade ledger (${trades.length} trades)`)),
      el('div', { class: 'table-wrap', style: 'max-height:60vh;overflow:auto' }, lt)));
  }
}

function editPos(p = null) {
  const v = p || { symbol: '', company: '', qty: 0, avg_cost: 0, price: 0, price_date: todayISO(), closed: false,
    buy_qty: 0, buy_value: 0, sell_qty: 0, sell_value: 0, realised: 0, dividends: 0 };
  const inp = (k, type = 'number', step = 'any') => el('input', { type, step, value: v[k] ?? '' });
  const symbol = el('input', { value: v.symbol, placeholder: 'TMPV' });
  const company = el('input', { value: v.company || '', placeholder: 'Tata Motors Passenger Veh' });
  const qty = inp('qty'), avg = inp('avg_cost'), price = inp('price');
  const pdate = el('input', { type: 'date', value: v.price_date || todayISO() });
  const closed = el('input', { type: 'checkbox', checked: !!v.closed });
  const bq = inp('buy_qty'), bv = inp('buy_value'), sq = inp('sell_qty'), sv = inp('sell_value');
  const real = inp('realised'), div = inp('dividends');
  const closedBox = el('div', { class: 'form-grid full', style: v.closed ? '' : 'display:none' },
    fld('Buy qty', bq), fld('Buy value', bv), fld('Sell qty', sq), fld('Sell value', sv),
    fld('Realised P&L', real), fld('Dividends', div));
  closed.onchange = () => { closedBox.style.display = closed.checked ? '' : 'none'; };

  function fld(l, n, cls = '') { return el('div', { class: 'field ' + cls }, el('label', {}, l), n); }
  const body = el('div', { class: 'form-grid' },
    fld('Symbol', symbol), fld('Company', company),
    fld('Quantity held', qty), fld('Average cost', avg),
    fld('Market price', price), fld('Price date', pdate),
    el('label', { class: 'field full row', style: 'flex-direction:row;align-items:center;gap:8px' }, closed, ' This position is closed'),
    closedBox);
  const m = modal(p ? 'Edit position' : 'Add position', body, {
    footer: [
      p ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Delete this position?')) { await remove('equity_positions', p.id); m.close(); } } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!symbol.value.trim()) return toast('Symbol?', 'warn');
        await put('equity_positions', { ...v, symbol: symbol.value.trim().toUpperCase(), company: company.value.trim(),
          qty: +qty.value || 0, avg_cost: +avg.value || 0, price: +price.value || 0, price_date: pdate.value,
          closed: closed.checked, buy_qty: +bq.value || 0, buy_value: +bv.value || 0,
          sell_qty: +sq.value || 0, sell_value: +sv.value || 0, realised: +real.value || 0, dividends: +div.value || 0 });
        m.close();
      } }, 'Save'),
    ].filter(Boolean),
  });
}

function exportCSV() {
  const rows = DB.equity_positions.map(p => [p.symbol, p.company || '', p.closed ? 'closed' : 'open',
    p.qty, p.avg_cost, p.price, p.buy_qty, p.buy_value, p.sell_qty, p.sell_value, p.realised, p.dividends]);
  downloadCSV(`jinnyfin-equity-${todayISO()}.csv`,
    [['Symbol', 'Company', 'Status', 'Qty', 'Avg cost', 'Price', 'Buy qty', 'Buy value', 'Sell qty', 'Sell value', 'Realised', 'Dividends'], ...rows]);
}
