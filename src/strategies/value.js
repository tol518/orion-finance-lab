export class ValueStrategy {
  id = "value";
  name = "Value Screen";
  description = "Deterministic valuation screen based on reported multiples and analyst targets.";
  deterministic = true;

  constructor({ marketData }) {
    this.marketData = marketData;
  }

  async analyze({ symbol, timeHorizon = "180d" }) {
    const fundamentals = await this.marketData.fundamentals(symbol);
    const data = fundamentals.data ?? {};
    const summaryData = data.summary ?? data;
    const summary = summaryData.summaryDetail ?? {};
    const financial = summaryData.financialData ?? {};
    const statistics = summaryData.defaultKeyStatistics ?? {};
    const price = number(financial.currentPrice);
    const target = number(financial.targetMeanPrice);
    const trailingPe = number(summary.trailingPE ?? statistics.trailingPE);
    const forwardPe = number(summary.forwardPE ?? statistics.forwardPE);
    const upside = price && target ? target / price - 1 : null;
    const components = [
      upside === null ? null : Math.max(-1, Math.min(1, upside * 3)),
      forwardPe === null ? null : forwardPe < 20 ? 0.35 : forwardPe > 40 ? -0.35 : 0,
    ].filter(Number.isFinite);
    const score = components.length ? components.reduce((sum, value) => sum + value, 0) / components.length : 0;
    return {
      score,
      confidence: components.length === 2 ? 0.62 : 0.4,
      timeHorizon,
      thesis: `Forward P/E is ${format(forwardPe)}, trailing P/E is ${format(trailingPe)}, and consensus target upside is ${upside === null ? "unavailable" : `${(upside * 100).toFixed(1)}%`}.`,
      evidence: [fundamentals],
      metadata: { price, target, trailingPe, forwardPe, upside },
    };
  }
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function format(value) {
  return value === null ? "unavailable" : value.toFixed(1);
}
