import { useState, useMemo, useEffect } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import {
  connectedRx,
  exchangeConnectedRx,
  walletAddressRx,
  pricesRx,
  tradingActiveRx,
  modeRx,
  wsLastMessageTsRx,
  storageHealthRx,
  activeMarketIdRx,
  enabledMarketsRx,
} from "../store/index.js";
import { Wifi, WifiOff, Wallet, Play, Square, Loader2, Eye, Radio } from "lucide-react";
import { setMarketMode, toggleMarketTrading } from "../utils/market-actions.js";

export function Header() {
  const wsConnected = useRxValue(connectedRx);
  const exchangeConnected = useRxValue(exchangeConnectedRx);
  const walletAddress = useRxValue(walletAddressRx);
  const prices = useRxValue(pricesRx);
  const tradingActive = useRxValue(tradingActiveRx);
  const mode = useRxValue(modeRx);
  const wsLastMessageTs = useRxValue(wsLastMessageTsRx);
  const storageHealth = useRxValue(storageHealthRx);
  const activeMarketId = useRxValue(activeMarketIdRx);
  const enabledMarkets = useRxValue(enabledMarketsRx);
  const [toggling, setToggling] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [nowTs, setNowTs] = useState(Date.now());

  const latestPrice = useMemo(() => {
    let best: number | null = null;
    let bestTs = 0;
    for (const p of Object.values(prices)) {
      if (p.price > 0 && p.timestamp > bestTs) {
        best = p.price;
        bestTs = p.timestamp;
      }
    }
    return best;
  }, [prices]);

  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const wsAgeMs = wsLastMessageTs > 0 ? nowTs - wsLastMessageTs : Infinity;
  const isStale = !wsConnected || wsAgeMs > 8000;
  const spotDecimals = activeMarketId === "xrp" ? 4 : 2;

  async function handleTradingToggle() {
    setToggling(true);
    setControlError(null);
    try {
      await toggleMarketTrading(activeMarketId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to toggle trading";
      setControlError(msg);
      console.error("Failed to toggle trading:", err);
    } finally {
      setToggling(false);
    }
  }

  async function handleModeToggle() {
    setSwitchingMode(true);
    setControlError(null);
    try {
      const newMode = mode === "live" ? "shadow" : "live";
      await setMarketMode(activeMarketId, newMode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to switch mode";
      setControlError(msg);
      console.error("Failed to switch mode:", err);
    } finally {
      setSwitchingMode(false);
    }
  }

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold tracking-tight">
          <span className="text-[var(--accent-blue)]">5m</span>Tracker
        </h1>
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text-secondary)]">
          {enabledMarkets.length} markets
        </div>
        {latestPrice !== null && (
          <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-[var(--bg-card)] text-sm">
            <span className="text-[var(--text-secondary)]">{enabledMarkets.find((m) => m.id === activeMarketId)?.displayName ?? activeMarketId.toUpperCase()}</span>
            <span className="font-mono font-semibold">
              ${latestPrice.toLocaleString(undefined, { minimumFractionDigits: spotDecimals, maximumFractionDigits: spotDecimals })}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleModeToggle}
          disabled={switchingMode}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
            mode === "shadow"
              ? "bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)] border-[var(--accent-yellow)]/40"
              : "bg-[var(--accent-red)]/15 text-[var(--accent-red)] border-[var(--accent-red)]/40"
          }`}
        >
          {mode === "shadow" ? <Eye size={12} /> : <Radio size={12} />}
          {mode === "shadow" ? "SHADOW" : "LIVE"}
        </button>

        <button
          onClick={handleTradingToggle}
          disabled={toggling}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
            tradingActive
              ? "bg-[var(--accent-red)]/15 text-[var(--accent-red)] border border-[var(--accent-red)]/40 hover:bg-[var(--accent-red)]/25"
              : "bg-[var(--accent-green)]/15 text-[var(--accent-green)] border border-[var(--accent-green)]/40 hover:bg-[var(--accent-green)]/25"
          } disabled:opacity-50`}
        >
          {toggling ? (
            <Loader2 size={14} className="animate-spin" />
          ) : tradingActive ? (
            <Square size={14} />
          ) : (
            <Play size={14} />
          )}
          {tradingActive ? "Stop Trading" : "Start Trading"}
        </button>

        {walletAddress && (
          <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <Wallet size={14} />
            <span className="font-mono">
              {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
            </span>
          </div>
        )}
        <div className="flex items-center gap-3">
          {isStale && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)]">
              STALE
            </span>
          )}
          <div className="flex items-center gap-1.5" title="WebSocket to server">
            {wsConnected ? (
              <>
                <Wifi size={12} className="text-[var(--accent-green)]" />
                <span className="text-[10px] text-[var(--accent-green)]">WS</span>
              </>
            ) : (
              <>
                <WifiOff size={12} className="text-[var(--accent-red)]" />
                <span className="text-[10px] text-[var(--accent-red)]">WS</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5" title="Polymarket CLOB connection">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                exchangeConnected
                  ? "bg-[var(--accent-green)]"
                  : "bg-[var(--accent-red)]"
              }`}
            />
            <span
              className={`text-[10px] ${
                exchangeConnected
                  ? "text-[var(--accent-green)]"
                  : "text-[var(--accent-red)]"
              }`}
            >
              {exchangeConnected ? "CLOB" : "CLOB Off"}
            </span>
          </div>
          <div className="flex items-center gap-1.5" title="Database connection">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                !storageHealth.enabled
                  ? "bg-[var(--text-secondary)]"
                  : storageHealth.ok
                    ? "bg-[var(--accent-green)]"
                    : "bg-[var(--accent-red)]"
              }`}
            />
            <span
              className={`text-[10px] ${
                !storageHealth.enabled
                  ? "text-[var(--text-secondary)]"
                  : storageHealth.ok
                    ? "text-[var(--accent-green)]"
                    : "text-[var(--accent-red)]"
              }`}
            >
              {!storageHealth.enabled ? "DB N/A" : storageHealth.ok ? "DB" : "DB Off"}
            </span>
          </div>
        </div>
      </div>
      {controlError && (
        <div className="ml-4 text-xs text-[var(--accent-red)] max-w-[360px] truncate" title={controlError}>
          {controlError}
        </div>
      )}
    </header>
  );
}
