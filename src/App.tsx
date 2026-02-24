import { useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { Layout, type Tab } from "./components/Layout.js";
import { Dashboard } from "./components/Dashboard.js";
import { StrategyPanel } from "./components/StrategyPanel.js";
import { TradeLog } from "./components/TradeLog.js";
import { ConnectionSetup } from "./components/ConnectionSetup.js";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  useWebSocket();

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === "dashboard" && <Dashboard />}
      {activeTab === "strategies" && <StrategyPanel />}
      {activeTab === "trades" && <TradeLog />}
      {activeTab === "settings" && <ConnectionSetup />}
    </Layout>
  );
}

export default App;
