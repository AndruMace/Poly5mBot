-- Enforce market-scoped strategy_state schema for engine persistence.
-- Idempotent and safe on both legacy and partially-migrated databases.

ALTER TABLE strategy_state
  ADD COLUMN IF NOT EXISTS market_id text;

UPDATE strategy_state
SET market_id = 'btc'
WHERE market_id IS NULL OR btrim(market_id) = '';

ALTER TABLE strategy_state
  ALTER COLUMN market_id SET DEFAULT 'btc';

ALTER TABLE strategy_state
  ALTER COLUMN market_id SET NOT NULL;

ALTER TABLE strategy_state
  ADD COLUMN IF NOT EXISTS updated_at_ms bigint NOT NULL DEFAULT 0;

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

ALTER TABLE strategy_state
  ADD PRIMARY KEY (market_id, strategy_name);

