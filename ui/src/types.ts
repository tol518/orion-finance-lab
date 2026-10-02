export type Position = {
  symbol: string;
  quantity: number;
  averageCost: number;
  price: number;
  marketValue: number;
  unrealisedPnl: number;
  dailyPnl: number;
  quoteError: string | null;
};

export type Portfolio = {
  id: string;
  name: string;
  mode: "paper";
  currency: string;
  cash: number;
  initialCash: number | null;
  totalValue: number;
  grossExposure: number;
  dailyPnl: number;
  dailyReturn: number;
  totalReturn: number | null;
  benchmarkReturn: number | null;
  alpha: number | null;
  drawdown: number | null;
  benchmarkSymbol: string;
  createdAt: string;
  positions: Position[];
  broker: {
    name: "local" | "ibkr";
    environment: "paper";
    connected: boolean;
    readOnly: boolean;
    accountIdMasked?: string;
    availableFunds?: number | null;
    buyingPower?: number | null;
    retrievedAt?: string;
  };
  performance: {
    observations: number;
    totalReturn: number | null;
    annualizedReturn: number | null;
    volatility: number | null;
    sharpe: number | null;
    sortino: number | null;
    maximumDrawdown: number | null;
  };
};

export type Trade = {
  id: string;
  decisionId: string;
  portfolioId: string;
  agentId: string;
  strategyId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  fee: number;
  executedAt: string;
};

export type Proposal = {
  id: string;
  decisionId: string;
  portfolioId: string;
  agentId: string;
  strategyId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  requestedQuantity: number;
  approvedQuantity: number | null;
  leadApprovedByAgentId: string | null;
  leadApprovedAt: string | null;
  status: string;
  thesis: string | null;
  createdAt: string;
};

export type BrokerOrder = {
  id: string;
  proposalId: string;
  portfolioId: string;
  agentId: string;
  broker: "ibkr";
  brokerOrderId: string | null;
  clientOrderId: number | null;
  accountMasked: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: string;
  status: "WORKING" | "FILLED" | "CANCELLED";
  brokerStatus: string | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  fee: number | null;
  orderId: string | null;
  executionIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type Prediction = {
  id: string;
  agentId: string;
  strategyId: string | null;
  symbol: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  expectedReturnMin: number;
  expectedReturnMax: number;
  horizonDays: number;
  confidence: number;
  thesis: string;
  createdAt: string;
  dueAt: string;
  result: null | {
    actualReturn: number;
    alpha: number | null;
    directionCorrect: boolean;
    rangeCorrect: boolean;
    evaluatedAt: string;
  };
};

export type AgentPerformance = {
  agentId: string;
  totalPredictions: number;
  evaluatedPredictions: number;
  pendingPredictions: number;
  directionalAccuracy: number | null;
  rangeAccuracy: number | null;
  averageActualReturn: number | null;
  averageAlpha: number | null;
  tradeCount: number;
  transactionFees: number;
  confidenceCalibration: {
    status: string;
    expectedCalibrationError: number | null;
    bins: Array<{
      from: number;
      to: number;
      count: number;
      averageConfidence: number;
      successRate: number | null;
      gap: number | null;
    }>;
  };
};

export type FinanceAgent = {
  agentId: string;
  displayName: string;
  role: string | null;
  assignedAt: string;
};

export type FinanceTeamMember = FinanceAgent & {
  rank: number;
  lead: boolean;
};

export type FinanceTeam = {
  id: string;
  name: string;
  portfolioId: string | null;
  leadAgentId: string | null;
  members: FinanceTeamMember[];
  createdAt: string;
};

export type TeamPortfolio = {
  teamId: string;
  teamName: string;
  leadAgentId: string | null;
  members: FinanceTeamMember[];
  createdAt: string;
  portfolio: Portfolio;
};

export type TeamPortfolioTotal = {
  portfolioCount: number;
  currency: string;
  cash: number;
  initialCash: number;
  totalValue: number;
  grossExposure: number;
  dailyPnl: number;
  dailyReturn: number;
  totalReturn: number | null;
  positions: Position[];
};

export type TeamPortfolios = {
  teams: TeamPortfolio[];
  total: TeamPortfolioTotal;
};

export type TeamTradingRun = {
  teamId: string;
  teamName: string;
  available: boolean;
  status: "IDLE" | "RUNNING" | "COMPLETED" | "STOPPED" | "FAILED";
  phase: string;
  message: string;
  researcherAgentId: string | null;
  traderAgentId: string | null;
  leadAgentId: string | null;
  proposalId: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
};

export type Strategy = {
  id: string;
  name: string;
  description: string;
  deterministic: boolean;
  controlGroup: boolean;
  available: boolean;
  unavailableReason: string | null;
  portfolioCount: number;
  tradeCount: number;
  totalReturn: number | null;
  fees: number;
};

export type Experiment = {
  id: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED";
  strategyId: string;
  agentId: string | null;
  portfolioId: string;
  benchmarkSymbol: string;
  initialCapital: number;
  startedAt: string;
};

export type RiskState = {
  mode: "paper";
  policy: Record<string, unknown> & {
    maxPositionPct: number;
    maxGrossExposurePct: number;
    maxDailyLossPct: number;
    maxDrawdownPct: number;
    minCashReservePct: number;
  };
  metrics: {
    portfolioValue: number;
    grossExposure: number;
    grossExposurePct: number;
    largestPositionPct: number;
    cashReservePct: number;
    dailyReturn: number;
    drawdown: number | null;
  };
  breaches: string[];
};

export type Overview = {
  mode: "paper" | "ibkr-paper-read-only" | "ibkr-paper-dry-run" | "ibkr-paper-live";
  generatedAt: string;
  portfolio: Portfolio;
  risk: RiskState;
  recentTrades: Trade[];
  recentProposals: Proposal[];
  recentBrokerOrders: BrokerOrder[];
  recentPredictions: Prediction[];
  experiments: Experiment[];
  agents: AgentPerformance[];
  financeAgents: FinanceAgent[];
  financeTeams: FinanceTeam[];
  teamPortfolios: TeamPortfolios;
  strategies: Strategy[];
};

export type OrderPreview = {
  mode: "dry-run";
  broker: "ibkr";
  decision: {
    status: string;
    approvedQuantity: number;
    reasons: string[];
  };
  preview: null | {
    accountIdMasked: string;
    orderId: number | null;
    whatIf: boolean;
    status: string | null;
    symbol: string;
    side: string;
    quantity: number;
    orderType: string;
    preview: null | {
      status: string;
      initMarginChange: number | null;
      maintMarginChange: number | null;
      commissionAndFees: number | null;
      commissionAndFeesCurrency: string;
      warningText: string;
      rejectReason: string;
    };
  };
};

export type LiveOrderResult = {
  mode: "live";
  broker: "ibkr";
  decision: {
    status: string;
    approvedQuantity: number;
    reasons: string[];
  };
  brokerOrder: BrokerOrder | null;
  trade: Trade | null;
};

export type ReconcileReport = {
  broker: "ibkr";
  checked: number;
  settled: LiveOrderResult["brokerOrder"][];
  stillWorking: LiveOrderResult["brokerOrder"][];
  retrievedAt?: string;
};

export type StrategyRun = {
  decisionId: string;
  evidenceManifestId: string;
  strategyId: string;
  symbol: string;
  signal: string;
  score: number;
  confidence: number;
  timeHorizon: string;
  thesis: string;
  metadata: Record<string, unknown>;
};
