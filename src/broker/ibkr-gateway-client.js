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

  // Orders always re-resolve the account allowlist first: an order must never inherit an
  // account from Gateway state, and a paper account swap has to fail closed.
  async placeOrder({ symbol, side, quantity, orderType = "MKT", limitPrice = null, whatIf = true, orderRef = null }) {
    const probe = await this.probe();
    const accountId = probe.selectedAccount;
    if (!accountId) {
      throw new FinanceError("IBKR paper account allowlist is not configured", {
        code: "IBKR_ACCOUNT_NOT_CONFIGURED",
        status: 503,
      });
    }
    const result = await this.#request("place_order", {
      accountId,
      symbol,
      side,
      quantity,
      orderType,
      limitPrice,
      whatIf,
      orderRef,
    });
    if (cleanAccountId(result.accountId) !== accountId) {
      throw new FinanceError("IBKR returned an unexpected account", {
        code: "IBKR_ACCOUNT_MISMATCH",
        status: 503,
      });
    }
    // A resting order may emit openOrder before orderStatus. Either callback proves IBKR
    // accepted it; requiring a fill object misclassifies working orders as rejections.
    const acknowledged = whatIf ? Boolean(result.preview) : Boolean(result.fill || result.preview);
    if (!acknowledged) {
      const rejection = Array.isArray(result.errors) ? result.errors[0] : null;
      throw new FinanceError(rejection?.message ?? "IBKR did not acknowledge the order", {
        code: "IBKR_ORDER_REJECTED",
        status: 502,
        details: { ibkrCode: rejection?.code ?? null, orderId: result.orderId ?? null },
      });
    }
    const executions = Array.isArray(result.executions) ? result.executions : [];
    return {
      accountIdMasked: maskAccountId(accountId),
      orderId: result.orderId ?? null,
      whatIf: result.whatIf === true,
      status: result.status ?? null,
      symbol: result.symbol ?? symbol,
      side: result.side ?? side,
      quantity: Number(result.quantity ?? quantity),
      orderType: result.orderType ?? orderType,
      contract: result.contract ?? null,
      preview: result.preview ?? null,
      fill: result.fill ?? null,
      executions,
      // A live order settles as either a fill or a working order; the ledger needs the
      // difference, and permId is the id that survives an API session restart.
      settlement: result.whatIf === true ? null : normalizeSettlement(result, executions),
    };
  }

  // Re-reads what IBKR still holds open and every execution it has for the account, so an
  // order that filled after the placing call returned can still be settled exactly once.
  async reconcile() {
    const probe = await this.probe();
    const accountId = probe.selectedAccount;
    if (!accountId) {
      throw new FinanceError("IBKR paper account allowlist is not configured", {
        code: "IBKR_ACCOUNT_NOT_CONFIGURED",
        status: 503,
      });
    }
    const result = await this.#request("reconcile", { accountId });
    if (cleanAccountId(result.accountId) !== accountId) {
      throw new FinanceError("IBKR returned an unexpected account", {
        code: "IBKR_ACCOUNT_MISMATCH",
        status: 503,
      });
    }
    const executions = Array.isArray(result.executions) ? result.executions : [];
    const normalizeOrder = (order) => ({
      brokerOrderId: brokerOrderId(order),
      symbol: order.symbol ?? null,
      side: order.side ?? null,
      quantity: Number(order.quantity ?? 0),
      status: order.status ?? null,
      orderRef: order.orderRef || null,
      clientOrderId: Number(order.orderId ?? 0) || null,
    });
    return {
      accountIdMasked: maskAccountId(accountId),
      openOrders: (Array.isArray(result.openOrders) ? result.openOrders : []).map(normalizeOrder),
      completedOrders: (Array.isArray(result.completedOrders) ? result.completedOrders : []).map(normalizeOrder),
      executionsByBrokerOrderId: groupExecutions(executions),
      retrievedAt: new Date().toISOString(),
    };
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

// permId is stable across API sessions; the per-session orderId is only a fallback for a
// Gateway that has not assigned one yet, and is namespaced so the two can never collide.
function brokerOrderId(source) {
  const permId = Number(source?.permId ?? 0);
  if (Number.isSafeInteger(permId) && permId > 0) return String(permId);
  const orderId = Number(source?.orderId ?? 0);
  return Number.isSafeInteger(orderId) && orderId > 0 ? `client:${orderId}` : null;
}

function normalizeSettlement(result, executions) {
  const fill = result.fill ?? null;
  const filledQuantity = Number(fill?.filled ?? 0);
  const grouped = groupExecutions(executions);
  const id = brokerOrderId({ permId: fill?.permId ?? result.permId, orderId: result.orderId });
  return {
    brokerOrderId: id,
    clientOrderId: Number(result.orderId ?? 0) || null,
    status: String(fill?.status ?? result.status ?? "UNKNOWN"),
    filledQuantity,
    remainingQuantity: Number(fill?.remaining ?? 0),
    averageFillPrice: positiveOrNull(fill?.averageFillPrice),
    // IBKR reports commission per execution; an order with no execution yet has no fee.
    commission: totalCommission(id ? grouped[id]?.executions ?? executions : executions, filledQuantity),
    executionIds: executions.map((item) => String(item.executionId)).filter(Boolean),
  };
}

function groupExecutions(executions) {
  const grouped = {};
  for (const execution of executions) {
    const id = brokerOrderId(execution);
    if (!id) continue;
    const bucket = (grouped[id] ??= { executions: [], filledQuantity: 0, notional: 0 });
    bucket.orderRef ??= execution.orderRef || null;
    bucket.executions.push(execution);
    const quantity = Number(execution.quantity ?? 0);
    const price = Number(execution.price ?? 0);
    if (quantity > 0 && price > 0) {
      bucket.filledQuantity += quantity;
      bucket.notional += quantity * price;
    }
  }
  for (const bucket of Object.values(grouped)) {
    bucket.averageFillPrice = bucket.filledQuantity > 0 ? bucket.notional / bucket.filledQuantity : null;
    bucket.commission = totalCommission(bucket.executions);
  }
  return grouped;
}

// A missing commission report is not a zero fee: the ledger must know the difference so it
// does not book a free trade for a fill whose cost has not arrived yet.
function totalCommission(executions, expectedQuantity = null) {
  if (executions.length === 0) return null;
  let total = 0;
  for (const execution of executions) {
    const rawValue = execution?.commission?.commission;
    if (rawValue == null) return null;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return null;
    total += value;
  }
  if (expectedQuantity != null) {
    const executionQuantity = executions.reduce((sum, execution) => sum + Number(execution.quantity ?? 0), 0);
    if (executionQuantity + 1e-9 < expectedQuantity) return null;
  }
  return total;
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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
