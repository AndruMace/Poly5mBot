import { useStore } from "../store/index.js";
import { StrategyCard } from "./StrategyCard.js";
import { Brain } from "lucide-react";
import type { RegimeFilter } from "../types/index.js";

export function StrategyPanel() {
  const strategies = useStore((s) => s.strategies);
  const setStrategies = useStore((s) => s.setStrategies);

  async function handleToggle(name: string) {
    try {
      await fetch(`/api/strategies/${name}/toggle`, { method: "POST" });
    } catch (err) {
      console.error("Failed to toggle strategy:", err);
    }
  }

  async function handleConfigChange(
    name: string,
    config: Record<string, number>,
  ): Promise<boolean> {
    try {
      const res = await fetch(`/api/strategies/${name}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) return false;
      const latest = await fetch("/api/strategies");
      if (latest.ok) {
        const data = await latest.json();
        setStrategies(data);
      }
      return true;
    } catch (err) {
      console.error("Failed to update config:", err);
      return false;
    }
  }

  async function handleRegimeFilterChange(
    name: string,
    filter: RegimeFilter,
  ): Promise<boolean> {
    try {
      const res = await fetch(`/api/strategies/${name}/regime-filter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filter),
      });
      if (!res.ok) return false;
      const latest = await fetch("/api/strategies");
      if (latest.ok) {
        const data = await latest.json();
        setStrategies(data);
      }
      return true;
    } catch (err) {
      console.error("Failed to update regime filter:", err);
      return false;
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Brain size={20} className="text-[var(--accent-blue)]" />
        <h2 className="text-lg font-semibold">Trading Strategies</h2>
      </div>

      {strategies.length === 0 ? (
        <div className="bg-[var(--bg-card)] rounded-xl p-8 border border-[var(--border)] text-center">
          <p className="text-[var(--text-secondary)]">
            Connect to the backend to view and manage strategies.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {strategies.map((s) => (
            <StrategyCard
              key={s.name}
              strategy={s}
              onToggle={() => handleToggle(s.name)}
              onConfigChange={(cfg) => handleConfigChange(s.name, cfg)}
              onRegimeFilterChange={(filter) =>
                handleRegimeFilterChange(s.name, filter)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
