import assert from "node:assert/strict";
import test from "node:test";
import { FinanceStore } from "../src/persistence/finance-store.js";
import { FixtureMarketDataProvider } from "../src/market-data/fixture-provider.js";
import { FinanceLabService, OPERATOR_ACTOR, createActor } from "../src/service/finance-lab.js";

const allPermissions = [
  "market.read",
  "portfolio.read",
  "strategy.run",
  "prediction.write",
  "trade.propose",
  "trade.execute",
  "experiment.manage",
  "audit.read",
];

function setup({ broker } = {}) {
  const bars = Array.from({ length: 120 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    open: 80 + index / 5,
    high: 81 + index / 5,
    low: 79 + index / 5,
    close: 80 + index / 5,
    adjustedClose: 80 + index / 5,
    volume: 1_000_000,
  }));
  const provider = new FixtureMarketDataProvider({
    quotes: {
      AAPL: { symbol: "AAPL", name: "Apple", assetType: "EQUITY", currency: "USD", price: 100, previousClose: 99 },
      MSFT: { symbol: "MSFT", name: "Microsoft", assetType: "EQUITY", currency: "USD", price: 200, previousClose: 200 },
      "^GSPC": { symbol: "^GSPC", name: "S&P 500", assetType: "INDEX", currency: "USD", price: 6_000, previousClose: 5_990 },
    },
    histories: { AAPL: bars, MSFT: bars, "^GSPC": bars },
    fundamentals: { AAPL: { summary: { financialData: { currentPrice: 100, targetMeanPrice: 115 } } } },
  });
  const store = new FinanceStore();
  const service = new FinanceLabService({
    store,
    provider,
    broker,
    riskPolicy: { maxPositionPct: 0.05, maxOrderPct: 0.1 },
    tradingAgents: {},
  });
  const patrick = createActor({ actorId: "openclaw:patrick", agentId: "patrick", permissions: allPermissions });
  return { store, service, patrick, provider };
}

test("proposal must pass deterministic risk before atomic paper execution", async (t) => {
  const { service, patrick } = setup();
  t.after(() => service.close());
  const proposal = await service.createTradeProposal(patrick, {
    symbol: "AAPL",
    side: "BUY",
    quantity: 100,
    thesis: "Position should be capped by deterministic portfolio limits.",
  });
  assert.equal(proposal.status, "PROPOSED");

  const execution = await service.executePaperTrade(patrick, proposal.id);
  assert.equal(execution.decision.status, "RESIZED");
  assert.ok(execution.decision.approvedQuantity > 49.9);
  assert.ok(execution.decision.approvedQuantity < 50);
  assert.equal(execution.trade.side, "BUY");

  const portfolio = await service.getPortfolio(patrick, "paper-main", { recordValuation: false });
  assert.equal(portfolio.positions[0].symbol, "AAPL");
  assert.equal(portfolio.positions[0].quantity, execution.decision.approvedQuantity);
  assert.ok(portfolio.cash < 95_000);
  assert.ok((await service.getRiskState(patrick)).metrics.largestPositionPct <= 0.05);

  await assert.rejects(() => service.executePaperTrade(patrick, proposal.id), /already been resolved/);
});

test("concurrent executions are serialized against current portfolio risk", async (t) => {
  const { service, patrick } = setup();
  t.after(() => service.close());
  const proposals = await Promise.all([1, 2].map(() => service.createTradeProposal(patrick, {
    symbol: "AAPL",
    side: "BUY",
    quantity: 100,
  })));
  const executions = await Promise.all(proposals.map((proposal) => service.executePaperTrade(patrick, proposal.id)));
  const portfolio = await service.getPortfolio(patrick, "paper-main", { recordValuation: false });
  assert.ok(portfolio.positions[0].marketValue / portfolio.totalValue <= 0.05);
  assert.ok(executions[1].decision.approvedQuantity < executions[0].decision.approvedQuantity);
});

test("an agent cannot mutate another agent's experiment portfolio", async (t) => {
  const { service, patrick } = setup();
  t.after(() => service.close());
  const experiment = await service.createExperiment(patrick, {
    name: "Patrick private experiment",
    strategyId: "quant-core",
    initialCapital: 25_000,
  });
  const another = createActor({
    actorId: "openclaw:another",
    agentId: "another",
    permissions: ["trade.propose", "trade.execute"],
  });
  await assert.rejects(
    () => service.createTradeProposal(another, {
      portfolioId: experiment.portfolioId,
      symbol: "AAPL",
      side: "BUY",
      quantity: 1,
    }),
    (error) => error.code === "FORBIDDEN_PORTFOLIO",
  );
});

test("market history rejects ranges larger than ten years", async (t) => {
  const { service, patrick } = setup();
  t.after(() => service.close());
  await assert.rejects(
    () => service.getPriceHistory(patrick, "AAPL", { from: "2000-01-01", to: "2026-01-01" }),
    (error) => error.code === "HISTORY_RANGE_LIMIT",
  );
});

test("trade execution permission is separate from proposal permission", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const proposer = createActor({
    actorId: "openclaw:researcher",
    agentId: "researcher",
    permissions: ["trade.propose", "portfolio.read", "market.read"],
  });
  const proposal = await service.createTradeProposal(proposer, { symbol: "MSFT", side: "BUY", quantity: 1 });
  await assert.rejects(() => service.executePaperTrade(proposer, proposal.id), (error) => error.code === "FINANCE_PERMISSION_DENIED");
});

test("predictions are append-only and non-operators cannot read another agent's record", async (t) => {
  const { service, store, patrick } = setup();
  t.after(() => service.close());
  const prediction = await service.recordPrediction(patrick, {
    symbol: "AAPL",
    direction: "BULLISH",
    expectedReturnMin: 0.05,
    expectedReturnMax: 0.15,
    horizonDays: 30,
    confidence: 0.7,
    thesis: "Testable thesis",
    invalidationConditions: ["Revenue contracts"],
  });
  assert.equal(service.listPredictions(patrick).length, 1);
  assert.throws(() => store.db.prepare("UPDATE predictions SET thesis = 'changed' WHERE id = ?").run(prediction.id), /append-only/);

  const another = createActor({ actorId: "openclaw:another", agentId: "another", permissions: ["portfolio.read"] });
  assert.deepEqual(service.listPredictions(another), []);
  await assert.rejects(async () => service.getAgentPerformance(another, "patrick"), (error) => error.code === "FINANCE_PERMISSION_DENIED");
});

test("an agent cannot attach a prediction to another agent's experiment", async (t) => {
  const { service, patrick } = setup();
  t.after(() => service.close());
  const experiment = await service.createExperiment(patrick, {
    name: "Patrick experiment",
    strategyId: "quant-core",
    initialCapital: 25_000,
  });
  const another = createActor({
    actorId: "openclaw:another",
    agentId: "another",
    permissions: ["prediction.write"],
  });
  await assert.rejects(() => service.recordPrediction(another, {
    experimentId: experiment.id,
    symbol: "AAPL",
    direction: "BULLISH",
    expectedReturnMin: 0,
    expectedReturnMax: 0.1,
    horizonDays: 30,
    confidence: 0.6,
    thesis: "Synthetic test",
  }), (error) => error.code === "FORBIDDEN_EXPERIMENT");
});

test("strategy runs normalize output and persist reproducible evidence", async (t) => {
  const { service, patrick } = setup();
  t.after(() => service.close());
  const result = await service.runStrategy(patrick, "quant-core", { symbol: "AAPL" });
  assert.equal(result.strategyId, "quant-core");
  assert.equal(result.signal, "BUY");
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  const evidence = service.getEvidence(patrick, result.evidenceManifestId);
  assert.equal(evidence.agentId, "patrick");
  assert.equal(evidence.body.marketData[0].provider, "fixture");
});

test("experiments allocate isolated paper portfolios without creating agents", async (t) => {
  const { service, patrick } = setup();
  t.after(() => service.close());
  const experiment = await service.createExperiment(patrick, {
    name: "Patrick quant control",
    strategyId: "quant-core",
    initialCapital: 25_000,
  });
  assert.equal(experiment.agentId, "patrick");
  const portfolios = await service.listPortfolios(patrick);
  assert.equal(portfolios.find((portfolio) => portfolio.id === experiment.portfolioId)?.initialCash, 25_000);
});

test("experiment risk and fee assumptions govern its paper executions", async (t) => {
  const { service, patrick } = setup();
  t.after(() => service.close());
  const experiment = await service.createExperiment(patrick, {
    name: "Constrained experiment",
    strategyId: "quant-core",
    initialCapital: 25_000,
    riskRules: { maxPositionPct: 0.01, maxOrderPct: 0.01 },
    feeAssumptions: { feeBps: 50, minimumFee: 12.34, slippageBps: 25 },
  });
  const proposal = await service.createTradeProposal(patrick, {
    portfolioId: experiment.portfolioId,
    symbol: "AAPL",
    side: "BUY",
    quantity: 100,
  });
  const execution = await service.executePaperTrade(patrick, proposal.id);
  assert.equal(execution.decision.policy.maxPositionPct, 0.01);
  assert.ok(execution.decision.approvedQuantity < 2.5);
  assert.ok(execution.trade.fee >= 12.34);
  const risk = await service.getRiskState(patrick, experiment.portfolioId);
  assert.equal(risk.policy.maxPositionPct, 0.01);
});

test("valuation snapshots coalesce repeated reads within one UTC day", async (t) => {
  const { service, store, patrick } = setup();
  t.after(() => service.close());
  const first = await service.getPortfolio(patrick);
  const second = await service.getPortfolio(patrick);
  assert.equal(store.listValuations("paper-main").length, 1);
  assert.equal(first.performance.observations, second.performance.observations);
});

test("paper execution rejects quotes with an unknown asset class", async (t) => {
  const { service, patrick, provider } = setup();
  t.after(() => service.close());
  provider.quotes.AAPL = { ...provider.quotes.AAPL, assetType: null };
  const proposal = await service.createTradeProposal(patrick, {
    symbol: "AAPL",
    side: "BUY",
    quantity: 1,
  });
  const execution = await service.executePaperTrade(patrick, proposal.id);
  assert.equal(execution.decision.status, "REJECTED");
  assert.equal(execution.trade, null);
});

test("daily loss remains visible after a losing position is closed", async (t) => {
  const { service, store, patrick, provider } = setup();
  t.after(() => service.close());
  await service.getPortfolio(patrick);
  const buyProposal = await service.createTradeProposal(patrick, {
    symbol: "AAPL",
    side: "BUY",
    quantity: 50,
  });
  const buy = await service.executePaperTrade(patrick, buyProposal.id);
  provider.quotes.AAPL = { ...provider.quotes.AAPL, price: 60, previousClose: 100 };
  service.marketData.cache.clear();
  const sellProposal = await service.createTradeProposal(patrick, {
    symbol: "AAPL",
    side: "SELL",
    quantity: buy.trade.quantity,
  });
  await service.executePaperTrade(patrick, sellProposal.id);
  service.marketData.cache.clear();
  const portfolio = await service.getPortfolio(patrick, "paper-main", { recordValuation: false });
  assert.equal(portfolio.positions.length, 0);
  assert.ok(portfolio.dailyPnl < -1_900);
  assert.ok(portfolio.dailyReturn < -0.019);
  assert.equal(store.listValuations("paper-main").length, 1);
});

test("loss limits still permit a bounded sell that reduces exposure", async (t) => {
  const { service, patrick, provider } = setup();
  t.after(() => service.close());
  await service.getPortfolio(patrick);
  const buyProposal = await service.createTradeProposal(patrick, { symbol: "AAPL", side: "BUY", quantity: 50 });
  const buy = await service.executePaperTrade(patrick, buyProposal.id);
  provider.quotes.AAPL = { ...provider.quotes.AAPL, price: 20, previousClose: 100 };
  service.marketData.cache.clear();
  const sellProposal = await service.createTradeProposal(patrick, {
    symbol: "AAPL",
    side: "SELL",
    quantity: buy.trade.quantity,
  });
  const sell = await service.executePaperTrade(patrick, sellProposal.id);
  assert.ok(sell.trade);
  assert.equal(sell.decision.status, "APPROVED");
});

test("daily valuation coalescing retains the intraday high-water mark", () => {
  const store = new FinanceStore();
  try {
    store.ensureDefaultPortfolio();
    store.recordValuation({ portfolioId: "paper-main", totalValue: 100_000, cash: 100_000, grossExposure: 0 });
    store.recordValuation({ portfolioId: "paper-main", totalValue: 120_000, cash: 120_000, grossExposure: 0 });
    store.recordValuation({ portfolioId: "paper-main", totalValue: 90_000, cash: 90_000, grossExposure: 0 });
    const valuation = store.listValuations("paper-main")[0];
    assert.equal(valuation.openingValue, 100_000);
    assert.equal(valuation.highValue, 120_000);
    assert.equal(valuation.totalValue, 90_000);
  } finally {
    store.close();
  }
});

test("finance teams persist assigned Orion agents and allow teams smaller than five", async (t) => {
  const { service } = setup();
  t.after(() => service.close());

  const assigned = await service.assignFinanceAgent(OPERATOR_ACTOR, {
    agentId: "patrick",
    displayName: "Patrick Bateman",
    role: "Finance specialist",
  });
  assert.equal(assigned.agentId, "patrick");

  const team = await service.createFinanceTeam(OPERATOR_ACTOR, {
    name: "Research desk",
    agentIds: ["patrick"],
  });
  assert.equal(team.members.length, 1);
  assert.equal(service.listFinanceTeams(OPERATOR_ACTOR)[0].members[0].displayName, "Patrick Bateman");

  await assert.rejects(
    async () => service.createFinanceTeam(OPERATOR_ACTOR, { name: "Unassigned", agentIds: ["wall-e"] }),
    (error) => error.code === "FINANCE_AGENT_NOT_ASSIGNED",
  );
  await assert.rejects(
    async () => service.createFinanceTeam(OPERATOR_ACTOR, { name: "Empty", agentIds: [] }),
    (error) => error.code === "FINANCE_TEAM_REQUIRES_AGENT",
  );
});

test("Finance Lab rejects a sixth team and a team larger than five agents", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const agentIds = ["a1", "a2", "a3", "a4", "a5", "a6"];
  for (const agentId of agentIds) {
    await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId, displayName: agentId.toUpperCase() });
  }
  await assert.rejects(
    async () => service.createFinanceTeam(OPERATOR_ACTOR, { name: "Too large", agentIds }),
    (error) => error.code === "INVALID_INPUT",
  );
  for (let index = 1; index <= 5; index += 1) {
    await service.createFinanceTeam(OPERATOR_ACTOR, { name: `Team ${index}`, agentIds: ["a1"] });
  }
  await assert.rejects(
    async () => service.createFinanceTeam(OPERATOR_ACTOR, { name: "Team 6", agentIds: ["a1"] }),
    (error) => error.code === "FINANCE_TEAM_LIMIT_REACHED",
  );
});

test("IBKR paper snapshots replace local balances while execution stays locked", async (t) => {
  const broker = {
    probe: async () => ({
      connected: true,
      accounts: ["TEST-PAPER-ACCOUNT"],
      selectedAccount: "TEST-PAPER-ACCOUNT",
      serverVersion: 190,
    }),
    snapshot: async () => ({
      accountId: "TEST-PAPER-ACCOUNT",
      accountIdMasked: "T***UNT",
      netLiquidation: 250_000,
      cash: 240_000,
      availableFunds: 235_000,
      buyingPower: 900_000,
      currency: "GBP",
      positions: [{ symbol: "AAPL", quantity: 10, averageCost: 90 }],
      retrievedAt: "2026-08-21T09:00:00.000Z",
    }),
  };
  const { store, service, patrick } = setup({ broker });
  t.after(() => service.close());

  const portfolio = await service.getPortfolio(patrick, "paper-main", { recordValuation: false });
  assert.equal(portfolio.totalValue, 250_000);
  assert.equal(portfolio.cash, 240_000);
  assert.equal(portfolio.currency, "GBP");
  assert.equal(portfolio.broker.name, "ibkr");
  assert.equal(portfolio.broker.accountIdMasked, "T***UNT");
  assert.equal(portfolio.totalReturn, null);
  assert.equal(portfolio.drawdown, null);
  assert.equal(portfolio.performance.totalReturn, null);
  assert.equal(store.listValuations("paper-main").length, 0);

  const proposal = await service.createTradeProposal(patrick, { symbol: "AAPL", side: "BUY", quantity: 1 });
  await assert.rejects(() => service.executePaperTrade(patrick, proposal.id), (error) => error.code === "IBKR_READ_ONLY");
  assert.equal(store.getProposal(proposal.id).status, "PROPOSED");
});

test("assigned agents cannot be removed while they belong to a finance team", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "patrick", displayName: "Patrick" });
  const team = await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Research", agentIds: ["patrick"] });
  await assert.rejects(
    () => service.removeFinanceAgent(OPERATOR_ACTOR, "patrick"),
    (error) => error.code === "FINANCE_AGENT_IN_TEAM",
  );
  assert.deepEqual(await service.removeFinanceTeam(OPERATOR_ACTOR, team.id), { removed: true });
  assert.deepEqual(await service.removeFinanceAgent(OPERATOR_ACTOR, "patrick"), { removed: true });
});
