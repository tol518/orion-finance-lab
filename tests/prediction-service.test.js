import assert from "node:assert/strict";
import test from "node:test";
import { PredictionService } from "../src/predictions/prediction-service.js";

test("prediction evaluation waits for the first market bar at or after its due time", async () => {
  const prediction = {
    id: "prediction-1",
    symbol: "AAPL",
    benchmarkSymbol: "^GSPC",
    startPrice: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    dueAt: "2026-01-04T00:00:00.000Z",
    direction: "BULLISH",
    expectedReturnMin: 0,
    expectedReturnMax: 0.2,
  };
  const recorded = [];
  const store = {
    listDuePredictions: () => [prediction],
    recordPredictionResult: (result) => { recorded.push(result); return result; },
  };
  let bars = [{ date: "2026-01-02T00:00:00.000Z", close: 101 }];
  const marketData = { history: async () => ({ data: bars }) };
  const service = new PredictionService({ store, marketData });

  assert.deepEqual(await service.evaluateDue("2026-01-04T00:00:00.000Z"), []);
  assert.equal(recorded.length, 0);

  bars = [...bars, { date: "2026-01-05T00:00:00.000Z", close: 105 }];
  const results = await service.evaluateDue("2026-01-05T00:00:00.000Z");
  assert.equal(results.length, 1);
  assert.equal(results[0].endPrice, 105);
});

test("prediction recording rejects a missing starting price", async () => {
  const service = new PredictionService({
    store: { recordPrediction: () => assert.fail("invalid prediction must not be stored") },
    marketData: { quote: async () => ({ data: { price: null } }) },
  });
  await assert.rejects(() => service.record({ symbol: "AAPL" }), (error) =>
    error.code === "INVALID_MARKET_PRICE",
  );
});
