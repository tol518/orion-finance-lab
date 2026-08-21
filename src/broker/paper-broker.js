import { FinanceError } from "../api/validation.js";

export class PaperBroker {
  constructor({ store, riskEngine, feeBps = 1, minimumFee = 0.25, slippageBps = 2 }) {
    this.store = store;
    this.riskEngine = riskEngine;
    this.feeBps = feeBps;
    this.minimumFee = minimumFee;
    this.slippageBps = slippageBps;
  }

  execute({ proposalId, portfolio, quote }) {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) {
      throw new FinanceError("Trade proposal not found", { code: "PROPOSAL_NOT_FOUND", status: 404 });
    }
    if (proposal.portfolioId !== portfolio.id) {
      throw new FinanceError("Proposal does not belong to this portfolio", {
        code: "PROPOSAL_PORTFOLIO_MISMATCH",
        status: 409,
      });
    }
    const decision = this.riskEngine.evaluate({
      proposal,
      portfolio,
      quote,
      executionCosts: {
        feeBps: this.feeBps,
        minimumFee: this.minimumFee,
        slippageBps: this.slippageBps,
      },
    });
    const notional = Number(quote.price) * decision.approvedQuantity;
    const fee = decision.approvedQuantity > 0
      ? Math.max(this.minimumFee, notional * this.feeBps / 10_000)
      : 0;
    return {
      decision,
      ...this.store.applyPaperDecision({
        proposal,
        decision,
        quotePrice: Number(quote.price),
        feeCents: Math.round(fee * 100),
        slippageBps: this.slippageBps,
      }),
    };
  }
}
