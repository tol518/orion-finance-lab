import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BookOpenCheck,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  History,
  LineChart,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Target,
  Trash2,
  UserPlus,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import type {
  AgentPerformance,
  Experiment,
  FinanceAgent,
  FinanceTeam,
  Overview,
  Portfolio,
  Prediction,
  Proposal,
  Strategy,
  StrategyRun,
  Trade,
} from "./types";

const TABS = ["Overview", "Portfolio", "Trades", "Predictions", "Agents", "Strategies", "Experiments", "Analytics"] as const;
type Tab = (typeof TABS)[number];

export default function FinanceLabApp({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [researchResult, setResearchResult] = useState<StrategyRun | null>(null);

  const request = useCallback(async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(`${apiBase}${path}`, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
    return payload.data as T;
  }, [apiBase]);

  const load = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      setOverview(await request<Overview>("/overview"));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <StateMessage icon={<LoaderCircle className="spin" />} title="Opening Finance Lab" detail="Loading paper portfolios and risk state." />;
  if (!overview) return <StateMessage icon={<ShieldCheck />} title="Finance Lab is unavailable" detail={error ?? "The plugin did not return a dashboard."} action={<button className="button" onClick={() => void load()}><RefreshCw size={15} /> Retry</button>} />;

  const refresh = () => void load(true);
  return (
    <section className="finance-shell">
      <header className="finance-header">
        <div>
          <div className="eyebrow">ORION / FINANCE LAB</div>
          <div className="title-row">
            <h1>Finance Lab</h1>
            <span className="paper-badge"><ShieldCheck size={13} /> {overview.mode === "ibkr-paper-read-only" ? "IBKR PAPER / READ ONLY" : "LOCAL PAPER"}</span>
          </div>
          <p>Auditable research, deterministic risk, and measurable agent track records.</p>
        </div>
        <button className="icon-button" title="Refresh finance data" onClick={refresh} disabled={refreshing}>
          <RefreshCw size={17} className={refreshing ? "spin" : ""} />
        </button>
      </header>

      {error && <div className="error-banner"><span>{error}</span><button title="Dismiss" onClick={() => setError(null)}><X size={15} /></button></div>}

      <nav className="tabs" aria-label="Finance Lab views">
        {TABS.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}
      </nav>

      {tab === "Overview" && <OverviewView overview={overview} request={request} refresh={refresh} onResearch={setResearchResult} onNavigate={setTab} />}
      {tab === "Portfolio" && <PortfolioView portfolio={overview.portfolio} />}
      {tab === "Trades" && <TradesView trades={overview.recentTrades} proposals={overview.recentProposals} currency={overview.portfolio.currency} request={request} refresh={refresh} />}
      {tab === "Predictions" && <PredictionsView predictions={overview.recentPredictions} request={request} refresh={refresh} />}
      {tab === "Agents" && <AgentsView agents={overview.agents} financeAgents={overview.financeAgents} financeTeams={overview.financeTeams} request={request} refresh={refresh} />}
      {tab === "Strategies" && <StrategiesView strategies={overview.strategies} request={request} onResearch={setResearchResult} />}
      {tab === "Experiments" && <ExperimentsView experiments={overview.experiments} strategies={overview.strategies} request={request} refresh={refresh} />}
      {tab === "Analytics" && <AnalyticsView overview={overview} />}

      {researchResult && <ResearchResult result={researchResult} close={() => setResearchResult(null)} />}
    </section>
  );
}

type Request = <T>(path: string, options?: RequestInit) => Promise<T>;

function OverviewView({ overview, request, refresh, onResearch, onNavigate }: {
  overview: Overview; request: Request; refresh: () => void; onResearch: (result: StrategyRun) => void; onNavigate: (tab: Tab) => void;
}) {
  const portfolio = overview.portfolio;
  return <div className="view-stack">
    <div className="metric-strip">
      <Metric label="Portfolio value" value={money(portfolio.totalValue, portfolio.currency)} detail={portfolio.broker.name === "ibkr" ? `${portfolio.broker.accountIdMasked} · ${money(portfolio.cash, portfolio.currency)} cash` : `${money(portfolio.cash, portfolio.currency)} cash`} />
      <Metric label="Daily change" value={signedMoney(portfolio.dailyPnl, portfolio.currency)} detail={percent(portfolio.dailyReturn)} tone={tone(portfolio.dailyPnl)} />
      <Metric label="Total return" value={optionalPercent(portfolio.totalReturn)} detail={portfolio.totalReturn === null ? "IBKR baseline pending" : `Since ${shortDate(portfolio.createdAt)}`} tone={tone(portfolio.totalReturn ?? 0)} />
      <Metric label="Benchmark" value={optionalPercent(portfolio.benchmarkReturn)} detail={portfolio.benchmarkSymbol} tone={tone(portfolio.benchmarkReturn ?? 0)} />
      <Metric label="Alpha" value={optionalPercent(portfolio.alpha)} detail={portfolio.alpha === null ? "Needs two market days" : "Against benchmark"} tone={tone(portfolio.alpha ?? 0)} />
    </div>
    <div className="overview-grid">
      <div className="column-stack">
        <Panel title="Portfolio allocation" icon={<WalletCards size={16} />} action={<TextButton onClick={() => onNavigate("Portfolio")}>Details</TextButton>}>
          <Allocation portfolio={portfolio} />
        </Panel>
        <Panel title="Open positions" icon={<LineChart size={16} />} action={<TextButton onClick={() => onNavigate("Portfolio")}>View portfolio</TextButton>}>
          <PositionTable positions={portfolio.positions} currency={portfolio.currency} compact />
        </Panel>
        <Panel title="Recent decisions" icon={<BookOpenCheck size={16} />} action={<TextButton onClick={() => onNavigate("Trades")}>Decision ledger</TextButton>}>
          <DecisionList proposals={overview.recentProposals} />
        </Panel>
      </div>
      <div className="column-stack">
        <ResearchPanel strategies={overview.strategies} request={request} onResearch={onResearch} />
        <RiskPanel risk={overview.risk} />
        <Panel title="Active experiments" icon={<FlaskConical size={16} />} action={<TextButton onClick={() => onNavigate("Experiments")}>Manage</TextButton>}>
          <ExperimentList experiments={overview.experiments.filter((item) => item.status === "ACTIVE")} />
        </Panel>
        <Panel title="Agent coverage" icon={<Bot size={16} />} action={<TextButton onClick={() => onNavigate("Agents")}>Performance</TextButton>}>
          {overview.agents.length ? <div className="compact-list">{overview.agents.slice(0, 4).map((agent) => <div key={agent.agentId}><strong>{agent.agentId}</strong><span>{agent.evaluatedPredictions} evaluated</span></div>)}</div> : <Empty compact text="No Orion agent has recorded a finance decision yet." />}
        </Panel>
      </div>
    </div>
  </div>;
}

function Metric({ label, value, detail, tone: valueTone = "neutral" }: { label: string; value: string; detail: string; tone?: "positive" | "negative" | "neutral" }) {
  return <div className="metric"><span>{label}</span><strong className={valueTone}>{value}</strong><small>{detail}</small></div>;
}

function Panel({ title, icon, action, children }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return <section className="panel"><header><div className="panel-title">{icon}<h2>{title}</h2></div>{action}</header><div className="panel-body">{children}</div></section>;
}

function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button className="text-button" onClick={onClick}>{children}<ChevronRight size={13} /></button>;
}

function Allocation({ portfolio }: { portfolio: Portfolio }) {
  const total = portfolio.totalValue || 1;
  const cashPct = portfolio.cash / total;
  const slices = portfolio.positions.map((position) => ({ label: position.symbol, value: position.marketValue, pct: position.marketValue / total }));
  const colors = ["#56d6d0", "#f6c453", "#a78bfa", "#fb7185", "#60a5fa"];
  let cursor = cashPct * 360;
  const stops = [`#2c3443 0deg ${cursor}deg`];
  slices.forEach((slice, index) => { const next = cursor + slice.pct * 360; stops.push(`${colors[index % colors.length]} ${cursor}deg ${next}deg`); cursor = next; });
  return <div className="allocation">
    <div className="donut" style={{ background: `conic-gradient(${stops.join(",")})` }}><div><strong>{percent(portfolio.grossExposure / total)}</strong><span>invested</span></div></div>
    <div className="legend"><div><i style={{ background: "#2c3443" }} /><span>Cash</span><strong>{money(portfolio.cash, portfolio.currency)}</strong></div>{slices.slice(0, 5).map((slice, index) => <div key={slice.label}><i style={{ background: colors[index % colors.length] }} /><span>{slice.label}</span><strong>{percent(slice.pct)}</strong></div>)}</div>
  </div>;
}

function PositionTable({ positions, currency, compact = false }: { positions: Portfolio["positions"]; currency: string; compact?: boolean }) {
  if (!positions.length) return <Empty text="No open positions. Approved paper trades will appear here." />;
  return <div className="table-wrap"><table><thead><tr><th>Security</th><th>Qty</th><th>Price</th><th>Market value</th><th>Unrealised P&amp;L</th>{!compact && <th>Daily P&amp;L</th>}</tr></thead><tbody>{positions.map((position) => <tr key={position.symbol}><td><strong>{position.symbol}</strong>{position.quoteError && <small>stale quote</small>}</td><td>{number(position.quantity)}</td><td>{money(position.price, currency)}</td><td>{money(position.marketValue, currency)}</td><td className={tone(position.unrealisedPnl)}>{signedMoney(position.unrealisedPnl, currency)}</td>{!compact && <td className={tone(position.dailyPnl)}>{signedMoney(position.dailyPnl, currency)}</td>}</tr>)}</tbody></table></div>;
}

function DecisionList({ proposals }: { proposals: Proposal[] }) {
  if (!proposals.length) return <Empty text="No trade proposals. Research a security or use an Orion agent finance tool." />;
  return <div className="decision-list">{proposals.slice(0, 6).map((item) => <div key={item.id}><span className={`side ${item.side.toLowerCase()}`}>{item.side}</span><div><strong>{item.symbol} · {number(item.requestedQuantity)} shares</strong><small>{item.agentId} · {relative(item.createdAt)}</small></div><Status value={item.status} /></div>)}</div>;
}

function ResearchPanel({ strategies, request, onResearch }: { strategies: Strategy[]; request: Request; onResearch: (result: StrategyRun) => void }) {
  const [symbol, setSymbol] = useState("NVDA");
  const [strategyId, setStrategyId] = useState("quant-core");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { onResearch(await request<StrategyRun>(`/strategies/${encodeURIComponent(strategyId)}/run`, { method: "POST", body: JSON.stringify({ symbol }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Panel title="Research a security" icon={<Search size={16} />}><form className="research-form" onSubmit={submit}><label><span>Symbol</span><input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} maxLength={16} /></label><label><span>Strategy</span><select value={strategyId} onChange={(event) => setStrategyId(event.target.value)}>{strategies.map((strategy) => <option key={strategy.id} value={strategy.id} disabled={!strategy.available}>{strategy.name}{strategy.available ? "" : " (unavailable)"}</option>)}</select></label><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <BarChart3 size={15} />}{busy ? "Analyzing" : "Run analysis"}</button>{error && <p className="form-error">{error}</p>}</form></Panel>;
}

function RiskPanel({ risk }: { risk: Overview["risk"] }) {
  const safe = risk.breaches.length === 0;
  return <Panel title="Deterministic risk" icon={<ShieldCheck size={16} />}><div className="risk-summary"><div className={safe ? "risk-icon safe" : "risk-icon danger"}>{safe ? <CheckCircle2 size={20} /> : <Gauge size={20} />}</div><div><strong>{safe ? "All limits clear" : `${risk.breaches.length} active breach${risk.breaches.length === 1 ? "" : "es"}`}</strong><span>Policy enforcement is server-side</span></div></div><div className="risk-bars"><RiskBar label="Gross exposure" value={risk.metrics.grossExposurePct} limit={risk.policy.maxGrossExposurePct} /><RiskBar label="Largest position" value={risk.metrics.largestPositionPct} limit={risk.policy.maxPositionPct} /><RiskBar label="Drawdown" value={risk.metrics.drawdown === null ? null : Math.abs(risk.metrics.drawdown)} limit={risk.policy.maxDrawdownPct} /></div></Panel>;
}

function RiskBar({ label, value, limit }: { label: string; value: number | null; limit: number }) {
  const width = value === null ? 0 : Math.min(100, limit ? value / limit * 100 : 0);
  return <div><div><span>{label}</span><small>{optionalPercent(value)} / {percent(limit)}</small></div><div className="bar"><i style={{ width: `${width}%` }} /></div></div>;
}

function PortfolioView({ portfolio }: { portfolio: Portfolio }) {
  return <div className="view-stack"><div className="section-heading"><div><span className="eyebrow">PAPER PORTFOLIO</span><h2>{portfolio.name}</h2></div><span className="mode-label"><ShieldCheck size={14} /> No live execution</span></div><div className="metric-strip four"><Metric label="Total value" value={money(portfolio.totalValue, portfolio.currency)} detail={portfolio.currency} /><Metric label="Cash reserve" value={money(portfolio.cash, portfolio.currency)} detail={percent(portfolio.cash / portfolio.totalValue)} /><Metric label="Gross exposure" value={money(portfolio.grossExposure, portfolio.currency)} detail={percent(portfolio.grossExposure / portfolio.totalValue)} /><Metric label="Max drawdown" value={optionalPercent(portfolio.drawdown)} detail={`${portfolio.performance.observations} valuation points`} tone={tone(portfolio.drawdown ?? 0)} /></div><Panel title="Current positions" icon={<WalletCards size={16} />}><PositionTable positions={portfolio.positions} currency={portfolio.currency} /></Panel><div className="analytics-grid"><Analytic label="Annualized return" value={optionalPercent(portfolio.performance.annualizedReturn)} /><Analytic label="Volatility" value={optionalPercent(portfolio.performance.volatility)} /><Analytic label="Sharpe ratio" value={optionalNumber(portfolio.performance.sharpe)} /><Analytic label="Sortino ratio" value={optionalNumber(portfolio.performance.sortino)} /></div></div>;
}

function TradesView({ trades, proposals, currency, request, refresh }: { trades: Trade[]; proposals: Proposal[]; currency: string; request: Request; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function execute(id: string) { setBusy(id); setError(null); try { await request(`/proposals/${encodeURIComponent(id)}/execute`, { method: "POST" }); refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(null); } }
  return <div className="view-stack"><div className="section-heading"><div><span className="eyebrow">DECISION PIPELINE</span><h2>Proposals and paper trades</h2></div></div>{error && <div className="error-banner">{error}</div>}<Panel title="Trade proposals" icon={<Target size={16} />}>{proposals.length ? <div className="table-wrap"><table><thead><tr><th>Decision</th><th>Agent</th><th>Order</th><th>Status</th><th>Created</th><th /></tr></thead><tbody>{proposals.map((proposal) => <tr key={proposal.id}><td><strong>{proposal.decisionId}</strong><small>{proposal.strategyId ?? "manual"}</small></td><td>{proposal.agentId}</td><td><span className={`side ${proposal.side.toLowerCase()}`}>{proposal.side}</span> {number(proposal.requestedQuantity)} {proposal.symbol}</td><td><Status value={proposal.status} /></td><td>{relative(proposal.createdAt)}</td><td>{proposal.status === "PROPOSED" && <button className="button small" onClick={() => void execute(proposal.id)} disabled={busy === proposal.id}>{busy === proposal.id ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} Risk check</button>}</td></tr>)}</tbody></table></div> : <Empty text="No proposals are waiting for deterministic review." />}</Panel><Panel title="Executed paper trades" icon={<History size={16} />}>{trades.length ? <div className="table-wrap"><table><thead><tr><th>Security</th><th>Side</th><th>Quantity</th><th>Execution</th><th>Fee</th><th>Agent</th><th>Time</th></tr></thead><tbody>{trades.map((trade) => <tr key={trade.id}><td><strong>{trade.symbol}</strong></td><td><span className={`side ${trade.side.toLowerCase()}`}>{trade.side}</span></td><td>{number(trade.quantity)}</td><td>{money(trade.price, currency)}</td><td>{money(trade.fee, currency)}</td><td>{trade.agentId}</td><td>{relative(trade.executedAt)}</td></tr>)}</tbody></table></div> : <Empty text="No paper orders have passed risk review and executed." />}</Panel></div>;
}

function PredictionsView({ predictions, request, refresh }: { predictions: Prediction[]; request: Request; refresh: () => void }) {
  const [form, setForm] = useState({ symbol: "NVDA", direction: "BULLISH", expectedReturnMin: "0.05", expectedReturnMax: "0.12", horizonDays: "30", confidence: "0.70", thesis: "", invalidation: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(null); try { await request("/predictions", { method: "POST", body: JSON.stringify({ symbol: form.symbol, direction: form.direction, expectedReturnMin: Number(form.expectedReturnMin), expectedReturnMax: Number(form.expectedReturnMax), horizonDays: Number(form.horizonDays), confidence: Number(form.confidence), thesis: form.thesis, invalidationConditions: form.invalidation ? [form.invalidation] : [] }) }); setForm({ ...form, thesis: "", invalidation: "" }); refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  return <div className="split-view"><Panel title="Record a prediction" icon={<Target size={16} />}><form className="form-grid" onSubmit={submit}><label><span>Symbol</span><input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} /></label><label><span>Direction</span><select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}><option>BULLISH</option><option>BEARISH</option><option>NEUTRAL</option></select></label><label><span>Return min</span><input type="number" step="0.01" value={form.expectedReturnMin} onChange={(e) => setForm({ ...form, expectedReturnMin: e.target.value })} /></label><label><span>Return max</span><input type="number" step="0.01" value={form.expectedReturnMax} onChange={(e) => setForm({ ...form, expectedReturnMax: e.target.value })} /></label><label><span>Horizon days</span><input type="number" min="1" value={form.horizonDays} onChange={(e) => setForm({ ...form, horizonDays: e.target.value })} /></label><label><span>Confidence</span><input type="number" min="0" max="1" step="0.01" value={form.confidence} onChange={(e) => setForm({ ...form, confidence: e.target.value })} /></label><label className="full"><span>Investment thesis</span><textarea required value={form.thesis} onChange={(e) => setForm({ ...form, thesis: e.target.value })} /></label><label className="full"><span>Invalidation condition</span><input value={form.invalidation} onChange={(e) => setForm({ ...form, invalidation: e.target.value })} /></label>{error && <p className="form-error full">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Target size={15} />}Append prediction</button></form></Panel><Panel title="Prediction ledger" icon={<BookOpenCheck size={16} />}>{predictions.length ? <div className="prediction-list">{predictions.map((prediction) => <article key={prediction.id}><div><span className={`direction ${prediction.direction.toLowerCase()}`}>{prediction.direction}</span><strong>{prediction.symbol}</strong><small>{prediction.agentId}</small></div><p>{prediction.thesis}</p><footer><span>{percent(prediction.expectedReturnMin)} to {percent(prediction.expectedReturnMax)}</span><span>{percent(prediction.confidence)} confidence</span><Status value={prediction.result ? prediction.result.directionCorrect ? "CORRECT" : "INCORRECT" : "PENDING"} /></footer></article>)}</div> : <Empty text="Predictions are append-only and appear here even when no trade is made." />}</Panel></div>;
}

type OrionAgent = {
  id: string;
  name?: string;
  role?: string;
  identity?: { name?: string };
};

function AgentsView({ agents, financeAgents, financeTeams, request, refresh }: {
  agents: AgentPerformance[];
  financeAgents: FinanceAgent[];
  financeTeams: FinanceTeam[];
  request: Request;
  refresh: () => void;
}) {
  const [availableAgents, setAvailableAgents] = useState<OrionAgent[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAvailableAgents = useCallback(async () => {
    try {
      const response = await fetch("/api/agents", { credentials: "same-origin" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error("Orion agents could not be loaded");
      setAvailableAgents(Array.isArray(payload.agents) ? payload.agents : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void loadAvailableAgents(); }, [loadAvailableAgents]);

  async function assign(agent: OrionAgent) {
    setBusyId(agent.id); setError(null);
    try {
      await request("/finance-agents", {
        method: "POST",
        body: JSON.stringify({
          agentId: agent.id,
          displayName: agent.identity?.name?.trim() || agent.name?.trim() || agent.id,
          role: agent.role?.trim() || undefined,
        }),
      });
      refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  async function remove(agent: FinanceAgent) {
    setBusyId(agent.agentId); setError(null);
    try { await request(`/finance-agents/${encodeURIComponent(agent.agentId)}`, { method: "DELETE" }); refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  async function removeTeam(team: FinanceTeam) {
    setBusyId(`team:${team.id}`); setError(null);
    try { await request(`/finance-teams/${encodeURIComponent(team.id)}`, { method: "DELETE" }); refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  const assignedIds = new Set(financeAgents.map((agent) => agent.agentId));
  return <div className="view-stack">
    <div className="section-heading agent-management-heading"><div><span className="eyebrow">FINANCE AGENT OPERATIONS</span><h2>Assignments and teams</h2><p>Assign existing Orion agents, then group assigned agents into finance teams. A team is ready with one to five members.</p></div><div className="section-actions"><button className="button" onClick={() => { setAssignOpen(true); void loadAvailableAgents(); }}><UserPlus size={15} />Assign agent</button><button className="button primary" onClick={() => setTeamOpen(true)} disabled={!financeAgents.length || financeTeams.length >= 5}><Users size={15} />Create team</button></div></div>
    {error && <div className="error-banner"><span>{error}</span><button title="Dismiss" onClick={() => setError(null)}><X size={15} /></button></div>}
    <div className="team-metric-strip"><Metric label="Assigned agents" value={`${financeAgents.length}`} detail={`${availableAgents.length || "No"} available in Orion`} /><Metric label="Finance teams" value={`${financeTeams.length} / 5`} detail="Up to five teams" /><Metric label="Team capacity" value="1–5" detail="Agents per operating team" /></div>
    <div className="two-panels"><Panel title="Assigned finance agents" icon={<UserPlus size={16} />} action={<TextButton onClick={() => setAssignOpen(true)}>Assign</TextButton>}>{financeAgents.length ? <div className="finance-agent-list">{financeAgents.map((agent) => <article key={agent.agentId}><div><strong>{agent.displayName}</strong><small>{agent.agentId}{agent.role ? ` · ${agent.role}` : ""}</small></div><button className="icon-button small-icon" title={`Remove ${agent.displayName} from Finance Lab`} onClick={() => void remove(agent)} disabled={busyId === agent.agentId}>{busyId === agent.agentId ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}</button></article>)}</div> : <Empty text="No agents are assigned. Use Assign agent to choose from Orion Agent Room." />}</Panel>
      <Panel title="Finance teams" icon={<Users size={16} />} action={<TextButton onClick={() => setTeamOpen(true)}>Create</TextButton>}>{financeTeams.length ? <div className="finance-team-list">{financeTeams.map((team) => <article key={team.id}><header><div><strong>{team.name}</strong><small>{team.members.length} / 5 agents</small></div><button className="icon-button small-icon" title={`Delete ${team.name}`} onClick={() => void removeTeam(team)} disabled={busyId === `team:${team.id}`}>{busyId === `team:${team.id}` ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}</button></header><div className="team-members">{team.members.map((member) => <span key={member.agentId}>{member.displayName}</span>)}</div></article>)}</div> : <Empty text="No finance teams yet. Teams can operate with one to five assigned agents." />}</Panel></div>
    <Panel title="Agent scorecard" icon={<Bot size={16} />}>{agents.length ? <div className="table-wrap"><table><thead><tr><th>Agent ID</th><th>Predictions</th><th>Directional accuracy</th><th>Avg alpha</th><th>Calibration</th><th>Paper trades</th></tr></thead><tbody>{agents.map((agent) => <tr key={agent.agentId}><td><strong>{agent.agentId}</strong></td><td>{agent.evaluatedPredictions} / {agent.totalPredictions}</td><td>{optionalPercent(agent.directionalAccuracy)}</td><td className={tone(agent.averageAlpha ?? 0)}>{optionalPercent(agent.averageAlpha)}</td><td><Status value={agent.confidenceCalibration.status} /></td><td>{agent.tradeCount}</td></tr>)}</tbody></table></div> : <Empty text="No agent finance history exists yet. Agent creation remains in Orion Agent Room." />}</Panel>
    {assignOpen && <AssignFinanceAgentDialog availableAgents={availableAgents} assignedIds={assignedIds} busyId={busyId} assign={assign} close={() => setAssignOpen(false)} />}
    {teamOpen && <CreateFinanceTeamDialog financeAgents={financeAgents} teamCount={financeTeams.length} request={request} refresh={refresh} close={() => setTeamOpen(false)} />}
  </div>;
}

function AssignFinanceAgentDialog({ availableAgents, assignedIds, busyId, assign, close }: {
  availableAgents: OrionAgent[];
  assignedIds: Set<string>;
  busyId: string | null;
  assign: (agent: OrionAgent) => Promise<void>;
  close: () => void;
}) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section className="modal team-modal"><header><div><span className="eyebrow">ORION AGENT ROOM</span><h2>Assign finance agents</h2></div><button className="icon-button" title="Close assignment" onClick={close}><X size={17} /></button></header><div className="available-agent-list">{availableAgents.length ? availableAgents.map((agent) => { const assigned = assignedIds.has(agent.id); const name = agent.identity?.name?.trim() || agent.name?.trim() || agent.id; return <article key={agent.id}><div><strong>{name}</strong><small>{agent.id}{agent.role ? ` · ${agent.role}` : ""}</small></div><button className="button small" disabled={assigned || busyId === agent.id} onClick={() => void assign(agent)}>{busyId === agent.id ? <LoaderCircle size={14} className="spin" /> : <UserPlus size={14} />}{assigned ? "Assigned" : "Assign"}</button></article>; }) : <Empty text="No available Orion agents were returned." />}</div></section></div>;
}

function CreateFinanceTeamDialog({ financeAgents, teamCount, request, refresh, close }: {
  financeAgents: FinanceAgent[];
  teamCount: number;
  request: Request;
  refresh: () => void;
  close: () => void;
}) {
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function toggle(agentId: string) { setMemberIds((ids) => ids.includes(agentId) ? ids.filter((id) => id !== agentId) : ids.length < 5 ? [...ids, agentId] : ids); }
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(null); try { await request("/finance-teams", { method: "POST", body: JSON.stringify({ name, agentIds: memberIds }) }); refresh(); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section className="modal team-modal"><header><div><span className="eyebrow">FINANCE TEAM {teamCount + 1} / 5</span><h2>Create finance team</h2></div><button className="icon-button" title="Close team creation" onClick={close}><X size={17} /></button></header><form className="team-form" onSubmit={submit}><label><span>Team name</span><input required value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Research desk" /></label><div className="team-form-heading"><span>Assigned agents</span><small>{memberIds.length} / 5 selected</small></div><div className="team-picker">{financeAgents.map((agent) => { const checked = memberIds.includes(agent.agentId); return <label key={agent.agentId}><input type="checkbox" checked={checked} onChange={() => toggle(agent.agentId)} disabled={!checked && memberIds.length >= 5} /><span><strong>{agent.displayName}</strong><small>{agent.agentId}{agent.role ? ` · ${agent.role}` : ""}</small></span></label>; })}</div>{error && <p className="form-error">{error}</p>}<p className="team-helper">A team is ready as soon as it has one assigned agent. Five is the maximum, not a requirement.</p><button className="button primary" disabled={busy || !name.trim() || !memberIds.length}>{busy ? <LoaderCircle size={15} className="spin" /> : <Users size={15} />}Create team</button></form></section></div>;
}

function StrategiesView({ strategies, request, onResearch }: { strategies: Strategy[]; request: Request; onResearch: (result: StrategyRun) => void }) {
  return <div className="view-stack"><div className="section-heading"><div><span className="eyebrow">NORMALIZED STRATEGY INTERFACE</span><h2>Strategy registry</h2></div></div><div className="strategy-grid">{strategies.map((strategy) => <article className="strategy" key={strategy.id}><header><div className="strategy-icon">{strategy.deterministic ? <BarChart3 size={18} /> : <Bot size={18} />}</div><div><h3>{strategy.name}</h3><code>{strategy.id}</code></div><Status value={strategy.available ? strategy.controlGroup ? "CONTROL" : "READY" : "UNAVAILABLE"} /></header><p>{strategy.description}</p>{strategy.unavailableReason && <small className="warning-copy">{strategy.unavailableReason}</small>}<dl><div><dt>Portfolios</dt><dd>{strategy.portfolioCount}</dd></div><div><dt>Trades</dt><dd>{strategy.tradeCount}</dd></div><div><dt>Total return</dt><dd>{optionalPercent(strategy.totalReturn)}</dd></div><div><dt>Fees</dt><dd>{money(strategy.fees)}</dd></div></dl><QuickRun strategy={strategy} request={request} onResearch={onResearch} /></article>)}</div></div>;
}

function QuickRun({ strategy, request, onResearch }: { strategy: Strategy; request: Request; onResearch: (result: StrategyRun) => void }) {
  const [symbol, setSymbol] = useState("NVDA"); const [busy, setBusy] = useState(false);
  async function run() { setBusy(true); try { onResearch(await request(`/strategies/${encodeURIComponent(strategy.id)}/run`, { method: "POST", body: JSON.stringify({ symbol }) })); } finally { setBusy(false); } }
  return <div className="quick-run"><input aria-label={`Symbol for ${strategy.name}`} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /><button className="button small" disabled={!strategy.available || busy} onClick={() => void run()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}Run</button></div>;
}

function ExperimentsView({ experiments, strategies, request, refresh }: { experiments: Experiment[]; strategies: Strategy[]; request: Request; refresh: () => void }) {
  const [form, setForm] = useState({ name: "", strategyId: "quant-core", agentId: "", initialCapital: "25000", benchmarkSymbol: "^GSPC" }); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(null); try { await request("/experiments", { method: "POST", body: JSON.stringify({ ...form, agentId: form.agentId || undefined, initialCapital: Number(form.initialCapital) }) }); setForm({ ...form, name: "", agentId: "" }); refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  return <div className="split-view"><Panel title="Start isolated experiment" icon={<FlaskConical size={16} />}><form className="form-grid" onSubmit={submit}><label className="full"><span>Name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Quant vs benchmark" /></label><label><span>Strategy</span><select value={form.strategyId} onChange={(e) => setForm({ ...form, strategyId: e.target.value })}>{strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}</select></label><label><span>Orion agent ID</span><input value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })} placeholder="Optional reference" /></label><label><span>Initial capital</span><input type="number" min="1" value={form.initialCapital} onChange={(e) => setForm({ ...form, initialCapital: e.target.value })} /></label><label><span>Benchmark</span><input value={form.benchmarkSymbol} onChange={(e) => setForm({ ...form, benchmarkSymbol: e.target.value.toUpperCase() })} /></label>{error && <p className="form-error full">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}Create paper experiment</button></form></Panel><Panel title="Experiment registry" icon={<Target size={16} />}><ExperimentList experiments={experiments} /></Panel></div>;
}

function ExperimentList({ experiments }: { experiments: Experiment[] }) {
  if (!experiments.length) return <Empty text="No isolated strategy or agent experiments have started." />;
  return <div className="experiment-list">{experiments.map((experiment) => <article key={experiment.id}><div><strong>{experiment.name}</strong><small>{experiment.strategyId}{experiment.agentId ? ` · ${experiment.agentId}` : ""}</small></div><div><span>{money(experiment.initialCapital)}</span><small>{experiment.benchmarkSymbol} benchmark</small></div><Status value={experiment.status} /></article>)}</div>;
}

function AnalyticsView({ overview }: { overview: Overview }) {
  const performance = overview.portfolio.performance;
  const bestAgent = overview.agents.filter((agent) => agent.directionalAccuracy !== null).sort((a, b) => (b.directionalAccuracy ?? 0) - (a.directionalAccuracy ?? 0))[0];
  return <div className="view-stack"><div className="section-heading"><div><span className="eyebrow">RISK-ADJUSTED EVALUATION</span><h2>Finance analytics</h2></div></div><div className="analytics-grid"><Analytic label="Total return" value={optionalPercent(performance.totalReturn)} /><Analytic label="Annualized return" value={optionalPercent(performance.annualizedReturn)} /><Analytic label="Volatility" value={optionalPercent(performance.volatility)} /><Analytic label="Maximum drawdown" value={optionalPercent(performance.maximumDrawdown)} /><Analytic label="Sharpe ratio" value={optionalNumber(performance.sharpe)} /><Analytic label="Sortino ratio" value={optionalNumber(performance.sortino)} /></div><div className="two-panels"><Panel title="Agent calibration" icon={<Target size={16} />}>{bestAgent ? <Calibration agent={bestAgent} /> : <Empty text="Calibration requires evaluated predictions." />}</Panel><Panel title="Evaluation coverage" icon={<Gauge size={16} />}><div className="coverage"><div><span>Valuation observations</span><strong>{performance.observations}</strong></div><div><span>Strategies compared</span><strong>{overview.strategies.length}</strong></div><div><span>Agent records</span><strong>{overview.agents.length}</strong></div><div><span>Active experiments</span><strong>{overview.experiments.filter((item) => item.status === "ACTIVE").length}</strong></div></div></Panel></div></div>;
}

function Calibration({ agent }: { agent: AgentPerformance }) {
  const bins = agent.confidenceCalibration.bins.filter((bin) => bin.count > 0);
  return <div><div className="calibration-title"><div><strong>{agent.agentId}</strong><span>{agent.confidenceCalibration.status.replaceAll("_", " ").toLowerCase()}</span></div><strong>{optionalPercent(agent.confidenceCalibration.expectedCalibrationError)} ECE</strong></div><div className="calibration-chart">{bins.map((bin) => <div key={bin.from}><div className="calibration-bars"><i style={{ height: `${bin.averageConfidence * 100}%` }} /><b style={{ height: `${(bin.successRate ?? 0) * 100}%` }} /></div><small>{Math.round(bin.to * 100)}%</small></div>)}</div><div className="chart-legend"><span><i className="expected" />Confidence</span><span><i className="actual" />Success rate</span></div></div>;
}

function Analytic({ label, value }: { label: string; value: string }) { return <div className="analytic"><span>{label}</span><strong>{value}</strong></div>; }

function Status({ value }: { value: string }) { const normalized = value.toLowerCase(); return <span className={`status status-${normalized}`}>{value.replaceAll("_", " ")}</span>; }

function Empty({ text, compact = false }: { text: string; compact?: boolean }) { return <div className={`empty ${compact ? "compact" : ""}`}><CircleDollarSign size={compact ? 17 : 22} /><span>{text}</span></div>; }

function ResearchResult({ result, close }: { result: StrategyRun; close: () => void }) {
  const indicators = result.metadata.indicators as Record<string, number | null> | undefined;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section className="modal"><header><div><span className="eyebrow">{result.decisionId}</span><h2>{result.symbol} research result</h2></div><button className="icon-button" title="Close result" onClick={close}><X size={17} /></button></header><div className="signal-row"><span className={`signal signal-${result.signal.toLowerCase()}`}>{result.signal}</span><div><small>Normalized score</small><strong>{result.score.toFixed(2)}</strong></div><div><small>Confidence</small><strong>{percent(result.confidence)}</strong></div><div><small>Horizon</small><strong>{result.timeHorizon}</strong></div></div><p className="thesis">{result.thesis}</p>{indicators && <div className="indicator-grid"><Analytic label="RSI (14)" value={optionalNumber(indicators.rsi14)} /><Analytic label="Momentum (20)" value={optionalPercent(indicators.momentum20)} /><Analytic label="Volatility" value={optionalPercent(indicators.annualizedVolatility)} /><Analytic label="Max drawdown" value={optionalPercent(indicators.maximumDrawdown)} /></div>}<footer><span>Evidence manifest</span><code>{result.evidenceManifestId}</code></footer></section></div>;
}

function StateMessage({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) { return <div className="state-message">{icon}<h2>{title}</h2><p>{detail}</p>{action}</div>; }

function money(value: number, currency = "USD") { return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value); }
function signedMoney(value: number, currency = "USD") { return `${value > 0 ? "+" : ""}${money(value, currency)}`; }
function percent(value: number) { return `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`; }
function optionalPercent(value: number | null | undefined) { return value === null || value === undefined ? "Pending" : percent(value); }
function optionalNumber(value: number | null | undefined) { return value === null || value === undefined ? "Pending" : value.toFixed(2); }
function number(value: number) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function relative(value: string) { const ms = Date.now() - new Date(value).getTime(); const minutes = Math.floor(ms / 60000); if (minutes < 1) return "just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.floor(hours / 24)}d ago`; }
function tone(value: number): "positive" | "negative" | "neutral" { return value > 0 ? "positive" : value < 0 ? "negative" : "neutral"; }
