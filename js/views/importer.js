// ============================================================================
//  importer.js — one-time load of the workbook export into the app.
// ============================================================================
import { el, modal, toast, uuid, todayISO } from '../util.js';
import { putMany, setSettings, sync, state } from '../store.js';

export function runImport() {
  const bar = el('div', {}); const fill = el('div', { style: 'width:0%' });
  bar.append(el('div', { class: 'progress' }, fill));
  const log = el('p', { class: 'small muted' }, 'Fetching data/seed-data.json…');
  const m = modal('Importing your ledger', el('div', { class: 'grid', style: 'gap:10px' },
    el('p', { class: 'small' }, 'Loading everything from MISA Entry 06.xlsm. Keep this tab open — it takes a minute or two the first time, mostly uploading to Supabase.'),
    bar, log));

  const step = (pct, msg) => { fill.style.width = pct + '%'; log.textContent = msg; };

  (async () => {
    try {
      const res = await fetch('data/seed-data.json');
      if (!res.ok) throw new Error('seed-data.json not found in the data/ folder');
      const D = await res.json();
      step(8, `Read ${D.transactions.length.toLocaleString('en-IN')} transactions.`);

      // ---- reference tables ------------------------------------------------
      await putMany('accounts', D.accounts.map(a => ({
        id: uuid(), name: a.name, currency: a.currency, grp: a.group,
        opening_bal: 0, active: a.active !== false, sort: 0,
      })));
      step(14, 'Accounts in.');

      await putMany('categories', D.categories.map(c => ({
        id: uuid(), type: c.type || 'Expense', parent: c.parent, sub: c.sub || null,
      })));
      step(20, 'Categories in.');

      await putMany('payees', D.payees.map(p => ({ id: uuid(), name: p })));
      await putMany('fx_rates', D.fx_rates.map(r => ({
        id: uuid(), month: r.month, rate: r.rate, source: r.source,
      })));
      step(26, 'Exchange-rate history in.');

      await putMany('assets', D.assets.map(a => ({
        id: uuid(), name: a.name, category_tag: a.category_tag,
        opening_cost: a.opening_cost || 0, market_value: a.market_value || 0,
      })));
      await putMany('insurance', D.insurance.map(p => ({
        id: uuid(), label: p.label, policy: p.policy, renewal_date: p.renewal_date,
        notify_days: 30, kind: 'insurance', currency: 'INR',
      })));
      await putMany('businesses', D.businesses.map(b => ({
        id: uuid(), name: b.name, income_parent: b.income_parent, income_sub: b.income_sub,
        expense_parent: b.expense_parent, expense_sub: b.expense_sub,
      })));
      step(32, 'Assets, policies and businesses in.');

      const eq = D.equity;
      const pos = [
        ...eq.open_positions.map(p => ({
          id: uuid(), symbol: p.symbol, company: p.company, qty: p.qty, avg_cost: p.avg_cost,
          price: p.price, price_date: eq.valuation_date, closed: false, dividends: 0,
        })),
        ...eq.closed_positions.map(p => ({
          id: uuid(), symbol: p.symbol, company: p.company, qty: 0, avg_cost: 0, price: 0,
          closed: true, buy_qty: p.buy_qty, buy_value: p.buy_value, sell_qty: p.sell_qty,
          sell_value: p.sell_value, realised: p.realised, dividends: p.dividends,
        })),
      ];
      await putMany('equity_positions', pos);
      await putMany('equity_trades', (eq.trades || []).map(t => ({
        id: uuid(), date: t.date, symbol: t.symbol, company: t.company, exchange: t.exchange,
        action: t.action, qty: t.qty, rate: t.rate, value: t.value, source: t.source,
      })));
      step(38, 'Equity portfolio and trade ledger in.');

      // ---- transactions, in chunks ----------------------------------------
      const rows = D.transactions.map(t => ({
        id: uuid(), no: t.no, date: t.date, time: t.time, type: t.type, account: t.account,
        currency: t.currency, income: t.income || 0, expense: t.expense || 0,
        parent: t.parent, sub: t.sub, payee: t.payee, event: t.event, note: t.note, fx: t.fx || 1,
      }));
      const CH = 2000;
      for (let i = 0; i < rows.length; i += CH) {
        await putMany('transactions', rows.slice(i, i + CH));
        step(38 + Math.round((i / rows.length) * 42),
          `Transactions ${Math.min(i + CH, rows.length).toLocaleString('en-IN')} / ${rows.length.toLocaleString('en-IN')}`);
        await new Promise(r => setTimeout(r));
      }

      await setSettings({
        sar_to_inr: D.constants.sar_to_inr, usd_to_sar: D.constants.usd_to_sar,
        investment_categories: ['KSFE', 'Millionaire Federal Savings', 'PO Savings - Afiya', 'PO Savings - Lamiya'],
        seeded: todayISO(),
      });

      step(82, state.user ? 'Uploading to Supabase — this is the slow part…' : 'Saved locally.');
      await sync();
      step(100, 'Done.');
      toast('Workbook imported');
      setTimeout(() => { m.close(); location.reload(); }, 900);
    } catch (e) {
      console.error(e);
      log.textContent = 'Import failed: ' + (e.message || e);
      log.style.color = 'var(--critical)';
    }
  })();
}
