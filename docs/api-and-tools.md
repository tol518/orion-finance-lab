# API and tools

The ORION dashboard mounts the API at `/api/plugins/orion.finance`. The agent bridge uses `http://127.0.0.1:4830/api` by default and requires both a bearer token and a signed, short-lived agent assertion. The bridge cannot construct a dashboard operator actor.

## Response envelope

Successful calls return `{ "ok": true, "data": <value> }`. Failures return `{ "ok": false, "error": { "code", "message", "details" } }` with an HTTP status matching the failure.

## Permissions

| Permission | Allows |
| --- | --- |
| `market.read` | Quotes, history, fundamentals, news, and market context. |
| `portfolio.read` | Portfolios, positions, trades, proposals, predictions, agent performance, strategy comparison, and risk state. |
| `strategy.run` | Deterministic or configured external strategy execution and evidence creation. |
| `prediction.write` | Append a prediction and immutable supporting evidence. |
| `trade.propose` | Create a paper-trade proposal and immutable supporting evidence. |
| `trade.execute` | Approve as team lead, or submit/reconcile as the originating team trader; role and proposal-state checks separate those actions. |
| `experiment.manage` | Create isolated experiment portfolios and run due-prediction evaluation. |
| `audit.read` | Read evidence manifests and structured audit history. |

Non-operator calls are forced to the trusted caller's own predictions, proposals, trades, and agent performance. Supplying another agent ID cannot widen access. A non-operator experiment is also bound to the caller's trusted agent ID.

## Endpoints

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /health` | Bridge bearer token not required at root; dashboard parent auth still applies | Report service and paper mode. |
| `GET /overview` | Operator/dashboard | Finance Room aggregate, including recent proposals, fills, and broker-order lifecycle records across team portfolios. |
| `GET /market/context` | `market.read` | Broad market, volatility, and Treasury proxy quotes. |
| `GET /market/:symbol/quote` | `market.read` | Current source-stamped quote. |
| `GET /market/:symbol/history` | `market.read` | OHLCV; query `from`, `to`, `interval=1d|1wk|1mo`. |
| `GET /market/:symbol/fundamentals` | `market.read` | Profile, earnings, valuation, and annual statement data. |
| `GET /market/:symbol/news` | `market.read` | News; optional `count` from 1 to 30. |
| `GET /strategies` | `market.read` | Registered strategies and availability. |
| `POST /strategies/:id/run` | `strategy.run` | Normalized result and evidence manifest ID. |
| `POST /quant/run` | `strategy.run` | Shortcut for `quant-core`. |
| `POST /strategies/compare` | `portfolio.read` | Portfolio count, trades, fees, and return by strategy. |
| `GET /portfolios` | `portfolio.read` | Valued paper portfolios. |
| `GET /portfolios/:id` | `portfolio.read` | Cash, positions, P&L, drawdown, benchmark, alpha, Sharpe, and Sortino. |
| `GET /trades` | `portfolio.read` | Paper execution history. |
| `GET /proposals` | `portfolio.read` | Proposal and risk-resolution history. |
| `POST /proposals` | `trade.propose` | Create proposal from symbol, side, quantity, thesis, and optional strategy metadata. |
| `POST /proposals/:id/approve` | `trade.execute` | Record approval from the proposal's current rank-1 team lead. The proposal must belong to a non-lead trader on that team. |
| `POST /proposals/:id/execute` | `trade.execute` | The originating non-lead trader submits a currently lead-approved proposal to deterministic checks and the paper broker. In `dry-run` it returns an IBKR whatIf preview; in `live` it transmits a paper order. |
| `POST /broker/reconcile` | `trade.execute` | A non-lead trader settles working broker orders and recovers `SUBMITTING` proposals by IBKR `orderRef` for its own team book. Optional `portfolioId` narrows the pass. |
| `GET /broker/orders` | `portfolio.read` | Recent IBKR paper orders. Operators see all portfolios; team agents are restricted to their team portfolio. |
| `GET /finance-teams/portfolios` | `portfolio.read` | Per-team paper portfolios plus the combined roll-up across teams. |
| `GET /finance-teams/context` | `portfolio.read` | The calling agent's role, rank, lead, teammates, and team portfolio. |
| `POST /finance-teams/:id/lead` | operator | Promote a member to rank-1 team lead. |
| `GET /broker/status` | `portfolio.read` | Report local or IBKR paper connectivity with masked account identity. |
| `GET /risk/:portfolioId` | `portfolio.read` | Policy, current metrics, and breaches. |
| `GET /predictions` | `portfolio.read` | Pending/evaluated prediction ledger. |
| `POST /predictions` | `prediction.write` | Append direction, range, horizon, confidence, thesis, and invalidation conditions. |
| `POST /predictions/evaluate` | `experiment.manage` | Evaluate currently due predictions. |
| `GET /agents` | `portfolio.read` | Financial performance for referenced ORION agent IDs. |
| `GET /agents/:agentId` | `portfolio.read` | One agent's accuracy, alpha, trades, fees, and calibration. |
| `GET /finance-agents` | Operator/dashboard | List existing ORION agents assigned to Finance Lab. |
| `POST /finance-agents` | Operator/dashboard | Assign an existing ORION agent to Finance Lab. |
| `DELETE /finance-agents/:agentId` | Operator/dashboard | Remove an assignment when it is not used by a Finance team. |
| `GET /finance-teams` | Operator/dashboard | List up to five Finance teams and their assigned members. |
| `POST /finance-teams` | Operator/dashboard | Create a team with one to five assigned ORION agents. |
| `DELETE /finance-teams/:teamId` | Operator/dashboard | Delete a Finance team and release its member assignments. |
| `GET /finance-teams/:teamId/lessons` | Operator/dashboard | The team's lessons from graded decisions, including retired ones, with exposure scores. |
| `POST /finance-teams/:teamId/lessons/:lessonId/retire` | Operator/dashboard | Retire a lesson so later cycles stop receiving it, and remove it from shared memory. |
| `GET /experiments` | `portfolio.read` | Experiment definitions and isolated portfolio IDs. |
| `POST /experiments` | `experiment.manage` | Create experiment with fixed starting assumptions. |
| `GET /evidence/:id` | `audit.read` | Immutable evidence manifest. |
| `GET /audit` | `audit.read` | Structured action history. |

## OpenClaw tools

OpenClaw tool names use underscores because they are model-facing tool identifiers. They map directly to the conceptual `finance.*` capabilities.

| Tool | Permission | Side effect |
| --- | --- | --- |
| `finance_get_quote` | `market.read` | No |
| `finance_get_price_history` | `market.read` | No |
| `finance_get_fundamentals` | `market.read` | No |
| `finance_get_news` | `market.read` | No |
| `finance_get_market_context` | `market.read` | No |
| `finance_run_quant_analysis` | `strategy.run` | Evidence/audit only |
| `finance_run_strategy` | `strategy.run` | Evidence/audit only |
| `finance_get_portfolio` | `portfolio.read` | Valuation snapshot |
| `finance_get_trade_history` | `portfolio.read` | No |
| `finance_create_trade_proposal` | `trade.propose` | Proposal and evidence |
| `finance_get_trade_proposals` | `portfolio.read` | Own proposals, or all team proposals for the current team lead |
| `finance_approve_trade_proposal` | `trade.execute` | Rank-1 lead approval for a team trader's proposal |
| `finance_execute_paper_trade` | `trade.execute` | Risk event and possible paper execution, IBKR preview, or live broker order |
| `finance_settle_broker_orders` | `trade.execute` | Books completed IBKR fills for the caller's own team book; trader only |
| `finance_get_team` | `portfolio.read` | None; reads the caller's team hierarchy |
| `finance_record_prediction` | `prediction.write` | Prediction and evidence |
| `finance_get_prediction_results` | `portfolio.read` | No |
| `finance_get_agent_performance` | `portfolio.read` | No |
| `finance_compare_strategies` | `portfolio.read` | Valuation snapshots |
| `finance_get_risk_state` | `portfolio.read` | No |
| `finance_create_experiment` | `experiment.manage` | Experiment and isolated portfolio |

Every tool is optional at the OpenClaw layer. A tool appears only when the calling agent receives its Finance Lab permission, and normal OpenClaw tool policy can restrict the surface further.

## Important errors

| Code | Meaning |
| --- | --- |
| `UNAUTHORIZED` | Agent bridge bearer token is absent or wrong. |
| `INVALID_AGENT_ASSERTION` | Agent identity assertion is missing, expired, replayed, or has an invalid signature. |
| `FINANCE_PERMISSION_DENIED` | Caller lacks the required finance capability or attempted cross-agent access. |
| `FORBIDDEN_PORTFOLIO` | An agent attempted to modify another agent's experiment portfolio. |
| `FORBIDDEN_EXPERIMENT` | An agent attempted to attach a prediction to another agent's experiment. |
| `FINANCE_AGENT_IN_TEAM` | An assigned agent must be removed from its Finance team before its assignment can be deleted. |
| `HISTORY_RANGE_LIMIT` / `HISTORY_BAR_LIMIT` | Requested market history exceeds the bounded evidence limits. |
| `IBKR_ACCOUNT_NOT_CONFIGURED` | IBKR mode has no explicit paper-account allowlist entry. |
| `IBKR_ACCOUNT_MISMATCH` | The configured paper account is absent or the bridge returned another account. |
| `IBKR_GATEWAY_UNAVAILABLE` | IB Gateway, the official Python API, or the loopback bridge is unavailable. |
| `IBKR_READ_ONLY` | Broker execution was attempted while `FINANCE_IBKR_EXECUTION=off`. |
| `IBKR_ORDER_REJECTED` | IBKR refused the order. `details.ibkrCode` carries its own code, for example `321` while Gateway still has Read-Only API checked. |
| `PROPOSAL_ALREADY_RESOLVED` | The proposal already has a broker order or fill; it will not be sent again. |
| `IBKR_ORDER_REJECTED` | IB Gateway refused the order; the IBKR code and message are returned in `details`. |
| `FINANCE_TEAM_LEAD_REQUIRED` | An agent other than the current rank-1 lead tried to approve a team proposal. |
| `FINANCE_TEAM_TRADER_REQUIRED` | A lead, researcher, operator, or non-trader attempted a trader-only team action. |
| `FINANCE_TEAM_APPROVAL_REQUIRED` | The originating trader attempted submission without approval from the current lead. |
| `INVALID_SYMBOL` / `INVALID_INPUT` | Boundary validation rejected the request. |
| `MARKET_RATE_LIMIT` | The provider adapter's bounded request window is full. |
| `PORTFOLIO_NOT_FOUND` / `PROPOSAL_NOT_FOUND` | Referenced finance object does not exist. |
| `PROPOSAL_ALREADY_RESOLVED` | Risk/execution was requested for a completed proposal. |
| `INSUFFICIENT_CASH` / `INSUFFICIENT_POSITION` | Transaction-time invariants rejected execution. |
| `STRATEGY_UNAVAILABLE` | Optional strategy dependency, usually TradingAgents, is not configured. |
| `TRADINGAGENTS_TIMEOUT` / `TRADINGAGENTS_FAILED` | External adapter timed out or exited unsuccessfully. |
