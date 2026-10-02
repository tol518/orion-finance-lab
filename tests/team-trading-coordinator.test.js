import assert from "node:assert/strict";
import test from "node:test";
import { TeamTradingCoordinator } from "../src/automation/team-trading-coordinator.js";
import { FinanceStore } from "../src/persistence/finance-store.js";
import { FixtureMarketDataProvider } from "../src/market-data/fixture-provider.js";
import { FinanceLabService, OPERATOR_ACTOR, createActor } from "../src/service/finance-lab.js";

const permissions = ["market.read", "portfolio.read", "strategy.run", "trade.propose", "trade.execute"];

test("one team autonomously researches, approves, and trades through dynamically resolved agents", async (t) => {
  const { service, team } = await setup();
  t.after(() => service.close());
  const calls = [];
  const runtime = {
    async runTurn(input) {
      calls.push({ agentId: input.agentId, scope: input.scope });
      if (input.scope.endsWith("-research")) return "Recommend AAPL after reviewing market and fundamental evidence.";
      if (input.scope.endsWith("-strategy")) return "Draft a small AAPL BUY with a defined invalidation; final order approval follows the draft.";
      if (input.scope.endsWith("-proposal")) return 'FINANCE_PROPOSAL: {"decision":"PROPOSE","symbol":"AAPL","side":"BUY","quantity":1,"thesis":"Research handoff supports a small paper position."}';
      if (input.scope.endsWith("-approval")) return 'FINANCE_REVIEW: {"decision":"APPROVE","reason":"Risk is acceptable."}';
      if (input.scope.endsWith("-submission")) return 'FINANCE_SUBMISSION: {"decision":"SUBMIT"}';
      throw new Error(`Unexpected scope: ${input.scope}`);
    },
    async abortTurn() {},
  };
  const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });

  coordinator.start(team.id);
  const state = await coordinator.waitForTeam(team.id);

  assert.equal(state.status, "COMPLETED");
  assert.deepEqual(calls.map((call) => call.agentId), ["researcher-agent", "lead-agent", "trader-agent", "lead-agent", "trader-agent"]);
  const portfolio = await service.getPortfolio(OPERATOR_ACTOR, team.portfolioId, { recordValuation: false });
  assert.equal(portfolio.positions[0].symbol, "AAPL");
  assert.equal(service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 1);
});

test("a justified no-trade decision completes without creating a proposal", async (t) => {
  const { service, team } = await setup();
  t.after(() => service.close());
  const runtime = {
    async runTurn(input) {
      if (input.scope.endsWith("-research")) return "No defensible opportunity was found.";
      return 'FINANCE_PROPOSAL: {"decision":"NO_TRADE","reason":"Current evidence does not justify a position."}';
    },
    async abortTurn() {},
  };
  const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });

  coordinator.start(team.id);
  const state = await coordinator.waitForTeam(team.id);

  assert.equal(state.status, "COMPLETED");
  assert.equal(state.phase, "NO_TRADE");
  const audit = service.store.listAudit().find((entry) => entry.action === "finance.team.trading.complete");
  assert.equal(audit.payload.phase, "NO_TRADE");
  assert.equal(audit.payload.reason, "Current evidence does not justify a position.");
  assert.equal(service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 0);
});

test("a missing explicit lead decision fails without rejecting or submitting the proposal", async (t) => {
  const { service, team } = await setup();
  t.after(() => service.close());
  const calls = [];
  const runtime = {
    async runTurn(input) {
      calls.push(input.scope);
      if (input.scope.endsWith("-research")) return "Consider AAPL, with material downside risk.";
      if (input.scope.endsWith("-strategy")) return "Draft a small AAPL BUY with a defined invalidation; final order approval follows the draft.";
      if (input.scope.endsWith("-proposal")) return 'FINANCE_PROPOSAL: {"decision":"PROPOSE","symbol":"AAPL","side":"BUY","quantity":1,"thesis":"Small evidence-backed position."}';
      if (input.scope.endsWith("-approval")) return "I need more evidence before I can approve this proposal.";
      throw new Error("Submission must not run after rejection");
    },
    async abortTurn() {},
  };
  const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime, logger: { error() {} } });

  coordinator.start(team.id);
  const state = await coordinator.waitForTeam(team.id);
  const proposal = service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId })[0];

  assert.equal(state.status, "FAILED");
  assert.equal(state.phase, "FAILED");
  assert.match(state.error, /missing FINANCE_REVIEW/);
  assert.equal(proposal.status, "PROPOSED");
  const audit = service.store.listAudit().find((entry) => entry.action === "finance.team.trading.complete");
  assert.equal(audit.payload.proposalId, proposal.id);
  assert.equal(audit.payload.phase, "FAILED");
  assert.equal(audit.success, false);
  assert.equal(calls.some((scope) => scope.endsWith("-submission")), false);
});

test("duplicate starts are refused and stop prevents the proposal stage", async (t) => {
  const { service, team } = await setup();
  t.after(() => service.close());
  let rejectResearch;
  const runtime = {
    runTurn() {
      return new Promise((_resolve, reject) => { rejectResearch = reject; });
    },
    async abortTurn() {
      rejectResearch(new Error("aborted"));
    },
  };
  const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });

  coordinator.start(team.id);
  assert.throws(() => coordinator.start(team.id), (error) => error.code === "FINANCE_TEAM_TRADING_ACTIVE");
  await coordinator.stop(team.id);
  const state = await coordinator.waitForTeam(team.id);

  assert.equal(state.status, "STOPPED");
  assert.equal(service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 0);
});

async function setup({ name = "Dynamic Test Team", disposition = "", broker, ibkrExecution } = {}) {
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
      "^GSPC": { symbol: "^GSPC", name: "S&P 500", assetType: "INDEX", currency: "USD", price: 6_000, previousClose: 5_990 },
    },
    histories: { AAPL: bars, "^GSPC": bars },
  });
  const service = new FinanceLabService({ store: new FinanceStore(), provider, broker, ibkrExecution, tradingAgents: {} });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "lead-agent", displayName: "Lead", role: "Finance Team Lead" });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "researcher-agent", displayName: "Researcher", role: `Finance Researcher${disposition}` });
  await service.assignFinanceAgent(OPERATOR_ACTOR, { agentId: "trader-agent", displayName: "Trader", role: `Trader${disposition}` });
  const team = await service.createFinanceTeam(OPERATOR_ACTOR, {
    name,
    agentIds: ["lead-agent", "researcher-agent", "trader-agent"],
  });
  return {
    service,
    team,
    actors: {
      lead: createActor({ actorId: "openclaw:lead-agent", agentId: "lead-agent", permissions }),
      researcher: createActor({ actorId: "openclaw:researcher-agent", agentId: "researcher-agent", permissions }),
      trader: createActor({ actorId: "openclaw:trader-agent", agentId: "trader-agent", permissions }),
    },
  };
}

for (const viaTool of [false, true]) {
  for (const side of ["BUY", "SELL"]) {
    test(`IBKR dry-run via ${viaTool ? "tool" : "coordinator"} reports ${side === "BUY" ? "preview" : "risk rejection"} without an order`, async (t) => {
      const orders = [];
      const broker = {
        async placeOrder(input) {
          orders.push(input);
          return { whatIf: true, status: "PREVIEWED" };
        },
      };
      const { service, team, actors } = await setup({ broker, ibkrExecution: "dry-run" });
      t.after(() => service.close());
      const runtime = {
        async runTurn(input) {
          if (input.scope.endsWith("-research")) return "Synthetic evidence.";
          if (input.scope.endsWith("-strategy")) return "Draft a bounded paper proposal.";
          if (input.scope.endsWith("-proposal")) return `FINANCE_PROPOSAL: ${JSON.stringify({ decision: "PROPOSE", symbol: "AAPL", side, quantity: 1, thesis: "Preview test." })}`;
          if (input.scope.endsWith("-approval")) return 'FINANCE_REVIEW: {"decision":"APPROVE"}';
          if (viaTool) {
            const proposal = service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId })[0];
            await service.executePaperTrade(actors.trader, proposal.id);
          }
          return viaTool ? "The tool returned its preview or risk refusal." : 'FINANCE_SUBMISSION: {"decision":"SUBMIT"}';
        },
        async abortTurn() {},
      };
      const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
      coordinator.start(team.id);
      const state = await coordinator.waitForTeam(team.id);
      assert.equal(state.status, "COMPLETED");
      assert.equal(state.phase, side === "BUY" ? "PREVIEWED" : "REJECTED");
      assert.match(state.message, side === "BUY" ? /no order was submitted/ : /No position is available to sell/);
      assert.equal(service.store.getProposal(state.proposalId).status, "LEAD_APPROVED");
      assert.equal(service.listTrades(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 0);
      assert.equal(service.listBrokerOrders(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 0);
      assert.equal(orders.length, side === "BUY" ? 1 : 0);
      assert.ok(orders.every((order) => order.whatIf === true));
    });
  }
}

test("a trader's no-trade decision never adopts a tool-created draft or reaches lead review", async (t) => {
  const { service, team, actors } = await setup();
  t.after(() => service.close());
  const reason = "New primary-source evidence invalidated the catalyst after drafting.";
  let draft;
  const runtime = {
    async runTurn(input) {
      if (input.scope.endsWith("-research")) return "Synthetic research.";
      if (input.scope.endsWith("-strategy")) return "Draft a bounded proposal.";
      if (input.scope.endsWith("-proposal")) {
        draft = await service.createTradeProposal(actors.trader, { portfolioId: team.portfolioId, symbol: "AAPL", side: "BUY", quantity: 1, thesis: "Initial draft." });
        return `FINANCE_PROPOSAL: ${JSON.stringify({ decision: "NO_TRADE", reason })}`;
      }
      throw new Error("A withdrawn draft must not reach approval or submission");
    },
    async abortTurn() {},
  };
  const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
  coordinator.start(team.id);
  const state = await coordinator.waitForTeam(team.id);
  assert.equal(state.phase, "NO_TRADE");
  assert.equal(state.message, reason);
  assert.equal(state.proposalId, null);
  assert.equal(service.store.getProposal(draft.id).status, "PROPOSED");
  assert.equal(service.listTrades(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 0);
  const audit = service.store.listAudit().find((entry) => entry.action === "finance.team.trading.complete");
  assert.equal(audit.payload.proposalId, state.proposalId);
  assert.equal(audit.payload.reason, reason);
});

for (const viaTool of [false, true]) {
  test(`IBKR live risk refusal via ${viaTool ? "tool" : "coordinator"} is reported without replay`, async (t) => {
    const { service, team, actors } = await setup({
      broker: { async placeOrder() { throw new Error("Risk-refused orders cannot reach the broker"); } },
      ibkrExecution: "live",
    });
    t.after(() => service.close());
    const runtime = {
      async runTurn(input) {
        if (input.scope.endsWith("-research")) return "Synthetic evidence.";
        if (input.scope.endsWith("-strategy")) return "Draft a SELL proposal.";
        if (input.scope.endsWith("-proposal")) return 'FINANCE_PROPOSAL: {"decision":"PROPOSE","symbol":"AAPL","side":"SELL","quantity":1,"thesis":"Risk refusal test."}';
        if (input.scope.endsWith("-approval")) return 'FINANCE_REVIEW: {"decision":"APPROVE"}';
        if (viaTool) {
          const proposal = service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId })[0];
          await service.executePaperTrade(actors.trader, proposal.id);
          return "The tool refused the order because there is no held position.";
        }
        return 'FINANCE_SUBMISSION: {"decision":"SUBMIT"}';
      },
      async abortTurn() {},
    };
    const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
    coordinator.start(team.id);
    const state = await coordinator.waitForTeam(team.id);
    assert.equal(state.phase, "REJECTED");
    assert.match(state.message, /No position is available to sell/);
    const events = service.store.listAudit().filter((entry) => entry.action === "trade.execute");
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.execution.status, "REJECTED");
  });
}

test("a cycle creates its exact structured draft and evidence without adopting another session's proposal", async (t) => {
  const { service, team, actors } = await setup();
  t.after(() => service.close());
  let unrelated;
  const evidence = [{ source: "fixture://current-cycle/source", retrievedAt: "2026-01-01T00:00:00Z" }];
  const runtime = {
    async runTurn(input) {
      if (input.scope.endsWith("-research")) {
        unrelated = await service.createTradeProposal(actors.trader, { portfolioId: team.portfolioId, symbol: "AAPL", side: "SELL", quantity: 10, thesis: "Another session's draft." });
        return "Synthetic research.";
      }
      if (input.scope.endsWith("-strategy")) return "Draft one share of AAPL BUY.";
      if (input.scope.endsWith("-proposal")) return `FINANCE_PROPOSAL: ${JSON.stringify({ decision: "PROPOSE", symbol: "AAPL", side: "BUY", quantity: 1, thesis: "This cycle's exact thesis.", evidence })}`;
      if (input.scope.endsWith("-approval")) {
        const proposal = promptJson(input.message, "Full proposal including thesis: ");
        assert.notEqual(proposal.id, unrelated.id);
        assert.equal(proposal.side, "BUY");
        assert.equal(proposal.requestedQuantity, 1);
        const storedEvidence = promptJson(input.message, "Stored proposal evidence: ").body.marketData;
        assert.deepEqual(storedEvidence.map((entry) => entry.data), evidence);
        return 'FINANCE_REVIEW: {"decision":"APPROVE"}';
      }
      return 'FINANCE_SUBMISSION: {"decision":"SUBMIT"}';
    },
    async abortTurn() {},
  };
  const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
  coordinator.start(team.id);
  const state = await coordinator.waitForTeam(team.id);
  assert.equal(state.phase, "COMPLETED");
  assert.notEqual(state.proposalId, unrelated.id);
  assert.equal(service.store.getProposal(unrelated.id).status, "PROPOSED");
});

for (const mode of ["dry-run", "live"]) {
  test(`stopping after an IBKR ${mode} tool risk refusal preserves its blocker`, async (t) => {
    let signalExecuted;
    const executed = new Promise((resolve) => { signalExecuted = resolve; });
    let rejectTurn;
    const { service, team, actors } = await setup({
      broker: { async placeOrder() { throw new Error("A refused order cannot be transmitted"); } },
      ibkrExecution: mode,
    });
    t.after(() => service.close());
    const runtime = {
      async runTurn(input) {
        if (input.scope.endsWith("-research")) return "Synthetic evidence.";
        if (input.scope.endsWith("-strategy")) return "Draft a SELL proposal.";
        if (input.scope.endsWith("-proposal")) return 'FINANCE_PROPOSAL: {"decision":"PROPOSE","symbol":"AAPL","side":"SELL","quantity":1,"thesis":"Stopped risk refusal."}';
        if (input.scope.endsWith("-approval")) return 'FINANCE_REVIEW: {"decision":"APPROVE"}';
        const proposal = service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId })[0];
        await service.executePaperTrade(actors.trader, proposal.id);
        signalExecuted();
        return new Promise((_resolve, reject) => { rejectTurn = reject; });
      },
      async abortTurn() { rejectTurn(new Error("Aborted after risk refusal")); },
    };
    const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
    coordinator.start(team.id);
    await executed;
    await coordinator.stop(team.id);
    const state = await coordinator.waitForTeam(team.id);
    assert.equal(state.phase, "REJECTED");
    assert.match(state.message, /No position is available to sell/);
  });
}

for (const expectedPhase of ["COMPLETED", "REJECTED", "WORKING", "SUBMITTING"]) {
  test(`stopping a submission preserves its persisted ${expectedPhase} outcome`, async (t) => {
    let signalExecuted;
    const executed = new Promise((resolve) => { signalExecuted = resolve; });
    let rejectTurn;
    const live = expectedPhase === "WORKING" || expectedPhase === "SUBMITTING";
    const broker = live ? {
      async placeOrder(input) {
        if (expectedPhase === "SUBMITTING") {
          signalExecuted();
          return new Promise((_resolve, reject) => { rejectTurn = reject; });
        }
        return {
          accountIdMasked: "T***UNT",
          settlement: { brokerOrderId: "9001", clientOrderId: 17, status: "Submitted", filledQuantity: 0, remainingQuantity: input.quantity, averageFillPrice: null, commission: null, executionIds: [] },
        };
      },
    } : undefined;
    const { service, team, actors } = await setup({ broker, ibkrExecution: live ? "live" : undefined });
    t.after(() => service.close());
    const runtime = {
      async runTurn(input) {
        if (input.scope.endsWith("-research")) return "Synthetic evidence.";
        if (input.scope.endsWith("-strategy")) return "Draft a bounded paper proposal.";
        if (input.scope.endsWith("-proposal")) return `FINANCE_PROPOSAL: ${JSON.stringify({ decision: "PROPOSE", symbol: "AAPL", side: expectedPhase === "REJECTED" ? "SELL" : "BUY", quantity: 1, thesis: "Stop outcome test." })}`;
        if (input.scope.endsWith("-approval")) return 'FINANCE_REVIEW: {"decision":"APPROVE"}';
        const proposal = service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId })[0];
        await service.executePaperTrade(actors.trader, proposal.id);
        signalExecuted();
        return new Promise((_resolve, reject) => { rejectTurn = reject; });
      },
      async abortTurn() { rejectTurn(new Error("Turn aborted after execution started")); },
    };
    const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
    coordinator.start(team.id);
    await executed;
    await coordinator.stop(team.id);
    const state = await coordinator.waitForTeam(team.id);
    const phase = expectedPhase === "SUBMITTING" ? "WORKING" : expectedPhase;
    assert.equal(state.status, "COMPLETED");
    assert.equal(state.phase, phase);
    assert.equal(service.listTrades(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, expectedPhase === "COMPLETED" ? 1 : 0);
    if (expectedPhase === "SUBMITTING") assert.equal(service.store.getProposal(state.proposalId).status, "SUBMITTING");
    const audit = service.store.listAudit().find((entry) => entry.action === "finance.team.trading.complete");
    assert.equal(audit.payload.phase, phase);
    assert.equal(audit.payload.proposalId, state.proposalId);
  });
}

for (const disposition of ["Neutral", "Bearish"]) {
  test(`${disposition} team hands actual evidence, lead strategy, and risk context through a small paper trade`, async (t) => {
    const { service, team } = await setup({ name: `${disposition} Test Team`, disposition: `(${disposition})` });
    t.after(() => service.close());
    const research = "Verified fixture catalyst with counterevidence, 30-day horizon, and invalidation below 95.";
    const strategy = "Use a small cash-funded AAPL BUY under the current mandate; draft before final approval.";
    const thesis = "The verified catalyst supports this bounded position; exit the thesis if price falls below 95.";
    const seen = [];
    const runtime = {
      async runTurn(input) {
        seen.push(input);
        if (input.scope.endsWith("-research")) {
          const context = promptJson(input.message, "Current paper portfolio, risk limits, and execution mode: ");
          assert.equal(context.portfolio.id, team.portfolioId);
          assert.equal(context.portfolio.cash, 100_000);
          assert.equal(context.execution, "local-paper");
          assert.deepEqual(context.portfolio.positions, []);
          assert.match(input.message, /SELL cannot open a short/);
          assert.match(input.message, /neutral disposition can choose either direction/);
          return research;
        }
        if (input.scope.endsWith("-strategy")) {
          assert.equal(input.agentId, "lead-agent");
          assert.ok(input.message.includes(research));
          return strategy;
        }
        if (input.scope.endsWith("-proposal")) {
          assert.ok(input.message.includes(strategy));
          assert.ok(input.message.includes(research));
          return `FINANCE_PROPOSAL: ${JSON.stringify({ decision: "PROPOSE", symbol: "AAPL", side: "BUY", quantity: 1, thesis, evidence: [{ source: "fixture://AAPL/quote" }] })}`;
        }
        if (input.scope.endsWith("-approval")) {
          const proposal = promptJson(input.message, "Full proposal including thesis: ");
          assert.equal(proposal.thesis, thesis);
          assert.equal(proposal.requestedQuantity, 1);
          assert.equal(proposal.portfolioId, team.portfolioId);
          const evidence = promptJson(input.message, "Stored proposal evidence: ");
          assert.equal(evidence.id, proposal.evidenceManifestId);
          assert.equal(evidence.body.marketData[0].source, "fixture://AAPL/quote");
          assert.ok(input.message.includes(strategy));
          assert.ok(input.message.includes(research));
          const quote = promptJson(input.message, "Current source-stamped quote: ");
          assert.equal(quote.data.price, 100);
          assert.equal(quote.source, "fixture://AAPL/quote");
          const risk = promptJson(input.message, "Indicative deterministic sizing check (execution rechecks limits and costs): ");
          assert.equal(risk.status, "APPROVED");
          assert.equal(risk.snapshot.portfolio.cash, 100_000);
          return 'FINANCE_REVIEW: {"decision":"APPROVE","reason":"Evidence supports this small position."}';
        }
        return 'FINANCE_SUBMISSION: {"decision":"SUBMIT"}';
      },
      async abortTurn() {},
    };
    const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
    coordinator.start(team.id);
    const state = await coordinator.waitForTeam(team.id);
    assert.equal(state.phase, "COMPLETED");
    assert.equal(seen.length, 5);
    assert.equal(service.listTrades(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 1);
    const proposal = service.store.getProposal(state.proposalId);
    const evidence = service.store.getEvidenceManifest(proposal.evidenceManifestId);
    assert.equal(evidence.body.marketData[0].source, "fixture://AAPL/quote");
  });
}

for (const viaTool of [false, true]) {
  test(`explicit lead rejection via ${viaTool ? "tool" : "coordinator"} preserves the blocker in dashboard and audit`, async (t) => {
  const { service, team, actors } = await setup();
  t.after(() => service.close());
  const reason = "The primary filing contradicts the claimed catalyst; verify the earnings figure before reconsidering.";
  const runtime = {
    async runTurn(input) {
      if (input.scope.endsWith("-research")) return "Consider AAPL with conflicting earnings evidence.";
      if (input.scope.endsWith("-strategy")) return "Draft only if the earnings evidence can be verified.";
      if (input.scope.endsWith("-proposal")) return 'FINANCE_PROPOSAL: {"decision":"PROPOSE","symbol":"AAPL","side":"BUY","quantity":1,"thesis":"An earnings catalyst."}';
      if (input.scope.endsWith("-approval")) {
        if (viaTool) {
          const proposal = service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId })[0];
          await service.rejectTradeProposal(actors.lead, proposal.id);
        }
        return `FINANCE_REVIEW: ${JSON.stringify({ decision: "REJECT", reason })}`;
      }
      throw new Error("Rejected proposal must not reach submission");
    },
    async abortTurn() {},
  };
  const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
  coordinator.start(team.id);
  const state = await coordinator.waitForTeam(team.id);
  assert.equal(state.phase, "REJECTED");
  assert.ok(state.message.includes(reason));
  assert.equal(service.listTrades(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 0);
  const audit = service.store.listAudit().find((entry) => entry.action === "finance.team.trading.complete");
  assert.equal(audit.payload.teamId, team.id);
  assert.equal(audit.payload.phase, "REJECTED");
  assert.ok(audit.payload.reason.includes(reason));
});
}

function promptJson(message, prefix) {
  const line = message.split("\n").find((line) => line.startsWith(prefix));
  assert.ok(line, `Missing handoff field: ${prefix}`);
  return JSON.parse(line.slice(prefix.length));
}


for (const viaTool of [false, true]) {
  test(`paper execution via ${viaTool ? "tool" : "coordinator"} reports the held-position risk blocker`, async (t) => {
  const { service, team, actors } = await setup({ name: "Bearish Test Team", disposition: "(Bearish)" });
  t.after(() => service.close());
  const runtime = {
    async runTurn(input) {
      if (input.scope.endsWith("-research")) return "Synthetic bearish evidence for AAPL.";
      if (input.scope.endsWith("-strategy")) return "Consider selling AAPL.";
      if (input.scope.endsWith("-proposal")) return 'FINANCE_PROPOSAL: {"decision":"PROPOSE","symbol":"AAPL","side":"SELL","quantity":1,"thesis":"Synthetic downside thesis."}';
      if (input.scope.endsWith("-approval")) return 'FINANCE_REVIEW: {"decision":"APPROVE","reason":"Synthetic approval."}';
      if (viaTool) {
        const proposal = service.listProposals(OPERATOR_ACTOR, { portfolioId: team.portfolioId })[0];
        await service.executePaperTrade(actors.trader, proposal.id);
      }
      return 'FINANCE_SUBMISSION: {"decision":"SUBMIT"}';
    },
    async abortTurn() {},
  };
  const coordinator = new TeamTradingCoordinator({ service, agentRuntime: runtime });
  coordinator.start(team.id);
  const state = await coordinator.waitForTeam(team.id);
  assert.equal(state.phase, "REJECTED");
  assert.match(state.message, /No position is available to sell/);
  assert.equal(service.listTrades(OPERATOR_ACTOR, { portfolioId: team.portfolioId }).length, 0);
  assert.equal(service.store.getProposal(state.proposalId).status, "REJECTED");
});
}
