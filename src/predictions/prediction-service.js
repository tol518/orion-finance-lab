import { predictionPerformance } from "../evaluation/performance.js";
import { FinanceError } from "../api/validation.js";

export class PredictionService {
  constructor({ store, marketData }) {
    this.store = store;
    this.marketData = marketData;
  }

  async record(input) {
    const quote = await this.marketData.quote(input.symbol);
    const startPrice = Number(quote.data.price);
    if (!Number.isFinite(startPrice) || startPrice <= 0) {
      throw new FinanceError("A valid starting price is required", {
        code: "INVALID_MARKET_PRICE",
        status: 502,
      });
    }
    return this.store.recordPrediction({ ...input, startPrice });
  }

  async evaluateDue(at = new Date().toISOString()) {
    const due = this.store.listDuePredictions(at);
    const results = [];
    for (const prediction of due) {
      try {
        const history = await this.marketData.history(prediction.symbol, {
          from: prediction.createdAt,
          to: new Date(new Date(prediction.dueAt).getTime() + 7 * 86_400_000).toISOString(),
        });
        const endPrice = firstCloseAtOrAfter(history.data, prediction.dueAt);
        if (!prediction.startPrice || !endPrice) continue;
        const actualReturn = endPrice / prediction.startPrice - 1;
        const benchmarkReturn = await this.#benchmarkReturn(prediction);
        const directionCorrect = prediction.direction === "BULLISH"
          ? actualReturn > 0
          : prediction.direction === "BEARISH"
            ? actualReturn < 0
            : Math.abs(actualReturn) < 0.02;
        results.push(this.store.recordPredictionResult({
          predictionId: prediction.id,
          endPrice,
          actualReturn,
          benchmarkReturn,
          alpha: benchmarkReturn === null ? null : actualReturn - benchmarkReturn,
          directionCorrect,
          rangeCorrect: actualReturn >= prediction.expectedReturnMin && actualReturn <= prediction.expectedReturnMax,
        }));
      } catch {
        // A missing market session or transient provider error leaves the prediction pending for retry.
      }
    }
    return results;
  }

  performance(agentId) {
    return predictionPerformance(this.store.listPredictions({ agentId, limit: 10_000 }));
  }

  async #benchmarkReturn(prediction) {
    try {
      const history = await this.marketData.history(prediction.benchmarkSymbol, {
        from: prediction.createdAt,
        to: new Date(new Date(prediction.dueAt).getTime() + 7 * 86_400_000).toISOString(),
      });
      const start = history.data[0]?.close;
      const end = firstCloseAtOrAfter(history.data, prediction.dueAt);
      return start && end ? end / start - 1 : null;
    } catch {
      return null;
    }
  }
}

function firstCloseAtOrAfter(bars, timestamp) {
  const dueAt = new Date(timestamp).getTime();
  return bars.find((bar) => new Date(bar.date).getTime() >= dueAt)?.close;
}
