// Gráficos SVG simples (sem bibliotecas externas)
import { h } from './ui.js';
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of kids) if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export function barChart(data, { height = 200, format = (v) => v, color = '#0f766e' } = {}) {
  const W = 560; const H = height; const pad = { l: 8, r: 8, t: 22, b: 26 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = (W - pad.l - pad.r) / data.length;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Gráfico de barras' });
  svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b, class: 'axis' }));
  data.forEach((d, i) => {
    const bh = ((H - pad.t - pad.b) * d.value) / max;
    const x = pad.l + i * bw + bw * 0.2; const y = H - pad.b - bh;
    const last = i === data.length - 1;
    svg.append(s('rect', { x, y, width: bw * 0.6, height: Math.max(bh, d.value ? 2 : 0), rx: 4, fill: color, opacity: last ? 1 : 0.55 }, s('title', {}, `${d.label}: ${format(d.value)}`)));
    svg.append(s('text', { x: x + bw * 0.3, y: H - 8, 'text-anchor': 'middle' }, d.label));
    if (d.value) svg.append(s('text', { x: x + bw * 0.3, y: y - 6, 'text-anchor': 'middle', style: 'font-weight:600;fill:#3a4a55' }, format(d.value)));
  });
  return h('div', { class: 'chart' }, svg);
}

// Linha de dor (EVA) por sessão — séries múltiplas
export function lineChart(points, series, { height = 220, max = 10 } = {}) {
  const W = 620; const H = height; const pad = { l: 30, r: 14, t: 14, b: 30 };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Evolução da dor' });
  const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
  for (let v = 0; v <= max; v += 2) {
    const y = pad.t + ih - (ih * v) / max;
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: '#eef1f3' }));
    svg.append(s('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end' }, String(v)));
  }
  const n = points.length; const step = n > 1 ? iw / (n - 1) : 0;
  const xOf = (i) => pad.l + (n > 1 ? i * step : iw / 2);
  const every = Math.ceil(n / 12);
  points.forEach((p, i) => { if (i % every === 0 || i === n - 1) svg.append(s('text', { x: xOf(i), y: H - 10, 'text-anchor': 'middle' }, p.label)); });
  for (const se of series) {
    const pts = points.map((p, i) => (p[se.key] === '' || p[se.key] == null ? null : [xOf(i), pad.t + ih - (ih * Number(p[se.key])) / max, p[se.key], p.label]));
    const valid = pts.filter(Boolean);
    if (valid.length > 1) svg.append(s('polyline', { points: valid.map((p) => p.slice(0, 2).join(',')).join(' '), fill: 'none', stroke: se.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-dasharray': se.dash || null }));
    for (const p of valid) svg.append(s('circle', { cx: p[0], cy: p[1], r: 4, fill: '#fff', stroke: se.color, 'stroke-width': 2.5 }, s('title', {}, `${p[3]} — ${se.label}: ${p[2]}`)));
  }
  const legend = h('div', { class: 'legend', style: { marginTop: '6px' } }, series.map((se) => h('span', null, h('i', { style: { background: se.color } }), se.label)));
  return h('div', { class: 'chart' }, svg, legend);
}
