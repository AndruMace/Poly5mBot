import type { TradeEvent, TradeRecord, CriticalIncident } from "../types.js";
import type { AccountActivityRecord } from "../activity/store.js";

export interface TradeEventRepository {
  append(stream: "live" | "shadow", event: TradeEvent): Promise<void>;
  list(stream: "live" | "shadow", limit?: number): Promise<TradeEvent[]>;
}

export interface TradeProjectionRepository {
  upsert(stream: "live" | "shadow", trade: TradeRecord): Promise<void>;
  list(stream: "live" | "shadow" | "all", limit?: number): Promise<TradeRecord[]>;
}

export interface AccountActivityRepository {
  upsertMany(rows: AccountActivityRecord[]): Promise<void>;
  list(limit?: number): Promise<AccountActivityRecord[]>;
}

export interface CriticalIncidentRepository {
  upsert(incident: CriticalIncident): Promise<void>;
  list(limit?: number, activeOnly?: boolean): Promise<CriticalIncident[]>;
}

export interface StorageRepositories {
  tradeEvents: TradeEventRepository;
  tradeProjection: TradeProjectionRepository;
  accountActivity: AccountActivityRepository;
  incidents: CriticalIncidentRepository;
}
