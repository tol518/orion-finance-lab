# Orion Finance Lab

Orion Finance Lab is the financial intelligence and paper-trading subsystem for ORION. It gives agents created in ORION access to source-stamped market data, normalized strategies, deterministic risk controls, an auditable paper broker, prediction tracking, isolated experiments, and a native Finance Room.

Finance Lab does **not** create, register, persist, or orchestrate agents. Agent identity and lifecycle remain owned by ORION and OpenClaw.

> Paper trading only. Finance Lab supports its deterministic local simulator and a read-only IB Gateway paper-account connection. Live-account routing and IBKR order submission are not enabled.

## Public release notice

This repository is the sanitized public version of the Finance Lab used in the owner's private ORION workflow. It contains the implementation behind the dashboard, agent tools, strategy and risk pipeline, paper broker, persistence, and IBKR adapter, but it does not contain the owner's credentials, account identifiers, agent records, database, logs, local paths, or runtime configuration.

In the private workflow, IB Gateway Paper Trading is connected to Finance Lab and the owner's ORION agents. The agents can read current paper-account balances and positions, run research, record predictions, and prepare trade proposals. Finance Lab does not yet submit those proposals to Interactive Brokers. IBKR order placement, fills, cancellation, and commission reconciliation remain deliberately locked until that execution path is implemented and verified.

## Project goal

The goal is to give ORION agents a controlled financial workspace where research, predictions, evidence, risk decisions, and paper results can be inspected in one place. Agents can work alone or in small Finance teams, but deterministic policy remains responsible for approving or rejecting every simulated execution.

## What is implemented

- Provider-agnostic quote, OHLCV, fundamentals, financial-statement, news, and market-context interfaces.
- A Yahoo Finance 2 adapter with source URL, provider, symbol, request range, returned range, and retrieval timestamp metadata.
- Deterministic quant, momentum, and value strategies behind one normalized strategy contract.
- A replaceable adapter for [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents), preserved as the vanilla control strategy.
- Policy-based position, exposure, order, cash-reserve, daily-loss, drawdown, asset-class, symbol, leverage, and paper/live checks.
- Transactional paper orders, positions, cash, fees, slippage, realized P&L, unrealized P&L, and valuation history.
- A loopback-only IB Gateway adapter that discovers the configured paper account and reads authoritative balances and positions through IBKR's official Python API.
- Append-only predictions, immutable evidence manifests, expiry evaluation, benchmark return, alpha, agent accuracy, and confidence calibration.
- Isolated experiment portfolios with recorded strategy, agent reference, benchmark, risk, fee, model, and provider assumptions.
- An ORION plugin contribution with an authenticated API and native custom-element UI.
- Seventeen optional OpenClaw tools with trusted runtime agent identity and per-agent permissions.
- Finance Room assignment of existing ORION agents and up to five operating teams, with one to five agents per team.
- SQLite persistence, structured audit records, input validation, signed agent assertions, loopback bearer authentication, and request rate limiting.

## Architecture

```text
ORION OS
├── Agent Room and OpenClaw runtime        owns agents, sessions, memory, and orchestration
├── Generic ORION plugin runtime           loads independent plugin packages
└── Orion Finance Lab plugin               owns one FinanceLabService instance
    ├── Authenticated dashboard API        /api/plugins/orion.finance
    ├── Finance Room web component         #finance
    ├── Token + signed-agent bridge        127.0.0.1:4830/api
    └── SQLite finance state               ORION server/data/plugins/orion.finance/

OpenClaw Finance tools
└── loopback bridge ──► permissions ──► deterministic policy
                                             ├── Local PaperBroker
                                             └── IB Gateway :4002 (read-only)
```

The dependency direction is one way:

```text
orion-finance-lab ──► @orion-os/plugin-sdk

ORION core never imports Finance Lab.
```

Read [Architecture](docs/architecture.md) for boundaries, state flow, and persistence details.

## Requirements

- Node.js 24 or newer.
- npm.
- The ORION public repository with its generic plugin runtime changes.
- A running OpenClaw gateway if agents need finance tools.
- For IBKR mode: IB Gateway logged into Paper Trading and the user-accepted [official TWS API for Mac/Unix](https://interactivebrokers.github.io/), which includes the Python client. Use IBKR's current stable supported release.
- Optional: Python 3.11 or newer (3.13 is the verified private setup), an independent TradingAgents checkout, its model/provider credentials, and any provider-specific dependencies required by that project.

## Install

Install all three package surfaces and build the UI:

```bash
cd /path/to/orion-finance-lab
npm ci
npm --prefix ui ci
npm --prefix openclaw-plugin ci --legacy-peer-deps
npm run build
```

Generate two independent local secrets. Do not commit either value:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Use the first output as `FINANCE_SERVICE_TOKEN` and the second as `FINANCE_AGENT_SIGNING_KEY`.

### Run inside ORION

Integrated mode is the recommended mode. ORION owns one Finance Lab instance, one database, the dashboard API, and the loopback bridge used by OpenClaw tools.

Add these values to ORION's uncommitted `server/.env`:

```dotenv
ORION_PLUGIN_PATHS=/absolute/path/to/orion-finance-lab
FINANCE_SERVICE_TOKEN=<64_HEX_CHARACTER_TOKEN>
FINANCE_AGENT_SIGNING_KEY=<DIFFERENT_64_HEX_CHARACTER_KEY>
FINANCE_HOST=127.0.0.1
FINANCE_PORT=4830
```

Start ORION normally. Finance Lab appears in the sidebar after login. The BFF starts the loopback agent bridge only when both secrets are set. If either is omitted, the dashboard still works but OpenClaw finance tools cannot connect.

Do not run `npm start` in this repository at the same time as integrated mode. That would compete for the bridge port and create a second state owner.

### Connect an IBKR paper account

IBKR mode uses the same official socket API with IB Gateway; the Trader Workstation application is not required. Downloading the API requires the account owner to accept IBKR's non-commercial API licence.

Install the downloaded Python client into a dedicated local virtual environment, then configure the uncommitted ORION `server/.env`:

```dotenv
FINANCE_BROKER_MODE=ibkr-paper
FINANCE_IBKR_HOST=127.0.0.1
FINANCE_IBKR_PORT=4002
FINANCE_IBKR_CLIENT_ID=91
FINANCE_IBKR_ACCOUNT_ID=<EXPLICIT_PAPER_ACCOUNT_ID>
FINANCE_IBKR_PYTHON=/absolute/path/to/venv/bin/python
FINANCE_IBKR_TIMEOUT_MS=15000
```

Finance Lab refuses non-loopback IBKR hosts and refuses to select the first discovered account implicitly. The configured account must be present in the authenticated IB Gateway session. Account IDs sent to the browser are masked.

IBKR documents that the socket API does not know whether Gateway is logged into a live or paper username. Finance Lab therefore requires the standard paper Gateway port `4002`, while the operator must still verify the **Paper Trading** login in IB Gateway before each execution-enabled session.

This integration stage is intentionally read-only. It makes IBKR authoritative for displayed balance and positions and blocks the existing local execution path, preventing a failed IBKR request from falling back to a simulated fill.

### Give ORION agents finance tools

Link the included OpenClaw plugin from the Finance Lab checkout:

```bash
openclaw plugins install --link /absolute/path/to/orion-finance-lab/openclaw-plugin
```

Make `FINANCE_SERVICE_TOKEN` and `FINANCE_AGENT_SIGNING_KEY` available to the OpenClaw gateway process as `ORION_FINANCE_SERVICE_TOKEN` and `ORION_FINANCE_AGENT_SIGNING_KEY`. Then configure permissions under `plugins.entries.orion-finance-lab.config`:

```json
{
  "plugins": {
    "entries": {
      "orion-finance-lab": {
        "enabled": true,
        "config": {
          "serviceUrl": "http://127.0.0.1:4830/api",
          "defaultPermissions": [
            "market.read",
            "portfolio.read",
            "strategy.run",
            "prediction.write",
            "trade.propose"
          ],
          "agentPermissions": {
            "<ORION_AGENT_ID>": [
              "market.read",
              "portfolio.read",
              "strategy.run",
              "prediction.write",
              "trade.propose"
            ]
          }
        }
      }
    }
  }
}
```

`trade.execute` is excluded by default. In local mode it submits an existing proposal to deterministic risk and the local paper broker. In IBKR read-only mode it returns `IBKR_READ_ONLY`; no broker order is sent. OpenClaw tool allowlists remain an additional gate because every Finance Lab tool is registered as optional.

Restart the OpenClaw gateway after installing or changing plugin configuration. Confirm the plugin and runtime state with:

```bash
openclaw plugins inspect orion-finance-lab --runtime --json
openclaw gateway status --deep --require-rpc
```

### Run headless without ORION

Standalone mode is intended for API development and headless tool use. It uses `./data/finance-lab.sqlite` and does not contribute the Finance Room to ORION.

```bash
cp .env.example .env
# Set both generated Finance bridge secrets in .env.
npm start
curl http://127.0.0.1:4830/health
```

Use either integrated mode or standalone mode for a given state directory, never both.

## Core safety flow

```text
Orion agent
  └── finance_create_trade_proposal
        └── immutable evidence manifest
              └── finance_execute_paper_trade
                    └── deterministic RiskEngine
                          ├── reject
                          ├── resize
                          └── approve ──► transactional PaperBroker
```

`finance_execute_paper_trade` does not accept a new order. It accepts only an existing proposal ID, checks that a non-operator caller owns that proposal, reruns current portfolio and quote checks, and records the risk decision in the same transaction as any resulting paper execution.

## Finance Room

The Finance Room is loaded dynamically through ORION's generic plugin runtime. Its views are:

| View | Purpose |
| --- | --- |
| Overview | Portfolio metrics, allocation, positions, decisions, research, risk, experiments, and agent coverage. |
| Portfolio | Current valuation, cash, exposure, position P&L, drawdown, Sharpe, and Sortino. |
| Trades | Proposal ledger, explicit risk-check action, and immutable paper executions. |
| Predictions | Append a prediction and inspect pending or evaluated outcomes. |
| Agents | Assign existing ORION agents to Finance Lab and create up to five teams with one to five assigned agents each. Teams work below the maximum size. Finance Lab does not create agents. |
| Strategies | Run and compare quant, momentum, value, and optional TradingAgents strategies. |
| Experiments | Create isolated paper portfolios with fixed starting assumptions. |
| Analytics | Risk-adjusted portfolio metrics, evaluation coverage, and confidence calibration. |

New portfolios begin with cash only. The UI does not fabricate positions, gains, benchmark history, agent records, trades, or experiments.

## TradingAgents control strategy

Finance Lab does not vendor or modify TradingAgents. Install it separately, verify its own provider setup, and point Finance Lab to that checkout:

```dotenv
FINANCE_TRADINGAGENTS_REPO=/absolute/path/to/TradingAgents
FINANCE_TRADINGAGENTS_PYTHON=python3
FINANCE_TRADINGAGENTS_TIMEOUT_MS=300000
```

The adapter calls `TradingAgentsGraph.propagate(symbol, date)` through `integrations/tradingagents_runner.py`, captures available analyst reports and debate state, and normalizes the final result. It is marked unavailable when the checkout path is absent; the rest of Finance Lab continues to work.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run Node tests for quant logic, risk and paper execution, persistence immutability, permissions, experiments, and bridge authentication. |
| `npm run build` | Type-check and build the Finance Room custom-element bundle. |
| `npm run verify:public` | Reject credentials, account identifiers, runtime state, private paths, virtual environments, SDK downloads, and other forbidden release artifacts. |
| `npm run check` | Run the public-release verifier, tests, and production UI build. |
| `npm start` | Start headless standalone mode. Requires both Finance bridge secrets. |
| `npm run dev` | Start standalone mode with Node watch. |
| `npm --prefix ui run dev` | Start the isolated Vite UI development server; the embedded element still requires an API host. |

## API and tools

All service responses use:

```json
{ "ok": true, "data": {} }
```

or:

```json
{ "ok": false, "error": { "code": "FINANCE_PERMISSION_DENIED", "message": "..." } }
```

Read [API and tools](docs/api-and-tools.md) for endpoints, OpenClaw tool names, permissions, and response behavior.

## Persistence and evidence

Finance state lives in one SQLite database. Monetary balances and execution prices are stored as integer cents; quantities support up to six decimal places at risk approval. Foreign keys are enabled, and execution uses `BEGIN IMMEDIATE` so cash, position, order, trade, proposal, and risk records change together.

Predictions and evidence manifests have SQLite triggers that reject updates and deletes. Market reads record provider, source, symbol, request range, returned range, and retrieval time. Audit entries record action, trusted actor/agent ID, relevant finance IDs, latency, result, and bounded metadata without storing secrets.

## Current limits

- IBKR paper balances and positions are connected, but broker order submission and fill management are not implemented yet.
- Yahoo Finance is the included market-data adapter; production use may require a licensed provider.
- TradingAgents is optional and must be installed and configured separately.

## Security

- Keep both Finance bridge secrets, provider credentials, model keys, account identifiers, and local paths out of Git.
- The agent bridge rejects non-loopback binding. Keep ORION itself behind its authenticated local boundary.
- Do not grant `trade.execute` through broad defaults.
- Keep `FINANCE_IBKR_HOST` on loopback, use a dedicated client ID, and require an explicit paper-account ID. Never configure a live account ID.
- The bearer token authenticates the bridge client. A separate key signs short-lived agent identity and permission assertions, and the bridge rejects missing, expired, replayed, or invalid assertions.
- The browser never receives the bridge token or provider secrets. ORION's authenticated BFF mounts the dashboard API directly.
- Run `npm run verify:public` before every public push. GitHub Actions repeats the release check, tests, UI build, and Python bridge compile check on pushes and pull requests.
- This software is an engineering and research environment, not financial advice.

Read [Security Policy](SECURITY.md) before reporting a vulnerability.

## Repository map

```text
src/
├── api/                 validation, authenticated router, loopback service
├── broker/              local PaperBroker and read-only IB Gateway client
├── evaluation/          portfolio metrics and confidence calibration
├── evidence/            reproducible decision manifests
├── market-data/         provider contract, Yahoo adapter, fixture adapter, cache
├── persistence/         SQLite schema and repositories
├── plugin/              ORION plugin entry
├── predictions/         append-only prediction lifecycle
├── quant/               deterministic indicators and sizing
├── risk/                deterministic policy engine
├── service/             permissioned application service
└── strategies/          normalized quant, momentum, value, TradingAgents
ui/src/                  native ORION Finance Room custom element
openclaw-plugin/         optional composable agent tools
integrations/            thin official-IBKR and TradingAgents Python bridges
tests/                   deterministic unit and integration tests
docs/                    architecture and API reference
```
