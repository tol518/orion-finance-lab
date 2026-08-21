import { FinanceError } from "../api/validation.js";

export class StrategyRegistry {
  constructor(strategies = []) {
    this.strategies = new Map();
    for (const strategy of strategies) this.register(strategy);
  }

  register(strategy) {
    if (!strategy?.id || typeof strategy.analyze !== "function") {
      throw new Error("A finance strategy requires id and analyze()");
    }
    if (this.strategies.has(strategy.id)) throw new Error(`Duplicate strategy ${strategy.id}`);
    this.strategies.set(strategy.id, strategy);
  }

  list() {
    return [...this.strategies.values()].map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      description: strategy.description,
      deterministic: strategy.deterministic,
      controlGroup: strategy.controlGroup === true,
      available: strategy.available !== false,
      unavailableReason: strategy.unavailableReason ?? null,
    }));
  }

  async run(id, input) {
    const strategy = this.strategies.get(id);
    if (!strategy) throw new FinanceError("Strategy not found", { code: "STRATEGY_NOT_FOUND", status: 404 });
    if (strategy.available === false) {
      throw new FinanceError(strategy.unavailableReason ?? "Strategy is unavailable", {
        code: "STRATEGY_UNAVAILABLE",
        status: 503,
      });
    }
    const started = performance.now();
    const result = await strategy.analyze(input);
    return normalizeStrategyResult({ ...result, strategyId: strategy.id, latencyMs: performance.now() - started }, input);
  }
}
export function normalizeStrategyResult(result, input) {
  const score = clamp(Number(result.score ?? 0), -1, 1);
  const confidence = clamp(Number(result.confidence ?? 0), 0, 1);
  const signal = result.signal ?? (score > 0.2 ? "BUY" : score < -0.2 ? "SELL" : "HOLD");
  return {
    strategyId: result.strategyId,
    symbol: input.symbol,
    signal,
    score,
    confidence,
    timeHorizon: result.timeHorizon ?? "30d",
    thesis: result.thesis ?? "",
    evidence: Array.isArray(result.evidence) ? result.evidence : [],
    analystOutputs: result.analystOutputs ?? null,
    debate: result.debate ?? null,
    models: result.models ?? [],
    costs: result.costs ?? { tokens: 0, apiCost: 0, currency: "USD" },
    latencyMs: Math.round(result.latencyMs ?? 0),
    metadata: result.metadata ?? {},
  };
}

function clamp(value, minimum, maximum) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}
