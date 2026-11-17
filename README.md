# Chartist Broker

A full-stack stock-broking platform: client trading app (web + Android), back-office console and a broker backend with **OMS, RMS, KYC onboarding, funds ledger, end-of-day settlement and contract notes**.

It runs today against a built-in **exchange simulator**. When the broking entity has its SEBI registration, exchange membership and certified connectivity, the simulator is swapped for a real exchange gateway — the rest of the system stays the same. See [docs/GO-LIVE.md](docs/GO-LIVE.md).

## Live demo

| | |
|---|---|
| **Client app** | https://chartist.onrender.com |
| **Back office** | https://chartist.onrender.com/admin/ (admin@chartist.in · password is the `ADMIN_PASSWORD` value in Render → Environment) |
| **Demo client** | `demo@chartist.in` / `Demo@1234` — or press **Fill demo login** on the login page |
| **Android APK** | GitHub → Actions → *Android APK* → latest run → artifact `chartist-debug-apk` |

The demo runs on free tiers (Render web service + Neon Postgres, Singapore). The free server sleeps after 15 minutes idle, so the first visit can take ~50 seconds. The exchange is a **simulator** that is kept open 24×7, OTPs are shown on screen and prices are delayed reference prices (Yahoo Finance) — none of this is for real trading.

## What's inside

| Module | Highlights |
|---|---|
| **Auth & security** | Signup with mobile + email OTP verification · password + **mandatory 2FA** (SMS/email OTP or authenticator-app TOTP with QR) · account lockout · refresh-token sessions, logout-all · rate limiting · full audit log |
| **KYC onboarding** | PAN, personal, address, bank, nominee, segments (F&O needs income proof), document upload, IPV & e-sign steps · back-office review → approve (UCC allotted) / reject with remarks |
| **OMS** | Market / Limit / SL / SL-M · CNC, MIS, NRML · DAY / IOC · AMO queue released at open · modify / cancel · idempotent `client_order_id` · basket orders · full order event trail · rejected orders kept in the book |
| **RMS** | Kill switch · client status & trading block · segment checks · lot size, freeze qty, tick size, circuit limits · SL trigger validation · CNC short-sell block · per-order value limit · F&O SafeGuard (daily loss limit & pause) · **hedge-aware F&O margin** · live MTM monitor with auto square-off · intraday square-off at cut-off |
| **Exchange simulator** | Matching against the live feed, bid/ask, partial fills, IOC, SL triggers — same interface a real NSE/BSE gateway implements |
| **Market data** | Equities, indices, rolling NIFTY/BANKNIFTY weekly & monthly options and futures · WebSocket quotes · daily candles · option chain with Greeks, PCR, max pain |
| **Funds & ledger** | Double-entry style ledger · pay-in via UPI/IMPS/NEFT with UTR (ops approval) · payouts limited to withdrawable balance · unsettled sell credit (T+1) · accrued charges |
| **Back office (EOD)** | Cancels day orders · posts brokerage & statutory charges · contract notes · futures MTM · option/future expiry settlement · T+1 delivery settlement · candles & circuit roll · auto-runs at 16:00 IST |
| **Mutual funds** | Explore funds with 1Y / 3Y / 5Y returns (real AMFI NAVs via mfapi.in, or demo schemes) · one-time investment · monthly SIP with auto-debit on the chosen date · redeem · MF orders desk in back office |
| **IPO** | Open / upcoming / closed issues · apply with lots, bid price or cut-off and UPI ID · funds blocked and released on withdrawal · back-office allotment (lottery) with refunds and credit of allotted shares |
| **Reports** | P&L by category (intraday / delivery / F&O) · tradebook · ledger statement · contract notes |
| **Client app** | Dashboard, markets & heatmap, charts (candles, SMA, Bollinger, RSI, MACD), order window with live margin & charges preview, portfolio, funds, option chain + strategy builder with payoff, GTT (single & OCO), price alerts, watchlists, notifications, dark/light, mobile layout |
| **Back-office console** (`/admin/`) | Dashboard · KYC queue with document viewer · clients (limits, suspend, role, RMS square-off) · fund requests · orders & trades · RMS monitor · operations (kill switch, session, AMO, F&O switch, lot sizes, EOD, broadcast) · audit log |
| **Android** | Capacitor wrapper of the client app; APK built for free by GitHub Actions |

## Run locally

```bash
cd server
npm install
npm run dev          # http://localhost:8080  (client)   http://localhost:8080/admin/  (back office)
```
- Dev mode uses embedded PostgreSQL (PGlite) in `server/data/`, prints OTPs in the console and shows them in the UI.
- Default staff login: `admin@chartist.in` / `Admin@12345` (dev only — set `ADMIN_PASSWORD` in production).
- Outside market hours, open **Back office → Operations → Market session = open** to trade in the simulator.

```bash
npm test             # end-to-end API test: onboarding → KYC → funds → orders → RMS → EOD
```

## Architecture

```
web/ (client SPA + /admin console) ──HTTPS/WSS──►  server/ (Fastify, Node 22)
mobile/ (Capacitor Android) ────────┘                 ├─ services/auth, kyc, funds, portfolio
                                                      ├─ services/oms  ──► exchange/simulator.js  (→ nse-gateway.js when licensed)
                                                      ├─ services/rms, market (feed + candles), eod, reports
shared/ (options maths, margin, charges) ◄────────────┤
                                                      └─ PostgreSQL (pg)  |  PGlite (embedded, dev/tests)
```
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Deploy (free tiers)

| Piece | Free option |
|---|---|
| API + web | **Oracle Cloud Always Free VM** (`docker compose up -d`, includes Postgres) — best: always on, static IP · or **Render** free web service (`render.yaml`, sleeps when idle) |
| Database | Postgres in the compose file · or **Neon** / **Supabase** free Postgres via `DATABASE_URL` |
| HTTPS | Caddy or Cloudflare Tunnel in front of the VM |
| Android APK | GitHub Actions → *Android APK* workflow → enter your API URL → download artifact |
| Code & CI | GitHub (tests run on every push) |

Environment variables: see `.env.example`.

## Important

This software does **not** by itself make anyone a stockbroker. Accepting client money or orders for real trading requires SEBI registration, exchange and clearing memberships, a depository participant arrangement and exchange-approved trading software. Until then, run it as a simulator / UAT environment.
