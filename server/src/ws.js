// WebSocket: authenticated live quotes, order/trade updates and notifications
import { verifyAccess } from './services/auth.js';
import { bus } from './services/market.js';
import { quote } from './services/market.js';
import { events } from './services/oms.js';

const clients = new Set();
export default async function wsRoutes(app) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const c = { socket, user: null, subs: new Set(), dirty: new Set() };
    clients.add(c);
    const send = (m) => { if (socket.readyState === 1) socket.send(JSON.stringify(m)); };
    c.send = send;
    socket.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.op === 'auth') {
        try { c.user = await verifyAccess(m.token); send({ t: 'auth', ok: true }); } catch { send({ t: 'auth', ok: false }); }
      } else if (m.op === 'sub') {
        for (const t of (m.tokens || []).slice(0, 300)) { c.subs.add(t); c.dirty.add(t); }
      } else if (m.op === 'unsub') {
        for (const t of m.tokens || []) c.subs.delete(t);
      } else if (m.op === 'ping') send({ t: 'pong', ts: Date.now() });
    });
    socket.on('close', () => clients.delete(c));
  });

  // Batch quote pushes every 500 ms; derivatives move with their underlying, so they refresh every batch
  bus.on('ticks', (tokens) => { for (const c of clients) for (const t of tokens) if (c.subs.has(t)) c.dirty.add(t); });
  setInterval(() => {
    for (const c of clients) {
      for (const t of c.subs) if (t.startsWith('NFO:')) c.dirty.add(t);
      if (!c.dirty.size) continue;
      const d = {}; for (const t of c.dirty) { const q = quote(t); if (q) d[t] = { ltp: q.ltp, change: q.change, pct: q.pct, high: q.high, low: q.low, volume: q.volume, close: q.close }; }
      c.dirty.clear();
      c.send({ t: 'q', d });
    }
  }, 500).unref();
  const toUser = (userId, m) => { for (const c of clients) if (c.user?.id === userId) c.send(m); };
  events.on('order', ({ userId, order }) => toUser(userId, { t: 'order', d: order }));
  events.on('trade', ({ userId, trade }) => toUser(userId, { t: 'trade', d: trade }));
  events.on('notify', ({ userId, title, body }) => toUser(userId, { t: 'notify', d: { title, body } }));
  events.on('broadcast', (d) => { for (const c of clients) c.send({ t: 'notify', d }); });
}
