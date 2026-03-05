import { SpreadPanel } from "./SpreadPanel.js";
import { OrderBook } from "./OrderBook.js";
import { LiveMarket } from "./LiveMarket.js";
import { PnLCard } from "./PnLCard.js";
import { StrategyMini } from "./StrategyMini.js";
import { RecentTrades } from "./RecentTrades.js";
import { ExecutionMetricsCard } from "./ExecutionMetricsCard.js";
import { FeedHealthCard } from "./FeedHealthCard.js";
import { RiskStatusCard } from "./RiskStatusCard.js";

export function Dashboard() {
  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-12">
        <LiveMarket />
      </div>
      <div className="col-span-12">
        <SpreadPanel />
      </div>
      <div className="col-span-12">
        <RecentTrades />
      </div>
      <div className="col-span-12">
        <PnLCard />
      </div>
      <div className="col-span-12">
        <RiskStatusCard />
      </div>
      <div className="col-span-5">
        <OrderBook />
      </div>
      <div className="col-span-7">
        <StrategyMini />
      </div>
      <div className="col-span-12">
        <FeedHealthCard />
      </div>
      <div className="col-span-12">
        <ExecutionMetricsCard />
      </div>
    </div>
  );
}
