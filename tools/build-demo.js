// Gera a versão de demonstração (web-demo/) a partir de public/ + demo/mock-api.js
// Uso: node tools/build-demo.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'web-demo');

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'demo', 'mock-api.js'), path.join(OUT, 'js', 'mock-api.js'));
fs.rmSync(path.join(OUT, 'index.html'));

const head = `<title>FisioGestão</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="css/app.css">`;
const body = `<div id="root"></div>
<script src="js/mock-api.js"></script>
<script type="module" src="js/app.js"></script>`;

// Página publicada: fragmento (a hospedagem adiciona doctype/head/body)
fs.writeFileSync(path.join(OUT, 'index.html'), `${head}\n${body}\n`);
// Página para teste local
fs.writeFileSync(path.join(OUT, 'local.html'), `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n${head}\n</head><body>\n${body}\n</body></html>\n`);

// Documento de impressão: caminhos relativos + backend simulado
let print = fs.readFileSync(path.join(SRC, 'print.html'), 'utf8')
  .replace('href="/favicon.svg"', 'href="favicon.svg"')
  .replace('href="/css/print.css"', 'href="css/print.css"')
  .replace('<script type="module" src="/js/print.js"></script>', '<script src="js/mock-api.js"></script>\n  <script type="module" src="js/print.js"></script>');
fs.writeFileSync(path.join(OUT, 'print.html'), print);

// Páginas auxiliares para capturas de tela (somente com CAPTURE=1; não são publicadas)
if (process.env.CAPTURE === '1') fs.cpSync(path.join(ROOT, 'demo', 'capture'), OUT, { recursive: true });

const files = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else files.push(path.relative(OUT, p).split(path.sep).join('/'));
  }
})(OUT);
console.log('web-demo gerado:', files.length, 'arquivos');
console.log(JSON.stringify(files.filter((f) => f !== 'index.html' && f !== 'local.html')));
