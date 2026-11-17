-- Chartist Broker — core schema (PostgreSQL 14+)

create table if not exists users (
  id            bigserial primary key,
  role          text not null default 'client' check (role in ('client','admin','rms','ops','support')),
  name          text not null,
  email         text not null unique,
  mobile        text not null unique,
  password_hash text not null,
  totp_secret   text,
  totp_enabled  boolean not null default false,
  email_verified  boolean not null default false,
  mobile_verified boolean not null default false,
  status        text not null default 'onboarding' check (status in ('onboarding','kyc_submitted','active','suspended','closed')),
  ucc           text unique,
  failed_logins int not null default 0,
  locked_until  timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  id           text primary key,
  user_id      bigint not null references users(id) on delete cascade,
  refresh_hash text not null,
  device       text,
  ip           text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked      boolean not null default false
);
create index if not exists sessions_user on sessions(user_id);

create table if not exists otps (
  id         bigserial primary key,
  user_id    bigint references users(id) on delete cascade,
  target     text not null,
  purpose    text not null,
  code_hash  text not null,
  attempts   int not null default 0,
  expires_at timestamptz not null,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists kyc (
  user_id      bigint primary key references users(id) on delete cascade,
  pan          text,
  pan_name     text,
  dob          date,
  gender       text,
  father_name  text,
  aadhaar_last4 text,
  address      jsonb not null default '{}',
  bank         jsonb not null default '{}',
  nominee      jsonb not null default '{}',
  segments     text[] not null default '{EQ}',
  income_range text,
  occupation   text,
  experience   text,
  pep          boolean not null default false,
  fatca_ok     boolean not null default true,
  ipv_done     boolean not null default false,
  esign_done   boolean not null default false,
  status       text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  remarks      text,
  submitted_at timestamptz,
  reviewed_by  bigint references users(id),
  reviewed_at  timestamptz,
  updated_at   timestamptz not null default now()
);
create unique index if not exists kyc_pan on kyc(pan) where pan is not null;

create table if not exists kyc_documents (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  kind       text not null check (kind in ('pan','aadhaar','photo','signature','bank_proof','income_proof')),
  filename   text not null,
  mime       text not null,
  size       int not null,
  data       bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists kyc_docs_user on kyc_documents(user_id);

create table if not exists instruments (
  token      text primary key,
  symbol     text not null,
  name       text not null,
  exchange   text not null,
  segment    text not null,
  type       text not null,
  underlying text,
  strike     numeric(14,2),
  expiry     date,
  lot        int not null default 1,
  tick       numeric(8,2) not null default 0.05,
  freeze_qty int not null default 100000,
  band_pct   numeric(6,2),
  sector     text,
  isin       text,
  base_price numeric(14,2),
  active     boolean not null default true
);
create index if not exists instr_underlying on instruments(underlying, expiry);

create table if not exists candles (
  token text not null,
  day   date not null,
  open  numeric(14,2) not null, high numeric(14,2) not null, low numeric(14,2) not null, close numeric(14,2) not null,
  volume bigint not null default 0,
  primary key (token, day)
);

create table if not exists accounts (
  user_id          bigint primary key references users(id) on delete cascade,
  cash             numeric(18,2) not null default 0,
  unsettled_credit numeric(18,2) not null default 0,
  fno_loss_limit   numeric(18,2) not null default 25000,
  fno_day_loss     numeric(18,2) not null default 0,
  fno_paused       boolean not null default false,
  max_order_value  numeric(18,2) not null default 5000000,
  trading_blocked  boolean not null default false,
  updated_at       timestamptz not null default now()
);

create table if not exists ledger (
  id           bigserial primary key,
  user_id      bigint not null references users(id) on delete cascade,
  entry_date   date not null,
  type         text not null,
  debit        numeric(18,2) not null default 0,
  credit       numeric(18,2) not null default 0,
  balance      numeric(18,2) not null,
  ref          text,
  narration    text,
  created_at   timestamptz not null default now()
);
create index if not exists ledger_user on ledger(user_id, id);

create table if not exists fund_requests (
  id           bigserial primary key,
  user_id      bigint not null references users(id) on delete cascade,
  kind         text not null check (kind in ('PAYIN','PAYOUT')),
  amount       numeric(18,2) not null check (amount > 0),
  method       text not null default 'UPI',
  utr          text,
  status       text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  remarks      text,
  processed_by bigint references users(id),
  processed_at timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists orders (
  id              bigserial primary key,
  user_id         bigint not null references users(id) on delete cascade,
  client_order_id text,
  token           text not null references instruments(token),
  side            text not null check (side in ('BUY','SELL')),
  qty             int not null check (qty > 0),
  filled_qty      int not null default 0,
  price           numeric(14,2),
  trigger_price   numeric(14,2),
  avg_price       numeric(14,2),
  order_type      text not null check (order_type in ('MARKET','LIMIT','SL','SL-M')),
  product         text not null check (product in ('CNC','MIS','NRML')),
  validity        text not null default 'DAY' check (validity in ('DAY','IOC')),
  variety         text not null default 'REGULAR' check (variety in ('REGULAR','AMO')),
  status          text not null,
  status_message  text,
  exchange_order_id text,
  tag             text,
  blocked         numeric(18,2) not null default 0,
  placed_by       bigint references users(id),
  trade_date      date not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, client_order_id)
);
create index if not exists orders_user on orders(user_id, id desc);
create index if not exists orders_open on orders(status) where status in ('OPEN','TRIGGER_PENDING','AMO_REQ_RECEIVED','PUT_ORDER_REQ_RECEIVED');

create table if not exists order_events (
  id         bigserial primary key,
  order_id   bigint not null references orders(id) on delete cascade,
  status     text not null,
  message    text,
  created_at timestamptz not null default now()
);

create table if not exists trades (
  id            bigserial primary key,
  order_id      bigint not null references orders(id),
  user_id       bigint not null references users(id) on delete cascade,
  token         text not null,
  side          text not null,
  qty           int not null,
  price         numeric(14,2) not null,
  product       text not null,
  exchange_trade_id text not null,
  trade_date    date not null,
  charges       jsonb not null default '{}',
  charges_posted boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists trades_user on trades(user_id, trade_date);

create table if not exists positions (
  user_id   bigint not null references users(id) on delete cascade,
  token     text not null,
  product   text not null,
  qty       int not null default 0,
  avg       numeric(14,4) not null default 0,
  buy_qty   int not null default 0, buy_value numeric(18,2) not null default 0,
  sell_qty  int not null default 0, sell_value numeric(18,2) not null default 0,
  realised  numeric(18,2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, token, product)
);

create table if not exists holdings (
  user_id  bigint not null references users(id) on delete cascade,
  token    text not null,
  qty      int not null default 0,
  t1_qty   int not null default 0,
  avg      numeric(14,4) not null default 0,
  primary key (user_id, token)
);

create table if not exists gtts (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  token       text not null references instruments(token),
  kind        text not null check (kind in ('SINGLE','OCO')),
  side        text not null,
  qty         int not null,
  product     text not null default 'CNC',
  trigger_price numeric(14,2), limit_price numeric(14,2),
  target      numeric(14,2), stoploss numeric(14,2),
  ref_price   numeric(14,2) not null,
  status      text not null default 'ACTIVE',
  order_id    bigint,
  fired_leg   text,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create table if not exists alerts (
  id        bigserial primary key,
  user_id   bigint not null references users(id) on delete cascade,
  token     text not null,
  direction text not null check (direction in ('above','below')),
  price     numeric(14,2) not null,
  status    text not null default 'ACTIVE',
  created_at timestamptz not null default now()
);

create table if not exists watchlists (
  id      bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  name    text not null,
  tokens  text[] not null default '{}',
  position int not null default 0
);

create table if not exists contract_notes (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  trade_date date not null,
  number     text not null unique,
  totals     jsonb not null,
  html       text not null,
  created_at timestamptz not null default now(),
  unique (user_id, trade_date)
);

create table if not exists notifications (
  id        bigserial primary key,
  user_id   bigint references users(id) on delete cascade,
  title     text not null,
  body      text,
  read      boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists risk_events (
  id        bigserial primary key,
  user_id   bigint references users(id) on delete cascade,
  kind      text not null,
  message   text not null,
  data      jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id         bigserial primary key,
  actor_id   bigint,
  actor_role text,
  action     text not null,
  entity     text,
  entity_id  text,
  data       jsonb,
  ip         text,
  created_at timestamptz not null default now()
);

create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

create table if not exists eod_runs (
  trade_date date primary key,
  status     text not null,
  summary    jsonb,
  run_by     bigint,
  created_at timestamptz not null default now()
);
