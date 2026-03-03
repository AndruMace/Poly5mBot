import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class MockWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      static latest: MockWebSocket | null = null;
      static queued: unknown[] = [];
      readyState = MockWebSocket.OPEN;
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: Event) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;

      constructor(_url: string) {
        MockWebSocket.latest = this;
        setTimeout(() => {
          this.onopen?.(new Event("open"));
          MockWebSocket.flush();
        }, 0);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }

      send() {}

      static flush() {
        const ws = MockWebSocket.latest;
        if (!ws || !ws.onmessage || MockWebSocket.queued.length === 0) return;
        const queued = [...MockWebSocket.queued];
        MockWebSocket.queued.length = 0;
        for (const msg of queued) {
          ws.onmessage(new MessageEvent("message", { data: JSON.stringify(msg) }));
        }
      }
    }

    (window as any).__emitWs = (msg: unknown) => {
      MockWebSocket.queued.push(msg);
      MockWebSocket.flush();
    };

    (window as any).WebSocket = MockWebSocket;
  });

  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/notes", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "initial note", updatedAt: Date.now() }),
      });
      return;
    }

    const postData = request.postDataJSON() as { text?: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: postData.text ?? "", updatedAt: Date.now() }),
    });
  });

  await page.goto("/");

  await page.waitForTimeout(50);
  await page.evaluate(() => {
    (window as any).__emitWs({
      type: "status",
      timestamp: Date.now(),
      data: {
        tradingActive: false,
        mode: "shadow",
        exchangeConnected: true,
        walletAddress: "0x1234567890abcdef",
        strategies: [
          {
            name: "arb",
            enabled: true,
            status: "watching",
            lastSignal: null,
            config: { tradeSize: 10 },
            wins: 1,
            losses: 0,
            totalPnl: 1,
            regimeFilter: {},
          },
        ],
        market: null,
        orderbook: {
          up: { bids: [], asks: [] },
          down: { bids: [], asks: [] },
          bestAskUp: null,
          bestAskDown: null,
          bestBidUp: null,
          bestBidDown: null,
        },
        prices: {
          binance: {
            exchange: "binance",
            price: 110000,
            timestamp: Date.now(),
          },
        },
        oracleEstimate: 110000,
        feedHealth: {
          sources: [],
          healthyCount: 0,
          staleCount: 0,
          downCount: 0,
          oracleEstimate: 110000,
          oracleSourceCount: 0,
          updatedAt: Date.now(),
        },
        pnl: {
          totalPnl: 0,
          todayPnl: 0,
          totalTrades: 0,
          winRate: 0,
          byStrategy: {},
          history: [],
        },
        shadowPnl: {
          totalPnl: 0,
          todayPnl: 0,
          totalTrades: 0,
          winRate: 0,
          byStrategy: {},
          history: [],
        },
        trades: [
          {
            id: "=danger",
            strategy: "=SUM(1,1)",
            side: "UP",
            tokenId: "tok",
            entryPrice: 0.5,
            size: 10,
            shares: 20,
            fee: 0.1,
            status: "resolved",
            outcome: "win",
            pnl: 1,
            timestamp: Date.now(),
            windowEnd: Date.now() + 30000,
            conditionId: "cond-1",
            priceToBeatAtEntry: 100,
          },
        ],
        regime: {
          volatilityRegime: "normal",
          trendRegime: "chop",
          liquidityRegime: "normal",
          spreadRegime: "normal",
        },
        killSwitches: [],
        risk: {
          openPositions: 0,
          maxConcurrentPositions: 0,
          openExposure: 0,
          maxTotalExposure: 0,
          dailyPnl: 0,
          maxDailyLoss: 0,
          hourlyPnl: 0,
          maxHourlyLoss: 0,
          consecutiveLosses: 0,
          maxConsecutiveLosses: 0,
          windowLosses: 0,
          maxLossPerWindow: 0,
          pauseRemainingSec: 0,
        },
        metrics: {
          windowConditionId: null,
          rolling: {},
          window: {},
          latency: {
            lastSignalToSubmitMs: 0,
            avgSignalToSubmitMs: 0,
            avgRecentSignalToSubmitMs: 0,
            samples: 0,
            lastSampleAt: 0,
            priceDataAgeMs: 0,
            orderbookAgeMs: 0,
          },
          reconciliation: {
            updatedAt: 0,
            liveTotalTrades: 0,
            shadowTotalTrades: 0,
            liveWinRate: 0,
            shadowWinRate: 0,
            liveTotalPnl: 0,
            shadowTotalPnl: 0,
            strategies: [],
          },
        },
      },
    });
  });
});

test("dashboard boot + header controls", async ({ page }) => {
  await expect(page.getByText("5mTracker")).toBeVisible();
  await expect(page.getByRole("button", { name: /shadow/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /start trading/i })).toBeVisible();

  const modeReq = page.waitForRequest("**/api/mode/**");
  await page.getByRole("button", { name: /shadow/i }).click();
  await modeReq;

  const toggleReq = page.waitForRequest("**/api/trading/**/toggle");
  await page.getByRole("button", { name: /start trading/i }).click();
  await toggleReq;
});

test("strategy and trade tabs render server-backed state", async ({ page }) => {
  await page.getByRole("button", { name: "Strategies" }).click();
  await expect(page.getByText(/trading strategies/i)).toBeVisible();
  await expect(page.getByText(/arbitrage|arb/i)).toBeVisible();

  await page.getByRole("button", { name: "Trades" }).click();
  await expect(page.getByText(/trade history/i)).toBeVisible();
  await page.evaluate(() => {
    (window as any).__emitWs({
      type: "trade",
      timestamp: Date.now(),
      data: {
        id: "trade-e2e-1",
        strategy: "arb",
        side: "UP",
        tokenId: "tok",
        entryPrice: 0.5,
        size: 10,
        shares: 20,
        fee: 0.1,
        status: "resolved",
        outcome: "win",
        pnl: 1,
        timestamp: Date.now(),
        windowEnd: Date.now() + 30_000,
        conditionId: "cond-e2e-1",
        priceToBeatAtEntry: 100,
      },
    });
  });
  await expect(page.getByText(/1 trades/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /export csv/i })).toBeVisible();
});

test("notes load and save roundtrip", async ({ page }) => {
  await page.getByRole("button", { name: /^notes$/i }).click();
  await expect(page.getByPlaceholder("Write notes here...")).toHaveValue("initial note");

  await page.getByPlaceholder("Write notes here...").fill("updated note body");

  const saveReq = page.waitForRequest("**/api/notes");
  await page.getByRole("button", { name: /save notes/i }).click();
  const request = await saveReq;
  expect(request.method()).toBe("PUT");

  await expect(page.getByText(/^Saved/)).toBeVisible();
});
