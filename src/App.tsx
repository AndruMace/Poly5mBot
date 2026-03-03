import { useState, useEffect } from "react";
import { useRxValue } from "@effect-rx/rx-react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { Layout, type Tab } from "./components/Layout.js";
import { Dashboard } from "./components/Dashboard.js";
import { StrategyPanel } from "./components/StrategyPanel.js";
import { TradeLog } from "./components/TradeLog.js";
import { ConnectionSetup } from "./components/ConnectionSetup.js";
import { CriticalIncidentBanner } from "./components/CriticalIncidentBanner.js";
import { Observability } from "./components/Observability.js";
import { activeMarketIdRx } from "./store/index.js";

const VALID_TABS: Tab[] = ["dashboard", "strategies", "trades", "observability", "settings"];

function getInitialTab(): Tab {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return VALID_TABS.includes(tab as Tab) ? (tab as Tab) : "dashboard";
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>(getInitialTab);
  const activeMarketId = useRxValue(activeMarketIdRx);
  useWebSocket();

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("tab", activeTab);
    params.set("market", activeMarketId);
    history.replaceState(null, "", `?${params.toString()}`);
  }, [activeTab, activeMarketId]);

  return (
    <>
      <CriticalIncidentBanner />
      <Layout activeTab={activeTab} onTabChange={setActiveTab}>
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "strategies" && <StrategyPanel />}
        {activeTab === "trades" && <TradeLog />}
        {activeTab === "observability" && <Observability />}
        {activeTab === "settings" && <ConnectionSetup />}
      </Layout>
    </>
  );
}

export default App;
