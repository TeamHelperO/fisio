'use strict';
// Função serverless da Vercel: todas as rotas /api/* chegam aqui (ver rewrites em vercel.json)
const { handler } = require('../server/app');

module.exports = (req, res) => handler(req, res);
