'use strict';
// Servidor local de desenvolvimento: serve a interface (public/) e a API.
// Em produção, a Vercel serve public/ pela CDN e a API por api/index.js.
const http = require('http');
const path = require('path');
const fs = require('fs');

// carrega variáveis do arquivo .env (se existir) — DATABASE_URL, MASTER_KEY, chaves do Stripe...
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { handler, housekeeping } = require('./app');
const { serveStatic, send } = require('./http');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = process.env.FISIO_PUBLIC_DIR ? path.resolve(process.env.FISIO_PUBLIC_DIR) : path.join(__dirname, '..', 'public');

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) return await handler(req, res);
    // mesmo atalho da Vercel (vercel.json): /admin → admin.html
    return serveStatic(PUBLIC_DIR, req, res, pathname === '/admin' ? '/admin.html' : pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, 'Requisição inválida');
  }
});

setInterval(() => housekeeping().catch((e) => console.error('Limpeza', e.message)), 3600e3).unref();

server.listen(PORT, HOST, () => {
  console.log(`\n  FisioGestão rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
});
