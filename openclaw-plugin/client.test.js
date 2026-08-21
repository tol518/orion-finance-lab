import assert from "node:assert/strict";
import test from "node:test";
import { createFinanceClient, resolveAgentPermissions } from "./client.js";

test("per-agent permissions replace defaults and discard unknown values", () => {
  const permissions = resolveAgentPermissions({
    defaultPermissions: ["market.read"],
    agentPermissions: { patrick: ["portfolio.read", "trade.execute", "not.real"] },
  }, "patrick");
  assert.deepEqual(permissions, ["portfolio.read", "trade.execute"]);
});

test("trade execution is not silently added to defaults", () => {
  const permissions = resolveAgentPermissions({ defaultPermissions: ["market.read", "trade.propose"] }, "main");
  assert.equal(permissions.includes("trade.execute"), false);
});

test("finance client refuses to send credentials to a non-loopback service", () => {
  assert.throws(() => createFinanceClient({
    serviceUrl: "https://example.com/api",
    serviceToken: "a".repeat(64),
    agentSigningKey: "b".repeat(64),
    agentId: "patrick",
    permissions: ["market.read"],
  }), /loopback host/);
});
