import path from "node:path";
import { spawn } from "node:child_process";
import { FinanceError } from "../../api/validation.js";

export class TradingAgentsStrategy {
  id = "tradingagents-vanilla";
  name = "TradingAgents Vanilla";
  description = "Minimally wrapped TauricResearch TradingAgents control strategy.";
  deterministic = false;
  controlGroup = true;

  constructor({ repoPath, python = "python3", runnerPath, timeoutMs = 300_000, logger = console } = {}) {
    this.repoPath = repoPath;
    this.python = python;
    this.runnerPath = runnerPath;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.available = Boolean(repoPath);
    this.unavailableReason = this.available
      ? null
      : "Set FINANCE_TRADINGAGENTS_REPO to an installed TauricResearch/TradingAgents checkout";
  }

  async analyze({ symbol, date = new Date().toISOString().slice(0, 10), modelConfig = {} }) {
    if (!this.available) throw new FinanceError(this.unavailableReason, { code: "STRATEGY_UNAVAILABLE", status: 503 });
    const output = await invokePython({
      executable: this.python,
      runnerPath: this.runnerPath,
      cwd: this.repoPath,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      input: { repoPath: path.resolve(this.repoPath), symbol, date, modelConfig },
    });
    const recommendation = String(output.decision ?? output.finalRecommendation ?? "HOLD").toUpperCase();
    const signal = recommendation.includes("BUY") ? "BUY" : recommendation.includes("SELL") ? "SELL" : "HOLD";
    const score = signal === "BUY" ? 0.65 : signal === "SELL" ? -0.65 : 0;
    return {
      signal,
      score,
      confidence: Number.isFinite(output.confidence) ? output.confidence : 0.6,
      timeHorizon: output.timeHorizon ?? "30d",
      thesis: String(output.finalRecommendation ?? output.decision ?? "TradingAgents returned no narrative."),
      evidence: output.evidence ?? [],
      analystOutputs: output.analystOutputs ?? null,
      debate: output.debate ?? null,
      models: output.models ?? [],
      costs: output.costs ?? { tokens: 0, apiCost: 0, currency: "USD" },
      metadata: { upstream: "TauricResearch/TradingAgents", rawState: output.state ?? null },
    };
  }
}

function invokePython({ executable, runnerPath, cwd, timeoutMs, input, logger }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [runnerPath], {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new FinanceError("TradingAgents timed out", { code: "TRADINGAGENTS_TIMEOUT", status: 504 }));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      logger.error(`[finance-lab] TradingAgents could not start (${error.code ?? "spawn error"})`);
      reject(new FinanceError("TradingAgents could not start", {
        code: "TRADINGAGENTS_START_FAILED",
        status: 503,
      }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.error(`[finance-lab] TradingAgents exited with code ${code}; diagnostics were withheld from clients`);
        reject(new FinanceError("TradingAgents failed; inspect the Finance Lab server logs", {
          code: "TRADINGAGENTS_FAILED",
          status: 502,
        }));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new FinanceError("TradingAgents returned invalid JSON", {
          code: "TRADINGAGENTS_INVALID_OUTPUT",
          status: 502,
        }));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
