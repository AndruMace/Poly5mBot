import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { Effect, Ref } from "effect";
import { AppConfig } from "../config.js";
import { PolymarketError } from "../errors.js";

export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export class PolymarketClient extends Effect.Service<PolymarketClient>()("PolymarketClient", {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig;
    const clientRef = yield* Ref.make<ClobClient | null>(null);
    const signerRef = yield* Ref.make<Wallet | null>(null);

    const connect = Effect.gen(function* () {
      const existing = yield* Ref.get(clientRef);
      if (existing) return existing;

      if (!config.poly.privateKey) {
        return yield* Effect.fail(new PolymarketError({ message: "POLY_PRIVATE_KEY is required" }));
      }

      const signer = new Wallet(config.poly.privateKey);
      yield* Ref.set(signerRef, signer);

      const hasCachedCreds = config.poly.apiKey && config.poly.apiSecret && config.poly.apiPassphrase;

      let client: ClobClient;

      if (hasCachedCreds) {
        client = new ClobClient(
          config.poly.clobUrl,
          config.poly.chainId,
          signer,
          {
            key: config.poly.apiKey,
            secret: config.poly.apiSecret,
            passphrase: config.poly.apiPassphrase,
          },
          config.poly.signatureType,
          config.poly.proxyAddress || undefined,
        );
      } else {
        const tempClient = new ClobClient(
          config.poly.clobUrl,
          config.poly.chainId,
          signer,
        );

        yield* Effect.log("[Polymarket] Deriving API credentials...");
        const creds = yield* Effect.tryPromise({
          try: () => (tempClient as any).createOrDeriveApiKey() as Promise<ApiCreds>,
          catch: (err) => new PolymarketError({ message: `Failed to derive API key: ${err}`, cause: err }),
        });
        yield* Effect.log(
          `[Polymarket] API Key: ${creds.key.slice(0, 6)}...${creds.key.slice(-4)} (save to .env as POLY_API_KEY to skip derivation)`,
        );

        client = new ClobClient(
          config.poly.clobUrl,
          config.poly.chainId,
          signer,
          creds,
          config.poly.signatureType,
          config.poly.proxyAddress || undefined,
        );
      }

      const addr = yield* Effect.promise(() => signer.getAddress());
      yield* Effect.log(`[Polymarket] Client initialized for ${addr}`);
      yield* Ref.set(clientRef, client);
      return client;
    });

    const getClient = connect;

    const getWalletAddress = Ref.get(signerRef).pipe(
      Effect.map((s) => s?.address ?? null),
    );

    const isConnected = Ref.get(clientRef).pipe(
      Effect.map((c) => c !== null),
    );

    return { getClient, getWalletAddress, isConnected } as const;
  }),
}) {}
