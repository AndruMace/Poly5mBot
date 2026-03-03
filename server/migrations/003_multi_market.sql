-- Multi-market support: add market_id columns and relax stream constraints.

-- trade_events: add market_id and update stream constraint
ALTER TABLE trade_events ADD COLUMN IF NOT EXISTS market_id text NOT NULL DEFAULT 'btc';
ALTER TABLE trade_events DROP CONSTRAINT IF EXISTS trade_events_stream_check;
CREATE INDEX IF NOT EXISTS idx_trade_events_market ON trade_events (market_id, stream);

-- trades_projection: add market_id and update stream constraint
ALTER TABLE trades_projection ADD COLUMN IF NOT EXISTS market_id text NOT NULL DEFAULT 'btc';
ALTER TABLE trades_projection DROP CONSTRAINT IF EXISTS trades_projection_stream_check;
CREATE INDEX IF NOT EXISTS idx_trades_projection_market ON trades_projection (market_id);

-- strategy_state: add market_id as part of composite key
ALTER TABLE strategy_state ADD COLUMN IF NOT EXISTS market_id text NOT NULL DEFAULT 'btc';
ALTER TABLE strategy_state DROP CONSTRAINT IF EXISTS strategy_state_pkey;
ALTER TABLE strategy_state ADD PRIMARY KEY (market_id, strategy_name);

-- observability_events: add optional market_id
ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS market_id text DEFAULT 'btc';
CREATE INDEX IF NOT EXISTS idx_observability_events_market ON observability_events (market_id);
