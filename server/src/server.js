// Chartist Broker — API server entry point
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fstatic from '@fastify/static';
import { config } from './config.js';
import { connect, db } from './db.js';
import { AppError } from './errors.js';
import { loadSettings } from './services/settings.js';
import { seedInstruments, rollDerivatives } from './services/instruments.js';
import { initMarket, startFeed, spotOf } from './services/market.js';
import { initOms, startRiskMonitor } from './services/oms.js';
import { startEodScheduler } from './services/eod.js';
import { ensureAdmin, ensureDemo, DEMO } from './services/auth.js';
import clientRoutes from './routes/client.js';
import adminRoutes from './routes/admin.js';
import wsRoutes from './ws.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function build({ logger = true, background = true } = {}) {
  await connect();
  await loadSettings();
  await seedInstruments();
  await initMarket();
  await rollDerivatives(spotOf);
  await ensureAdmin();
  await ensureDemo();
  await initOms();
  if (background) { startFeed(); startRiskMonitor(); startEodScheduler(); }

  const app = Fastify({ logger: logger ? { level: config.dev ? 'info' : 'warn' } : false, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(cors, { origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, credentials: false });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(websocket);
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    return payload;
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message, code: err.code, ...(err.extra || {}) });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'Too many requests. Slow down.', code: 'RATE_LIMIT' });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: err.message, code: 'BAD_REQUEST' });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong. Please try again.', code: 'INTERNAL' });
  });
  await app.register(clientRoutes);
  await app.register(adminRoutes);
  await app.register(wsRoutes);
  await app.register(fstatic, { root: path.join(root, 'web'), prefix: '/' });
  await app.register(fstatic, { root: path.join(root, 'shared'), prefix: '/shared/', decorateReply: false });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await build();
  await app.listen({ port: config.port, host: config.host });
  console.log(`Chartist Broker running on http://localhost:${config.port}  (db: ${db.kind}, exchange: ${config.exchangeAdapter}, dev: ${config.dev})`);
  const stop = async () => { await app.close(); await db.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
