import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { config } from "../config.js";

let clientInstance: ClobClient | null = null;
let signerInstance: Wallet | null = null;

export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export async function getPolymarketClient(): Promise<ClobClient> {
  if (clientInstance) return clientInstance;

  if (!config.poly.privateKey) {
    throw new Error("POLY_PRIVATE_KEY is required");
  }

  signerInstance = new Wallet(config.poly.privateKey);

  const hasCachedCreds =
    config.poly.apiKey && config.poly.apiSecret && config.poly.apiPassphrase;

  if (hasCachedCreds) {
    clientInstance = new ClobClient(
      config.poly.clobUrl,
      config.poly.chainId,
      signerInstance,
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
      signerInstance,
    );

    console.log("[Polymarket] Deriving API credentials...");
    const creds = await (tempClient as any).createOrDeriveApiKey();
    console.log("[Polymarket] API Key:", creds.key);
    console.log("[Polymarket] Save these to .env to skip derivation on restart");

    clientInstance = new ClobClient(
      config.poly.clobUrl,
      config.poly.chainId,
      signerInstance,
      creds,
      config.poly.signatureType,
      config.poly.proxyAddress || undefined,
    );
  }

  console.log(
    "[Polymarket] Client initialized for",
    await signerInstance.getAddress(),
  );
  return clientInstance;
}

export function getWalletAddress(): string | null {
  return signerInstance?.address ?? null;
}

export function isConnected(): boolean {
  return clientInstance !== null;
}
