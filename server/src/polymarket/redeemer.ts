import { ethers, Wallet, Contract, providers } from "ethers";
import { Effect, Ref, Schedule, Chunk, Queue } from "effect";
import { AppConfig } from "../config.js";
import { PolymarketError } from "../errors.js";

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

export interface RedeemerStatus {
  running: boolean;
  method: "relayer" | "direct";
  targetAddress: string;
  isProxy: boolean;
  hasBuilderCreds: boolean;
  totalRedeemed: number;
  redemptionCount: number;
  failCount: number;
  pendingCount: number;
  lastCheck: number;
  lastError: string | null;
  recentRedemptions: RedemptionEvent[];
}

interface AutoRedeemerApi {
  getStatus: Effect.Effect<RedeemerStatus, never, never>;
  queueRedemption: (conditionId: string) => Effect.Effect<void, never, never>;
  setEnabled: (v: boolean) => Effect.Effect<void, never, never>;
  getUsdcBalance: Effect.Effect<number, never, never>;
  getMaticBalance: Effect.Effect<number, never, never>;
}

type RelayClientInstance = {
  execute: (
    txs: Array<{ to: string; data: string; value: string; operation?: number }>,
    description: string,
  ) => Promise<{ transactionID: string; wait: () => Promise<any> }>;
};

export class AutoRedeemer extends Effect.Service<AutoRedeemer>()("AutoRedeemer", {
  scoped: Effect.gen(function* () {
    const config = yield* AppConfig;
    const configuredPrivateKey = config.poly.privateKey.trim();
    const configuredProxyAddress = config.poly.proxyAddress.trim();

    if (configuredPrivateKey.length === 0) {
      if (config.redemption.enabled) {
        yield* Effect.logWarning(
          "[Redeemer] AUTO_REDEEM enabled but POLY_PRIVATE_KEY is empty. " +
          "Auto redeemer is disabled until POLY_PRIVATE_KEY is configured.",
        );
      }

      const disabledTargetAddress = configuredProxyAddress || "";
      const disabledStatus: Effect.Effect<RedeemerStatus, never, never> = Effect.succeed({
        running: false,
        method: "direct" as const,
        targetAddress: disabledTargetAddress,
        isProxy: !!configuredProxyAddress,
        hasBuilderCreds: false,
        totalRedeemed: 0,
        redemptionCount: 0,
        failCount: 0,
        pendingCount: 0,
        lastCheck: 0,
        lastError: "POLY_PRIVATE_KEY is not configured",
        recentRedemptions: [] as RedemptionEvent[],
      });

      const disabledApi: AutoRedeemerApi = {
        getStatus: disabledStatus,
        queueRedemption: (_conditionId: string) => Effect.void,
        setEnabled: (_v: boolean) => Effect.void,
        getUsdcBalance: Effect.succeed(-1),
        getMaticBalance: Effect.succeed(-1),
      };

      return disabledApi;
    }

    const provider = new providers.JsonRpcProvider(config.redemption.polygonRpcUrl);
    const signer = new Wallet(configuredPrivateKey, provider);
    const proxyAddress = configuredProxyAddress || null;
    const targetAddress = proxyAddress || signer.address;
    const hasBuilderCreds = !!(config.poly.builderApiKey && config.poly.builderSecret && config.poly.builderPassphrase);

    const relayClientRef = yield* Ref.make<RelayClientInstance | null>(null);
    const logRef = yield* Ref.make<RedemptionEvent[]>([]);
    const totalRedeemedRef = yield* Ref.make(0);
    const failCountRef = yield* Ref.make(0);
    const lastCheckRef = yield* Ref.make(0);
    const lastErrorRef = yield* Ref.make<string | null>(null);
    const enabledRef = yield* Ref.make(config.redemption.enabled);
    const pendingRef = yield* Ref.make(new Set<string>());
    const redeemQueue = yield* Queue.unbounded<string>();

    const initRelayClient = Effect.gen(function* () {
      if (!hasBuilderCreds) return;
      yield* Effect.tryPromise({
        try: async () => {
          const { RelayClient } = await import("@polymarket/builder-relayer-client");
          const { BuilderConfig } = await import("@polymarket/builder-signing-sdk");
          const builderConfig = new BuilderConfig({
            localBuilderCreds: {
              key: config.poly.builderApiKey,
              secret: config.poly.builderSecret,
              passphrase: config.poly.builderPassphrase,
            },
          });
          const client = new RelayClient(RELAYER_URL, 137, signer, builderConfig) as unknown as RelayClientInstance;
          return client;
        },
        catch: (err) => new PolymarketError({ message: `Builder relayer init failed: ${err}`, cause: err }),
      }).pipe(
        Effect.tap((client) => Ref.set(relayClientRef, client)),
        Effect.tap(() => Effect.log("[Redeemer] Builder relayer initialized (gasless mode)")),
        Effect.catchAll((err) => Effect.logError(`[Redeemer] ${err.message}. Falling back to direct on-chain.`)),
      );
    });

    const fetchRedeemablePositions = Effect.tryPromise({
      try: async () => {
        const url = `${DATA_API}/positions?user=${targetAddress.toLowerCase()}&redeemable=true&limit=100`;
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
          const conditionId = rawCid.startsWith("0x") ? rawCid.toLowerCase() : `0x${rawCid.toLowerCase()}`;
          let indexSet = 2;
          if (p.outcomeIndex !== undefined && p.outcomeIndex !== null) {
            const idx = Number(p.outcomeIndex);
            if (Number.isFinite(idx)) indexSet = idx + 1;
          }
          const key = `${conditionId}-${indexSet}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ conditionId, indexSet, size: parseFloat(p.size), asset: (p.asset ?? "") as string });
        }
        return results;
      },
      catch: (err) => new PolymarketError({ message: `Fetch positions error: ${err}`, cause: err }),
    });

    const redeemCondition = (conditionId: string, indexSets: number[]) =>
      Effect.gen(function* () {
        const formatted = conditionId.startsWith("0x") ? conditionId : `0x${conditionId}`;
        if (formatted.length !== 66) {
          return yield* Effect.fail(new PolymarketError({ message: `Invalid conditionId length: ${formatted.length}` }));
        }

        const ctfIface = new ethers.utils.Interface(CTF_ABI);
        const calldata = ctfIface.encodeFunctionData("redeemPositions", [
          USDC_E.toLowerCase(),
          ethers.constants.HashZero,
          formatted,
          indexSets,
        ]);

        const relayClient = yield* Ref.get(relayClientRef);
        if (relayClient) {
          return yield* Effect.tryPromise({
            try: async () => {
              const response = await relayClient.execute(
                [{ to: CTF_ADDRESS.toLowerCase(), data: calldata, value: "0", operation: 0 }],
                JSON.stringify({ action: "redeem-positions", conditionId: conditionId.slice(0, 16) + "...", indexSets }),
              );
              const receipt = await response.wait();
              const state = receipt?.state ?? "unknown";
              const isSuccess = state === "STATE_CONFIRMED" || state === "STATE_MINED" || state === 3 || state === 2;
              if (!isSuccess) throw new Error(`Relayer transaction failed (state: ${state})`);
              return { txId: response.transactionID, method: "relayer" as const };
            },
            catch: (err) => new PolymarketError({ message: `Relayer redeem failed: ${err}`, cause: err }),
          });
        }

        return yield* Effect.tryPromise({
          try: async () => {
            const tx = await signer.sendTransaction({ to: CTF_ADDRESS, data: calldata, gasLimit: 200_000 });
            const receipt = await tx.wait();
            return { txId: receipt.transactionHash, method: "direct" as const };
          },
          catch: (err) => new PolymarketError({ message: `Direct redeem failed: ${err}`, cause: err }),
        });
      });

    const executeRedemption = (conditionId: string, estimatedAmount: number, indexSets: number[]) =>
      Effect.gen(function* () {
        yield* Ref.update(pendingRef, (s) => { const n = new Set(s); n.add(conditionId); return n; });
        yield* redeemCondition(conditionId, indexSets).pipe(
          Effect.tap((result) =>
            Effect.all([
              Ref.update(totalRedeemedRef, (t) => t + estimatedAmount),
              Ref.update(logRef, (l) => [
                ...l,
                { conditionId, transactionId: result.txId, timestamp: Date.now(), estimatedAmount, method: result.method },
              ]),
              Effect.log(
                `[Redeemer] Redeemed ${conditionId.slice(0, 12)}... ` +
                (estimatedAmount > 0 ? `(~$${estimatedAmount.toFixed(2)}) ` : "") +
                `via ${result.method} [${result.txId.slice(0, 16)}...]`,
              ),
            ]),
          ),
          Effect.catchAll((err) =>
            Effect.all([
              Ref.update(failCountRef, (c) => c + 1),
              Ref.set(lastErrorRef, err.message),
              Effect.logError(`[Redeemer] Failed ${conditionId.slice(0, 12)}...: ${err.message}`),
              Queue.offer(redeemQueue, conditionId),
            ]),
          ),
        );
        yield* Ref.update(pendingRef, (s) => { const n = new Set(s); n.delete(conditionId); return n; });
      });

    const checkAndRedeem = Effect.gen(function* () {
      yield* Ref.set(lastCheckRef, Date.now());
      const positions = yield* fetchRedeemablePositions.pipe(
        Effect.tap(() => Ref.set(lastErrorRef, null)),
        Effect.catchAll((err) => {
          const msg = err.message;
          if (msg.includes("429") || msg.includes("rate")) return Effect.succeed([]);
          return Ref.set(lastErrorRef, msg).pipe(
            Effect.tap(() => Effect.logError(`[Redeemer] Poll error: ${msg}`)),
            Effect.map(() => [] as RedeemablePosition[]),
          );
        }),
      );
      if (positions.length === 0) return;

      const byCondition = new Map<string, RedeemablePosition[]>();
      for (const pos of positions) {
        const arr = byCondition.get(pos.conditionId) ?? [];
        arr.push(pos);
        byCondition.set(pos.conditionId, arr);
      }

      yield* Effect.log(`[Redeemer] Found ${byCondition.size} redeemable condition(s)`);
      const pending = yield* Ref.get(pendingRef);

      for (const [condId, conds] of byCondition) {
        if (pending.has(condId)) continue;
        const totalSize = conds.reduce((s, p) => s + p.size, 0);
        const indexSets = [...new Set(conds.map((c) => c.indexSet))].sort((a, b) => a - b);
        yield* executeRedemption(condId, totalSize, indexSets);
      }
    });

    const processQueue = Effect.gen(function* () {
      const items = yield* Queue.takeAll(redeemQueue);
      const batch = Chunk.toReadonlyArray(items);
      const pending = yield* Ref.get(pendingRef);
      for (const conditionId of batch) {
        if (pending.has(conditionId)) {
          yield* Queue.offer(redeemQueue, conditionId);
          continue;
        }
        yield* executeRedemption(conditionId, 0, [1, 2]);
      }
    });

    yield* initRelayClient;

    if (!hasBuilderCreds) {
      yield* Effect.logWarning(
        "[Redeemer] No builder credentials configured. " +
        "Get them at polymarket.com/settings?tab=builder and add " +
        "POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE to .env",
      );
    }

    const relayClient = yield* Ref.get(relayClientRef);
    yield* Effect.log(
      `[Redeemer] Started (interval: ${config.redemption.intervalMs / 1000}s, ` +
      `wallet: ${targetAddress.slice(0, 10)}..., ` +
      `method: ${relayClient ? "relayer (gasless)" : "direct (needs MATIC)"})`,
    );

    yield* checkAndRedeem.pipe(
      Effect.catchAll(() => Effect.void),
      Effect.repeat(Schedule.fixed(`${config.redemption.intervalMs} millis`)),
      Effect.forkScoped,
    );

    yield* processQueue.pipe(
      Effect.repeat(Schedule.fixed("30 seconds")),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );

    const getStatus = Effect.gen(function* () {
      const enabled = yield* Ref.get(enabledRef);
      const relay = yield* Ref.get(relayClientRef);
      const totalRedeemed = yield* Ref.get(totalRedeemedRef);
      const redemptionLog = yield* Ref.get(logRef);
      const failCount = yield* Ref.get(failCountRef);
      const pending = yield* Ref.get(pendingRef);
      const lastCheck = yield* Ref.get(lastCheckRef);
      const lastError = yield* Ref.get(lastErrorRef);
      const queueSize = yield* Queue.size(redeemQueue);
      return {
        running: enabled,
        method: relay ? ("relayer" as const) : ("direct" as const),
        targetAddress,
        isProxy: !!proxyAddress,
        hasBuilderCreds,
        totalRedeemed,
        redemptionCount: redemptionLog.length,
        failCount,
        pendingCount: pending.size + queueSize,
        lastCheck,
        lastError,
        recentRedemptions: redemptionLog.slice(-10),
      };
    });

    const queueRedemption = (conditionId: string) => Queue.offer(redeemQueue, conditionId);

    const setEnabled = (v: boolean) => Ref.set(enabledRef, v);

    const getUsdcBalance = Effect.tryPromise({
      try: async () => {
        const usdc = new Contract(USDC_E, ERC20_ABI, provider);
        const balance = await usdc.balanceOf(targetAddress);
        return parseFloat(ethers.utils.formatUnits(balance, 6));
      },
      catch: () => -1,
    }).pipe(Effect.catchAll(() => Effect.succeed(-1)));

    const getMaticBalance = Effect.tryPromise({
      try: async () => {
        const balance = await provider.getBalance(signer.address);
        return parseFloat(ethers.utils.formatEther(balance));
      },
      catch: () => -1,
    }).pipe(Effect.catchAll(() => Effect.succeed(-1)));

    const api: AutoRedeemerApi = {
      getStatus,
      queueRedemption,
      setEnabled,
      getUsdcBalance,
      getMaticBalance,
    };

    return api;
  }),
}) {}
