// Runtime configuration (environment variables)
import crypto from 'node:crypto';
const env = process.env;
const dev = env.DEV_MODE === '1' || env.NODE_ENV === 'development';

export const config = {
  dev,
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  databaseUrl: env.DATABASE_URL || '',            // empty → embedded PGlite
  pgliteDir: env.PGLITE_DIR ?? './data/pgdata',   // '' → in-memory
  jwtSecret: env.JWT_SECRET || (dev ? 'dev-only-secret-change-me' : crypto.randomBytes(32).toString('hex')),
  accessTtlSec: 15 * 60,
  refreshTtlDays: 7,
  corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
  brokerName: env.BROKER_NAME || 'Chartist Securities',
  sebiReg: env.SEBI_REG || 'INZ000000000 (placeholder)',
  adminEmail: env.ADMIN_EMAIL || 'admin@chartist.in',
  adminPassword: env.ADMIN_PASSWORD || (dev ? 'Admin@12345' : ''),
  exchangeAdapter: env.EXCHANGE_ADAPTER || 'simulator', // 'simulator' | 'nse' (requires membership)
  feedAdapter: env.FEED_ADAPTER || 'simulator',
  tickMs: Number(env.SIM_TICK_MS || 1000),
  marketMode: env.MARKET_MODE || 'auto',              // auto | open | closed (simulator only)
  require2FA: env.REQUIRE_2FA !== '0',
  showOtp: env.SHOW_OTP === '1' || dev,               // demo only: return OTPs in API responses
  simAlwaysTick: env.SIM_ALWAYS_TICK === '1' || dev,  // simulator prices move outside market hours
  demoSeed: env.DEMO_SEED === '1',                    // create a funded demo client account
  otpDelivery: env.OTP_DELIVERY || 'log',             // log | smtp (configure SMTP_* vars)
};
