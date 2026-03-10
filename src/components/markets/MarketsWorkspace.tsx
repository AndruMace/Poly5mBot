import { useEffect } from "react";
import { useRxSet, useRxValue } from "@effect-rx/rx-react";
import {
  activeMarketIdRx,
  enabledMarketsRx,
  pinnedMarketsRx,
  workspaceLayoutPrefsRx,
} from "../../store/index.js";
import { MarketsOverviewPanel } from "./MarketsOverviewPanel.js";
import { FocusedMarketPanel } from "./FocusedMarketPanel.js";

const PINNED_STORAGE_KEY = "marketsWorkspacePinned";
const PREFS_STORAGE_KEY = "marketsWorkspacePrefs";

export function MarketsWorkspace() {
  const enabledMarkets = useRxValue(enabledMarketsRx);
  const activeMarketId = useRxValue(activeMarketIdRx);
  const pinnedMarkets = useRxValue(pinnedMarketsRx);
  const prefs = useRxValue(workspaceLayoutPrefsRx);
  const setActiveMarketId = useRxSet(activeMarketIdRx);
  const setPinnedMarkets = useRxSet(pinnedMarketsRx);
  const setWorkspacePrefs = useRxSet(workspaceLayoutPrefsRx);

  useEffect(() => {
    try {
      const savedPins = JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) ?? "[]") as string[];
      if (Array.isArray(savedPins)) {
        setPinnedMarkets(savedPins.filter((v) => typeof v === "string"));
      }
      const savedPrefs = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
      if (savedPrefs && typeof savedPrefs === "object") {
        setWorkspacePrefs({ ...prefs, ...savedPrefs });
      }
    } catch {
      // Ignore malformed local storage values.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPinnedMarkets, setWorkspacePrefs]);

  useEffect(() => {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinnedMarkets));
  }, [pinnedMarkets]);

  useEffect(() => {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  const focusMarketId = prefs.focusMarketId ?? activeMarketId;

  const handleFocusMarket = (marketId: string) => {
    setActiveMarketId(marketId);
    setWorkspacePrefs({ ...prefs, showFocusPanel: true, focusMarketId: marketId });
  };

  const handleSelectMarket = (marketId: string) => {
    setActiveMarketId(marketId);
    setWorkspacePrefs({ ...prefs, focusMarketId: marketId });
  };

  const handleCloseFocus = () => {
    setWorkspacePrefs({ ...prefs, showFocusPanel: false });
  };

  return (
    <div className="space-y-4" data-testid="markets-workspace">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Markets Workspace</h2>
          <p className="text-xs text-[var(--text-secondary)]">
            Compare {enabledMarkets.length} enabled markets and open a focused detail pane.
          </p>
        </div>
      </div>

      <div className={`grid gap-4 ${prefs.showFocusPanel ? "xl:grid-cols-12" : "grid-cols-1"}`}>
        <div className={prefs.showFocusPanel ? "xl:col-span-7" : "col-span-1"}>
          <MarketsOverviewPanel
            onFocusMarket={handleFocusMarket}
            onSelectMarket={handleSelectMarket}
          />
        </div>
        {prefs.showFocusPanel && (
          <div className="xl:col-span-5 xl:max-h-[calc(100vh-210px)] xl:overflow-y-auto">
            <FocusedMarketPanel marketId={focusMarketId} onClose={handleCloseFocus} />
          </div>
        )}
      </div>
    </div>
  );
}
