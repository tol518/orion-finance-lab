import { analyzeBars } from "../quant/indicators.js";

export class MomentumStrategy {
  id = "momentum";
  name = "Momentum";
  description = "Deterministic medium-term price momentum with volatility-aware confidence.";
  deterministic = true;

  constructor({ marketData }) {
    this.marketData = marketData;
  }

  async analyze({ symbol, from, to, timeHorizon = "30d" }) {
    const history = await this.marketData.history(symbol, { from, to });
    const indicators = analyzeBars(history.data);
    const momentum = indicators.momentum20 ?? indicators.totalReturn ?? 0;
    const volatilityPenalty = Math.min(0.5, indicators.annualizedVolatility ?? 0.5);
    const score = Math.max(-1, Math.min(1, momentum * 5));
    return {
      score,
      confidence: Math.max(0.35, Math.min(0.8, 0.65 - volatilityPenalty / 2 + Math.abs(score) / 5)),
      timeHorizon,
      thesis: `Twenty-period momentum is ${percent(momentum)} with annualized volatility of ${percent(indicators.annualizedVolatility)}.`,
      evidence: [history],
      metadata: { indicators },
    };
  }
}
function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "unavailable";
}
