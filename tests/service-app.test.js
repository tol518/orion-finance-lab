import assert from "node:assert/strict";
import test from "node:test";
import { createFinanceClient } from "../openclaw-plugin/client.js";
import { FinanceStore } from "../src/persistence/finance-store.js";
import { FixtureMarketDataProvider } from "../src/market-data/fixture-provider.js";
import { FinanceLabService } from "../src/service/finance-lab.js";
import { listenFinanceService } from "../src/api/service-app.js";

test("loopback service requires its bearer token and enforces agent permissions", async (t) => {
  const service = new FinanceLabService({
    store: new FinanceStore(),
    provider: new FixtureMarketDataProvider({
      quotes: { AAPL: { symbol: "AAPL", assetType: "EQUITY", price: 100, previousClose: 99 } },
    }),
  });
  const token = "a".repeat(64);
  const signingKey = "b".repeat(64);
  const server = await listenFinanceService({ service, token, signingKey, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    service.close();
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api`;

  const unauthorized = await fetch(`${base}/market/AAPL/quote`);
  assert.equal(unauthorized.status, 401);

  const client = createFinanceClient({
    serviceUrl: base,
    serviceToken: token,
    agentSigningKey: signingKey,
    agentId: "patrick",
    permissions: ["market.read"],
  });
  const quote = await client.request("/market/AAPL/quote");
  assert.equal(quote.data.price, 100);
  await assert.rejects(
    () => client.request("/proposals", {
      method: "POST",
      body: { symbol: "AAPL", side: "BUY", quantity: 1 },
    }),
    (error) => error.code === "FINANCE_PERMISSION_DENIED",
  );

  const missingIdentity = await fetch(`${base}/market/AAPL/quote`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(missingIdentity.status, 401);
  assert.equal((await missingIdentity.json()).error.code, "INVALID_AGENT_ASSERTION");
});

test("agent bridge rejects weak secrets and non-loopback binding", async () => {
  const service = new FinanceLabService({
    store: new FinanceStore(),
    provider: new FixtureMarketDataProvider(),
  });
  try {
    assert.throws(
      () => listenFinanceService({ service, token: "replace-with-a-long-random-token", signingKey: "b".repeat(64), port: 0 }),
      /generated hexadecimal secret/,
    );
    assert.throws(
      () => listenFinanceService({ service, token: "a".repeat(64), signingKey: "b".repeat(64), host: "0.0.0.0", port: 0 }),
      /loopback host/,
    );
  } finally {
    service.close();
  }
});
