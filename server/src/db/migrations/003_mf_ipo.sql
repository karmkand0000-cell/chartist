-- Mutual funds (distribution) and IPO applications

create table if not exists mf_schemes (
  code      text primary key,
  name      text not null,
  house     text,
  category  text not null,
  nav       numeric(14,4) not null,
  nav_date  date not null,
  history   jsonb not null default '[]',
  min_sip   numeric(12,2) not null default 500,
  min_lump  numeric(12,2) not null default 1000,
  source    text not null default 'demo',
  active    boolean not null default true
);

create table if not exists mf_holdings (
  user_id  bigint not null references users(id) on delete cascade,
  code     text not null references mf_schemes(code),
  units    numeric(18,4) not null default 0,
  invested numeric(18,2) not null default 0,
  primary key (user_id, code)
);

create table if not exists sips (
  id           bigserial primary key,
  user_id      bigint not null references users(id) on delete cascade,
  code         text not null references mf_schemes(code),
  amount       numeric(12,2) not null,
  day          int not null check (day between 1 and 28),
  next_date    date not null,
  installments int not null default 0,
  status       text not null default 'ACTIVE',
  created_at   timestamptz not null default now()
);

create table if not exists mf_orders (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  code       text not null references mf_schemes(code),
  side       text not null check (side in ('BUY','REDEEM')),
  amount     numeric(18,2) not null,
  units      numeric(18,4) not null,
  nav        numeric(14,4) not null,
  sip_id     bigint,
  status     text not null default 'ALLOTTED',
  created_at timestamptz not null default now()
);

create table if not exists ipos (
  id            bigserial primary key,
  name          text not null,
  symbol        text,
  issue_type    text not null default 'Mainboard',
  price_lo      numeric(12,2) not null,
  price_hi      numeric(12,2) not null,
  lot           int not null,
  issue_size    text,
  open_date     date not null,
  close_date    date not null,
  listing_date  date,
  listing_price numeric(12,2),
  status        text not null default 'UPCOMING',
  sample        boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists ipo_applications (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  ipo_id     bigint not null references ipos(id) on delete cascade,
  lots       int not null,
  price      numeric(12,2) not null,
  amount     numeric(18,2) not null,
  upi_id     text not null,
  status     text not null default 'APPLIED',
  allotted_lots int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, ipo_id)
);
