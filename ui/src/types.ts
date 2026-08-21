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
  agentId: string;
  strategyId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  requestedQuantity: number;
  approvedQuantity: number | null;
  status: string;
  thesis: string | null;
  createdAt: string;
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

export type FinanceTeam = {
  id: string;
  name: string;
  members: FinanceAgent[];
  createdAt: string;
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
  mode: "paper" | "ibkr-paper-read-only";
  generatedAt: string;
  portfolio: Portfolio;
  risk: RiskState;
  recentTrades: Trade[];
  recentProposals: Proposal[];
  recentPredictions: Prediction[];
  experiments: Experiment[];
  agents: AgentPerformance[];
  financeAgents: FinanceAgent[];
  financeTeams: FinanceTeam[];
  strategies: Strategy[];
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
