// Gerador de QR Code (modo byte, correção de erro nível M, versões 1 a 10), sem dependências.
// Usado para cadastrar a verificação em duas etapas no app autenticador.
const EC_M = [null, [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]], [16, [[4, 27]]], [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

// aritmética em GF(256), polinômio 0x11D
const EXP = new Array(512); const LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsRemainder(data, n) {
  let gen = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let k = 0; k < gen.length; k++) { next[k] ^= gen[k]; next[k + 1] ^= mul(gen[k], EXP[i]); }
    gen = next;
  }
  const msg = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const c = msg[i];
    if (c) for (let j = 1; j <= n; j++) msg[i + j] ^= mul(gen[j], c);
  }
  return msg.slice(data.length);
}

function encode(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const cap = EC_M[v][1].reduce((s, [n, k]) => s + n * k, 0) * 8;
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap) { ver = v; break; }
  }
  if (!ver) throw new Error('Texto longo demais para o QR Code');
  const [ecLen, groups] = EC_M[ver];
  const dataLen = groups.reduce((s, [n, k]) => s + n * k, 0);
  // bits: modo byte (0100), tamanho, dados, terminador, completar com 0xEC 0x11
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);
  // divide em blocos, calcula a correção e intercala
  const blocks = []; let off = 0;
  for (const [n, k] of groups) for (let i = 0; i < n; i++) { const d = data.slice(off, off + k); off += k; blocks.push({ d, e: rsRemainder(d, ecLen) }); }
  const out = [];
  const maxK = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxK; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return { ver, codewords: out };
}

function matrix(text) {
  const { ver, codewords } = encode(text);
  const size = 17 + ver * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  // padrões de localização
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  // alinhamento
  const al = ALIGN[ver];
  for (const ay of al) for (const ax of al) {
    if ((ax === 6 && ay === 6) || (ax === 6 && ay === al[al.length - 1]) || (ax === al[al.length - 1] && ay === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // linhas de sincronização
  for (let i = 0; i < size; i++) { if (!fn[6][i]) set(i, 6, i % 2 === 0); if (!fn[i][6]) set(6, i, i % 2 === 0); }
  // reserva a área do formato (preenchida depois) e o módulo escuro
  const formatCells = [];
  for (let i = 0; i <= 8; i++) { if (i !== 6) { formatCells.push([8, i], [i, 8]); } }
  for (let i = 0; i < 8; i++) formatCells.push([size - 1 - i, 8]);
  for (let i = 0; i < 7; i++) formatCells.push([8, size - 1 - i]);
  formatCells.forEach(([x, y]) => set(x, y, false));
  set(8, size - 8, true);
  // informação de versão (7+)
  if (ver >= 7) {
    const vi = VERSION_INFO[ver];
    for (let i = 0; i < 18; i++) {
      const bit = ((vi >>> i) & 1) === 1; const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }
  // dados em zigue-zague
  let bi = 0; const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j; const upward = ((right + 1) & 2) === 0; const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < total) { m[y][x] = ((codewords[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1; bi++; }
      }
    }
  }
  // escolhe a máscara com menor penalidade
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const drawFormat = (g, mask) => {
    const dataBits = mask; // nível M = 00
    let rem = dataBits;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((dataBits << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) g[i][8] = bit(i);
    g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8);
    for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) g[size - 15 + i][8] = bit(i);
    g[size - 8][8] = true;
  };
  const penalty = (g) => {
    let p = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let run = 1; const line = [];
        for (let b = 0; b < size; b++) line.push(pass ? g[b][a] : g[a][b]);
        for (let b = 1; b <= size; b++) {
          if (b < size && line[b] === line[b - 1]) run++;
          else { if (run >= 5) p += 3 + (run - 5); run = 1; }
        }
        const s = line.map((v) => (v ? 1 : 0)).join('');
        for (const pat of ['10111010000', '00001011101']) { let i = s.indexOf(pat); while (i >= 0) { p += 40; i = s.indexOf(pat, i + 1); } }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = g[y][x]; if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) p += 3;
    }
    const dark = g.flat().filter(Boolean).length; const tot = size * size;
    p += Math.max(0, Math.ceil(Math.abs(dark * 20 - tot * 10) / tot) - 1) * 10;
    return p;
  };
  let best = null;
  for (let k = 0; k < 8; k++) {
    const g = m.map((row, y) => row.map((v, x) => (fn[y][x] ? v : v !== MASKS[k](x, y))));
    drawFormat(g, k);
    const p = penalty(g);
    if (!best || p < best.p) best = { g, p };
  }
  return best.g;
}

// SVG do QR Code (com margem de 4 módulos)
export function qrSvg(text, px = 4) {
  const g = matrix(text); const n = g.length; const q = 4; const dim = (n + q * 2) * px;
  let path = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (g[y][x]) path += `M${(x + q) * px},${(y + q) * px}h${px}v${px}h-${px}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
export const qrMatrix = matrix;
