import { FinanceError } from "../api/validation.js";
import { OPERATOR_ACTOR, createActor } from "../service/finance-lab.js";

const RUN_TIMEOUT_MS = 5 * 60_000;

export class TeamTradingCoordinator {
  constructor({ service, agentRuntime, logger = console, timeoutMs = RUN_TIMEOUT_MS }) {
    this.service = service;
    this.agentRuntime = agentRuntime ?? null;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.states = new Map();
    this.controls = new Map();
    this.running = new Map();
  }

  list() {
    return this.service.listFinanceTeams(OPERATOR_ACTOR).map((team) =>
      this.states.get(team.id) ?? idleState(team, Boolean(this.agentRuntime)),
    );
  }

  get(teamId) {
    const team = this.#team(teamId);
    return this.states.get(team.id) ?? idleState(team, Boolean(this.agentRuntime));
  }

  start(teamId) {
    if (!this.agentRuntime) {
      throw new FinanceError("Autonomous trading requires the Orion agent runtime", {
        code: "FINANCE_AGENT_RUNTIME_UNAVAILABLE",
        status: 503,
      });
    }
    const team = this.#team(teamId);
    if (this.controls.has(team.id)) {
      throw new FinanceError("This finance team is already trading", {
        code: "FINANCE_TEAM_TRADING_ACTIVE",
        status: 409,
      });
    }
    const roles = resolveRoles(team);
    const now = new Date().toISOString();
    const control = { stopped: false, activeAgentId: null, activeScope: null };
    this.controls.set(team.id, control);
    this.#set(team, roles, {
      status: "RUNNING",
      phase: "RESEARCHING",
      message: `${roles.researcher.displayName} is researching a paper-trade opportunity.`,
      startedAt: now,
      completedAt: null,
      proposalId: null,
      error: null,
    });
    const running = this.#run(team, roles, control)
      .catch((error) => this.#finishAfterError(team, roles, control, error))
      .finally(() => {
        this.controls.delete(team.id);
        this.running.delete(team.id);
      });
    this.running.set(team.id, running);
    return this.get(team.id);
  }

  async stop(teamId) {
    const team = this.#team(teamId);
    const control = this.controls.get(team.id);
    if (!control) return this.get(team.id);
    control.stopped = true;
    const current = this.states.get(team.id);
    this.states.set(team.id, {
      ...current,
      phase: "STOPPING",
      message: "Stopping after the active agent turn.",
      updatedAt: new Date().toISOString(),
    });
    if (control.activeAgentId && control.activeScope) {
      await this.agentRuntime.abortTurn({
        agentId: control.activeAgentId,
        scope: control.activeScope,
      }).catch(() => undefined);
    }
    return this.get(team.id);
  }

  async waitForTeam(teamId) {
    await this.running.get(teamId);
    return this.get(teamId);
  }

  async close() {
    await Promise.all([...this.controls.keys()].map((teamId) => this.stop(teamId)));
    await Promise.allSettled([...this.running.values()]);
  }

  async #run(team, roles, control) {
    const actors = roleActors(roles);
    const context = await this.#context(team);
    const research = await this.#turn(team, roles, control, {
      agent: roles.researcher,
      scope: `team-${team.id}-research`,
      label: `Finance · ${team.name} · Research`,
      message: researchPrompt(team, roles, context),
    });
    this.#assertRunning(control);

    // The lead owns the thesis; a trader who only executes approved strategies cannot
    // invent it before the lead has seen the research. Planning is not order approval.
    this.#set(team, roles, {
      phase: "PLANNING",
      message: `${roles.lead.displayName} is setting the strategy from the research.`,
    });
    const strategy = await this.#turn(team, roles, control, {
      agent: roles.lead,
      scope: `team-${team.id}-strategy`,
      label: `Finance · ${team.name} · Strategy`,
      message: strategyPrompt(team, roles, research, context),
    });
    this.#assertRunning(control);

    this.#set(team, roles, {
      phase: "PROPOSING",
      message: `${roles.trader.displayName} is reviewing the research and creating a proposal.`,
    });
    const proposalDecisionText = await this.#turn(team, roles, control, {
      agent: roles.trader,
      scope: `team-${team.id}-proposal`,
      label: `Finance · ${team.name} · Proposal`,
      message: proposalPrompt(team, roles, research, strategy, context),
    });
    this.#assertRunning(control);

    const decision = parseDecision(proposalDecisionText, "FINANCE_PROPOSAL");
    if (decision.decision === "NO_TRADE") {
      this.#complete(team, roles, {
        phase: "NO_TRADE",
        message: decision.reason || `${roles.trader.displayName} found no justified paper trade.`,
      });
      return;
    }
    if (decision.decision !== "PROPOSE") {
      throw invalidDecision("The team trader did not return a valid proposal decision");
    }
    // Own this cycle's draft directly: discovering recent tool drafts can adopt another
    // session's order and discard the evidence returned in this trader's decision.
    const proposal = await this.service.createTradeProposal(actors.trader, {
      portfolioId: team.portfolioId,
      symbol: decision.symbol,
      side: decision.side,
      quantity: decision.quantity,
      thesis: decision.thesis,
      evidence: decision.evidence,
    });

    this.#set(team, roles, {
      phase: "REVIEWING",
      proposalId: proposal.id,
      message: `${roles.lead.displayName} is reviewing ${proposal.symbol} as team lead.`,
    });
    const reviewContext = await this.#context(team);
    const quote = await this.service.getQuote(actors.lead, proposal.symbol);
    const risk = this.service.riskEngine.evaluate({ proposal, portfolio: reviewContext.portfolio, quote: quote.data });
    const evidence = this.service.store.getEvidenceManifest(proposal.evidenceManifestId);
    const reviewDecisionText = await this.#turn(team, roles, control, {
      agent: roles.lead,
      scope: `team-${team.id}-approval`,
      label: `Finance · ${team.name} · Lead review`,
      message: approvalPrompt(team, roles, proposal, research, strategy, reviewContext, quote, risk, evidence),
    });
    this.#assertRunning(control);

    let reviewed = this.service.store.getProposal(proposal.id);
    let reviewReason = "The team lead recorded a rejection.";
    if (reviewed?.status === "PROPOSED") {
      const decision = parseReviewDecision(reviewDecisionText);
      reviewReason = decision.reason || reviewReason;
      if (decision.decision === "APPROVE") {
        reviewed = await this.service.approveTradeProposal(actors.lead, proposal.id);
      } else {
        reviewed = await this.service.rejectTradeProposal(actors.lead, proposal.id);
      }
    }
    if (reviewed?.status === "REJECTED") {
      // A tool may have already persisted the lead's decision. Keep its rationale
      // without trying to reject the now-resolved proposal a second time.
      try {
        reviewReason = parseReviewDecision(reviewDecisionText).reason || reviewReason;
      } catch {
        reviewReason = String(reviewDecisionText ?? reviewReason).slice(0, 2000) || reviewReason;
      }
      this.#complete(team, roles, {
        phase: "REJECTED",
        proposalId: proposal.id,
        message: `${roles.lead.displayName}, the team leader, rejected ${proposal.symbol}: ${reviewReason}`,
      });
      return;
    }
    if (reviewed?.status !== "LEAD_APPROVED") {
      throw new FinanceError("The team lead finished without approving or rejecting the proposal", {
        code: "FINANCE_AUTOMATION_REVIEW_MISSING",
        status: 409,
      });
    }

    this.#set(team, roles, {
      phase: "SUBMITTING",
      proposalId: proposal.id,
      message: `${roles.trader.displayName} is submitting the approved paper order.`,
    });
    const submissionDecisionText = await this.#turn(team, roles, control, {
      agent: roles.trader,
      scope: `team-${team.id}-submission`,
      label: `Finance · ${team.name} · Submission`,
      message: submissionPrompt(team, roles, reviewed),
    });
    this.#assertRunning(control);

    let outcome = this.#executionOutcome(proposal.id);
    if (!outcome && this.service.store.getProposal(proposal.id)?.status === "LEAD_APPROVED") {
      const decision = parseDecision(submissionDecisionText, "FINANCE_SUBMISSION");
      if (decision.decision !== "SUBMIT") {
        throw invalidDecision("The assigned trader did not authorize submission of the approved proposal");
      }
      await this.service.executePaperTrade(actors.trader, proposal.id);
      outcome = this.#executionOutcome(proposal.id);
    }
    // Tools and coordinator execution share one outcome projection. Read the persisted
    // risk event when the tool already ran, so a rejected order is never shown as success.
    if (!outcome) {
      throw new FinanceError("The team trader finished without submitting the approved paper order", {
        code: "FINANCE_AUTOMATION_SUBMISSION_MISSING",
        status: 409,
      });
    }
    this.#complete(team, roles, outcome);
  }

  #executionOutcome(proposalId) {
    const submitted = this.service.store.getProposal(proposalId);
    if (!submitted || submitted.status === "PROPOSED") return null;
    // A prior preview/refusal cannot override a later broker claim or booked fill.
    // Claims remain unresolved after transport failures and must be reconciled first.
    if (["SUBMITTING", "WORKING", "APPROVED", "RESIZED"].includes(submitted.status)) {
      const working = submitted.status === "WORKING" || submitted.status === "SUBMITTING";
      return {
        phase: working ? "WORKING" : "COMPLETED",
        proposalId,
        message: working
          ? submitted.status === "SUBMITTING"
            ? `${submitted.symbol} broker submission is unresolved; reconcile with IBKR Paper before retrying.`
            : `${submitted.symbol} was submitted to IBKR Paper and is still working.`
          : `${submitted.symbol} completed the autonomous paper-trading workflow.`,
      };
    }
    const result = this.service.store.getProposalExecutionResult(proposalId);
    const executionDecision = result ?? this.service.store.getBrokerSubmissionDecision(proposalId);
    if (submitted?.status === "REJECTED" || executionDecision?.status === "REJECTED") {
      return {
        phase: "REJECTED",
        proposalId,
        message: executionDecision?.status === "REJECTED"
          ? `Deterministic risk rejected ${submitted.symbol}: ${executionDecision.reasons.join("; ")}`
          : `${submitted.symbol} was rejected during paper execution.`,
      };
    }
    if (submitted.status === "LEAD_APPROVED" && result?.mode === "dry-run" && result.previewed) {
      return {
        phase: "PREVIEWED",
        proposalId,
        message: `${submitted.symbol} was previewed in IBKR Paper dry-run mode; no order was submitted.`,
      };
    }
    return null;
  }

  async #context(team) {
    const portfolio = await this.service.getPortfolio(OPERATOR_ACTOR, team.portfolioId, { recordValuation: false });
    return {
      capturedAt: new Date().toISOString(),
      portfolio: {
        id: portfolio.id,
        mode: portfolio.mode,
        currency: portfolio.currency,
        cash: portfolio.cash,
        totalValue: portfolio.totalValue,
        grossExposure: portfolio.grossExposure,
        dailyReturn: portfolio.dailyReturn,
        drawdown: portfolio.drawdown,
        positions: portfolio.positions,
      },
      risk: this.service.riskEngine.state(portfolio),
      execution: this.service.ibkrBroker ? `ibkr-paper-${this.service.ibkrExecution}` : "local-paper",
    };
  }

  async #turn(team, roles, control, { agent, scope, label, message }) {
    this.#assertRunning(control);
    control.activeAgentId = agent.agentId;
    control.activeScope = scope;
    try {
      return await this.agentRuntime.runTurn({
        agentId: agent.agentId,
        scope,
        label,
        message,
        timeoutMs: this.timeoutMs,
      });
    } finally {
      control.activeAgentId = null;
      control.activeScope = null;
    }
  }

  #finishAfterError(team, roles, control, error) {
    // An aborted or failed turn cannot retract a tool's committed fill or broker claim.
    // Report persisted execution before treating the remaining workflow as stopped/failed.
    const current = this.states.get(team.id);
    if (current?.proposalId && (control.stopped || current.phase === "SUBMITTING")) {
      const outcome = this.#executionOutcome(current.proposalId);
      if (outcome) {
        this.#complete(team, roles, outcome);
        return;
      }
    }
    if (control.stopped) {
      this.#complete(team, roles, {
        status: "STOPPED",
        phase: "STOPPED",
        message: "Autonomous trading was stopped before the next stage.",
      });
      return;
    }
    this.logger.error(`[finance-lab] autonomous team trading failed for ${team.id}: ${error.message}`);
    this.#complete(team, roles, {
      status: "FAILED",
      phase: "FAILED",
      message: "The autonomous paper-trading cycle failed.",
      error: String(error?.message ?? error),
    });
  }

  #complete(team, roles, patch) {
    // Preserve refusals in the existing SQLite audit: in-memory dashboard state is lost
    // on restart, hiding whether evidence, role handoff, or risk blocked a cycle.
    this.service.store.recordAudit({
      action: "finance.team.trading.complete",
      actorId: OPERATOR_ACTOR.actorId,
      portfolioId: team.portfolioId,
      success: patch.status !== "FAILED",
      payload: { teamId: team.id, phase: patch.phase, proposalId: patch.proposalId ?? this.states.get(team.id)?.proposalId ?? null, reason: String(patch.error ?? patch.message).slice(0, 2000) },
    });
    this.#set(team, roles, {
      status: patch.status ?? "COMPLETED",
      completedAt: new Date().toISOString(),
      ...patch,
    });
  }

  #set(team, roles, patch) {
    const current = this.states.get(team.id) ?? idleState(team, Boolean(this.agentRuntime));
    this.states.set(team.id, {
      ...current,
      available: Boolean(this.agentRuntime),
      researcherAgentId: roles.researcher.agentId,
      traderAgentId: roles.trader.agentId,
      leadAgentId: roles.lead.agentId,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  #assertRunning(control) {
    if (control.stopped) {
      throw new FinanceError("Autonomous trading was stopped", {
        code: "FINANCE_TEAM_TRADING_STOPPED",
        status: 409,
      });
    }
  }

  #team(teamId) {
    const team = this.service.listFinanceTeams(OPERATOR_ACTOR).find((entry) => entry.id === teamId);
    if (!team) {
      throw new FinanceError("Finance team not found", {
        code: "FINANCE_TEAM_NOT_FOUND",
        status: 404,
      });
    }
    return team;
  }
}

function resolveRoles(team) {
  const lead = team.members.find((member) => member.rank === 1 && member.lead);
  const trader = team.members.find((member) => !member.lead && /(^|\W)trader(\W|$)/i.test(member.role ?? ""));
  const researchers = team.members.filter((member) => /research/i.test(member.role ?? ""));
  const researcher = researchers.find((member) => member.agentId !== trader?.agentId) ?? researchers[0];
  if (!lead || !trader || !researcher) {
    throw new FinanceError("Autonomous trading needs a rank-1 lead, a Finance Researcher, and a non-lead Trader", {
      code: "FINANCE_TEAM_AUTOMATION_ROLES_MISSING",
      status: 409,
      details: {
        lead: Boolean(lead),
        researcher: Boolean(researcher),
        trader: Boolean(trader),
      },
    });
  }
  return { lead, researcher, trader };
}

function idleState(team, available) {
  return {
    teamId: team.id,
    teamName: team.name,
    available,
    status: "IDLE",
    phase: "IDLE",
    message: available ? "Ready for an autonomous paper-trading cycle." : "Orion agent runtime is unavailable.",
    researcherAgentId: null,
    traderAgentId: null,
    leadAgentId: team.leadAgentId,
    proposalId: null,
    error: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };
}

function cycleContext(team, roles, context) {
  return [
    `Team roles: ${JSON.stringify(team.members.map(({ displayName, role, lead }) => ({ displayName, role, lead })))}`,
    `Current paper portfolio, risk limits, and execution mode: ${JSON.stringify(context)}`,
    "Supported orders are cash-funded BUY of permitted equities/ETFs and SELL of an existing held position. SELL cannot open a short. Options, margin shorts, and atomic paired orders are not supported. Do not recommend unsupported instruments as executable trades.",
    "Team disposition is an analytical lens, not an extra execution veto. A neutral disposition can choose either direction without a permanent bias; do not invent a requirement for a beta-neutral pair unless the lead explicitly sets that mandate. A bearish disposition prioritizes downside evidence and defensive opportunities rather than requiring a short in every cycle. Preserve the lead's actual mandate.",
    "Seek a positive expected risk/reward with a defined horizon and invalidation condition, not certainty or absence of counterarguments. Express uncertainty through a smaller paper position within existing limits. Never force a trade if evidence is insufficient or hard risk limits block it.",
    `Stage ownership: ${roles.researcher.displayName} researches; ${roles.lead.displayName} sets strategy; ${roles.trader.displayName} drafts; the lead approves the concrete proposal; that same trader submits. A draft does not require prior order approval.`,
    "The coordinator owns Finance Lab persistence, role enforcement, and final deterministic risk checks. Missing model-visible Finance tools are not a reason to stop; use available reliable research tools and the supplied portfolio context. Never ask the human to repeat approval for this authorized paper cycle.",
  ].join("\n\n");
}

function researchPrompt(team, roles, context) {
  return [
    `You are ${roles.researcher.displayName}, the Finance Researcher for the ${team.name} team.`,
    "The human operator clicked Start Trading and authorized this PAPER-TRADING cycle.",
    cycleContext(team, roles, context),
    "Screen up to three plausible, executable candidates before concluding no trade; do not stop after the first weak setup. Use current market, news, fundamentals, and browser tools. For each candidate provide source URLs and timestamps, symbol, supported order direction, latest verified price, catalyst, counterevidence, horizon, and invalidation. Distinguish verified facts from assumptions; never fabricate evidence.",
    `Rank the candidates for ${roles.lead.displayName}, explaining which fit the team's disposition and actual portfolio. If none is defensible, explain the concrete blockers and what evidence would change that decision. Do not create, approve, or execute orders. Never use a live account.`,
  ].join("\n\n");
}

function strategyPrompt(team, roles, research, context) {
  return [
    `You are ${roles.lead.displayName}, rank 1 and team lead for ${team.name}. Set the strategy before your trader drafts an order.`,
    cycleContext(team, roles, context),
    `Research handoff:\n${String(research ?? "No research text was returned.").slice(0, 20_000)}`,
    `Evaluate the candidates independently. Give ${roles.trader.displayName} a concrete supported direction, thesis, sizing rationale, horizon, and invalidation, or a specific no-trade rationale. Resolve material evidence gaps with available tools. Ordinary uncertainty or one counterargument alone does not require rejecting every candidate.`,
    "This stage authorizes drafting a proposal, not execution. Do not create or approve an order here; you will review the trader's concrete proposal next. Paper trading only.",
  ].join("\n\n");
}

function proposalPrompt(team, roles, research, strategy, context) {
  return [
    `You are ${roles.trader.displayName}, the assigned non-lead Trader for ${team.name}. Draft a proposal under the lead's strategy.`,
    cycleContext(team, roles, context),
    `Research handoff:\n${String(research ?? "No research text was returned.").slice(0, 20_000)}`,
    `Strategy from ${roles.lead.displayName}:\n${String(strategy ?? "No strategy text was returned.").slice(0, 20_000)}`,
    "Choose at most one justified, supported paper order. A small position can express a defensible but uncertain thesis. Check size against the supplied portfolio and policy. Return the structured decision below; do not call finance_create_trade_proposal, approve, or submit here. The coordinator creates this cycle's draft with your returned evidence before lead review. Do not reject a draft because it has not yet passed that next approval stage.",
    'End with exactly one line: FINANCE_PROPOSAL: {"decision":"PROPOSE","symbol":"SYMBOL","side":"BUY","quantity":1,"thesis":"sources, catalyst, counterevidence, horizon, sizing and invalidation","evidence":[]}. Replace the example fields with your actual supported order; side is BUY or SELL and evidence contains verified source details.',
    'If no supported candidate is justified, end with exactly one line: FINANCE_PROPOSAL: {"decision":"NO_TRADE","reason":"specific evidence or risk blocker, alternatives considered, and what would change the decision"}',
    "Paper trading only; never use a live account.",
  ].join("\n\n");
}

function approvalPrompt(team, roles, proposal, research, strategy, context, quote, risk, evidence) {
  return [
    `You are ${roles.lead.displayName}, rank 1 and team lead for ${team.name}. Approve or reject the concrete proposal from ${roles.trader.displayName}.`,
    cycleContext(team, roles, context),
    `Full proposal including thesis: ${JSON.stringify(proposal)}`,
    `Stored proposal evidence: ${JSON.stringify(evidence)}`,
    `Research handoff:\n${String(research ?? "No research text was returned.").slice(0, 20_000)}`,
    `Your strategy:\n${String(strategy ?? "No strategy text was returned.").slice(0, 20_000)}`,
    `Current source-stamped quote: ${JSON.stringify(quote)}`,
    `Indicative deterministic sizing check (execution rechecks limits and costs): ${JSON.stringify(risk)}`,
    "Make an independent decision on thesis, mandate, evidence, and portfolio risk. Resolve a material missing fact with available tools rather than asking the human to supply this handoff again. Approve when the evidence justifies a bounded paper position; require a concrete thesis, mandate, evidence, or risk failure to reject. Never bypass hard limits or approve just to generate activity.",
    'End with exactly one line: FINANCE_REVIEW: {"decision":"APPROVE","reason":"concise evidence and risk rationale"} or FINANCE_REVIEW: {"decision":"REJECT","reason":"specific blocker and what would change it"}',
    "Do not submit the order yourself. Only the proposing trader may submit after approval. Paper trading only.",
  ].join("\n\n");
}

function submissionPrompt(team, roles, proposal) {
  return [
    `You are ${roles.trader.displayName}, the assigned Trader for ${team.name}.`,
    `The rank-1 lead ${roles.lead.displayName} approved this proposal: ${JSON.stringify(proposal)}. The human operator already authorized this PAPER cycle; do not ask again.`,
    'If the approved order should now be submitted, end with exactly one line: FINANCE_SUBMISSION: {"decision":"SUBMIT"}',
    "Deterministic risk checks and the paper broker remain authoritative. Do not reopen the strategy debate unless a material new fact invalidates the approved thesis.",
    "Never route to a live account. Report results accurately and do not retry an ambiguous broker submission.",
  ].join("\n\n");
}

function roleActors(roles) {
  const read = ["market.read", "portfolio.read", "strategy.run", "prediction.write"];
  return {
    researcher: agentActor(roles.researcher, read),
    trader: agentActor(roles.trader, [...read, "trade.propose", "trade.execute"]),
    lead: agentActor(roles.lead, [...read, "trade.execute"]),
  };
}

function agentActor(agent, permissions) {
  return createActor({
    actorId: `openclaw:${agent.agentId}`,
    agentId: agent.agentId,
    permissions,
  });
}

function parseDecision(text, tag) {
  const source = String(text ?? "");
  const marker = `${tag}:`;
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex < 0) throw invalidDecision(`Agent response is missing ${tag}`);
  const tail = source.slice(markerIndex + marker.length);
  const start = tail.indexOf("{");
  if (start < 0) throw invalidDecision(`Agent response has no JSON after ${tag}`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < tail.length; index += 1) {
    const char = tail[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(tail.slice(start, index + 1));
      } catch {
        throw invalidDecision(`Agent response contains invalid JSON after ${tag}`);
      }
    }
  }
  throw invalidDecision(`Agent response contains incomplete JSON after ${tag}`);
}

function parseReviewDecision(text) {
  const decision = parseDecision(text, "FINANCE_REVIEW");
  if (!["APPROVE", "REJECT"].includes(decision.decision)) {
    throw invalidDecision("The team lead must explicitly approve or reject the proposal");
  }
  // Protocol failures are failures, not investment vetoes. Leave the draft unresolved
  // and never submit unless the lead has explicitly approved it.
  return decision;
}

function invalidDecision(message) {
  return new FinanceError(message, {
    code: "FINANCE_AUTOMATION_DECISION_INVALID",
    status: 409,
  });
}
