import path from "node:path";
import { fileURLToPath } from "node:url";
import { FinanceLabService } from "../service/finance-lab.js";
import { createFinanceRouter } from "../api/router.js";
import { listenFinanceService } from "../api/service-app.js";
import { createIbkrBrokerFromEnv, resolveIbkrExecutionMode } from "../broker/ibkr-config.js";
import { TeamTradingCoordinator } from "../automation/team-trading-coordinator.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let financeLab;
let agentBridge;
let teamTrading;

/** @satisfies {import("@orion-os/plugin-sdk").OrionPlugin} */
const plugin = {
  id: "orion.finance",
  name: "Orion Finance Lab",
  version: "0.1.0",
  description: "Auditable market research, deterministic risk, and paper trading for Orion-created agents.",
  async initialize(context) {
    const broker = createIbkrBrokerFromEnv();
    financeLab = new FinanceLabService({
      dataDir: context.dataDir,
      logger: context.logger,
      broker,
      ibkrExecution: resolveIbkrExecutionMode(),
      riskPolicy: parseJsonEnv("FINANCE_RISK_POLICY_JSON"),
      tradingAgents: {
        repoPath: process.env.FINANCE_TRADINGAGENTS_REPO,
        python: process.env.FINANCE_TRADINGAGENTS_PYTHON ?? "python3",
        runnerPath: path.join(rootDir, "integrations", "tradingagents_runner.py"),
        timeoutMs: positiveIntegerEnv("FINANCE_TRADINGAGENTS_TIMEOUT_MS", 300_000),
      },
    });
    financeLab.start();
    teamTrading = new TeamTradingCoordinator({
      service: financeLab,
      agentRuntime: context.agentRuntime,
      logger: context.logger,
    });
    const serviceToken = process.env.FINANCE_SERVICE_TOKEN;
    const signingKey = process.env.FINANCE_AGENT_SIGNING_KEY;
    if (serviceToken && signingKey) {
      agentBridge = await listenFinanceService({
        service: financeLab,
        token: serviceToken,
        signingKey,
        host: process.env.FINANCE_HOST ?? "127.0.0.1",
        port: positiveIntegerEnv("FINANCE_PORT", 4830),
      });
      context.logger.info(`[finance-lab] agent bridge listening on ${process.env.FINANCE_HOST ?? "127.0.0.1"}:${positiveIntegerEnv("FINANCE_PORT", 4830)}`);
    } else {
      context.logger.warn("[finance-lab] Finance bridge secrets are unset; dashboard works, agent tools stay disconnected");
    }
    context.mountApi(createFinanceRouter({ service: financeLab, teamTrading }));
    context.mountAssets(path.join(rootDir, "ui", "dist"));
    context.registerUi({
      route: "finance",
      label: "Finance Lab",
      description: "Paper portfolios, research, risk, predictions, agents, and experiments.",
      icon: "chart",
      elementName: "orion-finance-lab",
      modulePath: "finance-lab.js",
    });
  },
  async shutdown() {
    await teamTrading?.close();
    teamTrading = undefined;
    if (agentBridge) await new Promise((resolve) => agentBridge.close(resolve));
    agentBridge = undefined;
    await financeLab?.close();
    financeLab = undefined;
  },
};

function parseJsonEnv(name) {
  const value = process.env[name];
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { throw new Error(`${name} must contain valid JSON`); }
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export default plugin;
