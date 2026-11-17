// Exchange simulator: accepts orders, matches against the live price feed, emits exchange events.
// Same interface a real exchange gateway implements: submit / modify / cancel / on('event').
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { quote, bus } from '../services/market.js';
import { getInstrument } from '../services/instruments.js';

export class ExchangeSimulator extends EventEmitter {
  constructor({ latencyMs = 5, maxFillPerTick = 2000 } = {}) {
    super();
    this.book = new Map(); // exchange order id → order
    this.latency = latencyMs;
    this.maxFill = maxFillPerTick;
    bus.on('ticks', (tokens) => this.#onTicks(new Set(tokens)));
  }
  name = 'SIMULATOR';
  #emit(ev) { setTimeout(() => this.emit('event', ev), this.latency); }
  #nextId() { return `SIM${Date.now()}${crypto.randomInt(1000, 9999)}`; }

  submit(o) {
    const xo = { ...o, exchangeOrderId: this.#nextId(), remaining: o.qty - (o.filled_qty || 0), triggered: !['SL', 'SL-M'].includes(o.order_type) };
    this.book.set(xo.exchangeOrderId, xo);
    this.#emit({ type: 'ack', orderId: o.id, exchangeOrderId: xo.exchangeOrderId, status: xo.triggered ? 'OPEN' : 'TRIGGER_PENDING' });
    setTimeout(() => this.#tryMatch(xo), this.latency + 1);
    return xo.exchangeOrderId;
  }
  modify(exchangeOrderId, { qty, price, trigger_price, order_type }) {
    const xo = this.book.get(exchangeOrderId);
    if (!xo) return this.#emit({ type: 'modify_reject', exchangeOrderId, message: 'Order not found at exchange' });
    const filled = xo.qty - xo.remaining;
    if (qty != null && qty <= filled) return this.#emit({ type: 'modify_reject', orderId: xo.id, exchangeOrderId, message: 'Quantity cannot be less than filled quantity' });
    Object.assign(xo, { qty: qty ?? xo.qty, price: price ?? xo.price, trigger_price: trigger_price ?? xo.trigger_price, order_type: order_type ?? xo.order_type });
    xo.remaining = xo.qty - filled;
    this.#emit({ type: 'modified', orderId: xo.id, exchangeOrderId });
    setTimeout(() => this.#tryMatch(xo), this.latency + 1);
  }
  cancel(exchangeOrderId, reason = 'Cancelled by user') {
    const xo = this.book.get(exchangeOrderId);
    if (!xo) return false;
    this.book.delete(exchangeOrderId);
    this.#emit({ type: 'cancelled', orderId: xo.id, exchangeOrderId, message: reason });
    return true;
  }
  #onTicks(tokens) {
    for (const xo of this.book.values()) if (tokens.has(xo.token) || xo.token.startsWith('NFO:')) this.#tryMatch(xo);
  }
  #tryMatch(xo) {
    if (!this.book.has(xo.exchangeOrderId)) return;
    const q = quote(xo.token);
    if (!q) return;
    const ltp = q.ltp;
    if (!xo.triggered) {
      const hit = xo.side === 'BUY' ? ltp >= xo.trigger_price : ltp <= xo.trigger_price;
      if (!hit) return;
      xo.triggered = true;
      this.emit('event', { type: 'triggered', orderId: xo.id, exchangeOrderId: xo.exchangeOrderId });
    }
    const marketable = xo.order_type === 'MARKET' || xo.order_type === 'SL-M' || (xo.side === 'BUY' ? ltp <= xo.price : ltp >= xo.price);
    if (!marketable) {
      if (xo.validity === 'IOC') this.cancel(xo.exchangeOrderId, 'IOC order cancelled: not marketable');
      return;
    }
    const lot = getInstrument(xo.token)?.lot || 1;
    const chunk = Math.max(lot, Math.floor(this.maxFill / lot) * lot);
    const qty = Math.min(xo.remaining, chunk);
    // Market orders take the offer/bid; limit orders get price improvement up to their limit
    const px = xo.order_type === 'MARKET' || xo.order_type === 'SL-M' ? (xo.side === 'BUY' ? q.ask : q.bid) : (xo.side === 'BUY' ? Math.min(xo.price, q.ask) : Math.max(xo.price, q.bid));
    xo.remaining -= qty;
    const done = xo.remaining === 0;
    if (done) this.book.delete(xo.exchangeOrderId);
    this.emit('event', { type: 'trade', orderId: xo.id, exchangeOrderId: xo.exchangeOrderId, tradeId: `T${this.#nextId()}`, qty, price: Math.max(0.05, px), complete: done });
    if (!done && xo.validity === 'IOC') this.cancel(xo.exchangeOrderId, 'IOC remainder cancelled');
    else if (!done) setTimeout(() => this.#tryMatch(xo), 50);
  }
  openOrders() { return [...this.book.values()]; }
}
