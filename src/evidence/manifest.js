import { normalizeAgentId, normalizeSymbol, requiredString } from "../api/validation.js";

export function buildEvidenceManifest({
  decisionId,
  agentId,
  strategyId,
  symbol,
  decision,
  marketData = [],
  indicators = {},
  fundamentals = null,
  news = [],
  models = [],
  costs = {},
  toolCalls = [],
  metadata = {},
}) {
  const createdAt = new Date().toISOString();
  return {
    decisionId: requiredString(decisionId, "decisionId", { max: 128 }),
    agentId: normalizeAgentId(agentId),
    strategyId: strategyId ? requiredString(strategyId, "strategyId", { max: 128 }) : null,
    symbol: normalizeSymbol(symbol),
    decision,
    createdAt,
    marketData: marketData.map(provenance),
    indicators,
    fundamentals: fundamentals ? provenance(fundamentals) : null,
    news: Array.isArray(news) ? news.map(provenance) : [],
    models,
    costs: {
      tokens: Number(costs.tokens ?? 0),
      apiCost: Number(costs.apiCost ?? 0),
      currency: costs.currency ?? "USD",
    },
    toolCalls,
    metadata,
  };
}

function provenance(item) {
  if (!item || typeof item !== "object") return item;
  return {
    provider: item.provider ?? null,
    source: item.source ?? null,
    retrievedAt: item.retrievedAt ?? null,
    requestedRange: item.requestedRange ?? null,
    actualRange: item.actualRange ?? null,
    symbol: item.symbol ?? null,
    data: item.data ?? item,
  };
}
