import { useState } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import {
  connectedRx,
  exchangeConnectedRx,
  walletAddressRx,
  killSwitchesRx,
  activeMarketIdRx,
} from "../store/index.js";
import {
  Settings,
  Shield,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Wifi,
  ShieldAlert,
  RefreshCw,
} from "lucide-react";

export function ConnectionSetup() {
  const connected = useRxValue(connectedRx);
  const exchangeConnected = useRxValue(exchangeConnectedRx);
  const walletAddress = useRxValue(walletAddressRx);
  const killSwitches = useRxValue(killSwitchesRx);
  const activeMarketId = useRxValue(activeMarketIdRx);

  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/connect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Connection failed");
      setStatus(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  }

  async function loadStatus() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("Status request failed");
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach backend");
    }
  }

  async function resetKillSwitches() {
    try {
      const res = await fetch(`/api/killswitches/${activeMarketId}/reset`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not reset kill switches");
      }
    } catch {
      setError("Could not reset kill switches");
    }
  }

  const anyActive = killSwitches.some((ks) => ks.active);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2 mb-6">
        <Settings size={20} className="text-[var(--accent-blue)]" />
        <h2 className="text-lg font-semibold">Settings & Connection</h2>
      </div>

      {/* Kill Switches Card */}
      <div className="bg-[var(--bg-card)] rounded-xl p-6 border border-[var(--border)]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2">
            <ShieldAlert size={16} />
            Kill Switches
          </h3>
          {anyActive && (
            <button
              onClick={resetKillSwitches}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)] border border-[var(--accent-yellow)]/30 rounded-lg hover:bg-[var(--accent-yellow)]/25 transition-colors"
            >
              <RefreshCw size={12} />
              Reset Pauses
            </button>
          )}
        </div>

        {killSwitches.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">
            Kill switch status will appear once the engine is running.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {killSwitches.map((ks) => (
              <div
                key={ks.name}
                className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${
                  ks.active
                    ? "border-[var(--accent-red)]/30 bg-[var(--accent-red)]/5"
                    : "border-[var(--border)] bg-[var(--bg-secondary)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      ks.active
                        ? "bg-[var(--accent-red)]"
                        : "bg-[var(--accent-green)]"
                    }`}
                  />
                  <span className={ks.active ? "text-[var(--accent-red)]" : ""}>
                    {ks.name}
                  </span>
                </div>
                <span className="text-xs font-mono text-[var(--text-secondary)]">
                  {ks.reason}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Polymarket Connection */}
      <div className="bg-[var(--bg-card)] rounded-xl p-6 border border-[var(--border)]">
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <Shield size={16} />
          Polymarket Connection
        </h3>

        <div className="bg-[var(--accent-yellow)]/10 border border-[var(--accent-yellow)]/30 rounded-lg p-4 mb-4">
          <div className="flex gap-2">
            <AlertTriangle
              size={16}
              className="text-[var(--accent-yellow)] shrink-0 mt-0.5"
            />
            <div className="text-sm">
              <p className="font-medium text-[var(--accent-yellow)] mb-1">
                Security Notice
              </p>
              <p className="text-[var(--text-secondary)]">
                Your private key is configured via the server's{" "}
                <code className="bg-[var(--bg-secondary)] px-1 rounded text-xs">
                  .env
                </code>{" "}
                file and never sent to the frontend. The key is used server-side
                only to sign Polymarket orders.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 mb-4">
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-[var(--text-secondary)]">
              WebSocket
            </span>
            <span
              className={`flex items-center gap-1.5 text-sm ${
                connected
                  ? "text-[var(--accent-green)]"
                  : "text-[var(--accent-red)]"
              }`}
            >
              <Wifi size={14} />
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>

          <div className="flex items-center justify-between py-2 border-t border-[var(--border)]">
            <span className="text-sm text-[var(--text-secondary)]">Exchange (CLOB)</span>
            <span
              className={`text-sm ${
                exchangeConnected ? "text-[var(--accent-green)]" : "text-[var(--accent-red)]"
              }`}
            >
              {exchangeConnected ? "Connected" : "Disconnected"}
            </span>
          </div>

          {walletAddress && (
            <div className="flex items-center justify-between py-2 border-t border-[var(--border)]">
              <span className="text-sm text-[var(--text-secondary)]">
                Wallet
              </span>
              <span className="text-sm font-mono">{walletAddress}</span>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-blue)] text-white text-sm rounded-lg hover:bg-[var(--accent-blue)]/80 disabled:opacity-50 transition-colors"
          >
            {connecting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CheckCircle size={14} />
            )}
            {connecting ? "Connecting..." : "Connect to Polymarket"}
          </button>

          <button
            onClick={loadStatus}
            className="px-4 py-2 text-sm border border-[var(--border)] rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
          >
            Refresh Status
          </button>
        </div>

        {error && (
          <div className="mt-3 p-3 bg-[var(--accent-red)]/10 border border-[var(--accent-red)]/30 rounded-lg text-sm text-[var(--accent-red)]">
            {error}
          </div>
        )}

        {status && (
          <div className="mt-4 p-3 bg-[var(--bg-secondary)] rounded-lg text-xs font-mono space-y-1">
            {Object.entries(status).map(([k, v]) => (
              <div key={k} className="flex">
                <span className="text-[var(--text-secondary)] w-32">{k}:</span>
                <span>
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Configuration Guide */}
      <div className="bg-[var(--bg-card)] rounded-xl p-6 border border-[var(--border)]">
        <h3 className="font-semibold mb-4">Configuration Guide</h3>
        <div className="text-sm text-[var(--text-secondary)] space-y-3">
          <p>
            To configure the bot, edit the{" "}
            <code className="bg-[var(--bg-secondary)] px-1.5 py-0.5 rounded text-xs">
              .env
            </code>{" "}
            file in the project root with the following keys:
          </p>
          <div className="bg-[var(--bg-secondary)] p-4 rounded-lg font-mono text-xs space-y-1">
            <div>
              <span className="text-[var(--accent-blue)]">POLY_PRIVATE_KEY</span>=your_key
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">POLY_SIGNATURE_TYPE</span>=2
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">POLY_PROXY_ADDRESS</span>=0x...
            </div>
            <div className="text-[var(--text-secondary)]">
              # Risk limits
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">MAX_TRADE_SIZE</span>=10
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">MAX_TOTAL_EXPOSURE</span>=100
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">MAX_DAILY_LOSS</span>=50
            </div>
            <div className="text-[var(--text-secondary)]">
              # Kill switches
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">MAX_HOURLY_LOSS</span>=25
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">MAX_LOSS_PER_WINDOW</span>=2
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">MAX_CONSECUTIVE_LOSSES</span>=5
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">STALE_DATA_MS</span>=5000
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">MAX_SPREAD_CENTS</span>=15
            </div>
            <div>
              <span className="text-[var(--accent-blue)]">MAX_SIGNAL_AGE_MS</span>=2000
            </div>
          </div>
          <p>
            After updating the{" "}
            <code className="bg-[var(--bg-secondary)] px-1.5 py-0.5 rounded text-xs">
              .env
            </code>
            , restart the server and click "Connect to Polymarket" above.
          </p>
        </div>
      </div>
    </div>
  );
}
