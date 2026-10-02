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

function setup({ broker, ibkrExecution } = {}) {
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
    ibkrExecution,
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
  // The broker-backed account portfolio belongs to no team, so an agent cannot execute on it
  // and the operator still needs execution explicitly enabled.
  await assert.rejects(() => service.executePaperTrade(patrick, proposal.id), (error) => error.code === "FORBIDDEN_PORTFOLIO");
  await assert.rejects(() => service.executePaperTrade(OPERATOR_ACTOR, proposal.id), (error) => error.code === "IBKR_READ_ONLY");
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

test("assigned agents can be added to an existing finance team up to its capacity", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  for (const agentId of ["patrick", "wall-e", "black-noir", "jarvis", "analyst", "extra"]) {
    await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId, displayName: agentId });
  }
  const team = await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Bullish", agentIds: ["patrick"] });
  const updated = await service.addFinanceTeamMembers(OPERATOR_ACTOR, team.id, { agentIds: ["wall-e", "black-noir"] });
  assert.deepEqual(updated.members.map((member) => member.agentId).sort(), ["black-noir", "patrick", "wall-e"]);
  assert.throws(
    () => service.addFinanceTeamMembers(OPERATOR_ACTOR, team.id, { agentIds: ["jarvis", "analyst", "extra"] }),
    (error) => error.code === "FINANCE_TEAM_MEMBER_LIMIT_REACHED",
  );
});

test("removing a team member keeps the Finance Lab assignment and protects the final member", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "patrick", displayName: "Patrick" });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "wall-e", displayName: "WALL-E" });
  const team = await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Research", agentIds: ["patrick", "wall-e"] });
  assert.deepEqual(await service.removeFinanceTeamMember(OPERATOR_ACTOR, team.id, "wall-e"), { removed: true });
  assert.equal(service.store.getFinanceAgent("wall-e").displayName, "WALL-E");
  assert.throws(
    () => service.removeFinanceTeamMember(OPERATOR_ACTOR, team.id, "patrick"),
    (error) => error.code === "FINANCE_TEAM_REQUIRES_AGENT",
  );
});

test("each finance team owns a paper portfolio and the roll-up sums them", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  for (const agentId of ["patrick", "ben", "noir"]) {
    await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId, displayName: agentId.toUpperCase() });
  }
  const bullish = await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Bullish", agentIds: ["patrick"] });
  const bearish = await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Bearish", agentIds: ["ben", "noir"] });
  assert.ok(bullish.portfolioId);
  assert.notEqual(bullish.portfolioId, bearish.portfolioId);

  const { teams, total } = await service.listTeamPortfolios(OPERATOR_ACTOR);
  assert.deepEqual([...teams.map((entry) => entry.teamName)].sort(), ["Bearish", "Bullish"]);
  const bullishEntry = teams.find((entry) => entry.teamName === "Bullish");
  const bearishEntry = teams.find((entry) => entry.teamName === "Bearish");
  assert.equal(bullishEntry.portfolio.name, "Bullish Team Portfolio");
  assert.equal(bearishEntry.members.length, 2);
  assert.equal(total.portfolioCount, 2);
  assert.equal(total.totalValue, bullishEntry.portfolio.totalValue + bearishEntry.portfolio.totalValue);
  assert.equal(total.cash, 200_000);
  assert.equal(total.initialCash, 200_000);

  const overview = await service.overview(OPERATOR_ACTOR);
  assert.equal(overview.teamPortfolios.teams.length, 2);
  assert.notEqual(overview.portfolio.id, overview.teamPortfolios.teams[0].portfolio.id);
});

test("team portfolio positions merge into the combined roll-up", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, {
    quantity: 10,
    thesis: "Team portfolio smoke",
  });
  await service.executePaperTrade(trader, proposal.id);

  const { teams, total } = await service.listTeamPortfolios(OPERATOR_ACTOR);
  assert.equal(teams[0].portfolio.positions[0].symbol, "AAPL");
  assert.equal(total.positions.length, 1);
  assert.equal(total.positions[0].quantity, 10);
  assert.equal(total.positions[0].marketValue, teams[0].portfolio.positions[0].marketValue);
});

test("removing a finance team drops its unused portfolio and keeps one with history", async (t) => {
  const { service, store } = setup();
  t.after(() => service.close());
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "patrick", displayName: "Patrick", role: "Trader/Finance Specialist" });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "dante", displayName: "Dante", role: "Trader(Bullish)" });
  const empty = await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Empty desk", agentIds: ["patrick"] });
  assert.deepEqual(await service.removeFinanceTeam(OPERATOR_ACTOR, empty.id), { removed: true });
  assert.equal(store.getPortfolio(empty.portfolioId), null);

  const traded = await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Traded desk", agentIds: ["patrick", "dante"] });
  const { trader, proposal } = await approvedTraderProposal(service, traded, { thesis: "Keep audit history" });
  await service.executePaperTrade(trader, proposal.id);
  assert.deepEqual(await service.removeFinanceTeam(OPERATOR_ACTOR, traded.id), { removed: true });
  assert.ok(store.getPortfolio(traded.portfolioId));
});

test("a finance team cannot be removed while its order workflow is unresolved", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader } = teamActors();
  await service.createTradeProposal(trader, {
    portfolioId: team.portfolioId,
    symbol: "AAPL",
    side: "BUY",
    quantity: 1,
    thesis: "Unresolved team workflow",
  });

  await assert.rejects(
    () => service.removeFinanceTeam(OPERATOR_ACTOR, team.id),
    (error) => error.code === "FINANCE_TEAM_ORDER_IN_FLIGHT",
  );
});

test("team creation order becomes the hierarchy and the first agent leads", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  for (const agentId of ["patrick", "sherlock", "dante"]) {
    await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId, displayName: agentId.toUpperCase(), role: "Trader" });
  }
  const team = await service.createFinanceTeam(OPERATOR_ACTOR, {
    name: "Bullish",
    agentIds: ["patrick", "sherlock", "dante"],
  });
  assert.deepEqual(team.members.map((member) => [member.agentId, member.rank, member.lead]), [
    ["patrick", 1, true],
    ["sherlock", 2, false],
    ["dante", 3, false],
  ]);
  assert.equal(team.leadAgentId, "patrick");

  const promoted = await service.promoteFinanceTeamLead(OPERATOR_ACTOR, team.id, "dante");
  assert.equal(promoted.leadAgentId, "dante");
  assert.deepEqual(promoted.members.map((member) => member.agentId), ["dante", "patrick", "sherlock"]);

  await service.removeFinanceTeamMember(OPERATOR_ACTOR, team.id, "dante");
  const afterRemoval = service.listFinanceTeams(OPERATOR_ACTOR)[0];
  assert.equal(afterRemoval.leadAgentId, "patrick");
  assert.deepEqual(afterRemoval.members.map((member) => member.rank), [1, 2]);

  await assert.rejects(
    async () => service.promoteFinanceTeamLead(OPERATOR_ACTOR, team.id, "dante"),
    (error) => error.code === "FINANCE_TEAM_MEMBER_NOT_FOUND",
  );
});

test("an agent reads its own role, lead, and team portfolio from team context", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "patrick", displayName: "Patrick Bateman", role: "Trader/Finance Specialist" });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "sherlock", displayName: "Sherlock Holmes", role: "Finance Researcher" });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "ben", displayName: "Ben Rickert", role: "Trader/Finance Specialist" });
  const bullish = await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Bullish", agentIds: ["patrick", "sherlock"] });
  await service.createFinanceTeam(OPERATOR_ACTOR, { name: "Bearish", agentIds: ["ben"] });

  const researcher = createActor({ actorId: "openclaw:sherlock", agentId: "sherlock", permissions: ["portfolio.read"] });
  const context = service.getFinanceTeamContext(researcher);
  assert.equal(context.role, "Finance Researcher");
  assert.equal(context.rank, 2);
  assert.equal(context.isLead, false);
  assert.equal(context.reportsTo, "patrick");
  assert.equal(context.team.portfolioId, bullish.portfolioId);
  assert.deepEqual(context.members.map((member) => member.agentId), ["patrick", "sherlock"]);
  assert.deepEqual(context.peerTeams.map((team) => team.name), ["Bearish"]);

  const lead = createActor({ actorId: "openclaw:patrick", agentId: "patrick", permissions: ["portfolio.read"] });
  assert.equal(service.getFinanceTeamContext(lead).reportsTo, null);
  assert.equal(service.getFinanceTeamContext(lead).isLead, true);

  assert.throws(
    () => service.getFinanceTeamContext(researcher, "patrick"),
    (error) => error.code === "FORBIDDEN_TEAM_CONTEXT",
  );
  const unassigned = createActor({ actorId: "openclaw:nobody", agentId: "nobody", permissions: ["portfolio.read"] });
  assert.throws(
    () => service.getFinanceTeamContext(unassigned),
    (error) => error.code === "FINANCE_TEAM_NOT_FOUND",
  );
});

test("teams stored before ranks existed keep assignment order as their hierarchy", async (t) => {
  const store = new FinanceStore();
  t.after(() => store.close());
  store.assignFinanceAgent({ agentId: "ben", displayName: "Ben Rickert" });
  store.assignFinanceAgent({ agentId: "noir", displayName: "Spider Noir" });
  const team = store.createFinanceTeam({ name: "Bearish", agentIds: ["ben", "noir"] });
  store.db.exec("UPDATE finance_team_members SET team_rank = 0");
  const reopened = store.listFinanceTeams();
  assert.deepEqual(reopened[0].members.map((member) => member.rank), [0, 0]);
  store.ensureTeamPortfolios();
  store.setFinanceTeamLead(team.id, "noir");
  assert.deepEqual(store.getFinanceTeam(team.id).members.map((member) => [member.agentId, member.rank]), [["noir", 1], ["ben", 2]]);
});

function fakeIbkrBroker({ onPlaceOrder, reconcileReport } = {}) {
  const orders = [];
  const reconcileCalls = [];
  return {
    orders,
    reconcileCalls,
    reconcile: async () => {
      reconcileCalls.push(true);
      return reconcileReport ?? { accountIdMasked: "T***UNT", openOrders: [], executionsByBrokerOrderId: {}, retrievedAt: "2026-08-24T10:00:00.000Z" };
    },
    probe: async () => ({
      connected: true,
      accounts: ["TEST-PAPER-ACCOUNT"],
      selectedAccount: "TEST-PAPER-ACCOUNT",
      serverVersion: 223,
    }),
    snapshot: async () => ({
      accountId: "TEST-PAPER-ACCOUNT",
      accountIdMasked: "T***UNT",
      netLiquidation: 250_000,
      cash: 240_000,
      availableFunds: 235_000,
      buyingPower: 900_000,
      currency: "GBP",
      positions: [],
      retrievedAt: "2026-08-22T09:00:00.000Z",
    }),
    placeOrder: async (input) => {
      orders.push(input);
      if (onPlaceOrder) return onPlaceOrder(input);
      return {
        accountIdMasked: "T***UNT",
        orderId: 17,
        whatIf: true,
        status: "PREVIEWED",
        symbol: input.symbol,
        side: input.side,
        quantity: input.quantity,
        orderType: input.orderType,
        contract: { contractId: 265598, primaryExchange: "NASDAQ" },
        preview: { status: "PreSubmitted", initMarginChange: 120.5, commissionAndFees: 1, warningText: "" },
        fill: null,
        executions: [],
      };
    },
  };
}

async function teamWithLead(service) {
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "patrick", displayName: "Patrick", role: "Trader/Finance Specialist" });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "sherlock", displayName: "Sherlock", role: "Finance Researcher" });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "dante", displayName: "Dante", role: "Trader(Bullish)" });
  return service.createFinanceTeam(OPERATOR_ACTOR, { name: "Bullish", agentIds: ["patrick", "sherlock", "dante"] });
}

function teamActors() {
  return {
    lead: createActor({ actorId: "openclaw:patrick", agentId: "patrick", permissions: allPermissions }),
    researcher: createActor({ actorId: "openclaw:sherlock", agentId: "sherlock", permissions: allPermissions }),
    trader: createActor({ actorId: "openclaw:dante", agentId: "dante", permissions: allPermissions }),
  };
}

async function approvedTraderProposal(service, team, input = {}) {
  const { lead, trader } = teamActors();
  const proposal = await service.createTradeProposal(trader, {
    portfolioId: team.portfolioId,
    symbol: "AAPL",
    side: "BUY",
    quantity: 5,
    thesis: "Trader proposes, team lead approves, trader submits",
    ...input,
  });
  const approved = await service.approveTradeProposal(lead, proposal.id);
  return { lead, trader, proposal: approved };
}

test("a trader submits only after the current team lead approves", async (t) => {
  const broker = fakeIbkrBroker();
  const { service } = setup({ broker, ibkrExecution: "dry-run" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { lead, researcher, trader } = teamActors();
  const proposal = await service.createTradeProposal(trader, {
    portfolioId: team.portfolioId,
    symbol: "AAPL",
    side: "BUY",
    quantity: 5,
    thesis: "Trader proposes, lead approves, trader executes",
  });
  await assert.rejects(
    () => service.executePaperTrade(trader, proposal.id),
    (error) => error.code === "FINANCE_TEAM_APPROVAL_REQUIRED" && error.details.leadAgentId === "patrick",
  );
  assert.throws(
    () => service.approveTradeProposal(researcher, proposal.id),
    (error) => error.code === "FINANCE_TEAM_LEAD_REQUIRED",
  );
  const approved = await service.approveTradeProposal(lead, proposal.id);
  assert.equal(approved.status, "LEAD_APPROVED");
  assert.equal(approved.leadApprovedByAgentId, "patrick");
  await assert.rejects(
    () => service.executePaperTrade(lead, proposal.id),
    (error) => error.code === "FINANCE_TEAM_TRADER_REQUIRED",
  );
  const result = await service.executePaperTrade(trader, proposal.id);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.broker, "ibkr");
  assert.equal(result.preview.whatIf, true);
  assert.equal(broker.orders.at(-1).whatIf, true);
  assert.equal(broker.orders.at(-1).symbol, "AAPL");
  assert.equal(broker.orders.at(-1).quantity, result.decision.approvedQuantity);
});

test("the current team lead can reject a trader proposal without human approval", async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { lead, researcher, trader } = teamActors();
  const proposal = await service.createTradeProposal(trader, {
    portfolioId: team.portfolioId,
    symbol: "AAPL",
    side: "BUY",
    quantity: 5,
    thesis: "Team lead should reject this paper proposal.",
  });

  assert.throws(
    () => service.rejectTradeProposal(researcher, proposal.id),
    (error) => error.code === "FINANCE_TEAM_LEAD_REQUIRED",
  );
  const rejected = await service.rejectTradeProposal(lead, proposal.id);
  assert.equal(rejected.status, "REJECTED");
  await assert.rejects(
    () => service.executePaperTrade(trader, proposal.id),
    (error) => error.code === "PROPOSAL_ALREADY_RESOLVED",
  );
});

test("approval from a former lead becomes stale after leadership changes", async (t) => {
  const broker = fakeIbkrBroker();
  const { service } = setup({ broker, ibkrExecution: "dry-run" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team);
  await service.promoteFinanceTeamLead(OPERATOR_ACTOR, team.id, "sherlock");
  assert.equal(service.store.getProposal(proposal.id).status, "PROPOSED");
  await assert.rejects(
    () => service.executePaperTrade(trader, proposal.id),
    (error) => error.code === "FINANCE_TEAM_APPROVAL_REQUIRED" && error.details.leadAgentId === "sherlock",
  );
  const { researcher: newLead } = teamActors();
  const reapproved = await service.approveTradeProposal(newLead, proposal.id);
  assert.equal(reapproved.status, "LEAD_APPROVED");
  assert.equal(reapproved.leadApprovedByAgentId, "sherlock");
  assert.equal(broker.orders.length, 0);
});

test("removing the current lead invalidates approvals for the promoted lead", async (t) => {
  const { service, store } = setup({ broker: fakeIbkrBroker(), ibkrExecution: "dry-run" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { proposal } = await approvedTraderProposal(service, team);

  await service.removeFinanceTeamMember(OPERATOR_ACTOR, team.id, "patrick");
  const updated = store.getFinanceTeam(team.id);
  assert.equal(updated.leadAgentId, "sherlock");
  assert.equal(store.getProposal(proposal.id).status, "PROPOSED");
  assert.equal(store.getProposal(proposal.id).leadApprovedByAgentId, null);
});

test("dry-run mode never writes a trade and stays off by default", async (t) => {
  const broker = fakeIbkrBroker();
  const previewed = setup({ broker, ibkrExecution: "dry-run" });
  t.after(() => previewed.service.close());
  const team = await teamWithLead(previewed.service);
  const previewWorkflow = await approvedTraderProposal(previewed.service, team, { thesis: "Preview only" });
  await previewed.service.executePaperTrade(previewWorkflow.trader, previewWorkflow.proposal.id);
  assert.equal(previewed.store.listTrades({ portfolioId: team.portfolioId, limit: 10 }).length, 0);
  assert.equal(previewed.store.getProposal(previewWorkflow.proposal.id).status, "LEAD_APPROVED");

  const locked = setup({ broker: fakeIbkrBroker() });
  t.after(() => locked.service.close());
  const lockedTeam = await teamWithLead(locked.service);
  const lockedWorkflow = await approvedTraderProposal(locked.service, lockedTeam, { thesis: "Execution disabled" });
  await assert.rejects(
    () => locked.service.executePaperTrade(lockedWorkflow.trader, lockedWorkflow.proposal.id),
    (error) => error.code === "IBKR_READ_ONLY",
  );
});

function liveFillOrder({ filledQuantity, averageFillPrice, commission, status = "Filled", brokerOrderId = "9001" }) {
  return (input) => ({
    accountIdMasked: "T***UNT",
    orderId: 17,
    whatIf: false,
    status,
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
    orderType: input.orderType,
    contract: { contractId: 265598, primaryExchange: "NASDAQ" },
    preview: null,
    fill: { status, filled: filledQuantity, remaining: input.quantity - filledQuantity, averageFillPrice, permId: Number(brokerOrderId) },
    executions: [],
    settlement: {
      brokerOrderId,
      clientOrderId: 17,
      status,
      filledQuantity,
      remainingQuantity: input.quantity - filledQuantity,
      averageFillPrice,
      commission,
      executionIds: filledQuantity > 0 ? ["exec-1"] : [],
    },
  });
}

function completedFillReport() {
  return {
    accountIdMasked: "T***UNT", openOrders: [],
    executionsByBrokerOrderId: {
      9001: { executions: [{ executionId: "exec-auto", quantity: 5, price: 102 }], filledQuantity: 5, averageFillPrice: 102, commission: 1.4 },
    },
    retrievedAt: "2026-08-24T10:00:00.000Z",
  };
}

test("startup automatically settles working fills once alongside manual reconciliation", async (t) => {
  const broker = fakeIbkrBroker({
    onPlaceOrder: liveFillOrder({ filledQuantity: 0, averageFillPrice: null, commission: null, status: "PreSubmitted" }),
    reconcileReport: completedFillReport(),
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team);
  await service.executePaperTrade(trader, proposal.id);
  service.start();
  service.start();
  const manual = await service.reconcileBrokerOrders(trader);
  assert.equal(manual.checked, 0);
  assert.equal(broker.reconcileCalls.length, 1);
  assert.equal(broker.orders.length, 1);
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 1);
  assert.equal(store.listBrokerOrders({ portfolioId: team.portfolioId })[0].status, "FILLED");
  assert.equal(store.getPortfolio(team.portfolioId).cash, 100_000 - (5 * 102 + 1.4));
});

test("automatic reconciliation retries a Gateway failure and stops broker reads after settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const broker = fakeIbkrBroker({ onPlaceOrder: liveFillOrder({ filledQuantity: 0, averageFillPrice: null, commission: null, status: "Submitted" }) });
  let reads = 0;
  broker.reconcile = async () => {
    reads += 1;
    if (reads === 1) throw new Error("Gateway temporarily unavailable");
    return completedFillReport();
  };
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  const errors = [];
  service.logger = { error(message) { errors.push(message); } };
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team);
  await service.executePaperTrade(trader, proposal.id);
  service.start();
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  assert.equal(errors.length, 1);
  assert.equal(store.getProposal(proposal.id).status, "WORKING");
  t.mock.timers.tick(15_000);
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 1);
  t.mock.timers.tick(15_000);
  await new Promise(setImmediate);
  assert.equal(reads, 2);
});

test("shutdown drains an active broker reconciliation before closing the ledger", async (t) => {
  const broker = fakeIbkrBroker({ onPlaceOrder: liveFillOrder({ filledQuantity: 0, averageFillPrice: null, commission: null, status: "Submitted" }) });
  let resolveRead;
  broker.reconcile = () => new Promise((resolve) => { resolveRead = resolve; });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team);
  await service.executePaperTrade(trader, proposal.id);
  service.start();
  await new Promise(setImmediate);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  assert.equal(store.getProposal(proposal.id).status, "WORKING");
  resolveRead(completedFillReport());
  await closing;
  assert.equal(closed, true);
  assert.equal(service.reconciliationTimer, null);
});

test("read-only and dry-run modes never start automatic broker reconciliation", async () => {
  for (const ibkrExecution of ["off", "dry-run"]) {
    const broker = fakeIbkrBroker();
    const { service } = setup({ broker, ibkrExecution });
    service.start();
    await new Promise(setImmediate);
    assert.equal(broker.reconcileCalls.length, 0);
    await service.close();
  }
});

test("automatic reconciliation cannot duplicate a submission that settles while its snapshot is in flight", async (t) => {
  let releasePlacement;
  const broker = fakeIbkrBroker({
    onPlaceOrder: (input) => new Promise((resolve) => {
      releasePlacement = () => resolve(liveFillOrder({ filledQuantity: 5, averageFillPrice: 102, commission: 1.4 })(input));
    }),
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team);
  const report = completedFillReport();
  report.executionsByBrokerOrderId[9001].orderRef = proposal.id;
  broker.reconcile = async () => report;
  const submission = service.executePaperTrade(trader, proposal.id);
  await new Promise(setImmediate);
  assert.equal(store.getProposal(proposal.id).status, "SUBMITTING");
  service.start();
  const reconciliation = service.reconcileBrokerOrders(trader);
  await new Promise(setImmediate);
  releasePlacement();
  await submission;
  await reconciliation;
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 1);
  assert.equal(store.listBrokerOrders({ portfolioId: team.portfolioId }).length, 1);
  assert.equal(store.getPortfolio(team.portfolioId).cash, 100_000 - (5 * 102 + 1.4));
});

test("live mode books the broker's own fill price and commission, not the local quote", async (t) => {
  const broker = fakeIbkrBroker({ onPlaceOrder: liveFillOrder({ filledQuantity: 5, averageFillPrice: 101.5, commission: 1.25 }) });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Live paper order" });

  const result = await service.executePaperTrade(trader, proposal.id);
  assert.equal(result.mode, "live");
  assert.equal(broker.orders.at(-1).whatIf, false);
  assert.equal(result.brokerOrder.status, "FILLED");
  assert.equal(result.brokerOrder.brokerOrderId, "9001");
  assert.equal(result.trade.price, 101.5);
  assert.equal(result.trade.fee, 1.25);
  assert.equal(result.trade.quantity, 5);
  assert.deepEqual(result.brokerOrder.executionIds, ["exec-1"]);
  assert.equal(store.getProposal(proposal.id).status, "APPROVED");
  // Cash must move by the broker's numbers: 5 * 101.5 + 1.25 commission.
  const portfolio = store.getPortfolio(team.portfolioId);
  assert.equal(portfolio.cash, 100_000 - (5 * 101.5 + 1.25));
});

test("a live order with no fill yet writes no trade and reconciles exactly once", async (t) => {
  const broker = fakeIbkrBroker({
    onPlaceOrder: liveFillOrder({ filledQuantity: 0, averageFillPrice: null, commission: null, status: "Submitted" }),
    reconcileReport: {
      accountIdMasked: "T***UNT",
      openOrders: [],
      executionsByBrokerOrderId: {
        9001: {
          executions: [{ executionId: "exec-9", quantity: 5, price: 102 }],
          filledQuantity: 5,
          averageFillPrice: 102,
          commission: 1.4,
        },
      },
      retrievedAt: "2026-08-24T10:00:00.000Z",
    },
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Working order" });

  const placed = await service.executePaperTrade(trader, proposal.id);
  assert.equal(placed.brokerOrder.status, "WORKING");
  assert.equal(placed.trade, null);
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 0);
  assert.equal(store.getPortfolio(team.portfolioId).cash, 100_000);
  const overview = await service.overview(OPERATOR_ACTOR);
  assert.equal(overview.recentProposals[0].id, proposal.id);
  assert.equal(overview.recentProposals[0].portfolioId, team.portfolioId);
  assert.equal(overview.recentBrokerOrders[0].proposalId, proposal.id);
  assert.equal(overview.recentBrokerOrders[0].status, "WORKING");
  const visibilityActors = teamActors();
  assert.equal(service.listBrokerOrders(visibilityActors.lead).length, 1);
  assert.equal(service.listBrokerOrders(visibilityActors.researcher).length, 1);
  assert.equal(service.listBrokerOrders(trader).length, 1);
  const outsider = createActor({ actorId: "openclaw:outsider", agentId: "outsider", permissions: ["portfolio.read"] });
  assert.equal(service.listBrokerOrders(outsider).length, 0);
  // A working order must not free the proposal for a second live order, and the duplicate
  // must be refused before anything reaches the broker.
  await assert.rejects(
    () => service.executePaperTrade(trader, proposal.id),
    (error) => error.code === "PROPOSAL_ALREADY_RESOLVED",
  );
  assert.equal(broker.orders.length, 1);

  const secondProposal = await service.createTradeProposal(trader, {
    portfolioId: team.portfolioId,
    symbol: "AAPL",
    side: "BUY",
    quantity: 1,
    thesis: "Must wait for the first broker order",
  });
  const { lead } = teamActors();
  await service.approveTradeProposal(lead, secondProposal.id);
  await assert.rejects(
    () => service.executePaperTrade(trader, secondProposal.id),
    (error) => error.code === "BROKER_ORDER_IN_FLIGHT",
  );
  assert.equal(broker.orders.length, 1);

  const first = await service.reconcileBrokerOrders(trader);
  assert.equal(first.checked, 1);
  assert.equal(first.settled.length, 1);
  assert.equal(first.settled[0].status, "FILLED");
  const trades = store.listTrades({ portfolioId: team.portfolioId });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].price, 102);
  assert.equal(trades[0].fee, 1.4);

  const second = await service.reconcileBrokerOrders(trader);
  assert.equal(second.checked, 0);
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 1);
  assert.equal(store.getPortfolio(team.portfolioId).cash, 100_000 - (5 * 102 + 1.4));
});

test("concurrent live submissions transmit a proposal only once", async (t) => {
  let releaseOrder;
  const broker = fakeIbkrBroker({
    onPlaceOrder: async (input) => {
      await new Promise((resolve) => { releaseOrder = resolve; });
      return liveFillOrder({ filledQuantity: 0, averageFillPrice: null, commission: null, status: "Submitted" })(input);
    },
  });
  const { service } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Concurrent submission" });

  const first = service.executePaperTrade(trader, proposal.id);
  const second = service.executePaperTrade(trader, proposal.id);
  while (!releaseOrder) await new Promise((resolve) => setImmediate(resolve));
  releaseOrder();
  const results = await Promise.allSettled([first, second]);

  assert.equal(broker.orders.length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "PROPOSAL_ALREADY_RESOLVED");
});

test("a fill whose commission has not arrived is not booked until reconciliation has it", async (t) => {
  const broker = fakeIbkrBroker({
    onPlaceOrder: liveFillOrder({ filledQuantity: 5, averageFillPrice: 101, commission: null }),
    reconcileReport: {
      accountIdMasked: "T***UNT",
      openOrders: [],
      executionsByBrokerOrderId: {
        9001: { executions: [{ executionId: "exec-1", quantity: 5, price: 101 }], filledQuantity: 5, averageFillPrice: 101, commission: null },
      },
      retrievedAt: "2026-08-24T10:00:00.000Z",
    },
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Fee unknown" });

  const placed = await service.executePaperTrade(trader, proposal.id);
  assert.equal(placed.brokerOrder.status, "WORKING");
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 0);
  const still = await service.reconcileBrokerOrders(trader);
  assert.equal(still.stillWorking.length, 1);
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 0);
});

test("an order absent from a broker snapshot remains working", async (t) => {
  const broker = fakeIbkrBroker({
    onPlaceOrder: liveFillOrder({ filledQuantity: 0, averageFillPrice: null, commission: null, status: "Submitted" }),
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Cancelled at the broker" });

  await service.executePaperTrade(trader, proposal.id);
  const report = await service.reconcileBrokerOrders(trader);
  assert.equal(report.settled.length, 0);
  assert.equal(report.stillWorking.length, 1);
  assert.equal(store.getProposal(proposal.id).status, "WORKING");
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 0);
});

test("an explicit IBKR cancellation releases an unfilled proposal", async (t) => {
  const broker = fakeIbkrBroker({
    onPlaceOrder: liveFillOrder({ filledQuantity: 0, averageFillPrice: null, commission: null, status: "Submitted" }),
    reconcileReport: {
      accountIdMasked: "T***UNT",
      openOrders: [],
      completedOrders: [{ brokerOrderId: "9001", status: "Cancelled" }],
      executionsByBrokerOrderId: {},
      retrievedAt: "2026-08-24T10:00:00.000Z",
    },
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Explicit cancellation" });

  await service.executePaperTrade(trader, proposal.id);
  const report = await service.reconcileBrokerOrders(trader);
  assert.equal(report.settled[0].status, "CANCELLED");
  assert.equal(store.getProposal(proposal.id).status, "REJECTED");
});

test("a sparse reconciliation snapshot preserves a known fill awaiting commission", async (t) => {
  const broker = fakeIbkrBroker({
    onPlaceOrder: liveFillOrder({ filledQuantity: 5, averageFillPrice: 101, commission: null, status: "Filled" }),
    reconcileReport: {
      accountIdMasked: "T***UNT",
      openOrders: [],
      completedOrders: [],
      executionsByBrokerOrderId: {},
      retrievedAt: "2026-08-24T10:00:00.000Z",
    },
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Known fill, fee pending" });

  const placed = await service.executePaperTrade(trader, proposal.id);
  assert.equal(placed.brokerOrder.filledQuantity, 5);
  const report = await service.reconcileBrokerOrders(trader);
  assert.equal(report.stillWorking[0].filledQuantity, 5);
  assert.equal(store.getProposal(proposal.id).status, "WORKING");
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 0);
});

test("reconciliation upgrades a client-order fallback to permId", async (t) => {
  let proposalRef;
  const broker = fakeIbkrBroker({
    onPlaceOrder: (input) => {
      proposalRef = input.orderRef;
      return liveFillOrder({
        filledQuantity: 0,
        averageFillPrice: null,
        commission: null,
        status: "Submitted",
        brokerOrderId: "client:17",
      })(input);
    },
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Identity upgrade" });
  const placed = await service.executePaperTrade(trader, proposal.id);
  broker.reconcile = async () => ({
    accountIdMasked: "T***UNT",
    openOrders: [{
      brokerOrderId: "9009",
      clientOrderId: 17,
      orderRef: proposalRef,
      status: "Submitted",
    }],
    completedOrders: [],
    executionsByBrokerOrderId: {},
    retrievedAt: "2026-08-24T10:00:00.000Z",
  });

  await service.reconcileBrokerOrders(trader);
  assert.equal(store.getBrokerOrder(placed.brokerOrder.id).brokerOrderId, "9009");
});

test("reconciliation never adopts an unrelated fill with a reused session order ID", async (t) => {
  const broker = fakeIbkrBroker({ onPlaceOrder: liveFillOrder({ filledQuantity: 0, averageFillPrice: null, commission: null, status: "Submitted" }) });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team);
  const placed = await service.executePaperTrade(trader, proposal.id);
  broker.reconcile = async () => ({
    accountIdMasked: "T***UNT", openOrders: [],
    completedOrders: [{ brokerOrderId: "9002", clientOrderId: 17, orderRef: "another-proposal", symbol: "MU", status: "Filled" }],
    executionsByBrokerOrderId: { 9002: { orderRef: "another-proposal", executions: [{ executionId: "unrelated-fill", quantity: 5, price: 102 }], filledQuantity: 5, averageFillPrice: 102, commission: 1.4 } },
  });
  await service.reconcileBrokerOrders(trader);
  const order = store.getBrokerOrder(placed.brokerOrder.id);
  assert.equal(order.brokerOrderId, "9001");
  assert.equal(order.status, "WORKING");
  assert.equal(order.filledQuantity, 0);
  assert.equal(store.listTrades({ portfolioId: team.portfolioId }).length, 0);
});

test("reconciliation adopts an ambiguously transmitted proposal by orderRef", async (t) => {
  let orderRef;
  const broker = fakeIbkrBroker({
    onPlaceOrder: (input) => {
      orderRef = input.orderRef;
      throw Object.assign(new Error("connection lost after transmit"), { code: "IBKR_GATEWAY_UNAVAILABLE" });
    },
  });
  const { service, store } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { trader, proposal } = await approvedTraderProposal(service, team, { thesis: "Recover transmitted order" });

  await assert.rejects(
    () => service.executePaperTrade(trader, proposal.id),
    (error) => error.code === "IBKR_GATEWAY_UNAVAILABLE",
  );
  assert.equal(orderRef, proposal.id);
  assert.equal(store.getProposal(proposal.id).status, "SUBMITTING");
  broker.reconcile = async () => ({
    accountIdMasked: "T***UNT",
    openOrders: [{
      brokerOrderId: "9002",
      clientOrderId: 18,
      orderRef: proposal.id,
      symbol: "AAPL",
      side: "BUY",
      quantity: 5,
      status: "Submitted",
    }],
    executionsByBrokerOrderId: {},
    retrievedAt: "2026-08-24T10:00:00.000Z",
  });

  const report = await service.reconcileBrokerOrders(trader);
  assert.equal(report.pendingSubmissions, 0);
  assert.equal(report.stillWorking.length, 1);
  assert.equal(report.stillWorking[0].brokerOrderId, "9002");
  assert.equal(store.getProposal(proposal.id).status, "WORKING");
  assert.equal(broker.orders.length, 1);
});

test("live execution stays behind trader ownership, lead approval, and the off switch", async (t) => {
  const broker = fakeIbkrBroker({ onPlaceOrder: liveFillOrder({ filledQuantity: 5, averageFillPrice: 101, commission: 1 }) });
  const { service } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { researcher } = teamActors();
  await assert.rejects(
    () => service.createTradeProposal(researcher, {
      portfolioId: team.portfolioId,
      symbol: "AAPL",
      side: "BUY",
      quantity: 5,
    }),
    (error) => error.code === "FINANCE_TEAM_TRADER_REQUIRED",
  );
  assert.equal(broker.orders.length, 0);

  const locked = setup({ broker: fakeIbkrBroker() });
  t.after(() => locked.service.close());
  await assert.rejects(
    () => locked.service.reconcileBrokerOrders(OPERATOR_ACTOR),
    (error) => error.code === "IBKR_READ_ONLY",
  );
});

test("settling broker orders is scoped to the caller's own team book", async (t) => {
  const broker = fakeIbkrBroker();
  const { service } = setup({ broker, ibkrExecution: "live" });
  t.after(() => service.close());
  const team = await teamWithLead(service);
  const { researcher, trader, lead } = teamActors();
  const stranger = createActor({ actorId: "openclaw:nobody", agentId: "nobody", permissions: allPermissions });

  await assert.rejects(
    () => service.reconcileBrokerOrders(OPERATOR_ACTOR),
    (error) => error.code === "FINANCE_TEAM_TRADER_REQUIRED",
  );

  await assert.rejects(
    () => service.reconcileBrokerOrders(researcher),
    (error) => error.code === "FINANCE_TEAM_TRADER_REQUIRED",
  );
  await assert.rejects(
    () => service.reconcileBrokerOrders(stranger),
    (error) => error.code === "FINANCE_TEAM_NOT_FOUND",
  );
  await assert.rejects(
    () => service.reconcileBrokerOrders(lead, { portfolioId: "paper-main" }),
    (error) => error.code === "FINANCE_TEAM_TRADER_REQUIRED",
  );
  // The trader's own book is allowed, and an empty pass never reaches the broker.
  const report = await service.reconcileBrokerOrders(trader, { portfolioId: team.portfolioId });
  assert.equal(report.checked, 0);
  assert.equal(broker.reconcileCalls.length, 0);
});
