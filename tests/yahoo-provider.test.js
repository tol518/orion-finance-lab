import assert from "node:assert/strict";
import test from "node:test";
import { YahooMarketDataProvider } from "../src/market-data/yahoo-provider.js";

test("Yahoo adapter preserves missing numeric values and drops bars without a close", async () => {
  const provider = new YahooMarketDataProvider({
    client: {
      quote: async () => ({ symbol: "AAPL", regularMarketPrice: null, regularMarketVolume: undefined }),
      chart: async () => ({
        quotes: [
          { date: new Date("2026-01-01T00:00:00.000Z"), close: null, open: null },
          { date: new Date("2026-01-02T00:00:00.000Z"), close: 101, open: null },
        ],
      }),
    },
  });
  const quote = await provider.quote("AAPL");
  assert.equal(quote.data.price, null);
  assert.equal(quote.data.volume, null);
  const history = await provider.history("AAPL", {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-03T00:00:00.000Z",
  });
  assert.equal(history.data.length, 1);
  assert.equal(history.data[0].open, null);
  assert.equal(history.data[0].close, 101);
});
