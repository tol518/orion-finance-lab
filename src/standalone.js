import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { FinanceLabService } from "./service/finance-lab.js";
import { listenFinanceService } from "./api/service-app.js";
import { createIbkrBrokerFromEnv } from "./broker/ibkr-config.js";

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.FINANCE_HOST ?? "127.0.0.1";
const port = positiveInteger(process.env.FINANCE_PORT, 4830);
const token = process.env.FINANCE_SERVICE_TOKEN ?? "";
const signingKey = process.env.FINANCE_AGENT_SIGNING_KEY ?? "";

const service = new FinanceLabService({
  dataDir: path.resolve(rootDir, process.env.FINANCE_DATA_DIR ?? "data"),
  broker: createIbkrBrokerFromEnv(),
  riskPolicy: parseJsonEnv("FINANCE_RISK_POLICY_JSON"),
  tradingAgents: {
    repoPath: process.env.FINANCE_TRADINGAGENTS_REPO,
    python: process.env.FINANCE_TRADINGAGENTS_PYTHON ?? "python3",
    runnerPath: path.join(rootDir, "integrations", "tradingagents_runner.py"),
    timeoutMs: positiveInteger(process.env.FINANCE_TRADINGAGENTS_TIMEOUT_MS, 300_000),
  },
});
service.start();

const server = await listenFinanceService({ service, token, signingKey, host, port });
console.log(`[orion-finance-lab] paper-only service listening on http://${host}:${port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  service.close();
  await new Promise((resolve) => server.close(resolve));
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function parseJsonEnv(name) {
  const value = process.env[name];
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { throw new Error(`${name} must contain valid JSON`); }
}
