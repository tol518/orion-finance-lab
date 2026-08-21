import path from "node:path";
import { randomUUID } from "node:crypto";
import { FinanceStore } from "../persistence/finance-store.js";
import { YahooMarketDataProvider } from "../market-data/yahoo-provider.js";
import { MarketDataService } from "../market-data/service.js";
import { StrategyRegistry } from "../strategies/strategy-registry.js";
import { QuantStrategy } from "../strategies/quant.js";
import { MomentumStrategy } from "../strategies/momentum.js";
import { ValueStrategy } from "../strategies/value.js";
import { TradingAgentsStrategy } from "../strategies/tradingagents/adapter.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { PaperBroker } from "../broker/paper-broker.js";
import { PredictionService } from "../predictions/prediction-service.js";
import { performanceFromValues } from "../evaluation/performance.js";
import { buildEvidenceManifest } from "../evidence/manifest.js";
import {
  FinanceError,
  enumValue,
  integer,
  jsonObject,
  normalizeAgentId,
  normalizeSymbol,
  optionalString,
  positiveNumber,
  requiredString,
  stringArray,
} from "../api/validation.js";

export const FINANCE_PERMISSIONS = Object.freeze([
  "market.read",
  "portfolio.read",
  "strategy.run",
  "prediction.write",
  "trade.propose",
  "trade.execute",
  "experiment.manage",
  "audit.read",
]);

export const OPERATOR_ACTOR = Object.freeze({
  actorId: "orion-dashboard",
  agentId: "orion-operator",
  operator: true,
  permissions: new Set(FINANCE_PERMISSIONS),
});

export class FinanceLabService {
  constructor({
    dataDir,
    store,
    provider,
    broker,
    riskPolicy,
    tradingAgents = {},
    logger = console,
  } = {}) {
    this.logger = logger;
    this.store = store ?? new FinanceStore({ filename: path.join(dataDir, "finance-lab.sqlite") });
    this.marketData = new MarketDataService({
      provider: provider ?? new YahooMarketDataProvider(),
      recordMetadata: (envelope) => this.store.recordMarketMetadata(envelope),
    });
    this.riskEngine = new RiskEngine(riskPolicy);
    this.ibkrBroker = broker ?? null;
    this.predictions = new PredictionService({ store: this.store, marketData: this.marketData });
    this.strategies = new StrategyRegistry([
      new QuantStrategy({ marketData: this.marketData }),
      new MomentumStrategy({ marketData: this.marketData }),
      new ValueStrategy({ marketData: this.marketData }),
      new TradingAgentsStrategy({ ...tradingAgents, logger }),
    ]);
    this.defaultPortfolio = this.store.ensureDefaultPortfolio();
    this.evaluationTimer = null;
    this.executionQueues = new Map();
  }

  start() {
    if (this.evaluationTimer) return;
    this.evaluationTimer = setInterval(() => {
      this.predictions.evaluateDue().catch((error) => {
        this.logger.error(`[finance-lab] prediction evaluation failed: ${error.message}`);
      });
    }, 60 * 60 * 1000);
    this.evaluationTimer.unref?.();
  }

  close() {
    if (this.evaluationTimer) clearInterval(this.evaluationTimer);
    this.evaluationTimer = null;
    this.store.close();
  }

  getQuote(actor, symbol) {
    return this.#audited("market.quote", actor, { symbol }, async () => {
      assertPermission(actor, "market.read");
      return this.marketData.quote(normalizeSymbol(symbol));
    });
  }

  getPriceHistory(actor, symbol, options = {}) {
    return this.#audited("market.history", actor, { symbol }, async () => {
      assertPermission(actor, "market.read");
      return this.marketData.history(normalizeSymbol(symbol), options);
    });
  }

  getFundamentals(actor, symbol) {
    return this.#audited("market.fundamentals", actor, { symbol }, async () => {
      assertPermission(actor, "market.read");
      return this.marketData.fundamentals(normalizeSymbol(symbol));
    });
  }

  getNews(actor, symbol, options = {}) {
    return this.#audited("market.news", actor, { symbol }, async () => {
      assertPermission(actor, "market.read");
      return this.marketData.news(normalizeSymbol(symbol), options);
    });
  }

  getMarketContext(actor) {
    return this.#audited("market.context", actor, {}, async () => {
      assertPermission(actor, "market.read");
      return this.marketData.context();
    });
  }

  runQuantAnalysis(actor, input) {
    return this.runStrategy(actor, "quant-core", input);
  }

  runStrategy(actor, strategyId, input) {
    const symbol = normalizeSymbol(input.symbol);
    const normalizedStrategyId = requiredString(strategyId, "strategyId", { max: 128 });
    return this.#audited("strategy.run", actor, { symbol, strategyId: normalizedStrategyId }, async () => {
      assertPermission(actor, "strategy.run");
      const result = await this.strategies.run(normalizedStrategyId, {
        ...input,
        symbol,
        modelConfig: jsonObject(input.modelConfig, "modelConfig"),
      });
      const decisionId = `FIN-${randomUUID().slice(0, 8).toUpperCase()}`;
      const evidenceBody = buildEvidenceManifest({
        decisionId,
        agentId: trustedAgentId(actor),
        strategyId: normalizedStrategyId,
        symbol,
        decision: { signal: result.signal, score: result.score, confidence: result.confidence },
        marketData: result.evidence,
        indicators: result.metadata?.indicators ?? {},
        models: result.models,
        costs: result.costs,
        metadata: result.metadata,
      });
      assertEvidenceSize(evidenceBody);
      const manifest = this.store.createEvidenceManifest({
        decisionId,
        agentId: trustedAgentId(actor),
        strategyId: normalizedStrategyId,
        symbol,
        body: evidenceBody,
      });
      return { ...result, decisionId, evidenceManifestId: manifest.id };
    });
  }

  listStrategies(actor) {
    assertPermission(actor, "market.read");
    return this.strategies.list();
  }

  async getPortfolio(actor, portfolioId = this.defaultPortfolio.id, { recordValuation = true } = {}) {
    assertPermission(actor, "portfolio.read");
    const portfolio = this.store.getPortfolio(portfolioId);
    if (!portfolio) throw new FinanceError("Portfolio not found", { code: "PORTFOLIO_NOT_FOUND", status: 404 });
    const brokerSnapshot = this.ibkrBroker && portfolioId === this.defaultPortfolio.id
      ? await this.ibkrBroker.snapshot()
      : null;
    const positions = brokerSnapshot?.positions ?? this.store.listPositions(portfolioId);
    const enriched = await Promise.all(positions.map(async (position) => {
      try {
        const quote = await this.marketData.quote(position.symbol);
        const price = quote.data.price ?? position.averageCost;
        const previousClose = quote.data.previousClose ?? price;
        return {
          ...position,
          price,
          previousClose,
          marketValue: position.quantity * price,
          unrealisedPnl: position.quantity * (price - position.averageCost),
          dailyPnl: position.quantity * (price - previousClose),
          quoteRetrievedAt: quote.retrievedAt,
          quoteError: null,
        };
      } catch (error) {
        return {
          ...position,
          price: position.averageCost,
          previousClose: position.averageCost,
          marketValue: position.quantity * position.averageCost,
          unrealisedPnl: 0,
          dailyPnl: 0,
          quoteRetrievedAt: null,
          quoteError: String(error?.message ?? error),
        };
      }
    }));
    const cash = brokerSnapshot?.cash ?? portfolio.cash;
    const grossExposure = enriched.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
    const totalValue = brokerSnapshot?.netLiquidation
      ?? cash + enriched.reduce((sum, position) => sum + position.marketValue, 0);
    const valuations = this.store.listValuations(portfolioId);
    const latestValuation = valuations.at(-1);
    const today = new Date().toISOString().slice(0, 10);
    const todayValuation = latestValuation?.recordedAt.slice(0, 10) === today ? latestValuation : null;
    const quotedDailyPnl = enriched.reduce((sum, position) => sum + position.dailyPnl, 0);
    const dailyPnl = brokerSnapshot || !todayValuation
      ? quotedDailyPnl
      : totalValue - todayValuation.openingValue;
    const closingValues = valuations.map((entry) =>
      entry.recordedAt.slice(0, 10) === today ? totalValue : entry.totalValue,
    );
    if (!todayValuation) closingValues.push(totalValue);
    const initialCash = brokerSnapshot ? null : portfolio.initialCash;
    const highWatermark = brokerSnapshot
      ? null
      : Math.max(initialCash, ...valuations.map((entry) => entry.highValue), totalValue);
    const benchmarkReturn = brokerSnapshot ? null : await this.#benchmarkReturn(portfolio);
    const totalReturn = brokerSnapshot ? null : totalValue / initialCash - 1;
    const snapshot = {
      ...portfolio,
      mode: "paper",
      currency: brokerSnapshot?.currency ?? portfolio.currency,
      initialCash,
      cash,
      broker: brokerSnapshot ? {
        name: "ibkr",
        environment: "paper",
        accountIdMasked: brokerSnapshot.accountIdMasked,
        connected: true,
        readOnly: true,
        availableFunds: brokerSnapshot.availableFunds,
        buyingPower: brokerSnapshot.buyingPower,
        retrievedAt: brokerSnapshot.retrievedAt,
      } : {
        name: "local",
        environment: "paper",
        connected: true,
        readOnly: false,
      },
      positions: enriched,
      grossExposure,
      totalValue,
      dailyPnl,
      dailyReturn: totalValue - dailyPnl > 0 ? dailyPnl / (totalValue - dailyPnl) : 0,
      totalReturn,
      benchmarkReturn,
      alpha: benchmarkReturn === null || totalReturn === null ? null : totalReturn - benchmarkReturn,
      drawdown: highWatermark === null ? null : highWatermark > 0 ? totalValue / highWatermark - 1 : 0,
      performance: brokerSnapshot ? pendingPerformance() : performanceFromValues([initialCash, ...closingValues]),
    };
    if (recordValuation && !brokerSnapshot) {
      this.store.recordValuation({
        portfolioId: snapshot.id,
        totalValue: snapshot.totalValue,
        cash: snapshot.cash,
        grossExposure: snapshot.grossExposure,
      });
    }
    return snapshot;
  }

  async listPortfolios(actor) {
    assertPermission(actor, "portfolio.read");
    return Promise.all(this.store.listPortfolios().map((portfolio) => this.getPortfolio(actor, portfolio.id)));
  }

  listTrades(actor, options = {}) {
    assertPermission(actor, "portfolio.read");
    return this.store.listTrades({
      ...options,
      agentId: actor.operator ? options.agentId : trustedAgentId(actor),
      limit: boundedLimit(options.limit),
    });
  }

  listProposals(actor, options = {}) {
    assertPermission(actor, "portfolio.read");
    return this.store.listProposals({
      ...options,
      agentId: actor.operator ? options.agentId : trustedAgentId(actor),
      limit: boundedLimit(options.limit),
    });
  }

  async createTradeProposal(actor, input) {
    assertPermission(actor, "trade.propose");
    const portfolioId = optionalString(input.portfolioId, "portfolioId", { max: 128 }) ?? this.defaultPortfolio.id;
    const portfolio = this.store.getPortfolio(portfolioId);
    if (!portfolio) {
      throw new FinanceError("Portfolio not found", { code: "PORTFOLIO_NOT_FOUND", status: 404 });
    }
    assertPortfolioMutationAccess(actor, portfolio, this.defaultPortfolio.id);
    const symbol = normalizeSymbol(input.symbol);
    const side = enumValue(input.side, "side", ["BUY", "SELL"]);
    const quantity = positiveNumber(input.quantity, "quantity", { max: 1_000_000 });
    const strategyId = optionalString(input.strategyId, "strategyId", { max: 128 });
    return this.#audited("trade.propose", actor, { portfolioId, symbol, strategyId }, async () => {
      const decisionId = `FIN-${randomUUID().slice(0, 8).toUpperCase()}`;
      const manifest = this.store.createEvidenceManifest({
        decisionId,
        agentId: trustedAgentId(actor),
        strategyId,
        symbol,
        body: buildEvidenceManifest({
          decisionId,
          agentId: trustedAgentId(actor),
          strategyId,
          symbol,
          decision: { type: "TRADE_PROPOSAL", side, quantity },
          marketData: Array.isArray(input.evidence) ? input.evidence : [],
          models: Array.isArray(input.models) ? input.models : [],
          costs: jsonObject(input.costs, "costs"),
          toolCalls: stringArray(input.toolCalls, "toolCalls", { maxItems: 50, maxLength: 200 }),
          metadata: jsonObject(input.metadata, "metadata"),
        }),
      });
      return this.store.createProposal({
        decisionId,
        portfolioId,
        agentId: trustedAgentId(actor),
        strategyId,
        experimentId: portfolio.experimentId,
        symbol,
        side,
        quantity,
        thesis: optionalString(input.thesis, "thesis", { max: 20_000 }),
        evidenceManifestId: manifest.id,
      });
    });
  }

  async executePaperTrade(actor, proposalId) {
    assertPermission(actor, "trade.execute");
    const proposal = this.store.getProposal(requiredString(proposalId, "proposalId", { max: 128 }));
    if (!proposal) throw new FinanceError("Trade proposal not found", { code: "PROPOSAL_NOT_FOUND", status: 404 });
    if (!actor.operator && proposal.agentId !== trustedAgentId(actor)) {
      throw new FinanceError("An agent cannot execute another agent's proposal", {
        code: "FORBIDDEN_PROPOSAL",
        status: 403,
      });
    }
    const portfolio = this.store.getPortfolio(proposal.portfolioId);
    if (!portfolio) throw new FinanceError("Portfolio not found", { code: "PORTFOLIO_NOT_FOUND", status: 404 });
    assertPortfolioMutationAccess(actor, portfolio, this.defaultPortfolio.id);
    if (this.ibkrBroker) {
      throw new FinanceError("IBKR paper execution is locked while the API is in read-only verification", {
        code: "IBKR_READ_ONLY",
        status: 409,
      });
    }
    return this.#serializeExecution(proposal.portfolioId, () =>
      this.#audited("trade.execute", actor, proposal, async () => {
        const [valuedPortfolio, quoteEnvelope] = await Promise.all([
          this.getPortfolio({ ...actor, permissions: new Set([...actor.permissions, "portfolio.read"]) }, proposal.portfolioId, { recordValuation: false }),
          this.marketData.quote(proposal.symbol),
        ]);
        this.store.recordValuation({
          portfolioId: valuedPortfolio.id,
          totalValue: valuedPortfolio.totalValue,
          cash: valuedPortfolio.cash,
          grossExposure: valuedPortfolio.grossExposure,
        });
        return this.#paperBrokerForPortfolio(portfolio).execute({
          proposalId: proposal.id,
          portfolio: valuedPortfolio,
          quote: quoteEnvelope.data,
        });
      }),
    );
  }

  async recordPrediction(actor, input) {
    assertPermission(actor, "prediction.write");
    const symbol = normalizeSymbol(input.symbol);
    const direction = enumValue(input.direction, "direction", ["BULLISH", "BEARISH", "NEUTRAL"]);
    const expectedReturnMin = Number(input.expectedReturnMin);
    const expectedReturnMax = Number(input.expectedReturnMax);
    if (![expectedReturnMin, expectedReturnMax].every(Number.isFinite) || expectedReturnMin > expectedReturnMax) {
      throw new FinanceError("Expected return range is invalid", { code: "INVALID_INPUT" });
    }
    const horizonDays = integer(input.horizonDays, "horizonDays", { min: 1, max: 3650 });
    const confidence = positiveNumber(input.confidence, "confidence", { max: 1, allowZero: true });
    const experimentId = optionalString(input.experimentId, "experimentId", { max: 128 });
    if (experimentId) {
      const experiment = this.store.getExperiment(experimentId);
      if (!experiment) throw new FinanceError("Experiment not found", { code: "EXPERIMENT_NOT_FOUND", status: 404 });
      if (!actor.operator && experiment.agentId !== trustedAgentId(actor)) {
        throw new FinanceError("An agent cannot attach a prediction to another agent's experiment", {
          code: "FORBIDDEN_EXPERIMENT",
          status: 403,
        });
      }
    }
    return this.#audited("prediction.record", actor, { symbol }, async () => {
      const decisionId = `FIN-${randomUUID().slice(0, 8).toUpperCase()}`;
      const strategyId = optionalString(input.strategyId, "strategyId", { max: 128 });
      const manifest = this.store.createEvidenceManifest({
        decisionId,
        agentId: trustedAgentId(actor),
        strategyId,
        symbol,
        body: buildEvidenceManifest({
          decisionId,
          agentId: trustedAgentId(actor),
          strategyId,
          symbol,
          decision: { type: "PREDICTION", direction, expectedReturnMin, expectedReturnMax, confidence },
          marketData: Array.isArray(input.evidence) ? input.evidence : [],
          models: Array.isArray(input.models) ? input.models : [],
          costs: jsonObject(input.costs, "costs"),
          metadata: jsonObject(input.metadata, "metadata"),
        }),
      });
      return this.predictions.record({
        agentId: trustedAgentId(actor),
        strategyId,
        experimentId,
        symbol,
        direction,
        expectedReturnMin,
        expectedReturnMax,
        horizonDays,
        confidence,
        thesis: requiredString(input.thesis, "thesis", { max: 20_000 }),
        invalidationConditions: stringArray(input.invalidationConditions, "invalidationConditions"),
        benchmarkSymbol: normalizeSymbol(input.benchmarkSymbol ?? "^GSPC"),
        evidenceManifestId: manifest.id,
      });
    });
  }

  listPredictions(actor, options = {}) {
    assertPermission(actor, "portfolio.read");
    const requestedAgentId = options.agentId ? normalizeAgentId(options.agentId) : undefined;
    const agentId = actor.operator ? requestedAgentId : trustedAgentId(actor);
    return this.store.listPredictions({ ...options, agentId, limit: boundedLimit(options.limit) });
  }

  async evaluatePredictions(actor) {
    assertPermission(actor, "experiment.manage");
    return this.#audited("prediction.evaluate", actor, {}, () => this.predictions.evaluateDue());
  }

  getAgentPerformance(actor, agentId) {
    assertPermission(actor, "portfolio.read");
    const normalized = normalizeAgentId(agentId);
    if (!actor.operator && normalized !== trustedAgentId(actor)) {
      throw new FinanceError("An agent cannot inspect another agent's performance record", {
        code: "FINANCE_PERMISSION_DENIED",
        status: 403,
      });
    }
    const predictions = this.predictions.performance(normalized);
    const trades = this.store.listTrades({ agentId: normalized, limit: 10_000 });
    const fees = trades.reduce((sum, trade) => sum + trade.fee, 0);
    return { agentId: normalized, ...predictions, tradeCount: trades.length, transactionFees: fees };
  }

  listAgentPerformance(actor) {
    assertPermission(actor, "portfolio.read");
    const agentIds = actor.operator ? this.store.listAgentIds() : [trustedAgentId(actor)];
    return agentIds.map((agentId) => this.getAgentPerformance(actor, agentId));
  }

  listFinanceAgents(actor) {
    assertOperator(actor);
    return this.store.listFinanceAgents();
  }

  assignFinanceAgent(actor, input) {
    assertOperator(actor);
    const agentId = normalizeAgentId(input.agentId);
    return this.#audited("finance.agent.assign", actor, { agentId }, () => this.store.assignFinanceAgent({
      agentId,
      displayName: requiredString(input.displayName ?? agentId, "displayName", { max: 120 }),
      role: optionalString(input.role, "role", { max: 160 }),
    }));
  }

  removeFinanceAgent(actor, agentId) {
    assertOperator(actor);
    const normalized = normalizeAgentId(agentId);
    return this.#audited("finance.agent.remove", actor, { agentId: normalized }, () => ({
      removed: this.store.removeFinanceAgent(normalized),
    }));
  }

  listFinanceTeams(actor) {
    assertOperator(actor);
    return this.store.listFinanceTeams();
  }

  createFinanceTeam(actor, input) {
    assertOperator(actor);
    const teams = this.store.listFinanceTeams();
    if (teams.length >= 5) {
      throw new FinanceError("Finance Lab supports at most five teams", {
        code: "FINANCE_TEAM_LIMIT_REACHED",
        status: 409,
      });
    }
    const agentIds = [...new Set(stringArray(input.agentIds, "agentIds", { maxItems: 5, maxLength: 128 }).map(normalizeAgentId))];
    if (!agentIds.length) {
      throw new FinanceError("A finance team needs at least one assigned agent", {
        code: "FINANCE_TEAM_REQUIRES_AGENT",
      });
    }
    const assignedIds = new Set(this.store.listFinanceAgents().map((entry) => entry.agentId));
    const unassigned = agentIds.find((agentId) => !assignedIds.has(agentId));
    if (unassigned) {
      throw new FinanceError("Every team member must first be assigned to Finance Lab", {
        code: "FINANCE_AGENT_NOT_ASSIGNED",
        details: { agentId: unassigned },
      });
    }
    return this.#audited("finance.team.create", actor, { agentIds }, () => this.store.createFinanceTeam({
      name: requiredString(input.name, "name", { max: 120 }),
      agentIds,
    }));
  }

  removeFinanceTeam(actor, teamId) {
    assertOperator(actor);
    const normalized = requiredString(teamId, "teamId", { max: 128 });
    return this.#audited("finance.team.remove", actor, { teamId: normalized }, () => ({
      removed: this.store.removeFinanceTeam(normalized),
    }));
  }

  async createExperiment(actor, input) {
    assertPermission(actor, "experiment.manage");
    const strategyId = requiredString(input.strategyId, "strategyId", { max: 128 });
    if (!this.strategies.list().some((strategy) => strategy.id === strategyId)) {
      throw new FinanceError("Strategy not found", { code: "STRATEGY_NOT_FOUND", status: 404 });
    }
    return this.store.createExperiment({
      name: requiredString(input.name, "name", { max: 120 }),
      strategyId,
      agentId: actor.operator
        ? input.agentId ? normalizeAgentId(input.agentId) : null
        : trustedAgentId(actor),
      benchmarkSymbol: normalizeSymbol(input.benchmarkSymbol ?? "^GSPC"),
      initialCapital: positiveNumber(input.initialCapital ?? 25_000, "initialCapital", { max: 1_000_000_000 }),
      riskRules: { ...this.riskEngine.policy, ...jsonObject(input.riskRules, "riskRules") },
      feeAssumptions: { feeBps: 1, minimumFee: 0.25, slippageBps: 2, ...jsonObject(input.feeAssumptions, "feeAssumptions") },
      modelConfig: jsonObject(input.modelConfig, "modelConfig"),
      providerConfig: { provider: this.marketData.provider.id },
    });
  }

  listExperiments(actor) {
    assertPermission(actor, "portfolio.read");
    return this.store.listExperiments();
  }

  async compareStrategies(actor, strategyIds) {
    assertPermission(actor, "portfolio.read");
    const requested = Array.isArray(strategyIds) && strategyIds.length ? new Set(strategyIds) : null;
    const portfolios = await Promise.all(
      this.store
        .listPortfolios()
        .filter((portfolio) => portfolio.strategyId)
        .map((portfolio) => this.getPortfolio(actor, portfolio.id, { recordValuation: false })),
    );
    return this.strategies.list().filter((strategy) => !requested || requested.has(strategy.id)).map((strategy) => {
      const owned = portfolios.filter((portfolio) => portfolio.strategyId === strategy.id);
      const trades = this.store.listTrades({ strategyId: strategy.id, limit: 10_000 });
      const initial = owned.reduce((sum, portfolio) => sum + portfolio.initialCash, 0);
      const current = owned.reduce((sum, portfolio) => sum + portfolio.totalValue, 0);
      return {
        ...strategy,
        portfolioCount: owned.length,
        tradeCount: trades.length,
        totalReturn: initial > 0 ? current / initial - 1 : null,
        fees: trades.reduce((sum, trade) => sum + trade.fee, 0),
      };
    });
  }

  async getRiskState(actor, portfolioId = this.defaultPortfolio.id) {
    const portfolio = await this.getPortfolio(actor, portfolioId, { recordValuation: false });
    return this.#riskEngineForPortfolio(portfolio).state(portfolio);
  }

  async getBrokerStatus(actor) {
    assertPermission(actor, "portfolio.read");
    if (!this.ibkrBroker) {
      return { name: "local", environment: "paper", connected: true, readOnly: false };
    }
    const probe = await this.ibkrBroker.probe();
    return {
      name: "ibkr",
      environment: "paper",
      connected: probe.connected,
      readOnly: true,
      configured: Boolean(probe.selectedAccount),
      accountIdMasked: probe.selectedAccount
        ? `${probe.selectedAccount.slice(0, 1)}***${probe.selectedAccount.slice(-3)}`
        : null,
      discoveredAccountCount: probe.accounts.length,
      serverVersion: probe.serverVersion,
      connectionTime: probe.connectionTime,
    };
  }

  getEvidence(actor, id) {
    assertPermission(actor, "audit.read");
    const evidence = this.store.getEvidenceManifest(requiredString(id, "evidenceId", { max: 128 }));
    if (!evidence) throw new FinanceError("Evidence manifest not found", { code: "EVIDENCE_NOT_FOUND", status: 404 });
    return evidence;
  }

  getAudit(actor, options = {}) {
    assertPermission(actor, "audit.read");
    return this.store.listAudit(options);
  }

  async overview(actor) {
    const [portfolio, experiments, agents, strategies, financeAgents, financeTeams] = await Promise.all([
      this.getPortfolio(actor),
      Promise.resolve(this.listExperiments(actor)),
      Promise.resolve(this.listAgentPerformance(actor)),
      this.compareStrategies(actor),
      Promise.resolve(this.listFinanceAgents(actor)),
      Promise.resolve(this.listFinanceTeams(actor)),
    ]);
    return {
      mode: this.ibkrBroker ? "ibkr-paper-read-only" : "paper",
      generatedAt: new Date().toISOString(),
      portfolio,
      risk: this.#riskEngineForPortfolio(portfolio).state(portfolio),
      recentTrades: this.store.listTrades({ portfolioId: portfolio.id, limit: 8 }),
      recentProposals: this.store.listProposals({ portfolioId: portfolio.id, limit: 8 }),
      recentPredictions: this.store.listPredictions({ limit: 8 }),
      experiments,
      agents,
      financeAgents,
      financeTeams,
      strategies,
    };
  }

  async #audited(action, actor, refs, work) {
    const started = performance.now();
    try {
      const result = await work();
      this.store.recordAudit({
        action,
        actorId: actor?.actorId,
        agentId: actor?.agentId,
        strategyId: refs.strategyId,
        experimentId: refs.experimentId,
        portfolioId: refs.portfolioId,
        decisionId: refs.decisionId,
        predictionId: refs.predictionId,
        success: true,
        latencyMs: Math.round(performance.now() - started),
        payload: sanitizeAuditPayload(refs),
      });
      return result;
    } catch (error) {
      this.store.recordAudit({
        action,
        actorId: actor?.actorId,
        agentId: actor?.agentId,
        success: false,
        latencyMs: Math.round(performance.now() - started),
        payload: sanitizeAuditPayload(refs),
        errorCode: error?.code ?? "INTERNAL_ERROR",
      });
      throw error;
    }
  }

  async #benchmarkReturn(portfolio) {
    const now = Date.now();
    const createdAt = new Date(portfolio.createdAt).getTime();
    if (!Number.isFinite(createdAt) || now - createdAt < 2 * 86_400_000) return null;
    try {
      const history = await this.marketData.history(portfolio.benchmarkSymbol, {
        from: portfolio.createdAt,
        to: new Date(now).toISOString(),
      });
      const first = history.data[0]?.close;
      const last = history.data.at(-1)?.close;
      return first && last ? last / first - 1 : null;
    } catch {
      return null;
    }
  }

  #riskEngineForPortfolio(portfolio) {
    const experiment = portfolio.experimentId ? this.store.getExperiment(portfolio.experimentId) : null;
    return experiment ? new RiskEngine(experiment.riskRules) : this.riskEngine;
  }

  #paperBrokerForPortfolio(portfolio) {
    const experiment = portfolio.experimentId ? this.store.getExperiment(portfolio.experimentId) : null;
    return new PaperBroker({
      store: this.store,
      riskEngine: this.#riskEngineForPortfolio(portfolio),
      ...(experiment?.feeAssumptions ?? {}),
    });
  }

  async #serializeExecution(portfolioId, work) {
    const previous = this.executionQueues.get(portfolioId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.executionQueues.set(portfolioId, current);
    try {
      return await current;
    } finally {
      if (this.executionQueues.get(portfolioId) === current) this.executionQueues.delete(portfolioId);
    }
  }
}

export function createActor({ actorId, agentId, permissions, operator = false }) {
  return {
    actorId: requiredString(actorId ?? agentId, "actorId", { max: 128 }),
    agentId: normalizeAgentId(agentId),
    operator,
    permissions: new Set(Array.isArray(permissions) ? permissions.filter((item) => FINANCE_PERMISSIONS.includes(item)) : []),
  };
}

function assertPermission(actor, permission) {
  if (!actor?.permissions?.has(permission)) {
    throw new FinanceError(`Missing Finance Lab permission: ${permission}`, {
      code: "FINANCE_PERMISSION_DENIED",
      status: 403,
    });
  }
}

function assertOperator(actor) {
  if (!actor?.operator) {
    throw new FinanceError("Finance Lab assignments and teams are managed from the operator dashboard", {
      code: "FINANCE_PERMISSION_DENIED",
      status: 403,
    });
  }
}

function trustedAgentId(actor) {
  if (!actor?.agentId) throw new FinanceError("Trusted agent identity is required", { code: "AGENT_ID_REQUIRED", status: 401 });
  return normalizeAgentId(actor.agentId);
}

function assertPortfolioMutationAccess(actor, portfolio, defaultPortfolioId) {
  if (actor.operator || portfolio.id === defaultPortfolioId || portfolio.agentId === trustedAgentId(actor)) return;
  throw new FinanceError("An agent cannot modify another agent's experiment portfolio", {
    code: "FORBIDDEN_PORTFOLIO",
    status: 403,
  });
}

function assertEvidenceSize(body) {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1_000_000) {
    throw new FinanceError("Strategy evidence exceeds the one-megabyte persistence limit", {
      code: "EVIDENCE_SIZE_LIMIT",
      status: 413,
    });
  }
}

function pendingPerformance() {
  return {
    observations: 0,
    totalReturn: null,
    annualizedReturn: null,
    volatility: null,
    sharpe: null,
    sortino: null,
    maximumDrawdown: null,
  };
}

function sanitizeAuditPayload(payload) {
  const copy = { ...payload };
  delete copy.thesis;
  delete copy.evidence;
  delete copy.modelConfig;
  return copy;
}

function boundedLimit(value, fallback = 100) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(500, parsed)) : fallback;
}
