import { Type } from "typebox";
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createFinanceClient, resolveAgentPermissions } from "./client.js";

const Permission = Type.Union([
  Type.Literal("market.read"),
  Type.Literal("portfolio.read"),
  Type.Literal("strategy.run"),
  Type.Literal("prediction.write"),
  Type.Literal("trade.propose"),
  Type.Literal("trade.execute"),
  Type.Literal("experiment.manage"),
  Type.Literal("audit.read"),
]);

const ConfigSchema = Type.Object({
  serviceUrl: Type.Optional(Type.String({ format: "uri", default: "http://127.0.0.1:4830/api" })),
  serviceToken: Type.Optional(Type.String({ minLength: 64, pattern: "^[A-Fa-f0-9]{64,}$" })),
  agentSigningKey: Type.Optional(Type.String({ minLength: 64, pattern: "^[A-Fa-f0-9]{64,}$" })),
  requestTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600000, default: 30000 })),
  defaultPermissions: Type.Optional(Type.Array(Permission, { uniqueItems: true })),
  agentPermissions: Type.Optional(Type.Record(Type.String(), Type.Array(Permission, { uniqueItems: true }))),
}, { additionalProperties: false });

const SymbolInput = Type.Object({ symbol: Type.String({ minLength: 1, maxLength: 16 }) });
const StrategyInput = Type.Object({
  strategyId: Type.String({ minLength: 1, maxLength: 128 }),
  symbol: Type.String({ minLength: 1, maxLength: 16 }),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  timeHorizon: Type.Optional(Type.String({ maxLength: 30 })),
  modelConfig: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const TOOL_NAMES = [
  "finance_get_quote",
  "finance_get_price_history",
  "finance_get_fundamentals",
  "finance_get_news",
  "finance_get_market_context",
  "finance_run_quant_analysis",
  "finance_run_strategy",
  "finance_get_team",
  "finance_get_portfolio",
  "finance_get_trade_history",
  "finance_get_trade_proposals",
  "finance_create_trade_proposal",
  "finance_approve_trade_proposal",
  "finance_execute_paper_trade",
  "finance_settle_broker_orders",
  "finance_record_prediction",
  "finance_get_prediction_results",
  "finance_get_agent_performance",
  "finance_compare_strategies",
  "finance_get_risk_state",
  "finance_create_experiment",
];

export default definePluginEntry({
  id: "orion-finance-lab",
  name: "Orion Finance Lab",
  description: "Auditable market research, prediction, risk, and paper-trading tools.",
  configSchema: buildJsonPluginConfigSchema(ConfigSchema),
  register(api) {
    api.registerTool((context) => {
      const config = api.pluginConfig ?? {};
      const agentId = context.agentId;
      if (!agentId) return null;
      const serviceToken = config.serviceToken ?? process.env.ORION_FINANCE_SERVICE_TOKEN ?? process.env.FINANCE_SERVICE_TOKEN;
      const agentSigningKey = config.agentSigningKey ?? process.env.ORION_FINANCE_AGENT_SIGNING_KEY ?? process.env.FINANCE_AGENT_SIGNING_KEY;
      if (!serviceToken || !agentSigningKey) return null;
      const permissions = resolveAgentPermissions(config, agentId);
      const client = createFinanceClient({
        serviceUrl: config.serviceUrl ?? process.env.ORION_FINANCE_API_URL ?? "http://127.0.0.1:4830/api",
        serviceToken,
        agentSigningKey,
        agentId,
        permissions,
        timeoutMs: config.requestTimeoutMs ?? 30_000,
      });
      return createTools(client, new Set(permissions));
    }, { names: TOOL_NAMES, optional: true });
  },
});

function createTools(client, permissions) {
  const tools = [
    tool("finance_get_quote", "Get a current, source-stamped market quote.", "market.read", SymbolInput,
      (params, signal) => client.request(`/market/${encodeURIComponent(params.symbol)}/quote`, { signal })),
    tool("finance_get_price_history", "Get source-stamped OHLCV history for deterministic analysis.", "market.read", Type.Object({
      symbol: Type.String({ minLength: 1, maxLength: 16 }),
      from: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      interval: Type.Optional(Type.Union([Type.Literal("1d"), Type.Literal("1wk"), Type.Literal("1mo")])),
    }), (params, signal) => client.request(`/market/${encodeURIComponent(params.symbol)}/history?${query(params, ["from", "to", "interval"])}`, { signal })),
    tool("finance_get_fundamentals", "Get company fundamentals and financial statement data with provenance.", "market.read", SymbolInput,
      (params, signal) => client.request(`/market/${encodeURIComponent(params.symbol)}/fundamentals`, { signal })),
    tool("finance_get_news", "Get recent financial news with source and publication timestamps.", "market.read", Type.Object({
      symbol: Type.String({ minLength: 1, maxLength: 16 }), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }), (params, signal) => client.request(`/market/${encodeURIComponent(params.symbol)}/news?${query(params, ["count"])}`, { signal })),
    tool("finance_get_market_context", "Get source-stamped broad-market index, volatility, and rate context.", "market.read", Type.Object({}),
      (_params, signal) => client.request("/market/context", { signal })),
    tool("finance_run_quant_analysis", "Run deterministic technical, volatility, drawdown, and momentum analysis.", "strategy.run", Type.Object({
      symbol: Type.String({ minLength: 1, maxLength: 16 }), from: Type.Optional(Type.String()), to: Type.Optional(Type.String()),
    }), (params, signal) => client.request("/quant/run", { method: "POST", body: params, signal })),
    tool("finance_run_strategy", "Run a registered Finance Lab strategy and persist its evidence manifest.", "strategy.run", StrategyInput,
      ({ strategyId, ...body }, signal) => client.request(`/strategies/${encodeURIComponent(strategyId)}/run`, { method: "POST", body, signal })),
    tool("finance_get_team", "Read your finance team: your role, your rank, who leads the team, your teammates, and the team paper portfolio your decisions belong to.", "portfolio.read", Type.Object({}),
      (_params, signal) => client.request("/finance-teams/context", { signal })),
    tool("finance_get_portfolio", "Inspect a paper portfolio, positions, valuation, and risk-adjusted statistics.", "portfolio.read", Type.Object({
      portfolioId: Type.Optional(Type.String({ maxLength: 128 })),
    }), (params, signal) => client.request(`/portfolios/${encodeURIComponent(params.portfolioId ?? "paper-main")}`, { signal })),
    tool("finance_get_trade_history", "Inspect immutable paper trade history.", "portfolio.read", Type.Object({
      portfolioId: Type.Optional(Type.String({ maxLength: 128 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }), (params, signal) => client.request(`/trades?${query(params, ["portfolioId", "limit"])}`, { signal })),
    tool("finance_get_trade_proposals", "Inspect your proposals, or all team proposals when you are the team lead.", "portfolio.read", Type.Object({
      portfolioId: Type.Optional(Type.String({ maxLength: 128 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }), (params, signal) => client.request(`/proposals?${query(params, ["portfolioId", "limit"])}`, { signal })),
    tool("finance_create_trade_proposal", "Create a paper-trade proposal. This never bypasses deterministic risk review.", "trade.propose", Type.Object({
      portfolioId: Type.Optional(Type.String({ maxLength: 128 })),
      strategyId: Type.Optional(Type.String({ maxLength: 128 })),
      symbol: Type.String({ minLength: 1, maxLength: 16 }),
      side: Type.Union([Type.Literal("BUY"), Type.Literal("SELL")]),
      quantity: Type.Number({ exclusiveMinimum: 0 }),
      thesis: Type.Optional(Type.String({ maxLength: 20000 })),
    }), (params, signal) => client.request("/proposals", { method: "POST", body: params, signal })),
    tool("finance_approve_trade_proposal", "Approve a trader's team proposal as the current rank-1 team lead.", "trade.execute", Type.Object({
      proposalId: Type.String({ minLength: 1, maxLength: 128 }),
    }), (params, signal) => client.request(`/proposals/${encodeURIComponent(params.proposalId)}/approve`, { method: "POST", signal })),
    tool("finance_execute_paper_trade", "Submit your team-lead-approved trader proposal to deterministic risk checks and the paper broker.", "trade.execute", Type.Object({
      proposalId: Type.String({ minLength: 1, maxLength: 128 }),
    }), (params, signal) => client.request(`/proposals/${encodeURIComponent(params.proposalId)}/execute`, { method: "POST", signal })),
    tool("finance_settle_broker_orders", "Settle your team's broker orders that are still working at IBKR, booking any completed fill onto your team book.", "trade.execute", Type.Object({}),
      (_params, signal) => client.request("/broker/reconcile", { method: "POST", body: {}, signal })),
    tool("finance_record_prediction", "Append a timestamped investment prediction without requiring a trade.", "prediction.write", Type.Object({
      strategyId: Type.Optional(Type.String({ maxLength: 128 })),
      experimentId: Type.Optional(Type.String({ maxLength: 128 })),
      symbol: Type.String({ minLength: 1, maxLength: 16 }),
      direction: Type.Union([Type.Literal("BULLISH"), Type.Literal("BEARISH"), Type.Literal("NEUTRAL")]),
      expectedReturnMin: Type.Number(), expectedReturnMax: Type.Number(),
      horizonDays: Type.Integer({ minimum: 1, maximum: 3650 }),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      thesis: Type.String({ minLength: 1, maxLength: 20000 }),
      invalidationConditions: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 30 })),
      benchmarkSymbol: Type.Optional(Type.String({ maxLength: 16 })),
    }), (params, signal) => client.request("/predictions", { method: "POST", body: params, signal })),
    tool("finance_get_prediction_results", "Inspect pending and evaluated predictions for this Orion agent.", "portfolio.read", Type.Object({
      status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("evaluated")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }), (params, signal) => client.request(`/predictions?${query(params, ["status", "limit"])}`, { signal })),
    tool("finance_get_agent_performance", "Inspect this Orion agent's prediction accuracy and confidence calibration.", "portfolio.read", Type.Object({}),
      (_params, signal) => client.request("/agents", { signal })),
    tool("finance_compare_strategies", "Compare registered strategies and isolated paper portfolio results.", "portfolio.read", Type.Object({
      strategyIds: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 20 })),
    }), (params, signal) => client.request("/strategies/compare", { method: "POST", body: params, signal })),
    tool("finance_get_risk_state", "Inspect deterministic risk limits and current breaches for a paper portfolio.", "portfolio.read", Type.Object({
      portfolioId: Type.Optional(Type.String({ maxLength: 128 })),
    }), (params, signal) => client.request(`/risk/${encodeURIComponent(params.portfolioId ?? "paper-main")}`, { signal })),
    tool("finance_create_experiment", "Create an isolated paper portfolio for an agent or strategy experiment.", "experiment.manage", Type.Object({
      name: Type.String({ minLength: 1, maxLength: 120 }), strategyId: Type.String({ minLength: 1, maxLength: 128 }),
      agentId: Type.Optional(Type.String({ maxLength: 128 })), initialCapital: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      benchmarkSymbol: Type.Optional(Type.String({ maxLength: 16 })),
    }), (params, signal) => client.request("/experiments", { method: "POST", body: params, signal })),
  ];
  return tools.filter((entry) => permissions.has(entry.requiredPermission)).map(({ requiredPermission: _, ...entry }) => entry);
}

function tool(name, description, requiredPermission, parameters, execute) {
  return {
    name,
    label: name.replaceAll("_", " "),
    description,
    parameters,
    requiredPermission,
    async execute(_toolCallId, params, signal) {
      try {
        const data = await execute(params, signal);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Finance Lab error (${error.code ?? "REQUEST_FAILED"}): ${error.message}` }],
          details: { error: error.code ?? "REQUEST_FAILED" },
          isError: true,
        };
      }
    },
  };
}

function query(params, keys) {
  const search = new URLSearchParams();
  for (const key of keys) if (params[key] !== undefined) search.set(key, String(params[key]));
  return search.toString();
}
