import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FinanceError } from "../api/validation.js";

const defaultBridgePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../integrations/ibkr_gateway_bridge.py",
);

export class IbkrGatewayClient {
  constructor({
    host = "127.0.0.1",
    port = 4002,
    clientId = 91,
    accountId,
    python = "python3",
    bridgePath = defaultBridgePath,
    timeoutMs = 15_000,
    runBridge = runPythonBridge,
  } = {}) {
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      throw new Error("IBKR Gateway must use a loopback host");
    }
    this.host = host;
    this.port = positiveInteger(port, "IBKR port");
    if (this.port !== 4002) throw new Error("IBKR paper mode requires Gateway port 4002");
    this.clientId = nonNegativeInteger(clientId, "IBKR client ID");
    this.accountId = cleanAccountId(accountId);
    this.python = python;
    this.bridgePath = bridgePath;
    this.timeoutMs = positiveInteger(timeoutMs, "IBKR timeout");
    this.runBridge = runBridge;
    this.queue = Promise.resolve();
  }

  async probe() {
    const result = await this.#request("probe");
    const accounts = Array.isArray(result.accounts) ? result.accounts.map(cleanAccountId).filter(Boolean) : [];
    return {
      connected: result.connected === true,
      serverVersion: Number(result.serverVersion) || null,
      connectionTime: result.connectionTime || null,
      accounts,
      selectedAccount: this.#selectAccount(accounts),
    };
  }

  async snapshot() {
    const probe = await this.probe();
    const accountId = probe.selectedAccount;
    if (!accountId) {
      throw new FinanceError("IBKR paper account allowlist is not configured", {
        code: "IBKR_ACCOUNT_NOT_CONFIGURED",
        status: 503,
      });
    }
    const result = await this.#request("snapshot", { accountId });
    if (cleanAccountId(result.accountId) !== accountId) {
      throw new FinanceError("IBKR returned an unexpected account", {
        code: "IBKR_ACCOUNT_MISMATCH",
        status: 503,
      });
    }
    return normalizeSnapshot(result, probe);
  }

  #request(operation, extra = {}) {
    const pending = this.queue.then(
      () => this.#performRequest(operation, extra),
      () => this.#performRequest(operation, extra),
    );
    this.queue = pending.catch(() => {});
    return pending;
  }

  async #performRequest(operation, extra) {
    try {
      return await this.runBridge({
        python: this.python,
        bridgePath: this.bridgePath,
        timeoutMs: this.timeoutMs,
        request: {
          operation,
          host: this.host,
          port: this.port,
          clientId: this.clientId,
          ...extra,
        },
      });
    } catch (error) {
      if (error instanceof FinanceError) throw error;
      throw new FinanceError(`IBKR Gateway request failed: ${error.message}`, {
        code: "IBKR_GATEWAY_UNAVAILABLE",
        status: 503,
      });
    }
  }

  #selectAccount(accounts) {
    if (!this.accountId) return null;
    if (!accounts.includes(this.accountId)) {
      throw new FinanceError("Configured IBKR paper account is not available in this Gateway session", {
        code: "IBKR_ACCOUNT_MISMATCH",
        status: 503,
      });
    }
    return this.accountId;
  }
}

function runPythonBridge({ python, bridgePath, timeoutMs, request }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(`IBKR bridge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(reject, new Error(bridgeFailureMessage(stdout, stderr, code)));
        return;
      }
      try {
        const payload = JSON.parse(stdout.trim());
        if (payload?.ok !== true) throw new Error(payload?.error?.message ?? "IBKR bridge returned an error");
        finish(resolve, payload.data);
      } catch (error) {
        finish(reject, new Error(`Invalid IBKR bridge response: ${error.message}`));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    }
  });
}

function normalizeSnapshot(result, probe) {
  const netLiquidation = finiteMoney(result.netLiquidation, "net liquidation");
  const cash = finiteMoney(result.cash, "cash");
  return {
    broker: "ibkr",
    environment: "paper",
    connected: true,
    accountId: result.accountId,
    accountIdMasked: maskAccountId(result.accountId),
    currency: String(result.currency || "USD"),
    netLiquidation,
    cash,
    availableFunds: optionalMoney(result.availableFunds),
    buyingPower: optionalMoney(result.buyingPower),
    realisedPnl: optionalMoney(result.realisedPnl),
    unrealisedPnl: optionalMoney(result.unrealisedPnl),
    positions: Array.isArray(result.positions) ? result.positions.map(normalizePosition) : [],
    serverVersion: probe.serverVersion,
    connectionTime: probe.connectionTime,
    retrievedAt: new Date().toISOString(),
  };
}

function normalizePosition(position) {
  return {
    symbol: String(position.symbol || "").trim().toUpperCase(),
    securityType: String(position.securityType || ""),
    currency: String(position.currency || ""),
    exchange: String(position.exchange || ""),
    contractId: Number(position.contractId) || null,
    quantity: Number(position.quantity) || 0,
    averageCost: optionalMoney(position.averageCost) ?? 0,
  };
}

function cleanAccountId(value) {
  const accountId = String(value ?? "").trim();
  if (!accountId) return null;
  if (!/^[A-Za-z0-9-]{3,32}$/.test(accountId)) throw new Error("IBKR account ID is invalid");
  return accountId;
}

function maskAccountId(value) {
  const text = String(value);
  return text.length <= 4 ? "****" : `${text.slice(0, 1)}***${text.slice(-3)}`;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function finiteMoney(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`IBKR ${label} is unavailable`);
  return parsed;
}

function optionalMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeBridgeError(stderr, code) {
  const lastLine = stderr.trim().split("\n").filter(Boolean).at(-1);
  return lastLine || `IBKR bridge exited with code ${code}`;
}

function bridgeFailureMessage(stdout, stderr, code) {
  try {
    const payload = JSON.parse(stdout.trim());
    if (payload?.error?.message) return payload.error.message;
  } catch {
    // The stderr fallback below is intentionally bounded to one line.
  }
  return safeBridgeError(stderr, code);
}
