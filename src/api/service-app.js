import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { FINANCE_PERMISSIONS, createActor } from "../service/finance-lab.js";
import { createFinanceRouter } from "./router.js";

const HEX_SECRET = /^[a-f0-9]{64,}$/i;
const ASSERTION_MAX_AGE_MS = 30_000;

export function createFinanceServiceApp({ service, token, signingKey, now = () => Date.now() }) {
  assertSecret(token, "Finance service token");
  assertSecret(signingKey, "Finance agent signing key");
  const usedAssertions = new Map();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, data: { status: "ok", mode: "paper" } }));
  app.use("/api", (req, res, next) => {
    if (!secureEqual(bearerToken(req), token)) {
      res.status(401).json({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Valid service token required" },
      });
      return;
    }
    try {
      req.financeActor = authenticatedActor(req, { signingKey, now, usedAssertions });
    } catch (error) {
      res.status(401).json({
        ok: false,
        error: { code: "INVALID_AGENT_ASSERTION", message: error.message },
      });
      return;
    }
    next();
  });
  app.use("/api", createRateLimit({ limit: 300, windowMs: 5 * 60_000, keyForRequest: (req) => req.financeActor.agentId }));
  app.use("/api", createFinanceRouter({ service, actorForRequest: (req) => req.financeActor }));
  return app;
}

export function listenFinanceService({ service, token, signingKey, host = "127.0.0.1", port = 4830 }) {
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw new Error("Finance agent bridge must bind to a loopback host");
  }
  const app = createFinanceServiceApp({ service, token, signingKey });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function authenticatedActor(req, { signingKey, now, usedAssertions }) {
  const agentId = String(req.get("x-finance-agent-id") ?? "").trim();
  const timestamp = String(req.get("x-finance-timestamp") ?? "").trim();
  const nonce = String(req.get("x-finance-nonce") ?? "").trim();
  const signature = String(req.get("x-finance-signature") ?? "").trim();
  if (!agentId || !timestamp || !nonce || !signature) throw new Error("Signed agent identity is required");
  const assertedAt = Number(timestamp);
  if (!Number.isSafeInteger(assertedAt) || Math.abs(now() - assertedAt) > ASSERTION_MAX_AGE_MS) {
    throw new Error("Agent assertion has expired");
  }
  const permissions = String(req.get("x-finance-permissions") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => FINANCE_PERMISSIONS.includes(item));
  const assertion = `${timestamp}\n${nonce}\n${agentId}\n${permissions.join(",")}`;
  const expected = createHmac("sha256", signingKey).update(assertion).digest("hex");
  if (!secureEqual(signature, expected)) throw new Error("Agent assertion signature is invalid");
  pruneAssertions(usedAssertions, now());
  if (usedAssertions.has(nonce)) throw new Error("Agent assertion has already been used");
  usedAssertions.set(nonce, assertedAt + ASSERTION_MAX_AGE_MS);
  return createActor({ actorId: `openclaw:${agentId}`, agentId, permissions });
}

function assertSecret(value, label) {
  if (typeof value !== "string" || !HEX_SECRET.test(value)) {
    throw new Error(`${label} must be a generated hexadecimal secret of at least 64 characters`);
  }
}

function pruneAssertions(assertions, now) {
  for (const [nonce, expiresAt] of assertions) {
    if (expiresAt > now) break;
    assertions.delete(nonce);
  }
  while (assertions.size > 1_000) assertions.delete(assertions.keys().next().value);
}

function bearerToken(req) {
  const header = String(req.get("authorization") ?? "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createRateLimit({ limit, windowMs, keyForRequest = (req) => req.ip ?? "local" }) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = keyForRequest(req);
    const current = clients.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    entry.count += 1;
    clients.set(key, entry);
    if (entry.count > limit) {
      res.status(429).json({
        ok: false,
        error: { code: "RATE_LIMITED", message: "Too many Finance Lab requests" },
      });
      return;
    }
    next();
  };
}
