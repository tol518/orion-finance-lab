import { createHmac, randomUUID } from "node:crypto";

const KNOWN_PERMISSIONS = new Set([
  "market.read",
  "portfolio.read",
  "strategy.run",
  "prediction.write",
  "trade.propose",
  "trade.execute",
  "experiment.manage",
  "audit.read",
]);

export function resolveAgentPermissions(config, agentId) {
  const explicit = config.agentPermissions?.[agentId];
  const source = Array.isArray(explicit) ? explicit : config.defaultPermissions ?? [];
  return [...new Set(source.filter((permission) => KNOWN_PERMISSIONS.has(permission)))];
}

export function createFinanceClient({ serviceUrl, serviceToken, agentSigningKey, agentId, permissions, timeoutMs = 30_000 }) {
  const baseUrl = String(serviceUrl).replace(/\/+$/, "");
  const parsedUrl = new URL(baseUrl);
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) throw new Error("Finance Lab serviceUrl must be HTTP(S)");
  if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(parsedUrl.hostname)) {
    throw new Error("Finance Lab serviceUrl must use a loopback host");
  }
  if (parsedUrl.username || parsedUrl.password) throw new Error("Finance Lab serviceUrl must not contain credentials");
  if (!/^[a-f0-9]{64,}$/i.test(serviceToken ?? "")) throw new Error("Finance Lab serviceToken must be a generated hexadecimal secret");
  if (!/^[a-f0-9]{64,}$/i.test(agentSigningKey ?? "")) throw new Error("Finance Lab agentSigningKey must be a generated hexadecimal secret");
  if (!agentId) throw new Error("Finance tools require a trusted OpenClaw agent ID");

  return {
    async request(path, { method = "GET", body, signal } = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const timestamp = String(Date.now());
      const nonce = randomUUID();
      const permissionHeader = permissions.join(",");
      const assertion = `${timestamp}\n${nonce}\n${agentId}\n${permissionHeader}`;
      const signature = createHmac("sha256", agentSigningKey).update(assertion).digest("hex");
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        signal: combined,
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          "Content-Type": "application/json",
          "X-Finance-Agent-Id": agentId,
          "X-Finance-Permissions": permissionHeader,
          "X-Finance-Timestamp": timestamp,
          "X-Finance-Nonce": nonce,
          "X-Finance-Signature": signature,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) {
        const message = payload?.error?.message ?? `Finance Lab request failed (${response.status})`;
        const error = new Error(message);
        error.code = payload?.error?.code ?? "FINANCE_REQUEST_FAILED";
        throw error;
      }
      return payload.data;
    },
  };
}
