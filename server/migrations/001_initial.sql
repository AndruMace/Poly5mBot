-- Core event/trade/activity/incident schema for migration off JSONL.

create table if not exists trade_events (
  id text primary key,
  trade_id text not null,
  stream text not null check (stream in ('live', 'shadow')),
  event_type text not null,
  event_ts bigint not null,
  data jsonb not null default '{}'::jsonb
);

create index if not exists idx_trade_events_trade_id on trade_events (trade_id);
create index if not exists idx_trade_events_event_ts_desc on trade_events (event_ts desc);

create table if not exists trades_projection (
  id text primary key,
  stream text not null check (stream in ('live', 'shadow')),
  strategy text not null,
  side text not null,
  token_id text not null,
  status text not null,
  outcome text null,
  size numeric(18, 6) not null default 0,
  shares numeric(18, 6) not null default 0,
  fee numeric(18, 6) not null default 0,
  pnl numeric(18, 6) not null default 0,
  timestamp_ms bigint not null,
  window_end_ms bigint not null,
  condition_id text not null,
  clob_order_id text null,
  clob_result text null,
  clob_reason text null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_trades_projection_ts_desc on trades_projection (timestamp_ms desc);
create index if not exists idx_trades_projection_condition on trades_projection (condition_id);
create index if not exists idx_trades_projection_strategy on trades_projection (strategy);
create index if not exists idx_trades_projection_clob on trades_projection (clob_order_id);

create table if not exists account_activity (
  id text primary key,
  market_name text not null,
  action text not null,
  usdc_amount numeric(18, 6) not null default 0,
  token_amount numeric(18, 6) not null default 0,
  token_name text not null default '',
  timestamp_sec bigint not null,
  tx_hash text not null default '',
  source text not null default 'imported_csv',
  imported_at_ms bigint not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_account_activity_ts_desc on account_activity (timestamp_sec desc);
create index if not exists idx_account_activity_hash on account_activity (tx_hash);
create index if not exists idx_account_activity_action on account_activity (action);

create table if not exists critical_incidents (
  id text primary key,
  kind text not null,
  severity text not null,
  message text not null,
  fingerprint text not null,
  details jsonb not null default '{}'::jsonb,
  created_at_ms bigint not null,
  resolved_at_ms bigint null
);

create unique index if not exists idx_critical_incidents_fingerprint_active
  on critical_incidents (fingerprint)
  where resolved_at_ms is null;
create index if not exists idx_critical_incidents_created_desc on critical_incidents (created_at_ms desc);

create table if not exists strategy_state (
  strategy_name text primary key,
  payload jsonb not null,
  updated_at_ms bigint not null
);

create table if not exists notes (
  id text primary key,
  text_body text not null,
  updated_at_ms bigint not null
);
