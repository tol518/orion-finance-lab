import { IbkrGatewayClient } from "./ibkr-gateway-client.js";

export function createIbkrBrokerFromEnv(env = process.env) {
  const mode = env.FINANCE_BROKER_MODE ?? "local";
  if (mode === "local") return null;
  if (mode !== "ibkr-paper") throw new Error("FINANCE_BROKER_MODE must be local or ibkr-paper");
  if (!env.FINANCE_IBKR_ACCOUNT_ID) {
    throw new Error("FINANCE_IBKR_ACCOUNT_ID is required in ibkr-paper mode");
  }
  return new IbkrGatewayClient({
    host: env.FINANCE_IBKR_HOST ?? "127.0.0.1",
    port: positiveInteger(env.FINANCE_IBKR_PORT, 4002),
    clientId: nonNegativeInteger(env.FINANCE_IBKR_CLIENT_ID, 91),
    accountId: env.FINANCE_IBKR_ACCOUNT_ID,
    python: env.FINANCE_IBKR_PYTHON ?? "python3",
    timeoutMs: positiveInteger(env.FINANCE_IBKR_TIMEOUT_MS, 15_000),
  });
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}
