import { ethers, Wallet, Contract, providers } from "ethers";
import { config } from "../config.js";

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const RELAYER_URL = "https://relayer-v2.polymarket.com/";
const DATA_API = "https://data-api.polymarket.com";

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

interface RedeemablePosition {
  conditionId: string;
  indexSet: number;
  size: number;
  asset: string;
}

export interface RedemptionEvent {
  conditionId: string;
  transactionId: string;
  timestamp: number;
  estimatedAmount: number;
  method: "relayer" | "direct";
}

type RelayClientInstance = {
  execute: (
    txs: Array<{ to: string; data: string; value: string; operation?: number }>,
    description: string,
  ) => Promise<{ transactionID: string; wait: () => Promise<any> }>;
};

export class AutoRedeemer {
  private provider: providers.JsonRpcProvider;
  private signer: Wallet;
  private proxyAddress: string | null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingRedemptions = new Set<string>();
  private redeemQueue: string[] = [];
  private _log: RedemptionEvent[] = [];
  private _totalRedeemed = 0;
  private _failCount = 0;
  private _lastCheck = 0;
  private _lastError: string | null = null;
  private _enabled = true;
  private relayClient: RelayClientInstance | null = null;
  private hasBuilderCreds: boolean;

  constructor(rpcUrl: string) {
    this.provider = new providers.JsonRpcProvider(rpcUrl);
    this.signer = new Wallet(config.poly.privateKey, this.provider);
    this.proxyAddress = config.poly.proxyAddress || null;
    this.hasBuilderCreds = !!(
      config.poly.builderApiKey &&
      config.poly.builderSecret &&
      config.poly.builderPassphrase
    );
  }

  get targetAddress(): string {
    return this.proxyAddress || this.signer.address;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    this._enabled = v;
    if (!v) this.stop();
  }

  async start(intervalMs = 45_000): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.hasBuilderCreds) {
      try {
        await this.initRelayClient();
        console.log("[Redeemer] Builder relayer initialized (gasless mode)");
      } catch (err: any) {
        console.error(
          `[Redeemer] Builder relayer init failed: ${err.message}. ` +
            "Falling back to direct on-chain (requires MATIC).",
        );
        this.relayClient = null;
      }
    } else {
      console.warn(
        "[Redeemer] No builder credentials configured. " +
          "Get them at polymarket.com/settings?tab=builder and add " +
          "POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE to .env",
      );
    }

    console.log(
      `[Redeemer] Started (interval: ${intervalMs / 1000}s, ` +
        `wallet: ${this.targetAddress.slice(0, 10)}..., ` +
        `method: ${this.relayClient ? "relayer (gasless)" : "direct (needs MATIC)"})`,
    );

    this.checkAndRedeem().catch(() => {});
    this.timer = setInterval(() => {
      if (this._enabled) this.checkAndRedeem().catch(() => {});
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  queueRedemption(conditionId: string): void {
    if (this.redeemQueue.includes(conditionId)) return;
    this.redeemQueue.push(conditionId);
    setTimeout(() => this.processQueue(), 30_000);
  }

  getStatus() {
    return {
      running: this.running && this._enabled,
      method: this.relayClient ? ("relayer" as const) : ("direct" as const),
      targetAddress: this.targetAddress,
      isProxy: !!this.proxyAddress,
      hasBuilderCreds: this.hasBuilderCreds,
      totalRedeemed: this._totalRedeemed,
      redemptionCount: this._log.length,
      failCount: this._failCount,
      pendingCount: this.pendingRedemptions.size + this.redeemQueue.length,
      lastCheck: this._lastCheck,
      lastError: this._lastError,
      recentRedemptions: this._log.slice(-10),
    };
  }

  async getUsdcBalance(): Promise<number> {
    try {
      const usdc = new Contract(USDC_E, ERC20_ABI, this.provider);
      const balance = await usdc.balanceOf(this.targetAddress);
      return parseFloat(ethers.utils.formatUnits(balance, 6));
    } catch {
      return -1;
    }
  }

  async getMaticBalance(): Promise<number> {
    try {
      const balance = await this.provider.getBalance(this.signer.address);
      return parseFloat(ethers.utils.formatEther(balance));
    } catch {
      return -1;
    }
  }

  // ── Builder relayer init ──

  private async initRelayClient(): Promise<void> {
    const { RelayClient } = await import("@polymarket/builder-relayer-client");
    const { BuilderConfig } = await import("@polymarket/builder-signing-sdk");

    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.poly.builderApiKey,
        secret: config.poly.builderSecret,
        passphrase: config.poly.builderPassphrase,
      },
    });

    this.relayClient = new RelayClient(
      RELAYER_URL,
      137,
      this.signer,
      builderConfig,
    ) as unknown as RelayClientInstance;
  }

  // ── Core redemption loop ──

  async checkAndRedeem(): Promise<void> {
    this._lastCheck = Date.now();
    try {
      const positions = await this.fetchRedeemablePositions();
      this._lastError = null;
      if (positions.length === 0) return;

      const byCondition = new Map<string, RedeemablePosition[]>();
      for (const pos of positions) {
        const arr = byCondition.get(pos.conditionId) ?? [];
        arr.push(pos);
        byCondition.set(pos.conditionId, arr);
      }

      console.log(
        `[Redeemer] Found ${byCondition.size} redeemable condition(s)`,
      );

      for (const [conditionId, conds] of byCondition) {
        if (this.pendingRedemptions.has(conditionId)) continue;
        const totalSize = conds.reduce((s, p) => s + p.size, 0);
        const indexSets = [...new Set(conds.map((c) => c.indexSet))].sort(
          (a, b) => a - b,
        );
        await this.executeRedemption(conditionId, totalSize, indexSets);
      }
    } catch (err: any) {
      const msg = err.message ?? String(err);
      if (msg.includes("429") || msg.includes("rate")) return;
      this._lastError = msg;
      console.error(`[Redeemer] Poll error: ${msg}`);
    }
  }

  private async processQueue(): Promise<void> {
    const batch = [...this.redeemQueue];
    this.redeemQueue = [];
    for (const conditionId of batch) {
      if (this.pendingRedemptions.has(conditionId)) {
        this.redeemQueue.push(conditionId);
        continue;
      }
      await this.executeRedemption(conditionId, 0, [1, 2]);
    }
  }

  private async executeRedemption(
    conditionId: string,
    estimatedAmount: number,
    indexSets: number[],
  ): Promise<void> {
    this.pendingRedemptions.add(conditionId);
    try {
      const result = await this.redeemCondition(conditionId, indexSets);
      this._totalRedeemed += estimatedAmount;
      this._log.push({
        conditionId,
        transactionId: result.txId,
        timestamp: Date.now(),
        estimatedAmount,
        method: result.method,
      });
      console.log(
        `[Redeemer] Redeemed ${conditionId.slice(0, 12)}... ` +
          (estimatedAmount > 0 ? `(~$${estimatedAmount.toFixed(2)}) ` : "") +
          `via ${result.method} [${result.txId.slice(0, 16)}...]`,
      );
    } catch (err: any) {
      this._failCount++;
      this._lastError = err.message ?? String(err);
      console.error(
        `[Redeemer] Failed ${conditionId.slice(0, 12)}...: ${this._lastError}`,
      );
      if (!this.redeemQueue.includes(conditionId)) {
        this.redeemQueue.push(conditionId);
      }
    } finally {
      this.pendingRedemptions.delete(conditionId);
    }
  }

  // ── Data API ──

  private async fetchRedeemablePositions(): Promise<RedeemablePosition[]> {
    const url = `${DATA_API}/positions?user=${this.targetAddress.toLowerCase()}&redeemable=true&limit=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Data API ${res.status}`);

    const data = (await res.json()) as any[];
    if (!Array.isArray(data)) return [];

    const results: RedeemablePosition[] = [];
    const seen = new Set<string>();

    for (const p of data) {
      if (!p.redeemable || parseFloat(p.size ?? "0") <= 0) continue;

      const rawCid = (p.conditionId || p.condition_id) as string;
      if (!rawCid) continue;

      const conditionId = rawCid.startsWith("0x")
        ? rawCid.toLowerCase()
        : `0x${rawCid.toLowerCase()}`;

      let indexSet = 2;
      if (p.outcomeIndex !== undefined && p.outcomeIndex !== null) {
        const idx = Number(p.outcomeIndex);
        if (Number.isFinite(idx)) indexSet = idx + 1;
      }

      const key = `${conditionId}-${indexSet}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        conditionId,
        indexSet,
        size: parseFloat(p.size),
        asset: (p.asset ?? "") as string,
      });
    }

    return results;
  }

  // ── On-chain redemption ──

  private async redeemCondition(
    conditionId: string,
    indexSets: number[],
  ): Promise<{ txId: string; method: "relayer" | "direct" }> {
    const formatted = conditionId.startsWith("0x")
      ? conditionId
      : `0x${conditionId}`;

    if (formatted.length !== 66) {
      throw new Error(`Invalid conditionId length: ${formatted.length}`);
    }

    const ctfIface = new ethers.utils.Interface(CTF_ABI);
    const calldata = ctfIface.encodeFunctionData("redeemPositions", [
      USDC_E.toLowerCase(),
      ethers.constants.HashZero,
      formatted,
      indexSets,
    ]);

    if (this.relayClient) {
      return this.redeemViaRelayer(calldata, conditionId, indexSets);
    }

    return this.redeemDirect(calldata);
  }

  private async redeemViaRelayer(
    calldata: string,
    conditionId: string,
    indexSets: number[],
  ): Promise<{ txId: string; method: "relayer" }> {
    const response = await this.relayClient!.execute(
      [
        {
          to: CTF_ADDRESS.toLowerCase(),
          data: calldata,
          value: "0",
          operation: 0,
        },
      ],
      JSON.stringify({
        action: "redeem-positions",
        conditionId: conditionId.slice(0, 16) + "...",
        indexSets,
      }),
    );

    const receipt = await response.wait();

    const state = receipt?.state ?? "unknown";
    const isSuccess =
      state === "STATE_CONFIRMED" ||
      state === "STATE_MINED" ||
      state === 3 ||
      state === 2;

    if (!isSuccess) {
      throw new Error(`Relayer transaction failed (state: ${state})`);
    }

    return { txId: response.transactionID, method: "relayer" };
  }

  private async redeemDirect(
    calldata: string,
  ): Promise<{ txId: string; method: "direct" }> {
    const tx = await this.signer.sendTransaction({
      to: CTF_ADDRESS,
      data: calldata,
      gasLimit: 200_000,
    });
    const receipt = await tx.wait();
    return { txId: receipt.transactionHash, method: "direct" };
  }
}
