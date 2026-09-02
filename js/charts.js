// ============================================================================
//  charts.js — small dependency-free SVG charts.
//  Rules followed: one axis, thin marks, 2px rounded data-ends, 2px gaps
//  between adjacent fills, recessive grid, legend whenever there are ≥2 series,
//  direct labels, and a hover tooltip on every plot.
// ============================================================================
import { el, compact, money } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// --------------------------------------------------------------- tooltip ---
let tipEl = null;
function showTip(html, ev) {
  if (!tipEl) { tipEl = el('div', { class: 'tip' }); document.body.append(tipEl); }
  tipEl.innerHTML = html;
  tipEl.style.display = 'block';
  const r = tipEl.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY - r.height - 10;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y < 8) y = ev.clientY + 16;
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
document.addEventListener('scroll', hideTip, true);

// --------------------------------------------------------------- helpers ---
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function yTicks(max, min = 0, count = 4) {
  const out = []; const step = (max - min) / count;
  for (let i = 0; i <= count; i++) out.push(min + step * i);
  return out;
}

/**
 * Grouped vertical bars. series = [{ name, color, values:[] }]
 * Always renders a legend (≥2 series) — colour never carries identity alone.
 */
export function groupedBars(host, { labels, series, format = compact, tipFormat = v => money(v, 'INR'), height = 210 }) {
  host.innerHTML = '';
  const W = Math.max(host.clientWidth || 640, 320), H = height;
  const padL = 46, padR = 8, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const flat = series.flatMap(s => s.values);
  const max = niceMax(Math.max(1, ...flat));
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, height: H, preserveAspectRatio: 'none' });

  for (const t of yTicks(max)) {
    const y = padT + ih - (t / max) * ih;
    svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: cssVar('--grid'), 'stroke-width': 1 }));
    const tx = svgEl('text', { x: padL - 7, y: y + 4, 'text-anchor': 'end', fill: cssVar('--ink-3'), 'font-size': 10.5 });
    tx.textContent = format(t); svg.append(tx);
  }

  const n = labels.length, slot = iw / n, gap = 2;
  const bw = Math.max(3, (slot * 0.62 - gap * (series.length - 1)) / series.length);
  labels.forEach((lab, i) => {
    const cx = padL + slot * i + slot / 2;
    const totalW = bw * series.length + gap * (series.length - 1);
    series.forEach((s, si) => {
      const v = s.values[i] || 0;
      const h = Math.max(v > 0 ? 2 : 0, (v / max) * ih);
      const x = cx - totalW / 2 + si * (bw + gap);
      const y = padT + ih - h;
      const r = svgEl('rect', { x, y, width: bw, height: h, rx: Math.min(4, bw / 2), fill: s.color });
      r.style.cursor = 'pointer';
      r.addEventListener('pointerenter', e => showTip(
        `<b>${lab}</b>${series.map(ss => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${ss.color};margin-right:5px"></i>${ss.name}: ${tipFormat(ss.values[i] || 0)}</div>`).join('')}`, e));
      r.addEventListener('pointermove', e => showTip(tipEl.innerHTML, e));
      r.addEventListener('pointerleave', hideTip);
      svg.append(r);
    });
    if (n <= 14 || i % Math.ceil(n / 12) === 0) {
      const t = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', fill: cssVar('--ink-3'), 'font-size': 10.5 });
      t.textContent = lab; svg.append(t);
    }
  });
  svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: padT + ih, y2: padT + ih, stroke: cssVar('--axis'), 'stroke-width': 1 }));
  host.append(svg);
  if (series.length >= 2) host.append(legend(series));
  return svg;
}

/** Single-series line with a crosshair. A lone series needs no legend box. */
export function lineChart(host, { labels, values, color, format = compact, tipFormat = v => money(v, 'INR'), height = 210, fill = true }) {
  host.innerHTML = '';
  const W = Math.max(host.clientWidth || 640, 320), H = height;
  const padL = 52, padR = 10, padT = 12, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const lo = Math.min(0, ...values), hi = niceMax(Math.max(1, ...values));
  const col = color || cssVar('--s1');
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, height: H, preserveAspectRatio: 'none' });
  const X = i => padL + (values.length === 1 ? iw / 2 : (i / (values.length - 1)) * iw);
  const Y = v => padT + ih - ((v - lo) / (hi - lo || 1)) * ih;

  for (const t of yTicks(hi, lo)) {
    const y = Y(t);
    svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: cssVar('--grid'), 'stroke-width': 1 }));
    const tx = svgEl('text', { x: padL - 7, y: y + 4, 'text-anchor': 'end', fill: cssVar('--ink-3'), 'font-size': 10.5 });
    tx.textContent = format(t); svg.append(tx);
  }
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  if (fill) {
    const grad = svgEl('linearGradient', { id: 'g' + Math.random().toString(36).slice(2), x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(svgEl('stop', { offset: '0%', 'stop-color': col, 'stop-opacity': .22 }));
    grad.append(svgEl('stop', { offset: '100%', 'stop-color': col, 'stop-opacity': 0 }));
    svg.append(grad);
    svg.append(svgEl('path', { d: `${d} L${X(values.length - 1)},${Y(lo)} L${X(0)},${Y(lo)} Z`, fill: `url(#${grad.id})` }));
  }
  svg.append(svgEl('path', { d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // last point gets a direct label
  if (values.length) {
    const li = values.length - 1;
    svg.append(svgEl('circle', { cx: X(li), cy: Y(values[li]), r: 4, fill: col, stroke: cssVar('--surface'), 'stroke-width': 2 }));
  }
  const cross = svgEl('line', { y1: padT, y2: padT + ih, stroke: cssVar('--axis'), 'stroke-width': 1, opacity: 0 });
  const dot = svgEl('circle', { r: 4.5, fill: col, stroke: cssVar('--surface'), 'stroke-width': 2, opacity: 0 });
  svg.append(cross, dot);
  const hit = svgEl('rect', { x: padL, y: padT, width: iw, height: ih, fill: 'transparent' });
  hit.style.cursor = 'crosshair';
  hit.addEventListener('pointermove', e => {
    const bb = svg.getBoundingClientRect();
    const rel = (e.clientX - bb.left) / bb.width * W;
    let i = Math.round(((rel - padL) / iw) * (values.length - 1));
    i = Math.max(0, Math.min(values.length - 1, i));
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', .6);
    dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(values[i])); dot.setAttribute('opacity', 1);
    showTip(`<b>${labels[i]}</b>${tipFormat(values[i])}`, e);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip(); });
  svg.append(hit);

  const step = Math.ceil(labels.length / 7);
  labels.forEach((l, i) => {
    if (i % step && i !== labels.length - 1) return;
    const t = svgEl('text', { x: X(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle', fill: cssVar('--ink-3'), 'font-size': 10.5 });
    t.textContent = l; svg.append(t);
  });
  host.append(svg);
  return svg;
}

/** Ranked horizontal bars with the value printed on every row (direct labels). */
export function barList(host, rows, { color, max, format = v => money(v, 'INR'), onClick } = {}) {
  host.innerHTML = '';
  const top = max || Math.max(1, ...rows.map(r => Math.abs(r.value)));
  for (const r of rows) {
    const pct = Math.min(100, Math.abs(r.value) / top * 100);
    const node = el('div', { class: 'bar-row' },
      el('div', { class: 'lab' },
        el('span', {}, r.label),
        el('span', {}, format(r.value))),
      el('div', { class: 'bar-track' },
        el('div', { class: 'bar-fill', style: `width:${pct}%;background:${r.color || color || cssVar('--s1')}` })));
    if (onClick) { node.style.cursor = 'pointer'; node.addEventListener('click', () => onClick(r)); }
    if (r.sub) node.querySelector('.lab').firstChild.append(el('span', { class: 'muted small' }, ' · ' + r.sub));
    host.append(node);
  }
  if (!rows.length) host.append(el('p', { class: 'muted small' }, 'Nothing in this period.'));
}

export function legend(series) {
  return el('div', { class: 'legend' },
    series.map(s => el('span', {}, el('i', { style: `background:${s.color}` }), s.name)));
}

export const SERIES = () => ({
  income: cssVar('--income'), expense: cssVar('--expense'),
  s1: cssVar('--s1'), s2: cssVar('--s2'), s3: cssVar('--s3'), s4: cssVar('--s4'),
  s5: cssVar('--s5'), s6: cssVar('--s6'), s7: cssVar('--s7'), s8: cssVar('--s8'),
});
export const palette = () => [cssVar('--s1'), cssVar('--s2'), cssVar('--s3'), cssVar('--s4'),
  cssVar('--s5'), cssVar('--s6'), cssVar('--s7'), cssVar('--s8')];
