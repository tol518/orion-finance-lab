const DEFAULT_POLICY = Object.freeze({
  maxPositionPct: 0.1,
  maxGrossExposurePct: 1,
  maxOrderPct: 0.1,
  maxDailyLossPct: 0.03,
  maxDrawdownPct: 0.2,
  minCashReservePct: 0.05,
  maxLeverage: 1,
  allowedAssetClasses: ["EQUITY", "ETF"],
  allowedSymbols: [],
  environment: "paper",
});

export class RiskEngine {
  constructor(policy = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  evaluate({ proposal, portfolio, quote, executionCosts = {} }) {
    const policy = this.policy;
    const reasons = [];
    const requestedQuantity = proposal.requestedQuantity;
    const price = Number(quote.price);
    const portfolioValue = Number(portfolio.totalValue);
    const currentPosition = portfolio.positions.find((position) => position.symbol === proposal.symbol);
    const heldQuantity = Number(currentPosition?.quantity ?? 0);
    const currentPositionValue = Number(currentPosition?.marketValue ?? 0);
    let approvedQuantity = requestedQuantity;

    if (policy.environment !== "paper" || portfolio.mode !== "paper") {
      return rejected("Finance Lab permits paper execution only", { proposal, portfolio, policy });
    }
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(portfolioValue) || portfolioValue <= 0) {
      return rejected("A valid quote and portfolio value are required", { proposal, portfolio, policy });
    }
    if (policy.allowedSymbols.length > 0 && !policy.allowedSymbols.includes(proposal.symbol)) {
      return rejected(`${proposal.symbol} is outside the allowed-symbol list`, { proposal, portfolio, policy });
    }
    const assetClass = typeof quote.assetType === "string" ? quote.assetType.trim().toUpperCase() : "";
    if (!assetClass) {
      return rejected("A known asset class is required", { proposal, portfolio, policy });
    }
    if (!policy.allowedAssetClasses.includes(assetClass)) {
      return rejected(`${assetClass} is not an allowed asset class`, { proposal, portfolio, policy });
    }
    if (proposal.side === "SELL") {
      approvedQuantity = Math.min(requestedQuantity, heldQuantity);
      if (approvedQuantity < requestedQuantity) reasons.push("Sell quantity reduced to the held position");
      if (approvedQuantity <= 0) {
        return rejected("No position is available to sell", { proposal, portfolio, policy });
      }
    } else {
      if (Number.isFinite(portfolio.dailyReturn) && portfolio.dailyReturn <= -policy.maxDailyLossPct) {
        return rejected("Daily loss limit has been reached", { proposal, portfolio, policy });
      }
      if (Number.isFinite(portfolio.drawdown) && portfolio.drawdown <= -policy.maxDrawdownPct) {
        return rejected("Portfolio drawdown limit has been reached", { proposal, portfolio, policy });
      }
      const slippageRate = Math.max(0, Number(executionCosts.slippageBps ?? 0)) / 10_000;
      const feeRate = Math.max(0, Number(executionCosts.feeBps ?? 0)) / 10_000;
      const minimumFee = Math.max(0, Number(executionCosts.minimumFee ?? 0));
      const fillPrice = price * (1 + slippageRate);
      const variableCostPerShare = fillPrice - price + fillPrice * feeRate;
      const costAdjustedValue = Math.max(0, portfolioValue - minimumFee);
      const exposureLimit = Math.min(policy.maxGrossExposurePct, policy.maxLeverage);
      const maxOrderQuantity = portfolioValue * policy.maxOrderPct / fillPrice;
      const maxPositionQuantity = Math.max(
        0,
        (costAdjustedValue * policy.maxPositionPct - currentPositionValue) /
          (price + policy.maxPositionPct * variableCostPerShare),
      );
      const maxGrossQuantity = Math.max(
        0,
        (costAdjustedValue * exposureLimit - portfolio.grossExposure) /
          (price + exposureLimit * variableCostPerShare),
      );
      const cashBudget = Math.max(
        0,
        portfolio.cash - portfolioValue * policy.minCashReservePct - minimumFee,
      );
      const maxCashQuantity = cashBudget / (fillPrice * (1 + feeRate));
      approvedQuantity = Math.min(
        requestedQuantity,
        maxOrderQuantity,
        maxPositionQuantity,
        maxGrossQuantity,
        maxCashQuantity,
      );
      if (approvedQuantity < requestedQuantity) {
        reasons.push("Buy quantity reduced by position, exposure, order, or cash-reserve limits");
      }
      if (approvedQuantity <= 0) {
        return rejected("Risk limits leave no permitted buy quantity", { proposal, portfolio, policy });
      }
    }

    approvedQuantity = floorQuantity(approvedQuantity);
    const status = approvedQuantity < requestedQuantity ? "RESIZED" : "APPROVED";
    return {
      status,
      approvedQuantity,
      reasons: reasons.length ? reasons : ["All deterministic risk checks passed"],
      policy,
      snapshot: snapshot(proposal, portfolio, quote),
    };
  }

  state(portfolio) {
    const grossExposurePct = portfolio.totalValue ? portfolio.grossExposure / portfolio.totalValue : 0;
    const largestPositionPct = portfolio.totalValue
      ? Math.max(0, ...portfolio.positions.map((position) => Math.abs(position.marketValue) / portfolio.totalValue))
      : 0;
    return {
      mode: "paper",
      policy: this.policy,
      metrics: {
        portfolioValue: portfolio.totalValue,
        grossExposure: portfolio.grossExposure,
        grossExposurePct,
        largestPositionPct,
        cashReservePct: portfolio.totalValue ? portfolio.cash / portfolio.totalValue : 0,
        dailyReturn: portfolio.dailyReturn,
        drawdown: portfolio.drawdown,
      },
      breaches: [
        Number.isFinite(portfolio.dailyReturn) && portfolio.dailyReturn <= -this.policy.maxDailyLossPct ? "MAX_DAILY_LOSS" : null,
        Number.isFinite(portfolio.drawdown) && portfolio.drawdown <= -this.policy.maxDrawdownPct ? "MAX_DRAWDOWN" : null,
        largestPositionPct > this.policy.maxPositionPct ? "MAX_POSITION" : null,
        grossExposurePct > this.policy.maxGrossExposurePct
          ? "MAX_GROSS_EXPOSURE"
          : null,
        grossExposurePct > this.policy.maxLeverage ? "MAX_LEVERAGE" : null,
      ].filter(Boolean),
    };
  }
}

function rejected(reason, { proposal, portfolio, policy }) {
  return {
    status: "REJECTED",
    approvedQuantity: 0,
    reasons: [reason],
    policy,
    snapshot: snapshot(proposal, portfolio, null),
  };
}

function snapshot(proposal, portfolio, quote) {
  return {
    proposalId: proposal.id,
    portfolioId: portfolio.id,
    symbol: proposal.symbol,
    side: proposal.side,
    quote: quote ? { price: quote.price, assetType: quote.assetType, marketTime: quote.marketTime } : null,
    portfolio: {
      totalValue: portfolio.totalValue,
      cash: portfolio.cash,
      grossExposure: portfolio.grossExposure,
      dailyReturn: portfolio.dailyReturn,
      drawdown: portfolio.drawdown,
    },
  };
}

function floorQuantity(value) {
  return Math.floor(Number(value) * 1_000_000) / 1_000_000;
}

export { DEFAULT_POLICY };
