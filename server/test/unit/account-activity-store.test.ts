import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { runTest } from "../helpers.js";
import { AccountActivityStore } from "../../src/activity/store.js";

describe("AccountActivityStore", () => {
  it("imports csv rows and deduplicates repeated imports", () =>
    runTest(
      Effect.gen(function* () {
        const store = yield* AccountActivityStore;
        const unique = Date.now();
        const csv = [
          '\uFEFF"marketName",action,usdcAmount,tokenAmount,tokenName,timestamp,hash',
          `"Bitcoin Up or Down - February 27, 9:45AM-9:50AM ET",Buy,4.96,8,Down,1772203731,0xabc${unique}`,
          `"Bitcoin Up or Down - February 27, 9:45AM-9:50AM ET",Redeem,64.128767,64.128767,,1772204027,0xdef${unique}`,
        ].join("\n");

        const first = yield* store.importCsv(csv);
        expect(first.imported).toBe(2);
        expect(first.skipped).toBe(0);

        const second = yield* store.importCsv(csv);
        expect(second.imported).toBe(0);
        expect(second.skipped).toBe(2);

        const page = yield* store.list({ limit: 10 });
        expect(page.items.length).toBeGreaterThanOrEqual(2);
        expect(page.items.some((r) => r.action === "Redeem")).toBe(true);
      }),
    ));
});
