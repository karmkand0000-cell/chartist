alter table trades add column if not exists pnl numeric(18,2) not null default 0;
create index if not exists trades_date on trades(trade_date);
