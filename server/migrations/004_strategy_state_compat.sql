-- Ensure strategy_state remains compatible with market-aware persistence code.
ALTER TABLE strategy_state ADD COLUMN IF NOT EXISTS market_id text NOT NULL DEFAULT 'btc';
ALTER TABLE strategy_state ADD COLUMN IF NOT EXISTS updated_at_ms bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'strategy_state'
      AND constraint_name = 'strategy_state_pkey'
  ) THEN
    ALTER TABLE strategy_state DROP CONSTRAINT strategy_state_pkey;
  END IF;
END $$;

ALTER TABLE strategy_state ADD PRIMARY KEY (market_id, strategy_name);
