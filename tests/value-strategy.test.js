import assert from "node:assert/strict";
import test from "node:test";
import { ValueStrategy } from "../src/strategies/value.js";

test("value strategy keeps missing valuation data neutral", async () => {
  const strategy = new ValueStrategy({
    marketData: {
      fundamentals: async () => ({
        data: {
          summary: {
            financialData: { currentPrice: 100, targetMeanPrice: null },
            summaryDetail: { forwardPE: null },
          },
        },
      }),
    },
  });
  const result = await strategy.analyze({ symbol: "AAPL" });
  assert.equal(result.score, 0);
  assert.equal(result.metadata.forwardPe, null);
  assert.equal(result.metadata.upside, null);
});
