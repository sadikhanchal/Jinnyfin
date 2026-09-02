// ============================================================================
//  printable.js — the branded statement that goes on paper or into a PDF.
//  One template, used by the account statement and by a payee's ledger, so a
//  statement always looks the same whoever it is handed to.
// ============================================================================
import { esc, fmtDate, num, toast } from '../util.js';
import { getSettings } from '../store.js';

const OWNER_SITE = 'sadikhanchal.com';

/** Every column of a printed statement carries the year — a bank statement
 *  without one is useless the moment it leaves your hands. */
export const printDate = d => {
  const [y, m, dd] = String(d || '').split('-');
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return y ? `${dd} ${MON[+m - 1]} ${y}` : '';
};

/**
 * @param {object} o
 * @param {string} o.title      what this statement is of
 * @param {string} o.subtitle   who it concerns
 * @param {Array}  o.meta       [label, value] pairs for the top-right block
 * @param {Array}  o.head       column headings; those in `o.numeric` align right
 * @param {Array}  o.widths     column widths in %, so nothing runs off the paper
 * @param {Array}  o.rows       arrays of cells, already formatted
 * @param {Array}  o.opening    the row that carries the balance brought forward
 * @param {Array}  o.closing    the totals row
 * @param {string} o.standing   the one sentence the reader actually wants
 * @param {string} o.note       the small print under it
 */
export function printStatement(o) {
  const s = getSettings();
  const owner = s.owner_name || '';
  const numeric = new Set(o.numeric || []);
  const cell = (v, i, tag = 'td') =>
    `<${tag}${numeric.has(i) ? ' class="n"' : ''}>${esc(v ?? '')}</${tag}>`;

  const body = o.rows.length
    ? o.rows.map(r => '<tr>' + r.map((v, i) => cell(v, i)).join('') + '</tr>').join('')
    : `<tr><td colspan="${o.head.length}" style="text-align:center;padding:20px">Nothing in this period.</td></tr>`;

  const html = `
    <div class="st-head">
      <div class="st-brand">
        <img src="icons/icon-192.png" alt="">
        <div>
          <h1>Jinnyfin</h1>
          <div class="st-tag">Personal Finance</div>
        </div>
      </div>
      <div class="st-meta">
        ${o.meta.map(([k, v]) => `<div><b>${esc(k)}</b> ${esc(v)}</div>`).join('')}
      </div>
    </div>

    <div class="st-title">
      <h2>${esc(o.title)}</h2>
      ${o.subtitle ? `<div class="st-sub">${esc(o.subtitle)}</div>` : ''}
    </div>

    <table class="st-tbl">
      ${o.widths ? '<colgroup>' + o.widths.map(w => `<col style="width:${w}%">`).join('') + '</colgroup>' : ''}
      <thead><tr>${o.head.map((h, i) => cell(h, i, 'th')).join('')}</tr></thead>
      <tbody>
        ${o.opening ? '<tr class="st-open">' + o.opening.map((v, i) => cell(v, i)).join('') + '</tr>' : ''}
        ${body}
        ${o.closing ? '<tr class="st-close">' + o.closing.map((v, i) => cell(v, i)).join('') + '</tr>' : ''}
      </tbody>
    </table>

    ${o.standing ? `<p class="st-line">${o.standing}</p>` : ''}
    ${o.note ? `<p class="st-note">${o.note}</p>` : ''}

    <div class="st-foot">
      <div>
        <b>Jinnyfin</b> — designed and built by ${esc(owner || 'Sadikh Anchal')}
        &nbsp;·&nbsp; <span class="st-web">${OWNER_SITE}</span>
      </div>
      <div>Issued ${fmtDate(new Date().toISOString().slice(0, 10))}</div>
    </div>`;

  let box = document.getElementById('jf-print');
  if (!box) { box = document.createElement('div'); box.id = 'jf-print'; document.body.append(box); }
  box.innerHTML = html;
  document.documentElement.classList.add('printing');

  const clean = () => { document.documentElement.classList.remove('printing'); box.innerHTML = ''; };
  addEventListener('afterprint', clean, { once: true });

  // The logo has to be decoded before the print dialog freezes the page, or it
  // prints as an empty box.
  const img = box.querySelector('img');
  const go = () => { window.print(); setTimeout(clean, 1500); };
  if (img && !img.complete) { img.onload = go; img.onerror = go; setTimeout(go, 1200); }
  else setTimeout(go, 60);

  toast('Choose “Save as PDF” in the print dialog to send it', 'ok', 5000);
}

export { num };
