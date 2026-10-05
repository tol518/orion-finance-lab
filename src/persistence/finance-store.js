import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { FinanceError } from "../api/validation.js";

const DEFAULT_PORTFOLIO_ID = "paper-main";
// IBKR will send nothing further about an order in one of these states, so a settlement
// pass may stop waiting for a fill that is never coming.
const TERMINAL_BROKER_STATUS = new Set(["Filled", "Cancelled", "ApiCancelled", "Inactive"]);
const EXECUTABLE_PROPOSAL_STATUS = new Set(["PROPOSED", "LEAD_APPROVED", "SUBMITTING"]);
const TEAM_PORTFOLIO_INITIAL_CAPITAL = 100_000;

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
        lead_approved_by_agent_id TEXT,
        lead_approved_at TEXT,
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
        -- Hierarchy position inside the team. Rank 1 is the team lead; ranks stay
        -- contiguous so removing the lead promotes the next member automatically.
        team_rank INTEGER NOT NULL DEFAULT 0,
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

      -- A broker order has a lifecycle the paper ledger does not: it can rest unfilled at
      -- IBKR for minutes. It is booked into orders/trades only once quantity, price and fee
      -- are all known, and order_id is the link proving that happened exactly once.
      CREATE TABLE IF NOT EXISTS broker_orders (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES trade_proposals(id),
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
        agent_id TEXT NOT NULL,
        broker TEXT NOT NULL,
        broker_order_id TEXT,
        client_order_id INTEGER,
        account_masked TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        quantity REAL NOT NULL CHECK (quantity > 0),
        order_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('WORKING', 'FILLED', 'CANCELLED')),
        broker_status TEXT,
        filled_quantity REAL NOT NULL DEFAULT 0,
        average_fill_price_cents INTEGER,
        fee_cents INTEGER,
        order_id TEXT UNIQUE REFERENCES orders(id),
        execution_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Two proposals must never claim the same IBKR order, so reconciliation cannot
      -- double-book a fill onto the ledger.
      CREATE UNIQUE INDEX IF NOT EXISTS broker_orders_broker_order_id
        ON broker_orders(broker_order_id) WHERE broker_order_id IS NOT NULL;

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

      -- Lessons are distilled from a graded proposal (its linked prediction), so each one
      -- names the outcome it came from and stays auditable after the team is removed.
      CREATE TABLE IF NOT EXISTS team_lessons (
        id TEXT PRIMARY KEY,
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
        proposal_id TEXT NOT NULL UNIQUE REFERENCES trade_proposals(id),
        author_agent_id TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        better_approach TEXT NOT NULL,
        avoid TEXT NOT NULL,
        verify TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT,
        retired_reason TEXT,
        memory_synced_at TEXT
      );

      -- Which lessons each proposal's cycle was shown; scoring compares decisions made
      -- with a lesson against the team's decisions made without it.
      CREATE TABLE IF NOT EXISTS proposal_lessons (
        proposal_id TEXT NOT NULL REFERENCES trade_proposals(id),
        lesson_id TEXT NOT NULL REFERENCES team_lessons(id),
        PRIMARY KEY (proposal_id, lesson_id)
      );

      CREATE INDEX IF NOT EXISTS team_lessons_portfolio_time ON team_lessons(portfolio_id, created_at DESC);
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
    const teamColumns = new Set(
      this.db.prepare("PRAGMA table_info(finance_teams)").all().map((column) => column.name),
    );
    if (!teamColumns.has("portfolio_id")) {
      this.db.exec("ALTER TABLE finance_teams ADD COLUMN portfolio_id TEXT REFERENCES portfolios(id)");
    }
    const memberColumns = new Set(
      this.db.prepare("PRAGMA table_info(finance_team_members)").all().map((column) => column.name),
    );
    if (!memberColumns.has("team_rank")) {
      this.db.exec("ALTER TABLE finance_team_members ADD COLUMN team_rank INTEGER NOT NULL DEFAULT 0");
    }
    const proposalColumns = new Set(
      this.db.prepare("PRAGMA table_info(trade_proposals)").all().map((column) => column.name),
    );
    if (!proposalColumns.has("lead_approved_by_agent_id")) {
      this.db.exec("ALTER TABLE trade_proposals ADD COLUMN lead_approved_by_agent_id TEXT");
    }
    if (!proposalColumns.has("lead_approved_at")) {
      this.db.exec("ALTER TABLE trade_proposals ADD COLUMN lead_approved_at TEXT");
    }
    if (!proposalColumns.has("prediction_id")) {
      this.db.exec("ALTER TABLE trade_proposals ADD COLUMN prediction_id TEXT REFERENCES predictions(id)");
    }
    if (!proposalColumns.has("reflected_at")) {
      this.db.exec("ALTER TABLE trade_proposals ADD COLUMN reflected_at TEXT");
    }
    // Rows written before the column existed carry rank 0; assignment order becomes the
    // hierarchy, so the first agent added to each team becomes its lead.
    for (const team of this.db.prepare("SELECT DISTINCT team_id FROM finance_team_members WHERE team_rank < 1").all()) {
      this.#recompactTeamRanks(team.team_id);
    }
  }

  // Ranks are rewritten as a contiguous 1..N sequence in current order, so rank 1 always
  // names exactly one lead and no gap survives a member removal.
  #recompactTeamRanks(teamId) {
    this.#writeTeamRanks(teamId, this.#orderedTeamMemberIds(teamId));
  }

  // Unranked rows sort last so a backfill keeps assignment order for legacy memberships.
  #orderedTeamMemberIds(teamId) {
    return this.db.prepare(`
      SELECT agent_id FROM finance_team_members
      WHERE team_id = ?
      ORDER BY CASE WHEN team_rank < 1 THEN 1 ELSE 0 END, team_rank, assigned_at, agent_id
    `).all(teamId).map((row) => row.agent_id);
  }

  #writeTeamRanks(teamId, agentIds) {
    const update = this.db.prepare("UPDATE finance_team_members SET team_rank = ? WHERE team_id = ? AND agent_id = ?");
    agentIds.forEach((agentId, index) => update.run(index + 1, teamId, agentId));
  }

  // Every finance team owns exactly one paper portfolio. Teams created before the column
  // existed are backfilled here so the dashboard never has to handle a team without one.
  ensureTeamPortfolios() {
    const orphans = this.db
      .prepare("SELECT id, name FROM finance_teams WHERE portfolio_id IS NULL ORDER BY created_at, name")
      .all();
    for (const team of orphans) this.#attachTeamPortfolio(team.id, team.name);
    return this.listFinanceTeams();
  }

  #attachTeamPortfolio(teamId, name) {
    const portfolio = this.createPortfolio({
      name: `${name} Team Portfolio`,
      initialCapital: TEAM_PORTFOLIO_INITIAL_CAPITAL,
    });
    this.db.prepare("UPDATE finance_teams SET portfolio_id = ? WHERE id = ?").run(portfolio.id, teamId);
    return portfolio;
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

  approveProposal({ proposalId, leadAgentId }) {
    const approvedAt = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE trade_proposals
      SET status = 'LEAD_APPROVED', lead_approved_by_agent_id = ?, lead_approved_at = ?
      WHERE id = ? AND status = 'PROPOSED'
    `).run(leadAgentId, approvedAt, proposalId);
    if (result.changes !== 1) {
      throw new FinanceError("Trade proposal is not waiting for team-lead approval", {
        code: "PROPOSAL_NOT_AWAITING_APPROVAL",
        status: 409,
      });
    }
    return this.getProposal(proposalId);
  }

  rejectProposal({ proposalId }) {
    const resolvedAt = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE trade_proposals
      SET status = 'REJECTED', approved_quantity = 0, resolved_at = ?
      WHERE id = ? AND status = 'PROPOSED'
    `).run(resolvedAt, proposalId);
    if (result.changes !== 1) {
      throw new FinanceError("Trade proposal is not waiting for team-lead review", {
        code: "PROPOSAL_NOT_AWAITING_APPROVAL",
        status: 409,
      });
    }
    return this.getProposal(proposalId);
  }

  linkProposalPrediction(proposalId, predictionId) {
    this.db.prepare("UPDATE trade_proposals SET prediction_id = ? WHERE id = ?").run(predictionId, proposalId);
    return this.getProposal(proposalId);
  }

  // A proposal is gradeable once its forecast has a result and the lead has decided it;
  // PROPOSED drafts are still undecided, so there is no decision to learn from yet.
  listUnreflectedGradedProposals(portfolioId, { limit = 3 } = {}) {
    return this.db.prepare(`
      SELECT tp.* FROM trade_proposals tp
      JOIN prediction_results r ON r.prediction_id = tp.prediction_id
      WHERE tp.portfolio_id = ? AND tp.reflected_at IS NULL AND tp.status <> 'PROPOSED'
      ORDER BY r.evaluated_at LIMIT ?
    `).all(portfolioId, limit).map((row) => ({
      ...mapProposal(row),
      prediction: this.getPrediction(row.prediction_id),
    }));
  }

  // Marking the proposal reflected and saving its lesson commit together, so a crash can
  // neither drop a lesson nor make the same outcome produce a second one.
  recordProposalReflection({ proposalId, authorAgentId, lesson = null }) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.db.prepare("SELECT portfolio_id FROM trade_proposals WHERE id = ? AND reflected_at IS NULL").get(proposalId);
      if (proposal && lesson) {
        this.db.prepare(`
          INSERT INTO team_lessons (
            id, portfolio_id, proposal_id, author_agent_id, trigger_text, better_approach, avoid, verify, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), proposal.portfolio_id, proposalId, authorAgentId, lesson.trigger, lesson.betterApproach, lesson.avoid, lesson.verify, now);
      }
      this.db.prepare("UPDATE trade_proposals SET reflected_at = ? WHERE id = ? AND reflected_at IS NULL").run(now, proposalId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listTeamLessons(portfolioId, { limit = 5, includeRetired = false } = {}) {
    return this.db.prepare(`
      SELECT * FROM team_lessons WHERE portfolio_id = ? ${includeRetired ? "" : "AND retired_at IS NULL"}
      ORDER BY created_at DESC LIMIT ?
    `).all(portfolioId, limit).map(mapLesson);
  }

  getTeamLesson(id) {
    const row = this.db.prepare("SELECT * FROM team_lessons WHERE id = ?").get(id);
    return row ? mapLesson(row) : null;
  }

  recordProposalLessons(proposalId, lessonIds) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO proposal_lessons (proposal_id, lesson_id) VALUES (?, ?)");
    for (const lessonId of lessonIds) insert.run(proposalId, lessonId);
  }

  // A decision is correct when a taken trade moved with its forecast, or a declined one
  // moved against it — the same rule reflection uses to pick mistakes.
  listGradedDecisions(portfolioId) {
    const rows = this.db.prepare(`
      SELECT tp.id, CASE WHEN tp.status = 'REJECTED' THEN 1 - r.direction_correct ELSE r.direction_correct END AS correct,
             (SELECT group_concat(pl.lesson_id) FROM proposal_lessons pl WHERE pl.proposal_id = tp.id) AS lesson_ids
      FROM trade_proposals tp JOIN prediction_results r ON r.prediction_id = tp.prediction_id
      WHERE tp.portfolio_id = ? AND tp.status <> 'PROPOSED'
    `).all(portfolioId);
    return rows.map((row) => ({
      proposalId: row.id,
      correct: row.correct === 1,
      lessonIds: row.lesson_ids ? row.lesson_ids.split(",") : [],
    }));
  }

  retireTeamLesson(id, reason) {
    this.db.prepare("UPDATE team_lessons SET retired_at = ?, retired_reason = ? WHERE id = ? AND retired_at IS NULL")
      .run(new Date().toISOString(), reason, id);
    return this.getTeamLesson(id);
  }

  // Active lessons not yet in shared memory, and retired ones still there.
  listLessonsNeedingMemorySync(portfolioId) {
    return this.db.prepare(`
      SELECT * FROM team_lessons WHERE portfolio_id = ?
        AND ((retired_at IS NULL AND memory_synced_at IS NULL) OR (retired_at IS NOT NULL AND memory_synced_at IS NOT NULL))
      ORDER BY created_at
    `).all(portfolioId).map(mapLesson);
  }

  setLessonMemorySynced(id, synced) {
    this.db.prepare("UPDATE team_lessons SET memory_synced_at = ? WHERE id = ?").run(synced ? new Date().toISOString() : null, id);
  }

  claimProposalForBroker({ proposalId, leadAgentId, traderAgentId, decision }) {
    const proposal = this.getProposal(proposalId);
    const riskEventId = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        UPDATE trade_proposals SET status = 'SUBMITTING', approved_quantity = ?
        WHERE id = ? AND status = 'LEAD_APPROVED'
          AND lead_approved_by_agent_id = ? AND agent_id = ?
      `).run(decision.approvedQuantity, proposalId, leadAgentId, traderAgentId);
      if (result.changes !== 1) {
        throw new FinanceError("Trade proposal is no longer ready for broker submission", {
          code: "PROPOSAL_ALREADY_RESOLVED",
          status: 409,
        });
      }
      this.db.prepare(`
        INSERT INTO risk_events (
          id, proposal_id, portfolio_id, agent_id, status, requested_quantity,
          approved_quantity, reasons_json, policy_json, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        riskEventId, proposal.id, proposal.portfolioId, proposal.agentId, decision.status,
        proposal.requestedQuantity, decision.approvedQuantity, JSON.stringify(decision.reasons),
        JSON.stringify(decision.policy), JSON.stringify(decision.snapshot), now,
      );
      this.db.exec("COMMIT");
      return { proposal: this.getProposal(proposalId), riskEventId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseBrokerProposalClaim(proposalId) {
    const proposal = this.getProposal(proposalId);
    const team = proposal ? this.getFinanceTeamByPortfolio(proposal.portfolioId) : null;
    const approvalStillCurrent = team?.leadAgentId === proposal?.leadApprovedByAgentId;
    this.db.prepare(`
      UPDATE trade_proposals SET status = ?, approved_quantity = NULL,
        lead_approved_by_agent_id = ?, lead_approved_at = ?
      WHERE id = ? AND status = 'SUBMITTING'
    `).run(
      approvalStillCurrent ? "LEAD_APPROVED" : "PROPOSED",
      approvalStillCurrent ? proposal.leadApprovedByAgentId : null,
      approvalStillCurrent ? proposal.leadApprovedAt : null,
      proposalId,
    );
    return this.getProposal(proposalId);
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

  listSubmittingProposals({ portfolioId } = {}) {
    const where = portfolioId ? "AND portfolio_id = ?" : "";
    const values = portfolioId ? [portfolioId] : [];
    return this.db.prepare(
      `SELECT * FROM trade_proposals WHERE status = 'SUBMITTING' ${where} ORDER BY created_at`,
    ).all(...values).map(mapProposal);
  }

  getBrokerSubmissionDecision(proposalId) {
    const row = this.db.prepare(`
      SELECT * FROM risk_events WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(proposalId);
    if (!row) return null;
    return {
      riskEventId: row.id,
      status: row.status,
      approvedQuantity: Number(row.approved_quantity),
      reasons: JSON.parse(row.reasons_json),
      policy: JSON.parse(row.policy_json),
      snapshot: JSON.parse(row.snapshot_json),
    };
  }

  getProposalExecutionResult(proposalId) {
    const row = this.db.prepare(`
      SELECT audit.payload_json FROM audit_log AS audit
      JOIN trade_proposals AS proposal ON proposal.decision_id = audit.decision_id
      WHERE proposal.id = ? AND audit.action IN ('trade.execute', 'trade.preview') AND audit.success = 1
      ORDER BY audit.created_at DESC, audit.rowid DESC LIMIT 1
    `).get(proposalId);
    return row ? JSON.parse(row.payload_json).execution ?? null : null;
  }

  // Cash and position movement for one fill. Paper simulation and a real broker fill differ
  // only in where price and fee come from, so both book through this single path; letting
  // them drift would let the two ledgers disagree about the same portfolio.
  #applyFillToLedger({ portfolioId, symbol, side, quantity, priceCents, feeCents, now }) {
    const portfolioRow = this.db.prepare("SELECT * FROM portfolios WHERE id = ?").get(portfolioId);
    if (!portfolioRow) throw new FinanceError("Portfolio not found", { code: "PORTFOLIO_NOT_FOUND", status: 404 });
    const positionRow = this.db.prepare(
      "SELECT * FROM positions WHERE portfolio_id = ? AND symbol = ?",
    ).get(portfolioId, symbol);
    const notionalCents = Math.round(priceCents * quantity);
    const currentCash = Number(portfolioRow.cash_cents);
    const currentQuantity = Number(positionRow?.quantity ?? 0);
    const currentAverage = Number(positionRow?.average_cost_cents ?? 0);
    let nextCash;
    let nextQuantity;
    let nextAverage;
    let nextRealised = Number(positionRow?.realised_pnl_cents ?? 0);

    if (side === "BUY") {
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
      .run(nextCash, now, portfolioId);
    if (nextQuantity === 0) {
      this.db.prepare("DELETE FROM positions WHERE portfolio_id = ? AND symbol = ?").run(portfolioId, symbol);
      return;
    }
    this.db.prepare(`
      INSERT INTO positions (portfolio_id, symbol, quantity, average_cost_cents, realised_pnl_cents, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(portfolio_id, symbol) DO UPDATE SET
        quantity = excluded.quantity,
        average_cost_cents = excluded.average_cost_cents,
        realised_pnl_cents = excluded.realised_pnl_cents,
        updated_at = excluded.updated_at
    `).run(portfolioId, symbol, nextQuantity, nextAverage, nextRealised, now);
  }

  applyPaperDecision({ proposal, decision, quotePrice, feeCents, slippageBps }) {
    if (!EXECUTABLE_PROPOSAL_STATUS.has(proposal.status)) {
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

      const quantity = decision.approvedQuantity;
      const executionPrice = proposal.side === "BUY"
        ? quotePrice * (1 + slippageBps / 10_000)
        : quotePrice * (1 - slippageBps / 10_000);
      const priceCents = toCents(executionPrice);
      this.#applyFillToLedger({
        portfolioId: proposal.portfolioId,
        symbol: proposal.symbol,
        side: proposal.side,
        quantity,
        priceCents,
        feeCents,
        now,
      });

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

  // A live broker order is booked onto the ledger only when the fill is complete: quantity,
  // average price and the broker's own commission all known. Anything else stays a
  // broker_orders row for reconciliation, so no trade is ever written with an invented fee.
  applyBrokerDecision({ proposal, decision, settlement, accountMasked, riskEventId, broker = "ibkr", orderType = "MKT" }) {
    if (!EXECUTABLE_PROPOSAL_STATUS.has(proposal.status)) {
      throw new FinanceError("Trade proposal has already been resolved", {
        code: "PROPOSAL_ALREADY_RESOLVED",
        status: 409,
      });
    }
    const now = new Date().toISOString();
    const resolvedRiskEventId = riskEventId ?? randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!riskEventId) this.db.prepare(`
        INSERT INTO risk_events (
          id, proposal_id, portfolio_id, agent_id, status, requested_quantity,
          approved_quantity, reasons_json, policy_json, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resolvedRiskEventId,
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

      const brokerOrderRowId = randomUUID();
      this.db.prepare(`
        INSERT INTO broker_orders (
          id, proposal_id, portfolio_id, agent_id, broker, broker_order_id, client_order_id,
          account_masked, symbol, side, quantity, order_type, status, broker_status,
          filled_quantity, average_fill_price_cents, fee_cents, execution_ids_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'WORKING', ?, 0, NULL, NULL, '[]', ?, ?)
      `).run(
        brokerOrderRowId,
        proposal.id,
        proposal.portfolioId,
        proposal.agentId,
        broker,
        settlement.brokerOrderId ?? null,
        settlement.clientOrderId ?? null,
        accountMasked,
        proposal.symbol,
        proposal.side,
        decision.approvedQuantity,
        orderType,
        settlement.status ?? null,
        now,
        now,
      );
      // The proposal is no longer open for a second order the moment IBKR accepts this one.
      this.db.prepare("UPDATE trade_proposals SET status = 'WORKING' WHERE id = ?").run(proposal.id);
      const settled = this.#settleBrokerOrderRow(this.#brokerOrderRow(brokerOrderRowId), settlement, decision.status, now);
      this.db.exec("COMMIT");
      return {
        proposal: this.getProposal(proposal.id),
        riskEventId: resolvedRiskEventId,
        brokerOrder: settled.brokerOrder,
        order: settled.order,
        trade: settled.trade,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Reconciliation entry point: applies whatever IBKR now reports for an order that was
  // still working, and is safe to call repeatedly because a booked row leaves WORKING.
  settleBrokerOrder(id, settlement, resolvedStatus = "APPROVED") {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#brokerOrderRow(id);
      if (!row) throw new FinanceError("Broker order not found", { code: "BROKER_ORDER_NOT_FOUND", status: 404 });
      if (row.status !== "WORKING") {
        this.db.exec("COMMIT");
        return { brokerOrder: mapBrokerOrder(row), order: this.getOrder(row.order_id), trade: null, changed: false };
      }
      const settled = this.#settleBrokerOrderRow(row, settlement, resolvedStatus, now);
      this.db.exec("COMMIT");
      return { ...settled, changed: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #settleBrokerOrderRow(row, settlement, resolvedStatus, now) {
    const filledQuantity = Number(settlement.filledQuantity ?? 0);
    const averageFillPrice = Number(settlement.averageFillPrice ?? 0);
    const commission = settlement.commission == null ? null : Number(settlement.commission);
    const brokerStatus = settlement.status ?? row.broker_status;
    const executionIds = Array.isArray(settlement.executionIds) ? settlement.executionIds : [];
    const terminal = TERMINAL_BROKER_STATUS.has(String(brokerStatus));
    const priced = filledQuantity > 0 && averageFillPrice > 0 && commission != null && Number.isFinite(commission);
    const complete = priced && (filledQuantity >= Number(row.quantity) || terminal);

    if (!complete) {
      const status = terminal && filledQuantity === 0 ? "CANCELLED" : "WORKING";
      this.db.prepare(`
        UPDATE broker_orders SET status = ?, broker_status = ?, filled_quantity = ?,
          execution_ids_json = ?, updated_at = ? WHERE id = ?
      `).run(status, brokerStatus, filledQuantity, JSON.stringify(executionIds), now, row.id);
      if (status === "CANCELLED") {
        this.db.prepare("UPDATE trade_proposals SET status = 'REJECTED', approved_quantity = 0, resolved_at = ? WHERE id = ?")
          .run(now, row.proposal_id);
      }
      return { brokerOrder: mapBrokerOrder(this.#brokerOrderRow(row.id)), order: null, trade: null };
    }

    const priceCents = toCents(averageFillPrice);
    const feeCents = toCents(Math.max(0, commission));
    const proposal = this.getProposal(row.proposal_id);
    this.#applyFillToLedger({
      portfolioId: row.portfolio_id,
      symbol: row.symbol,
      side: row.side,
      quantity: filledQuantity,
      priceCents,
      feeCents,
      now,
    });

    const orderId = randomUUID();
    const tradeId = randomUUID();
    this.db.prepare(`
      INSERT INTO orders (id, proposal_id, portfolio_id, agent_id, symbol, side, quantity, price_cents, fee_cents, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FILLED', ?)
    `).run(orderId, row.proposal_id, row.portfolio_id, row.agent_id, row.symbol, row.side, filledQuantity, priceCents, feeCents, now);
    this.db.prepare(`
      INSERT INTO trades (
        id, order_id, portfolio_id, agent_id, strategy_id, experiment_id, decision_id,
        symbol, side, quantity, price_cents, fee_cents, slippage_bps, evidence_manifest_id, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tradeId,
      orderId,
      row.portfolio_id,
      row.agent_id,
      proposal?.strategyId ?? null,
      proposal?.experimentId ?? null,
      proposal?.decisionId ?? row.proposal_id,
      row.symbol,
      row.side,
      filledQuantity,
      priceCents,
      feeCents,
      // A broker fill carries its own slippage inside the executed price; there is no
      // simulated allowance to record.
      0,
      proposal?.evidenceManifestId ?? null,
      now,
    );
    this.db.prepare(`
      UPDATE broker_orders SET status = 'FILLED', broker_status = ?, filled_quantity = ?,
        average_fill_price_cents = ?, fee_cents = ?, order_id = ?, execution_ids_json = ?, updated_at = ?
      WHERE id = ?
    `).run(brokerStatus, filledQuantity, priceCents, feeCents, orderId, JSON.stringify(executionIds), now, row.id);
    this.db.prepare("UPDATE trade_proposals SET status = ?, approved_quantity = ?, resolved_at = ? WHERE id = ?")
      .run(resolvedStatus, filledQuantity, now, row.proposal_id);
    return {
      brokerOrder: mapBrokerOrder(this.#brokerOrderRow(row.id)),
      order: this.getOrder(orderId),
      trade: this.getTrade(tradeId),
    };
  }

  #brokerOrderRow(id) {
    return this.db.prepare("SELECT * FROM broker_orders WHERE id = ?").get(id);
  }

  getBrokerOrder(id) {
    const row = this.#brokerOrderRow(id);
    return row ? mapBrokerOrder(row) : null;
  }

  listBrokerOrders({ portfolioId, agentId, status, limit = 100 } = {}) {
    const filters = [];
    const values = [];
    if (portfolioId) { filters.push("portfolio_id = ?"); values.push(portfolioId); }
    if (agentId) { filters.push("agent_id = ?"); values.push(agentId); }
    if (status) { filters.push("status = ?"); values.push(status); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT * FROM broker_orders ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...values, limit).map(mapBrokerOrder);
  }

  listWorkingBrokerOrders({ portfolioId, limit = 100 } = {}) {
    return this.listBrokerOrders({ portfolioId, status: "WORKING", limit })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  hasInFlightBrokerOrder(portfolioId) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM broker_orders WHERE portfolio_id = ? AND status = 'WORKING'
      UNION ALL SELECT 1 FROM trade_proposals WHERE portfolio_id = ? AND status = 'SUBMITTING'
      LIMIT 1
    `).get(portfolioId, portfolioId));
  }

  upgradeBrokerOrderIdentity(id, brokerOrderId) {
    this.db.prepare(`
      UPDATE broker_orders SET broker_order_id = ?, updated_at = ?
      WHERE id = ? AND status = 'WORKING'
    `).run(brokerOrderId, new Date().toISOString(), id);
    return this.getBrokerOrder(id);
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
      this.#attachTeamPortfolio(id, name);
      const insertMember = this.db.prepare(`
        INSERT INTO finance_team_members (team_id, agent_id, assigned_at, team_rank) VALUES (?, ?, ?, ?)
      `);
      agentIds.forEach((agentId, index) => insertMember.run(id, agentId, createdAt, index + 1));
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

  getFinanceTeamByPortfolio(portfolioId) {
    const row = this.db.prepare("SELECT * FROM finance_teams WHERE portfolio_id = ?").get(portfolioId);
    return row ? mapFinanceTeam(row, this.listFinanceTeamMembers(row.id)) : null;
  }

  removeFinanceTeam(id) {
    const team = this.db.prepare("SELECT portfolio_id FROM finance_teams WHERE id = ?").get(id);
    if (!team) return false;
    const unresolved = this.db.prepare(`
      SELECT 1 FROM trade_proposals
      WHERE portfolio_id = ? AND status IN ('PROPOSED', 'LEAD_APPROVED', 'SUBMITTING', 'WORKING')
      UNION ALL SELECT 1 FROM broker_orders WHERE portfolio_id = ? AND status = 'WORKING'
      LIMIT 1
    `).get(team.portfolio_id, team.portfolio_id);
    if (unresolved) {
      throw new FinanceError("Finance team has an unresolved order workflow", {
        code: "FINANCE_TEAM_ORDER_IN_FLIGHT",
        status: 409,
      });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM finance_teams WHERE id = ?").run(id);
      // A team portfolio without ledger history is scratch state; keep it only when
      // proposals, trades, or experiments still reference it for audit purposes.
      if (team.portfolio_id && !this.#portfolioHasLedger(team.portfolio_id)) {
        this.db.prepare("DELETE FROM portfolios WHERE id = ?").run(team.portfolio_id);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #portfolioHasLedger(portfolioId) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM trade_proposals WHERE portfolio_id = ?
      UNION ALL SELECT 1 FROM trades WHERE portfolio_id = ?
      UNION ALL SELECT 1 FROM experiments WHERE portfolio_id = ?
      LIMIT 1
    `).get(portfolioId, portfolioId, portfolioId));
  }

  addFinanceTeamMembers(teamId, agentIds) {
    const assignedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertMember = this.db.prepare(`
        INSERT OR IGNORE INTO finance_team_members (team_id, agent_id, assigned_at, team_rank) VALUES (?, ?, ?, ?)
      `);
      for (const agentId of agentIds) insertMember.run(teamId, agentId, assignedAt, 0);
      this.#recompactTeamRanks(teamId);
      this.db.exec("COMMIT");
      return this.getFinanceTeam(teamId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeFinanceTeamMember(teamId, agentId) {
    const previousLead = this.#orderedTeamMemberIds(teamId)[0];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.db.prepare(
        "DELETE FROM finance_team_members WHERE team_id = ? AND agent_id = ?",
      ).run(teamId, agentId).changes > 0;
      if (removed) {
        this.#recompactTeamRanks(teamId);
        if (previousLead === agentId) this.#invalidateTeamApprovals(teamId);
      }
      this.db.exec("COMMIT");
      return removed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setFinanceTeamLead(teamId, agentId) {
    const ordered = this.#orderedTeamMemberIds(teamId);
    if (!ordered.includes(agentId)) return null;
    const leadChanged = ordered[0] !== agentId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#writeTeamRanks(teamId, [agentId, ...ordered.filter((member) => member !== agentId)]);
      if (leadChanged) this.#invalidateTeamApprovals(teamId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getFinanceTeam(teamId);
  }

  #invalidateTeamApprovals(teamId) {
    this.db.prepare(`
      UPDATE trade_proposals
      SET status = 'PROPOSED', lead_approved_by_agent_id = NULL, lead_approved_at = NULL
      WHERE portfolio_id = (SELECT portfolio_id FROM finance_teams WHERE id = ?)
        AND status = 'LEAD_APPROVED'
    `).run(teamId);
  }

  listFinanceTeamMembers(teamId) {
    return this.db.prepare(`
      SELECT a.*, m.team_rank FROM finance_team_members m
      JOIN finance_agents a ON a.agent_id = m.agent_id
      WHERE m.team_id = ? ORDER BY m.team_rank, m.assigned_at, a.agent_id
    `).all(teamId).map(mapFinanceTeamMember);
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
    leadApprovedByAgentId: row.lead_approved_by_agent_id ?? null,
    leadApprovedAt: row.lead_approved_at ?? null,
    predictionId: row.prediction_id ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapLesson(row) {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    proposalId: row.proposal_id,
    authorAgentId: row.author_agent_id,
    trigger: row.trigger_text,
    betterApproach: row.better_approach,
    avoid: row.avoid,
    verify: row.verify,
    createdAt: row.created_at,
    retiredAt: row.retired_at ?? null,
    retiredReason: row.retired_reason ?? null,
    memorySynced: Boolean(row.memory_synced_at),
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

function mapBrokerOrder(row) {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    portfolioId: row.portfolio_id,
    agentId: row.agent_id,
    broker: row.broker,
    brokerOrderId: row.broker_order_id,
    clientOrderId: row.client_order_id == null ? null : Number(row.client_order_id),
    accountMasked: row.account_masked,
    symbol: row.symbol,
    side: row.side,
    quantity: Number(row.quantity),
    orderType: row.order_type,
    status: row.status,
    brokerStatus: row.broker_status,
    filledQuantity: Number(row.filled_quantity),
    averageFillPrice: row.average_fill_price_cents == null ? null : fromCents(row.average_fill_price_cents),
    fee: row.fee_cents == null ? null : fromCents(row.fee_cents),
    orderId: row.order_id,
    executionIds: JSON.parse(row.execution_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function mapFinanceTeamMember(row) {
  return { ...mapFinanceAgent(row), rank: Number(row.team_rank), lead: Number(row.team_rank) === 1 };
}

function mapFinanceTeam(row, members) {
  return {
    id: row.id,
    name: row.name,
    portfolioId: row.portfolio_id ?? null,
    leadAgentId: members.find((member) => member.lead)?.agentId ?? null,
    members,
    createdAt: row.created_at,
  };
}
