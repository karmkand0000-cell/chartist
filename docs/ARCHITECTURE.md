# Architecture

## Components
- **server/** — Fastify API + WebSocket (Node 22). Single process; stateless except the in-memory quote cache and simulator order book (both rebuilt on start; live orders are re-sent to the exchange adapter after a restart).
- **web/** — client SPA (ES modules, no build step) and `/admin` back-office console.
- **shared/** — pure functions used by both server and client: option pricing & payoff, margin model, charges, instrument token helpers.
- **mobile/** — Capacitor project that packages `web/` + `shared/` as an Android app.

## Order lifecycle
```
client → POST /api/orders
  └─ OMS.normalise → DB tx { lock account → RMS.preTrade (validations + funds) → insert order (OPEN_PENDING | AMO_REQ_RECEIVED) }
       └─ exchange.submit(order)
            ├─ 'ack'        → OPEN / TRIGGER_PENDING
            ├─ 'triggered'  → OPEN
            ├─ 'trade'      → tx { insert trade (+charges) → portfolio.applyTrade (holdings/positions + ledger) → order filled/avg/status, release blocked funds }
            └─ 'cancelled' / 'reject' → release blocked funds
  every step → order_events row + WebSocket push to the client
```

## Funds model
`available = ledger cash − blocked for open orders − margin used by positions − accrued charges − pending payouts + min(0, MTM)`

- CNC buy debits full value at trade; CNC sell credits value (marked *unsettled* until EOD, so not withdrawable).
- Option premiums are debited/credited at trade; option margin covers risk only (hedge-aware: `min(naked, defined max loss)` per underlying + expiry).
- MIS equity and futures realise P&L to the ledger on close; futures carry daily MTM at EOD.

## Data model (PostgreSQL)
users · sessions · otps · kyc · kyc_documents · instruments · candles · accounts · ledger · fund_requests · orders · order_events · trades · positions · holdings · gtts · alerts · watchlists · contract_notes · notifications · risk_events · audit_log · settings · eod_runs

## Security
bcrypt passwords · HMAC-hashed OTPs (5-minute expiry, 5 attempts) · mandatory second factor · JWT access tokens (15 min) bound to server-side sessions · rotating refresh tokens · lockout after 5 failures · role-based staff access (admin / rms / ops / support) · rate limits · audit log of every sensitive action · masked bank/Aadhaar data in client APIs.

## Swapping the simulator for a real exchange
Implement `server/src/exchange/nse-gateway.js` with the same `submit / modify / cancel / emit('event')` interface and set `EXCHANGE_ADAPTER=nse`. Replace the simulator feed with the exchange/vendor market-data feed in `services/market.js`.
