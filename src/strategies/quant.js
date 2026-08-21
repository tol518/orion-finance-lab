import { analyzeBars } from "../quant/indicators.js";

export class QuantStrategy {
  id = "quant-core";
  name = "Deterministic Quant";
  description = "Price-based technical and risk statistics with no model dependency.";
  deterministic = true;

  constructor({ marketData }) {
    this.marketData = marketData;
  }

  async analyze({ symbol, from, to, timeHorizon = "30d" }) {
    const history = await this.marketData.history(symbol, { from, to });
    const indicators = analyzeBars(history.data);
    const score = indicators.signalScore ?? 0;
    const evidenceStrength = Math.min(1, indicators.sampleSize / 100);
    const confidence = Math.min(0.85, 0.45 + Math.abs(score) * 0.25 + evidenceStrength * 0.15);
    return {
      score,
      confidence,
      timeHorizon,
      thesis: describeQuant(indicators),
      evidence: [history],
      metadata: { indicators },
    };
  }
}
function describeQuant(indicators) {
  if (indicators.insufficientData) return "The available price series is too short for a full technical assessment.";
  const trend = indicators.sma20 > indicators.sma50 ? "above" : "below";
  const momentum = indicators.momentum20 >= 0 ? "positive" : "negative";
  return `The 20-period average is ${trend} the 50-period average and 20-period momentum is ${momentum}.`;
}
