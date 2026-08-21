import assert from "node:assert/strict";
import test from "node:test";
import { IbkrGatewayClient } from "../src/broker/ibkr-gateway-client.js";
import { createIbkrBrokerFromEnv } from "../src/broker/ibkr-config.js";

test("IBKR client discovers accounts without selecting one implicitly", async () => {
  const client = new IbkrGatewayClient({
    runBridge: async () => ({
      connected: true,
      accounts: ["TEST-PAPER-ACCOUNT"],
      serverVersion: 190,
      connectionTime: "20260821 09:00:00 GMT",
    }),
  });
  const probe = await client.probe();
  assert.equal(probe.connected, true);
  assert.equal(probe.selectedAccount, null);
  await assert.rejects(() => client.snapshot(), (error) => error.code === "IBKR_ACCOUNT_NOT_CONFIGURED");
});

test("IBKR client rejects a configured account that Gateway does not expose", async () => {
  const client = new IbkrGatewayClient({
    accountId: "OTHER-PAPER-ACCOUNT",
    runBridge: async () => ({ connected: true, accounts: ["TEST-PAPER-ACCOUNT"] }),
  });
  await assert.rejects(() => client.probe(), (error) => error.code === "IBKR_ACCOUNT_MISMATCH");
});

test("IBKR snapshot is normalized and masks the selected paper account", async () => {
  const calls = [];
  const client = new IbkrGatewayClient({
    accountId: "TEST-PAPER-ACCOUNT",
    runBridge: async ({ request }) => {
      calls.push(request);
      if (request.operation === "probe") {
        return { connected: true, accounts: ["TEST-PAPER-ACCOUNT"], serverVersion: 190 };
      }
      return {
        accountId: "TEST-PAPER-ACCOUNT",
        currency: "USD",
        netLiquidation: "1000000.50",
        cash: "990000.25",
        availableFunds: "980000",
        buyingPower: "3900000",
        positions: [{
          symbol: "aapl",
          securityType: "STK",
          currency: "USD",
          exchange: "NASDAQ",
          contractId: 265598,
          quantity: "10",
          averageCost: "200.25",
        }],
      };
    },
  });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.accountIdMasked, "T***UNT");
  assert.equal(snapshot.netLiquidation, 1_000_000.5);
  assert.equal(snapshot.positions[0].symbol, "AAPL");
  assert.equal(calls[1].accountId, "TEST-PAPER-ACCOUNT");
});

test("IBKR client refuses non-loopback Gateway hosts", () => {
  assert.throws(() => new IbkrGatewayClient({ host: "192.168.1.2" }), /loopback/);
});

test("IBKR paper client refuses non-paper Gateway ports", () => {
  assert.throws(() => new IbkrGatewayClient({ port: 4001 }), /port 4002/);
});

test("IBKR requests sharing a client ID are serialized", async () => {
  let active = 0;
  let maximumActive = 0;
  const client = new IbkrGatewayClient({
    runBridge: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { connected: true, accounts: [] };
    },
  });
  await Promise.all([client.probe(), client.probe(), client.probe()]);
  assert.equal(maximumActive, 1);
});

test("shared broker environment config preserves IBKR paper read-only mode", () => {
  assert.equal(createIbkrBrokerFromEnv({ FINANCE_BROKER_MODE: "local" }), null);
  const broker = createIbkrBrokerFromEnv({
    FINANCE_BROKER_MODE: "ibkr-paper",
    FINANCE_IBKR_ACCOUNT_ID: "TEST-PAPER-ACCOUNT",
    FINANCE_IBKR_HOST: "127.0.0.1",
    FINANCE_IBKR_PORT: "4002",
  });
  assert.ok(broker instanceof IbkrGatewayClient);
  assert.equal(broker.accountId, "TEST-PAPER-ACCOUNT");
});
