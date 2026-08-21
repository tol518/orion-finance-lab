import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { FinanceError } from "../api/validation.js";

const DEFAULT_PORTFOLIO_ID = "paper-main";

export class FinanceStore {
  constructor({ filename = ":memory:" } = {}) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  close() {
    this.db.close();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode = 'paper'),
        currency TEXT NOT NULL,
        initial_cash_cents INTEGER NOT NULL CHECK (initial_cash_cents >= 0),
        cash_cents INTEGER NOT NULL CHECK (cash_cents >= 0),
        agent_id TEXT,
        strategy_id TEXT,
        experiment_id TEXT,
        benchmark_symbol TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL CHECK (quantity >= 0),
        average_cost_cents INTEGER NOT NULL CHECK (average_cost_cents >= 0),
        realised_pnl_cents INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (portfolio_id, symbol)
      );

      CREATE TABLE IF NOT EXISTS trade_proposals (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
        agent_id TEXT NOT NULL,
        strategy_id TEXT,
        experiment_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        requested_quantity REAL NOT NULL CHECK (requested_quantity > 0),
        thesis TEXT,
        evidence_manifest_id TEXT,
        status TEXT NOT NULL,
        approved_quantity REAL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS risk_events (
        id TEXT PRIMARY KEY,
        proposal_id TEXT REFERENCES trade_proposals(id),
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_quantity REAL NOT NULL,
        approved_quantity REAL NOT NULL,
        reasons_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES trade_proposals(id),
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
        agent_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        quantity REAL NOT NULL CHECK (quantity > 0),
        price_cents INTEGER NOT NULL CHECK (price_cents > 0),
        fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
        agent_id TEXT NOT NULL,
        strategy_id TEXT,
        experiment_id TEXT,
        decision_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        quantity REAL NOT NULL CHECK (quantity > 0),
        price_cents INTEGER NOT NULL CHECK (price_cents > 0),
        fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
        slippage_bps REAL NOT NULL,
        evidence_manifest_id TEXT,
        executed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS predictions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        strategy_id TEXT,
        experiment_id TEXT,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('BULLISH', 'BEARISH', 'NEUTRAL')),
        expected_return_min REAL NOT NULL,
        expected_return_max REAL NOT NULL,
        horizon_days INTEGER NOT NULL CHECK (horizon_days > 0),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        thesis TEXT NOT NULL,
        invalidation_json TEXT NOT NULL,
        benchmark_symbol TEXT NOT NULL,
        start_price REAL,
        evidence_manifest_id TEXT,
        created_at TEXT NOT NULL,
        due_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prediction_results (
        id TEXT PRIMARY KEY,
        prediction_id TEXT NOT NULL UNIQUE REFERENCES predictions(id),
        end_price REAL NOT NULL,
        actual_return REAL NOT NULL,
        benchmark_return REAL,
        alpha REAL,
        direction_correct INTEGER NOT NULL,
        range_correct INTEGER NOT NULL,
        evaluated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence_manifests (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        strategy_id TEXT,
        symbol TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS evidence_manifests_no_update
      BEFORE UPDATE ON evidence_manifests BEGIN SELECT RAISE(ABORT, 'evidence manifests are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS evidence_manifests_no_delete
      BEFORE DELETE ON evidence_manifests BEGIN SELECT RAISE(ABORT, 'evidence manifests are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS predictions_no_update
      BEFORE UPDATE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS predictions_no_delete
      BEFORE DELETE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are append-only'); END;

      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED')),
        strategy_id TEXT NOT NULL,
        agent_id TEXT,
        portfolio_id TEXT NOT NULL UNIQUE REFERENCES portfolios(id),
        benchmark_symbol TEXT NOT NULL,
        initial_capital_cents INTEGER NOT NULL,
        risk_rules_json TEXT NOT NULL,
        fee_assumptions_json TEXT NOT NULL,
        model_config_json TEXT NOT NULL,
        provider_config_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS finance_agents (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT,
        assigned_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_team_members (
        team_id TEXT NOT NULL REFERENCES finance_teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES finance_agents(agent_id) ON DELETE CASCADE,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (team_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS market_data_metadata (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        source TEXT NOT NULL,
        symbol TEXT NOT NULL,
        requested_range_json TEXT,
        actual_range_json TEXT,
        retrieved_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_valuations (
        id TEXT PRIMARY KEY,
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        total_value_cents INTEGER NOT NULL,
        opening_value_cents INTEGER NOT NULL,
        high_value_cents INTEGER NOT NULL,
        cash_cents INTEGER NOT NULL,
        gross_exposure_cents INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor_id TEXT,
        agent_id TEXT,
        strategy_id TEXT,
        experiment_id TEXT,
        portfolio_id TEXT,
        decision_id TEXT,
        prediction_id TEXT,
        success INTEGER NOT NULL,
        latency_ms INTEGER,
        model TEXT,
        token_usage INTEGER,
        estimated_cost REAL,
        payload_json TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS trades_portfolio_time ON trades(portfolio_id, executed_at DESC);
      CREATE INDEX IF NOT EXISTS predictions_agent_time ON predictions(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS predictions_due ON predictions(due_at);
      CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS valuations_portfolio_time ON portfolio_valuations(portfolio_id, recorded_at);
    `);
    const valuationColumns = new Set(
      this.db.prepare("PRAGMA table_info(portfolio_valuations)").all().map((column) => column.name),
    );
    if (!valuationColumns.has("opening_value_cents")) {
      this.db.exec("ALTER TABLE portfolio_valuations ADD COLUMN opening_value_cents INTEGER");
      this.db.exec("UPDATE portfolio_valuations SET opening_value_cents = total_value_cents");
    }
    if (!valuationColumns.has("high_value_cents")) {
      this.db.exec("ALTER TABLE portfolio_valuations ADD COLUMN high_value_cents INTEGER");
      this.db.exec("UPDATE portfolio_valuations SET high_value_cents = total_value_cents");
    }
  }

  ensureDefaultPortfolio() {
    const existing = this.getPortfolio(DEFAULT_PORTFOLIO_ID);
    if (existing) return existing;
    return this.createPortfolio({
      id: DEFAULT_PORTFOLIO_ID,
      name: "Main Paper Portfolio",
      initialCapital: 100_000,
      benchmarkSymbol: "^GSPC",
    });
  }

  createPortfolio({
    id = randomUUID(),
    name,
    initialCapital,
    currency = "USD",
    agentId = null,
    strategyId = null,
    experimentId = null,
    benchmarkSymbol = "^GSPC",
  }) {
    const now = new Date().toISOString();
    const cents = toCents(initialCapital);
    this.db.prepare(`
      INSERT INTO portfolios (
        id, name, mode, currency, initial_cash_cents, cash_cents, agent_id, strategy_id,
        experiment_id, benchmark_symbol, created_at, updated_at
      ) VALUES (?, ?, 'paper', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, currency, cents, cents, agentId, strategyId, experimentId, benchmarkSymbol, now, now);
    return this.getPortfolio(id);
  }

  getPortfolio(id) {
    const row = this.db.prepare("SELECT * FROM portfolios WHERE id = ?").get(id);
    return row ? mapPortfolio(row) : null;
  }

  listPortfolios() {
    return this.db.prepare("SELECT * FROM portfolios ORDER BY created_at").all().map(mapPortfolio);
  }

  listPositions(portfolioId) {
    return this.db.prepare("SELECT * FROM positions WHERE portfolio_id = ? ORDER BY symbol").all(portfolioId).map(mapPosition);
  }

  recordValuation({ portfolioId, totalValue, cash, grossExposure }) {
    const recordedAt = new Date().toISOString();
    const latest = this.db.prepare(`
      SELECT id, recorded_at, high_value_cents FROM portfolio_valuations
      WHERE portfolio_id = ? ORDER BY recorded_at DESC LIMIT 1
    `).get(portfolioId);
    if (latest?.recorded_at.slice(0, 10) === recordedAt.slice(0, 10)) {
      this.db.prepare(`
        UPDATE portfolio_valuations
        SET total_value_cents = ?, high_value_cents = ?, cash_cents = ?, gross_exposure_cents = ?, recorded_at = ?
        WHERE id = ?
      `).run(
        toCents(totalValue),
        Math.max(Number(latest.high_value_cents), toCents(totalValue)),
        toCents(cash),
        toCents(grossExposure),
        recordedAt,
        latest.id,
      );
      return { id: latest.id, portfolioId, totalValue, cash, grossExposure, recordedAt };
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO portfolio_valuations (
        id, portfolio_id, total_value_cents, opening_value_cents, high_value_cents,
        cash_cents, gross_exposure_cents, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      portfolioId,
      toCents(totalValue),
      toCents(totalValue),
      toCents(totalValue),
      toCents(cash),
      toCents(grossExposure),
      recordedAt,
    );
    return { id, portfolioId, totalValue, cash, grossExposure, recordedAt };
  }

  listValuations(portfolioId, { limit = 2000 } = {}) {
    return this.db.prepare(`
      SELECT * FROM portfolio_valuations WHERE portfolio_id = ? ORDER BY recorded_at DESC LIMIT ?
    `).all(portfolioId, limit).reverse().map((row) => ({
      id: row.id,
      portfolioId: row.portfolio_id,
      totalValue: fromCents(row.total_value_cents),
      openingValue: fromCents(row.opening_value_cents ?? row.total_value_cents),
      highValue: fromCents(row.high_value_cents ?? row.total_value_cents),
      cash: fromCents(row.cash_cents),
      grossExposure: fromCents(row.gross_exposure_cents),
      recordedAt: row.recorded_at,
    }));
  }

  getPosition(portfolioId, symbol) {
    const row = this.db.prepare("SELECT * FROM positions WHERE portfolio_id = ? AND symbol = ?").get(portfolioId, symbol);
    return row ? mapPosition(row) : null;
  }

  createProposal(input) {
    const id = randomUUID();
    const decisionId = input.decisionId ?? `FIN-${randomUUID().slice(0, 8).toUpperCase()}`;
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO trade_proposals (
        id, decision_id, portfolio_id, agent_id, strategy_id, experiment_id, symbol, side,
        requested_quantity, thesis, evidence_manifest_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?)
    `).run(
      id,
      decisionId,
      input.portfolioId,
      input.agentId,
      input.strategyId ?? null,
      input.experimentId ?? null,
      input.symbol,
      input.side,
      input.quantity,
      input.thesis ?? null,
      input.evidenceManifestId ?? null,
      createdAt,
    );
    return this.getProposal(id);
  }

  getProposal(id) {
    const row = this.db.prepare("SELECT * FROM trade_proposals WHERE id = ?").get(id);
    return row ? mapProposal(row) : null;
  }

  listProposals({ portfolioId, agentId, limit = 50 } = {}) {
    const filters = [];
    const values = [];
    if (portfolioId) { filters.push("portfolio_id = ?"); values.push(portfolioId); }
    if (agentId) { filters.push("agent_id = ?"); values.push(agentId); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM trade_proposals ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit);
    return rows.map(mapProposal);
  }

  applyPaperDecision({ proposal, decision, quotePrice, feeCents, slippageBps }) {
    if (proposal.status !== "PROPOSED") {
      throw new FinanceError("Trade proposal has already been resolved", {
        code: "PROPOSAL_ALREADY_RESOLVED",
        status: 409,
      });
    }
    const now = new Date().toISOString();
    const riskEventId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO risk_events (
          id, proposal_id, portfolio_id, agent_id, status, requested_quantity,
          approved_quantity, reasons_json, policy_json, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        riskEventId,
        proposal.id,
        proposal.portfolioId,
        proposal.agentId,
        decision.status,
        proposal.requestedQuantity,
        decision.approvedQuantity,
        JSON.stringify(decision.reasons),
        JSON.stringify(decision.policy),
        JSON.stringify(decision.snapshot),
        now,
      );

      if (decision.status === "REJECTED" || decision.approvedQuantity <= 0) {
        this.db.prepare(`
          UPDATE trade_proposals SET status = 'REJECTED', approved_quantity = 0, resolved_at = ? WHERE id = ?
        `).run(now, proposal.id);
        this.db.exec("COMMIT");
        return { proposal: this.getProposal(proposal.id), riskEventId, order: null, trade: null };
      }

      const portfolioRow = this.db.prepare("SELECT * FROM portfolios WHERE id = ?").get(proposal.portfolioId);
      if (!portfolioRow) throw new FinanceError("Portfolio not found", { code: "PORTFOLIO_NOT_FOUND", status: 404 });
      const positionRow = this.db.prepare(
        "SELECT * FROM positions WHERE portfolio_id = ? AND symbol = ?",
      ).get(proposal.portfolioId, proposal.symbol);
      const quantity = decision.approvedQuantity;
      const executionPrice = proposal.side === "BUY"
        ? quotePrice * (1 + slippageBps / 10_000)
        : quotePrice * (1 - slippageBps / 10_000);
      const priceCents = toCents(executionPrice);
      const notionalCents = Math.round(priceCents * quantity);
      const currentCash = Number(portfolioRow.cash_cents);
      const currentQuantity = Number(positionRow?.quantity ?? 0);
      const currentAverage = Number(positionRow?.average_cost_cents ?? 0);
      let nextCash;
      let nextQuantity;
      let nextAverage;
      let nextRealised = Number(positionRow?.realised_pnl_cents ?? 0);

      if (proposal.side === "BUY") {
        const debit = notionalCents + feeCents;
        if (debit > currentCash) {
          throw new FinanceError("Approved order exceeds available cash", {
            code: "INSUFFICIENT_CASH",
            status: 409,
          });
        }
        nextCash = currentCash - debit;
        nextQuantity = currentQuantity + quantity;
        nextAverage = Math.round((currentQuantity * currentAverage + notionalCents + feeCents) / nextQuantity);
      } else {
        if (quantity > currentQuantity) {
          throw new FinanceError("Approved sell exceeds held quantity", {
            code: "INSUFFICIENT_POSITION",
            status: 409,
          });
        }
        nextCash = currentCash + notionalCents - feeCents;
        nextQuantity = currentQuantity - quantity;
        nextAverage = nextQuantity === 0 ? 0 : currentAverage;
        nextRealised += Math.round((priceCents - currentAverage) * quantity - feeCents);
      }

      this.db.prepare("UPDATE portfolios SET cash_cents = ?, updated_at = ? WHERE id = ?")
        .run(nextCash, now, proposal.portfolioId);
      if (nextQuantity === 0) {
        this.db.prepare("DELETE FROM positions WHERE portfolio_id = ? AND symbol = ?")
          .run(proposal.portfolioId, proposal.symbol);
      } else {
        this.db.prepare(`
          INSERT INTO positions (portfolio_id, symbol, quantity, average_cost_cents, realised_pnl_cents, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(portfolio_id, symbol) DO UPDATE SET
            quantity = excluded.quantity,
            average_cost_cents = excluded.average_cost_cents,
            realised_pnl_cents = excluded.realised_pnl_cents,
            updated_at = excluded.updated_at
        `).run(proposal.portfolioId, proposal.symbol, nextQuantity, nextAverage, nextRealised, now);
      }

      const orderId = randomUUID();
      const tradeId = randomUUID();
      this.db.prepare(`
        INSERT INTO orders (id, proposal_id, portfolio_id, agent_id, symbol, side, quantity, price_cents, fee_cents, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FILLED', ?)
      `).run(
        orderId,
        proposal.id,
        proposal.portfolioId,
        proposal.agentId,
        proposal.symbol,
        proposal.side,
        quantity,
        priceCents,
        feeCents,
        now,
      );
      this.db.prepare(`
        INSERT INTO trades (
          id, order_id, portfolio_id, agent_id, strategy_id, experiment_id, decision_id,
          symbol, side, quantity, price_cents, fee_cents, slippage_bps, evidence_manifest_id, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tradeId,
        orderId,
        proposal.portfolioId,
        proposal.agentId,
        proposal.strategyId,
        proposal.experimentId,
        proposal.decisionId,
        proposal.symbol,
        proposal.side,
        quantity,
        priceCents,
        feeCents,
        slippageBps,
        proposal.evidenceManifestId,
        now,
      );
      this.db.prepare(`
        UPDATE trade_proposals SET status = ?, approved_quantity = ?, resolved_at = ? WHERE id = ?
      `).run(decision.status, quantity, now, proposal.id);
      this.db.exec("COMMIT");
      return {
        proposal: this.getProposal(proposal.id),
        riskEventId,
        order: this.getOrder(orderId),
        trade: this.getTrade(tradeId),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getOrder(id) {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    return row ? mapOrder(row) : null;
  }

  getTrade(id) {
    const row = this.db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
    return row ? mapTrade(row) : null;
  }

  listTrades({ portfolioId, agentId, strategyId, limit = 100 } = {}) {
    const filters = [];
    const values = [];
    if (portfolioId) { filters.push("portfolio_id = ?"); values.push(portfolioId); }
    if (agentId) { filters.push("agent_id = ?"); values.push(agentId); }
    if (strategyId) { filters.push("strategy_id = ?"); values.push(strategyId); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM trades ${where} ORDER BY executed_at DESC LIMIT ?`)
      .all(...values, limit).map(mapTrade);
  }

  recordPrediction(input) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const dueAt = new Date(new Date(createdAt).getTime() + input.horizonDays * 86_400_000).toISOString();
    this.db.prepare(`
      INSERT INTO predictions (
        id, agent_id, strategy_id, experiment_id, symbol, direction, expected_return_min,
        expected_return_max, horizon_days, confidence, thesis, invalidation_json,
        benchmark_symbol, start_price, evidence_manifest_id, created_at, due_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.agentId,
      input.strategyId ?? null,
      input.experimentId ?? null,
      input.symbol,
      input.direction,
      input.expectedReturnMin,
      input.expectedReturnMax,
      input.horizonDays,
      input.confidence,
      input.thesis,
      JSON.stringify(input.invalidationConditions),
      input.benchmarkSymbol,
      input.startPrice ?? null,
      input.evidenceManifestId ?? null,
      createdAt,
      dueAt,
    );
    return this.getPrediction(id);
  }

  getPrediction(id) {
    const row = this.db.prepare(`
      SELECT p.*, r.id AS result_id, r.end_price, r.actual_return, r.benchmark_return,
             r.alpha, r.direction_correct, r.range_correct, r.evaluated_at
      FROM predictions p LEFT JOIN prediction_results r ON r.prediction_id = p.id
      WHERE p.id = ?
    `).get(id);
    return row ? mapPrediction(row) : null;
  }

  listPredictions({ agentId, status, limit = 100 } = {}) {
    const filters = [];
    const values = [];
    if (agentId) { filters.push("p.agent_id = ?"); values.push(agentId); }
    if (status === "pending") filters.push("r.id IS NULL");
    if (status === "evaluated") filters.push("r.id IS NOT NULL");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT p.*, r.id AS result_id, r.end_price, r.actual_return, r.benchmark_return,
             r.alpha, r.direction_correct, r.range_correct, r.evaluated_at
      FROM predictions p LEFT JOIN prediction_results r ON r.prediction_id = p.id
      ${where} ORDER BY p.created_at DESC LIMIT ?
    `).all(...values, limit).map(mapPrediction);
  }

  listAgentIds() {
    return this.db.prepare(`
      SELECT agent_id FROM predictions
      UNION SELECT agent_id FROM trades
      ORDER BY agent_id
    `).all().map((row) => row.agent_id).filter(Boolean);
  }

  assignFinanceAgent({ agentId, displayName, role = null }) {
    const assignedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO finance_agents (agent_id, display_name, role, assigned_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role
    `).run(agentId, displayName, role, assignedAt);
    return this.getFinanceAgent(agentId);
  }

  getFinanceAgent(agentId) {
    const row = this.db.prepare("SELECT * FROM finance_agents WHERE agent_id = ?").get(agentId);
    return row ? mapFinanceAgent(row) : null;
  }

  listFinanceAgents() {
    return this.db.prepare("SELECT * FROM finance_agents ORDER BY assigned_at, agent_id").all().map(mapFinanceAgent);
  }

  removeFinanceAgent(agentId) {
    const membership = this.db.prepare(
      "SELECT 1 FROM finance_team_members WHERE agent_id = ? LIMIT 1",
    ).get(agentId);
    if (membership) {
      throw new FinanceError("Remove the agent from its Finance team before deleting the assignment", {
        code: "FINANCE_AGENT_IN_TEAM",
        status: 409,
      });
    }
    return this.db.prepare("DELETE FROM finance_agents WHERE agent_id = ?").run(agentId).changes > 0;
  }

  createFinanceTeam({ name, agentIds }) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO finance_teams (id, name, created_at) VALUES (?, ?, ?)").run(id, name, createdAt);
      const insertMember = this.db.prepare(`
        INSERT INTO finance_team_members (team_id, agent_id, assigned_at) VALUES (?, ?, ?)
      `);
      for (const agentId of agentIds) insertMember.run(id, agentId, createdAt);
      this.db.exec("COMMIT");
      return this.getFinanceTeam(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getFinanceTeam(id) {
    const row = this.db.prepare("SELECT * FROM finance_teams WHERE id = ?").get(id);
    if (!row) return null;
    return mapFinanceTeam(row, this.listFinanceTeamMembers(id));
  }

  listFinanceTeams() {
    const teams = this.db.prepare("SELECT * FROM finance_teams ORDER BY created_at, name").all();
    return teams.map((team) => mapFinanceTeam(team, this.listFinanceTeamMembers(team.id)));
  }

  removeFinanceTeam(id) {
    return this.db.prepare("DELETE FROM finance_teams WHERE id = ?").run(id).changes > 0;
  }

  listFinanceTeamMembers(teamId) {
    return this.db.prepare(`
      SELECT a.* FROM finance_team_members m
      JOIN finance_agents a ON a.agent_id = m.agent_id
      WHERE m.team_id = ? ORDER BY m.assigned_at, a.agent_id
    `).all(teamId).map(mapFinanceAgent);
  }

  listDuePredictions(at = new Date().toISOString()) {
    return this.db.prepare(`
      SELECT p.* FROM predictions p
      LEFT JOIN prediction_results r ON r.prediction_id = p.id
      WHERE r.id IS NULL AND p.due_at <= ? ORDER BY p.due_at
    `).all(at).map(mapPrediction);
  }

  recordPredictionResult(input) {
    const id = randomUUID();
    const evaluatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO prediction_results (
        id, prediction_id, end_price, actual_return, benchmark_return, alpha,
        direction_correct, range_correct, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.predictionId,
      input.endPrice,
      input.actualReturn,
      input.benchmarkReturn ?? null,
      input.alpha ?? null,
      input.directionCorrect ? 1 : 0,
      input.rangeCorrect ? 1 : 0,
      evaluatedAt,
    );
    return this.getPrediction(input.predictionId);
  }

  createEvidenceManifest(input) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO evidence_manifests (id, decision_id, agent_id, strategy_id, symbol, body_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.decisionId, input.agentId, input.strategyId ?? null, input.symbol, JSON.stringify(input.body), createdAt);
    return this.getEvidenceManifest(id);
  }

  getEvidenceManifest(id) {
    const row = this.db.prepare("SELECT * FROM evidence_manifests WHERE id = ?").get(id);
    return row ? {
      id: row.id,
      decisionId: row.decision_id,
      agentId: row.agent_id,
      strategyId: row.strategy_id,
      symbol: row.symbol,
      body: parseJson(row.body_json, {}),
      createdAt: row.created_at,
    } : null;
  }

  createExperiment(input) {
    const id = randomUUID();
    const portfolioId = randomUUID();
    const startedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.createPortfolio({
        id: portfolioId,
        name: `${input.name} Portfolio`,
        initialCapital: input.initialCapital,
        agentId: input.agentId,
        strategyId: input.strategyId,
        experimentId: id,
        benchmarkSymbol: input.benchmarkSymbol,
      });
      this.db.prepare(`
        INSERT INTO experiments (
          id, name, status, strategy_id, agent_id, portfolio_id, benchmark_symbol,
          initial_capital_cents, risk_rules_json, fee_assumptions_json, model_config_json,
          provider_config_json, started_at
        ) VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.name,
        input.strategyId,
        input.agentId ?? null,
        portfolioId,
        input.benchmarkSymbol,
        toCents(input.initialCapital),
        JSON.stringify(input.riskRules),
        JSON.stringify(input.feeAssumptions),
        JSON.stringify(input.modelConfig),
        JSON.stringify(input.providerConfig),
        startedAt,
      );
      this.db.exec("COMMIT");
      return this.getExperiment(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getExperiment(id) {
    const row = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id);
    return row ? mapExperiment(row) : null;
  }

  listExperiments() {
    return this.db.prepare("SELECT * FROM experiments ORDER BY started_at DESC").all().map(mapExperiment);
  }

  recordMarketMetadata(envelope) {
    this.db.prepare(`
      INSERT INTO market_data_metadata (
        id, provider, source, symbol, requested_range_json, actual_range_json, retrieved_at, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      envelope.provider,
      envelope.source,
      envelope.symbol,
      envelope.requestedRange ? JSON.stringify(envelope.requestedRange) : null,
      envelope.actualRange ? JSON.stringify(envelope.actualRange) : null,
      envelope.retrievedAt,
      new Date().toISOString(),
    );
  }

  recordAudit(input) {
    this.db.prepare(`
      INSERT INTO audit_log (
        id, action, actor_id, agent_id, strategy_id, experiment_id, portfolio_id,
        decision_id, prediction_id, success, latency_ms, model, token_usage,
        estimated_cost, payload_json, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.action,
      input.actorId ?? null,
      input.agentId ?? null,
      input.strategyId ?? null,
      input.experimentId ?? null,
      input.portfolioId ?? null,
      input.decisionId ?? null,
      input.predictionId ?? null,
      input.success === false ? 0 : 1,
      input.latencyMs ?? null,
      input.model ?? null,
      input.tokenUsage ?? null,
      input.estimatedCost ?? null,
      JSON.stringify(input.payload ?? {}),
      input.errorCode ?? null,
      new Date().toISOString(),
    );
  }

  listAudit({ limit = 100 } = {}) {
    return this.db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").all(limit).map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actor_id,
      agentId: row.agent_id,
      strategyId: row.strategy_id,
      experimentId: row.experiment_id,
      portfolioId: row.portfolio_id,
      decisionId: row.decision_id,
      predictionId: row.prediction_id,
      success: Boolean(row.success),
      latencyMs: row.latency_ms,
      model: row.model,
      tokenUsage: row.token_usage,
      estimatedCost: row.estimated_cost,
      payload: parseJson(row.payload_json, {}),
      errorCode: row.error_code,
      createdAt: row.created_at,
    }));
  }
}

function toCents(value) {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new FinanceError("Money value is invalid", { code: "INVALID_MONEY" });
  return cents;
}

function fromCents(value) {
  return Number(value) / 100;
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function mapPortfolio(row) {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    currency: row.currency,
    initialCash: fromCents(row.initial_cash_cents),
    cash: fromCents(row.cash_cents),
    agentId: row.agent_id,
    strategyId: row.strategy_id,
    experimentId: row.experiment_id,
    benchmarkSymbol: row.benchmark_symbol,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPosition(row) {
  return {
    portfolioId: row.portfolio_id,
    symbol: row.symbol,
    quantity: Number(row.quantity),
    averageCost: fromCents(row.average_cost_cents),
    realisedPnl: fromCents(row.realised_pnl_cents),
    updatedAt: row.updated_at,
  };
}

function mapProposal(row) {
  return {
    id: row.id,
    decisionId: row.decision_id,
    portfolioId: row.portfolio_id,
    agentId: row.agent_id,
    strategyId: row.strategy_id,
    experimentId: row.experiment_id,
    symbol: row.symbol,
    side: row.side,
    requestedQuantity: Number(row.requested_quantity),
    thesis: row.thesis,
    evidenceManifestId: row.evidence_manifest_id,
    status: row.status,
    approvedQuantity: row.approved_quantity === null ? null : Number(row.approved_quantity),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapOrder(row) {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    portfolioId: row.portfolio_id,
    agentId: row.agent_id,
    symbol: row.symbol,
    side: row.side,
    quantity: Number(row.quantity),
    price: fromCents(row.price_cents),
    fee: fromCents(row.fee_cents),
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapTrade(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    portfolioId: row.portfolio_id,
    agentId: row.agent_id,
    strategyId: row.strategy_id,
    experimentId: row.experiment_id,
    decisionId: row.decision_id,
    symbol: row.symbol,
    side: row.side,
    quantity: Number(row.quantity),
    price: fromCents(row.price_cents),
    fee: fromCents(row.fee_cents),
    slippageBps: Number(row.slippage_bps),
    evidenceManifestId: row.evidence_manifest_id,
    executedAt: row.executed_at,
  };
}

function mapPrediction(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    strategyId: row.strategy_id,
    experimentId: row.experiment_id,
    symbol: row.symbol,
    direction: row.direction,
    expectedReturnMin: Number(row.expected_return_min),
    expectedReturnMax: Number(row.expected_return_max),
    horizonDays: Number(row.horizon_days),
    confidence: Number(row.confidence),
    thesis: row.thesis,
    invalidationConditions: parseJson(row.invalidation_json, []),
    benchmarkSymbol: row.benchmark_symbol,
    startPrice: row.start_price === null ? null : Number(row.start_price),
    evidenceManifestId: row.evidence_manifest_id,
    createdAt: row.created_at,
    dueAt: row.due_at,
    result: row.result_id ? {
      id: row.result_id,
      endPrice: Number(row.end_price),
      actualReturn: Number(row.actual_return),
      benchmarkReturn: row.benchmark_return === null ? null : Number(row.benchmark_return),
      alpha: row.alpha === null ? null : Number(row.alpha),
      directionCorrect: Boolean(row.direction_correct),
      rangeCorrect: Boolean(row.range_correct),
      evaluatedAt: row.evaluated_at,
    } : null,
  };
}

function mapExperiment(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    strategyId: row.strategy_id,
    agentId: row.agent_id,
    portfolioId: row.portfolio_id,
    benchmarkSymbol: row.benchmark_symbol,
    initialCapital: fromCents(row.initial_capital_cents),
    riskRules: parseJson(row.risk_rules_json, {}),
    feeAssumptions: parseJson(row.fee_assumptions_json, {}),
    modelConfig: parseJson(row.model_config_json, {}),
    providerConfig: parseJson(row.provider_config_json, {}),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapFinanceAgent(row) {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    role: row.role,
    assignedAt: row.assigned_at,
  };
}

function mapFinanceTeam(row, members) {
  return {
    id: row.id,
    name: row.name,
    members,
    createdAt: row.created_at,
  };
}
