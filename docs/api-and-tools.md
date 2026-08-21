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
| `trade.execute` | Submit an owned proposal to deterministic risk and the paper broker. |
| `experiment.manage` | Create isolated experiment portfolios and run due-prediction evaluation. |
| `audit.read` | Read evidence manifests and structured audit history. |

Non-operator calls are forced to the trusted caller's own predictions, proposals, trades, and agent performance. Supplying another agent ID cannot widen access. A non-operator experiment is also bound to the caller's trusted agent ID.

## Endpoints

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /health` | Bridge bearer token not required at root; dashboard parent auth still applies | Report service and paper mode. |
| `GET /overview` | Operator/dashboard | Finance Room aggregate. |
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
| `POST /proposals/:id/execute` | `trade.execute` | Run current deterministic checks and execute only the permitted paper quantity. |
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
| `finance_execute_paper_trade` | `trade.execute` | Risk event and possible paper execution |
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
| `IBKR_READ_ONLY` | An execution was attempted during the read-only verification stage. |
| `INVALID_SYMBOL` / `INVALID_INPUT` | Boundary validation rejected the request. |
| `MARKET_RATE_LIMIT` | The provider adapter's bounded request window is full. |
| `PORTFOLIO_NOT_FOUND` / `PROPOSAL_NOT_FOUND` | Referenced finance object does not exist. |
| `PROPOSAL_ALREADY_RESOLVED` | Risk/execution was requested for a completed proposal. |
| `INSUFFICIENT_CASH` / `INSUFFICIENT_POSITION` | Transaction-time invariants rejected execution. |
| `STRATEGY_UNAVAILABLE` | Optional strategy dependency, usually TradingAgents, is not configured. |
| `TRADINGAGENTS_TIMEOUT` / `TRADINGAGENTS_FAILED` | External adapter timed out or exited unsuccessfully. |
