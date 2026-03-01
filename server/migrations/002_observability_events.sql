create table if not exists observability_events (
  event_id text primary key,
  event_ts bigint not null,
  category text not null,
  source text not null,
  action text not null,
  entity_type text not null,
  entity_id text null,
  status text null,
  strategy text null,
  mode text null,
  search_text text not null default '',
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_observability_events_ts_desc on observability_events (event_ts desc);
create index if not exists idx_observability_events_category on observability_events (category);
create index if not exists idx_observability_events_source on observability_events (source);
create index if not exists idx_observability_events_entity on observability_events (entity_type, entity_id);
create index if not exists idx_observability_events_strategy on observability_events (strategy);
create index if not exists idx_observability_events_mode on observability_events (mode);
create index if not exists idx_observability_events_status on observability_events (status);
