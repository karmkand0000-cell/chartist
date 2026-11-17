// Production exchange connectivity — placeholder.
//
// Going live requires (in order): SEBI stock-broker registration, NSE/BSE trading membership,
// exchange-approved trading software (empanelled vendor or own software with exchange approval + mock/UAT
// certification), connectivity (leased line / NNF over extranet / co-location), and clearing membership.
// Once approved, implement this class against the exchange's NNF (Native) or FIX interface with the SAME
// interface as ExchangeSimulator:
//   submit(order) → exchangeOrderId      modify(exchangeOrderId, changes)      cancel(exchangeOrderId)
//   emit('event', { type: 'ack'|'triggered'|'trade'|'cancelled'|'reject'|'modified'|'modify_reject', ... })
// The OMS/RMS/back-office in this codebase does not need to change.
import { EventEmitter } from 'node:events';
export class NseGateway extends EventEmitter {
  constructor() {
    super();
    throw new Error('NSE gateway not configured: exchange membership and certified connectivity are required. Set EXCHANGE_ADAPTER=simulator.');
  }
}
