import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BookOpenCheck,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Crown,
  FlaskConical,
  Gauge,
  History,
  LineChart,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Target,
  Trash2,
  UserPlus,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import type {
  AgentPerformance,
  BrokerOrder,
  Experiment,
  FinanceAgent,
  FinanceTeam,
  FinanceTeamMember,
  LiveOrderResult,
  OrderPreview,
  ReconcileReport,
  Overview,
  Portfolio,
  Prediction,
  Proposal,
  Strategy,
  StrategyRun,
  TeamPortfolio,
  TeamPortfolios,
  TeamPortfolioTotal,
  TeamLesson,
  TeamTradingRun,
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
  const refresh = useCallback(() => void load(true), [load]);
  const unsettled = Boolean(overview?.recentBrokerOrders.some((order) => order.status === "WORKING")
    || overview?.recentProposals.some((proposal) => proposal.status === "SUBMITTING"));
  useEffect(() => {
    if (!unsettled) return;
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [unsettled, load]);

  if (loading) return <StateMessage icon={<LoaderCircle className="spin" />} title="Opening Finance Lab" detail="Loading paper portfolios and risk state." />;
  if (!overview) return <StateMessage icon={<ShieldCheck />} title="Finance Lab is unavailable" detail={error ?? "The plugin did not return a dashboard."} action={<button className="button" onClick={() => void load()}><RefreshCw size={15} /> Retry</button>} />;

  return (
    <section className="finance-shell">
      <header className="finance-header">
        <div>
          <div className="eyebrow">ORION / FINANCE LAB</div>
          <div className="title-row">
            <h1>Finance Lab</h1>
            <span className="paper-badge"><ShieldCheck size={13} /> {MODE_LABEL[overview.mode]}</span>
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
      {tab === "Portfolio" && <PortfolioView portfolio={overview.portfolio} teamPortfolios={overview.teamPortfolios} brokerOrders={overview.recentBrokerOrders} mode={overview.mode} request={request} refresh={refresh} />}
      {tab === "Trades" && <TradesView trades={overview.recentTrades} proposals={overview.recentProposals} brokerOrders={overview.recentBrokerOrders} financeTeams={overview.financeTeams} teamPortfolios={overview.teamPortfolios} defaultCurrency={overview.portfolio.currency} mode={overview.mode} request={request} refresh={refresh} />}
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
  if (!positions.length) return <Empty text="No filled positions. Working IBKR orders remain separate until the broker reports a fill." />;
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

function PortfolioView({ portfolio, teamPortfolios, brokerOrders, mode, request, refresh }: { portfolio: Portfolio; teamPortfolios: TeamPortfolios; brokerOrders: BrokerOrder[]; mode: Overview["mode"]; request: Request; refresh: () => void }) {
  const teams = teamPortfolios.teams;
  const [tradingRuns, setTradingRuns] = useState<TeamTradingRun[]>([]);
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null);
  const [tradingError, setTradingError] = useState<string | null>(null);
  const runStatuses = useRef(new Map<string, TeamTradingRun["status"]>());
  const loadTradingRuns = useCallback(async () => {
    try {
      const runs = await request<TeamTradingRun[]>("/finance-teams/trading");
      const finished = runs.some((run) => run.status !== "RUNNING" && run.status !== "IDLE"
        && (!runStatuses.current.has(run.teamId) || runStatuses.current.get(run.teamId) === "RUNNING"));
      runStatuses.current = new Map(runs.map((run) => [run.teamId, run.status]));
      setTradingRuns(runs);
      setTradingError(null);
      // Start returns during research; refresh on completion, including after tab navigation.
      if (finished) refresh();
    } catch (reason) {
      setTradingError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [request, refresh]);

  useEffect(() => {
    void loadTradingRuns();
    const timer = window.setInterval(() => void loadTradingRuns(), 2500);
    return () => window.clearInterval(timer);
  }, [loadTradingRuns]);

  const setTeamTrading = async (teamId: string, action: "start" | "stop") => {
    setBusyTeamId(teamId);
    try {
      const state = await request<TeamTradingRun>(`/finance-teams/${encodeURIComponent(teamId)}/trading/${action}`, { method: "POST" });
      runStatuses.current.set(teamId, state.status);
      setTradingRuns((current) => [...current.filter((entry) => entry.teamId !== teamId), state]);
      setTradingError(null);
      refresh();
    } catch (reason) {
      setTradingError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyTeamId(null);
    }
  };

  return <div className="view-stack">
    <div className="section-heading"><div><span className="eyebrow">PAPER PORTFOLIO</span><h2>{portfolio.name}</h2></div><span className="mode-label"><ShieldCheck size={14} /> {MODE_LABEL[mode]}</span></div>
    <div className="metric-strip four"><Metric label="Total value" value={money(portfolio.totalValue, portfolio.currency)} detail={portfolio.currency} /><Metric label="Cash reserve" value={money(portfolio.cash, portfolio.currency)} detail={percent(portfolio.cash / portfolio.totalValue)} /><Metric label="Gross exposure" value={money(portfolio.grossExposure, portfolio.currency)} detail={percent(portfolio.grossExposure / portfolio.totalValue)} /><Metric label="Max drawdown" value={optionalPercent(portfolio.drawdown)} detail={`${portfolio.performance.observations} valuation points`} tone={tone(portfolio.drawdown ?? 0)} /></div>
    <Panel title="Current positions" icon={<WalletCards size={16} />}><PositionTable positions={portfolio.positions} currency={portfolio.currency} /></Panel>
    <div className="analytics-grid"><Analytic label="Annualized return" value={optionalPercent(portfolio.performance.annualizedReturn)} /><Analytic label="Volatility" value={optionalPercent(portfolio.performance.volatility)} /><Analytic label="Sharpe ratio" value={optionalNumber(portfolio.performance.sharpe)} /><Analytic label="Sortino ratio" value={optionalNumber(portfolio.performance.sortino)} /></div>

    <div className="section-heading"><div><span className="eyebrow">TEAM PORTFOLIOS</span><h2>{teams.length} of 5 team portfolios</h2><p>Every finance team runs its own paper portfolio. Creating a team opens one, and the combined section below rolls all of them up.</p></div></div>
    {tradingError && <div className="error-banner"><span>{tradingError}</span><button title="Dismiss" onClick={() => setTradingError(null)}><X size={15} /></button></div>}
    {teams.length
      ? <>{teams.map((entry) => <TeamPortfolioPanel key={entry.teamId} entry={entry} request={request} brokerOrders={brokerOrders.filter((order) => order.portfolioId === entry.portfolio.id && order.status === "WORKING")} tradingRun={tradingRuns.find((run) => run.teamId === entry.teamId)} busy={busyTeamId === entry.teamId} onTradingAction={(action) => void setTeamTrading(entry.teamId, action)} />)}<TeamPortfolioTotalPanel total={teamPortfolios.total} /></>
      : <Empty text="No finance teams yet. Create a team in the Agents tab and its paper portfolio appears here." />}
  </div>;
}

function TeamPortfolioPanel({ entry, request, brokerOrders, tradingRun, busy, onTradingAction }: { entry: TeamPortfolio; request: Request; brokerOrders: BrokerOrder[]; tradingRun?: TeamTradingRun; busy: boolean; onTradingAction: (action: "start" | "stop") => void }) {
  const portfolio = entry.portfolio;
  const running = tradingRun?.status === "RUNNING";
  // The coordinator stops between agent turns, so the run stays RUNNING until the aborted turn
  // unwinds. Without this the button keeps offering "Stop trading" and a stop looks ignored.
  const stopping = running && tradingRun?.phase === "STOPPING";
  return <Panel
    title={`${entry.teamName} portfolio`}
    icon={<Users size={16} />}
    action={<div className="team-portfolio-actions"><span className="portfolio-total">{money(portfolio.totalValue, portfolio.currency)}</span><button className={`button small${running ? "" : " primary"}`} disabled={busy || stopping || (!running && tradingRun?.available === false)} onClick={() => onTradingAction(running ? "stop" : "start")}>{busy || stopping ? <LoaderCircle size={13} className="spin" /> : running ? <Square size={12} /> : <Play size={13} />}{stopping ? "Stopping" : running ? "Stop trading" : "Start trading"}</button></div>}
  >
    <TeamRoster members={entry.members} />
    <div className={`team-trading-state state-${(tradingRun?.status ?? "IDLE").toLowerCase()}`}><span><i />{formatTradingPhase(tradingRun?.phase ?? "IDLE")}</span><small>{tradingRun?.message ?? "Ready for an autonomous paper-trading cycle."}</small></div>
    {/* The status message is deliberately generic, so the run's own failure text is the only place the operator can see which agent turn broke and why. */}
    {tradingRun?.error && <p className="team-trading-error">{formatTradingError(tradingRun.error)}</p>}
    <div className="metric-strip four"><Metric label="Total value" value={money(portfolio.totalValue, portfolio.currency)} detail={`${money(portfolio.cash, portfolio.currency)} cash`} /><Metric label="Daily change" value={signedMoney(portfolio.dailyPnl, portfolio.currency)} detail={percent(portfolio.dailyReturn)} tone={tone(portfolio.dailyPnl)} /><Metric label="Total return" value={optionalPercent(portfolio.totalReturn)} detail={portfolio.initialCash === null ? "Baseline pending" : `${money(portfolio.initialCash, portfolio.currency)} funded`} tone={tone(portfolio.totalReturn ?? 0)} /><Metric label="Gross exposure" value={money(portfolio.grossExposure, portfolio.currency)} detail={percent(portfolio.grossExposure / (portfolio.totalValue || 1))} /></div>
    {brokerOrders.length > 0 && <div className="portfolio-order-block"><span className="eyebrow">WORKING BROKER ORDERS</span><BrokerOrderTable orders={brokerOrders} teams={[]} compact /></div>}
    <PositionTable positions={portfolio.positions} currency={portfolio.currency} compact />
    <TeamLessons teamId={entry.teamId} request={request} refreshKey={tradingRun?.completedAt ?? null} />
  </Panel>;
}

const LESSON_VERDICT: Record<TeamLesson["score"]["verdict"], string> = {
  LEARNING: "Gathering evidence",
  HELPING: "Helping",
  NOT_HELPING: "Not helping",
};

// Lessons change only when a cycle finishes, so they reload on completion rather than
// joining the 2.5s trading-status poll.
function TeamLessons({ teamId, request, refreshKey }: { teamId: string; request: Request; refreshKey: string | null }) {
  const [lessons, setLessons] = useState<TeamLesson[] | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/finance-teams/${encodeURIComponent(teamId)}/lessons`;
  useEffect(() => {
    let cancelled = false;
    request<TeamLesson[]>(path)
      .then((result) => { if (!cancelled) { setLessons(result); setError(null); } })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [path, request, refreshKey]);

  async function retire(lesson: TeamLesson) {
    setBusyId(lesson.id);
    try {
      const updated = await request<TeamLesson>(`${path}/${encodeURIComponent(lesson.id)}/retire`, { method: "POST" });
      setLessons((current) => current?.map((entry) => entry.id === updated.id ? updated : entry) ?? null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  }

  const active = lessons?.filter((lesson) => !lesson.retiredAt) ?? [];
  const retired = lessons?.filter((lesson) => lesson.retiredAt) ?? [];
  const shown = showRetired ? [...active, ...retired] : active;
  return <div className="team-lessons">
    <div className="team-lessons-heading">
      <span className="eyebrow"><Brain size={12} /> LESSONS FROM GRADED DECISIONS</span>
      {retired.length > 0 && <button className="text-button" onClick={() => setShowRetired(!showRetired)}>{showRetired ? "Hide" : "Show"} {retired.length} retired</button>}
    </div>
    {error && <p className="team-trading-error">{error}</p>}
    {lessons === null && !error && <small className="team-lessons-empty">Loading lessons…</small>}
    {lessons !== null && shown.length === 0 && <small className="team-lessons-empty">No lessons yet. A lesson appears when a graded trade decision turns out wrong and the lead names a repeatable error.</small>}
    {shown.map((lesson) => <article key={lesson.id} className={`team-lesson${lesson.retiredAt ? " retired" : ""}`}>
      <header>
        <strong>When {lesson.trigger}</strong>
        <div className="team-lesson-meta">
          <span className={`lesson-verdict verdict-${lesson.retiredAt ? "retired" : lesson.score.verdict.toLowerCase()}`}>{lesson.retiredAt ? "Retired" : LESSON_VERDICT[lesson.score.verdict]}</span>
          {!lesson.retiredAt && <button className="icon-button" title="Retire lesson" disabled={busyId === lesson.id} onClick={() => void retire(lesson)}>{busyId === lesson.id ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}</button>}
        </div>
      </header>
      <dl>
        <div><dt>Better approach</dt><dd>{lesson.betterApproach}</dd></div>
        <div><dt>Avoid</dt><dd>{lesson.avoid}</dd></div>
        <div><dt>Verify</dt><dd>{lesson.verify}</dd></div>
      </dl>
      <footer>
        <span>{lesson.score.trials ? `Right on ${lesson.score.correct} of ${lesson.score.trials} decisions it was shown on, versus ${Math.round(lesson.score.baselineRate * 100)}% without it` : "Not yet shown on a graded decision"}</span>
        <span>{lesson.retiredAt ? lesson.retiredReason : lesson.memorySynced ? "In shared memory" : "Shared memory sync pending"} · {relative(lesson.createdAt)}</span>
      </footer>
    </article>)}
  </div>;
}

function TeamRoster({ members }: { members: FinanceTeamMember[] }) {
  if (!members.length) return <div className="team-roster"><span className="member-chip">No assigned agents</span></div>;
  return <ol className="team-roster">{members.map((member) => <li key={member.agentId} className={member.lead ? "lead" : ""}>
    <span className="roster-rank">{member.rank}</span>
    <div><strong>{member.displayName}</strong><small>{member.role ?? "Role unset"}</small></div>
    {member.lead && <span className="lead-badge"><Crown size={11} /> Team lead</span>}
  </li>)}</ol>;
}

function TeamPortfolioTotalPanel({ total }: { total: TeamPortfolioTotal }) {
  return <Panel
    title="All teams combined"
    icon={<WalletCards size={16} />}
    action={<span className="portfolio-total">{money(total.totalValue, total.currency)}</span>}
  >
    <div className="metric-strip four"><Metric label="Combined value" value={money(total.totalValue, total.currency)} detail={`${total.portfolioCount} team portfolio${total.portfolioCount === 1 ? "" : "s"}`} /><Metric label="Daily change" value={signedMoney(total.dailyPnl, total.currency)} detail={percent(total.dailyReturn)} tone={tone(total.dailyPnl)} /><Metric label="Total return" value={optionalPercent(total.totalReturn)} detail={`${money(total.initialCash, total.currency)} funded`} tone={tone(total.totalReturn ?? 0)} /><Metric label="Cash reserve" value={money(total.cash, total.currency)} detail={`${money(total.grossExposure, total.currency)} invested`} /></div>
    <PositionTable positions={total.positions} currency={total.currency} />
  </Panel>;
}

// The badge is the only place an operator sees whether real paper orders can leave the
// building, so each execution mode gets its own words rather than a shared "read only".
const MODE_LABEL: Record<Overview["mode"], string> = {
  paper: "LOCAL PAPER",
  "ibkr-paper-read-only": "IBKR PAPER / READ ONLY",
  "ibkr-paper-dry-run": "IBKR PAPER / DRY RUN",
  "ibkr-paper-live": "IBKR PAPER / LIVE ORDERS",
};

function TradesView({ trades, proposals, brokerOrders, financeTeams, teamPortfolios, defaultCurrency, mode, request, refresh }: { trades: Trade[]; proposals: Proposal[]; brokerOrders: BrokerOrder[]; financeTeams: FinanceTeam[]; teamPortfolios: TeamPortfolios; defaultCurrency: string; mode: Overview["mode"]; request: Request; refresh: () => void }) {
  // In live mode the same button transmits a real paper order, so it must not keep calling
  // itself a risk check.
  const liveMode = mode === "ibkr-paper-live";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<OrderPreview | null>(null);
  const [live, setLive] = useState<LiveOrderResult | null>(null);
  const [reconciling, setReconciling] = useState(false);
  async function execute(id: string) {
    setBusy(id); setError(null); setDryRun(null); setLive(null);
    try {
      const result = await request<OrderPreview | LiveOrderResult | unknown>(`/proposals/${encodeURIComponent(id)}/execute`, { method: "POST" });
      // A dry run leaves the ledger untouched, so its only outcome is the broker preview.
      if ((result as OrderPreview)?.mode === "dry-run") setDryRun(result as OrderPreview);
      // A live order may still be working at the broker, which the trade table cannot show.
      if ((result as LiveOrderResult)?.mode === "live") setLive(result as LiveOrderResult);
      refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(null); }
  }
  async function reconcile() {
    setReconciling(true); setError(null);
    try {
      const report = await request<ReconcileReport>("/broker/reconcile", { method: "POST" });
      if (report.checked === 0) setError("No working broker orders to settle.");
      refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setReconciling(false); }
  }
  return <div className="view-stack"><div className="section-heading"><div><span className="eyebrow">DECISION PIPELINE</span><h2>Proposals and paper trades</h2></div></div>{error && <div className="error-banner">{error}</div>}{dryRun && <DryRunNotice result={dryRun} close={() => setDryRun(null)} />}{live && <LiveOrderNotice result={live} close={() => setLive(null)} reconcile={reconcile} reconciling={reconciling} />}<Panel title="Trade proposals" icon={<Target size={16} />}>{proposals.length ? <div className="table-wrap"><table><thead><tr><th>Decision</th><th>Agent</th><th>Order</th><th>Status</th><th>Created</th><th /></tr></thead><tbody>{proposals.map((proposal) => { const teamProposal = financeTeams.some((team) => team.portfolioId === proposal.portfolioId); return <tr key={proposal.id}><td><strong>{proposal.decisionId}</strong><small>{proposal.strategyId ?? "manual"}</small></td><td>{proposal.agentId}</td><td><span className={`side ${proposal.side.toLowerCase()}`}>{proposal.side}</span> {number(proposal.requestedQuantity)} {proposal.symbol}</td><td><Status value={proposal.status} /></td><td>{relative(proposal.createdAt)}</td><td>{proposal.status === "PROPOSED" && !teamProposal && <button className="button small" onClick={() => void execute(proposal.id)} disabled={busy === proposal.id}>{busy === proposal.id ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} {liveMode ? "Send order" : "Risk check"}</button>}</td></tr>; })}</tbody></table></div> : <Empty text="No proposals have been recorded." />}</Panel><Panel title="IBKR paper orders" icon={<Activity size={16} />}>{brokerOrders.length ? <BrokerOrderTable orders={brokerOrders} teams={financeTeams} /> : <Empty text="No IBKR paper orders have been submitted." />}</Panel><Panel title="Executed paper trades" icon={<History size={16} />}>{trades.length ? <div className="table-wrap"><table><thead><tr><th>Security</th><th>Side</th><th>Quantity</th><th>Execution</th><th>Fee</th><th>Agent</th><th>Time</th></tr></thead><tbody>{trades.map((trade) => { const currency = teamPortfolios.teams.find((team) => team.portfolio.id === trade.portfolioId)?.portfolio.currency ?? defaultCurrency; return <tr key={trade.id}><td><strong>{trade.symbol}</strong></td><td><span className={`side ${trade.side.toLowerCase()}`}>{trade.side}</span></td><td>{number(trade.quantity)}</td><td>{money(trade.price, currency)}</td><td>{money(trade.fee, currency)}</td><td>{trade.agentId}</td><td>{relative(trade.executedAt)}</td></tr>; })}</tbody></table></div> : <Empty text="No IBKR orders have filled and entered the paper ledger yet." />}</Panel></div>;
}

function BrokerOrderTable({ orders, teams, compact = false }: { orders: BrokerOrder[]; teams: FinanceTeam[]; compact?: boolean }) {
  const teamByPortfolio = new Map(teams.map((team) => [team.portfolioId, team.name]));
  return <div className="table-wrap"><table><thead><tr>{!compact && <th>Team</th>}<th>Security</th><th>Order</th><th>Filled</th><th>IBKR status</th><th>Ledger</th><th>Trader</th><th>Submitted</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}>{!compact && <td>{teamByPortfolio.get(order.portfolioId) ?? "Main"}</td>}<td><strong>{order.symbol}</strong></td><td><span className={`side ${order.side.toLowerCase()}`}>{order.side}</span> {number(order.quantity)} · {order.orderType}</td><td>{number(order.filledQuantity)} / {number(order.quantity)}</td><td><Status value={order.brokerStatus ?? "UNKNOWN"} /></td><td><Status value={order.status} /></td><td>{order.agentId}</td><td>{relative(order.createdAt)}</td></tr>)}</tbody></table></div>;
}

function DryRunNotice({ result, close }: { result: OrderPreview; close: () => void }) {
  const order = result.preview;
  const margin = order?.preview;
  return <div className="dry-run-notice"><div><span className="eyebrow">IBKR PAPER DRY RUN · NOTHING PLACED</span>{order
    ? <strong>{order.side} {number(order.quantity)} {order.symbol} · {order.orderType} · account {order.accountIdMasked}</strong>
    : <strong>Risk engine approved no quantity; no order was previewed.</strong>}
    {margin && <small>IBKR preview {margin.status} · initial margin {margin.initMarginChange === null ? "n/a" : money(margin.initMarginChange)} · fees {margin.commissionAndFees === null ? "n/a" : money(margin.commissionAndFees, margin.commissionAndFeesCurrency || "USD")}{margin.warningText ? ` · ${margin.warningText}` : ""}</small>}
    {result.decision.reasons.length > 0 && <small>{result.decision.reasons.join(" · ")}</small>}
  </div><button className="icon-button" title="Dismiss dry run" onClick={close}><X size={15} /></button></div>;
}

function LiveOrderNotice({ result, close, reconcile, reconciling }: { result: LiveOrderResult; close: () => void; reconcile: () => void; reconciling: boolean }) {
  const order = result.brokerOrder;
  const working = order?.status === "WORKING";
  return <div className="dry-run-notice"><div>
    <span className="eyebrow">{working ? "IBKR PAPER ORDER WORKING · NOT YET ON THE LEDGER" : "IBKR PAPER ORDER PLACED"}</span>
    {order
      ? <strong>{order.side} {number(order.quantity)} {order.symbol} · {order.orderType} · account {order.accountMasked}{order.brokerOrderId ? ` · broker order ${order.brokerOrderId}` : ""}</strong>
      : <strong>Risk engine approved no quantity; no order was sent.</strong>}
    {order && <small>IBKR status {order.brokerStatus ?? "unknown"} · filled {number(order.filledQuantity)} of {number(order.quantity)}{order.averageFillPrice === null ? "" : ` at ${money(order.averageFillPrice)}`}{order.fee === null ? "" : ` · fee ${money(order.fee)}`}</small>}
    {working && <small>A working order is booked only once IBKR reports its fill and commission. Settle it when the fill lands.</small>}
    {result.decision.reasons.length > 0 && <small>{result.decision.reasons.join(" · ")}</small>}
    {working && <button className="button small" onClick={() => void reconcile()} disabled={reconciling}>{reconciling ? <LoaderCircle className="spin" size={14} /> : <History size={14} />} Settle working orders</button>}
  </div><button className="icon-button" title="Dismiss order receipt" onClick={close}><X size={15} /></button></div>;
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
  const [teamToUpdate, setTeamToUpdate] = useState<FinanceTeam | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<{ team: FinanceTeam; member: FinanceTeamMember } | null>(null);
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

  async function promoteTeamLead(team: FinanceTeam, member: FinanceTeamMember) {
    setBusyId(`lead:${team.id}:${member.agentId}`); setError(null);
    try { await request(`/finance-teams/${encodeURIComponent(team.id)}/lead`, { method: "POST", body: JSON.stringify({ agentId: member.agentId }) }); refresh(); setMemberToRemove(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  async function removeTeamMember(team: FinanceTeam, member: FinanceTeamMember) {
    setBusyId(`member:${team.id}:${member.agentId}`); setError(null);
    try { await request(`/finance-teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.agentId)}`, { method: "DELETE" }); refresh(); setMemberToRemove(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  const assignedIds = new Set(financeAgents.map((agent) => agent.agentId));
  return <div className="view-stack">
    <div className="section-heading agent-management-heading"><div><span className="eyebrow">FINANCE AGENT OPERATIONS</span><h2>Assignments and teams</h2><p>Assign existing Orion agents, then group assigned agents into finance teams. A team is ready with one to five members.</p></div><div className="section-actions"><button className="button" onClick={() => { setAssignOpen(true); void loadAvailableAgents(); }}><UserPlus size={15} />Assign agent</button><button className="button primary" onClick={() => setTeamOpen(true)} disabled={!financeAgents.length || financeTeams.length >= 5}><Users size={15} />Create team</button></div></div>
    {error && <div className="error-banner"><span>{error}</span><button title="Dismiss" onClick={() => setError(null)}><X size={15} /></button></div>}
    <div className="team-metric-strip"><Metric label="Assigned agents" value={`${financeAgents.length}`} detail={`${availableAgents.length || "No"} available in Orion`} /><Metric label="Finance teams" value={`${financeTeams.length} / 5`} detail="Up to five teams" /><Metric label="Team capacity" value="1–5" detail="Agents per operating team" /></div>
    <div className="two-panels"><Panel title="Assigned finance agents" icon={<UserPlus size={16} />} action={<TextButton onClick={() => setAssignOpen(true)}>Assign</TextButton>}>{financeAgents.length ? <div className="finance-agent-list">{financeAgents.map((agent) => <article key={agent.agentId}><div><strong>{agent.displayName}</strong><small>{agent.agentId}{agent.role ? ` · ${agent.role}` : ""}</small></div><button className="icon-button small-icon" title={`Remove ${agent.displayName} from Finance Lab`} onClick={() => void remove(agent)} disabled={busyId === agent.agentId}>{busyId === agent.agentId ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}</button></article>)}</div> : <Empty text="No agents are assigned. Use Assign agent to choose from Orion Agent Room." />}</Panel>
      <Panel title="Finance teams" icon={<Users size={16} />} action={<TextButton onClick={() => setTeamOpen(true)}>Create</TextButton>}>{financeTeams.length ? <div className="finance-team-list">{financeTeams.map((team) => <article key={team.id}><header><div><strong>{team.name}</strong><small>{team.members.length} / 5 agents · lead {team.members.find((member) => member.lead)?.displayName ?? "unset"}</small></div><div className="team-actions"><button className="button small" onClick={() => setTeamToUpdate(team)} disabled={team.members.length >= 5}><UserPlus size={14} />Add agents</button><button className="icon-button small-icon" title={`Delete ${team.name}`} onClick={() => void removeTeam(team)} disabled={busyId === `team:${team.id}`}>{busyId === `team:${team.id}` ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}</button></div></header><div className="team-members">{team.members.map((member) => <button className={member.lead ? "team-member lead" : "team-member"} key={member.agentId} title={`${member.displayName} · rank ${member.rank}${member.lead ? " · team lead" : ""}`} onClick={() => setMemberToRemove({ team, member })}>{member.lead && <Crown size={11} aria-hidden="true" />}<span>{member.displayName}</span><X size={11} aria-hidden="true" /></button>)}</div></article>)}</div> : <Empty text="No finance teams yet. Teams can operate with one to five assigned agents." />}</Panel></div>
    <Panel title="Agent scorecard" icon={<Bot size={16} />}>{agents.length ? <div className="table-wrap"><table><thead><tr><th>Agent ID</th><th>Predictions</th><th>Directional accuracy</th><th>Avg alpha</th><th>Calibration</th><th>Paper trades</th></tr></thead><tbody>{agents.map((agent) => <tr key={agent.agentId}><td><strong>{agent.agentId}</strong></td><td>{agent.evaluatedPredictions} / {agent.totalPredictions}</td><td>{optionalPercent(agent.directionalAccuracy)}</td><td className={tone(agent.averageAlpha ?? 0)}>{optionalPercent(agent.averageAlpha)}</td><td><Status value={agent.confidenceCalibration.status} /></td><td>{agent.tradeCount}</td></tr>)}</tbody></table></div> : <Empty text="No agent finance history exists yet. Agent creation remains in Orion Agent Room." />}</Panel>
    {assignOpen && <AssignFinanceAgentDialog availableAgents={availableAgents} assignedIds={assignedIds} busyId={busyId} assign={assign} close={() => setAssignOpen(false)} />}
    {teamOpen && <CreateFinanceTeamDialog financeAgents={financeAgents} teamCount={financeTeams.length} request={request} refresh={refresh} close={() => setTeamOpen(false)} />}
    {teamToUpdate && <AddFinanceTeamMembersDialog team={teamToUpdate} financeAgents={financeAgents} request={request} refresh={refresh} close={() => setTeamToUpdate(null)} />}
    {memberToRemove && <FinanceTeamMemberDialog team={memberToRemove.team} member={memberToRemove.member} busy={busyId === `member:${memberToRemove.team.id}:${memberToRemove.member.agentId}` || busyId === `lead:${memberToRemove.team.id}:${memberToRemove.member.agentId}`} promote={() => void promoteTeamLead(memberToRemove.team, memberToRemove.member)} remove={() => void removeTeamMember(memberToRemove.team, memberToRemove.member)} close={() => setMemberToRemove(null)} />}
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

function AddFinanceTeamMembersDialog({ team, financeAgents, request, refresh, close }: {
  team: FinanceTeam;
  financeAgents: FinanceAgent[];
  request: Request;
  refresh: () => void;
  close: () => void;
}) {
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = financeAgents.filter((agent) => !team.members.some((member) => member.agentId === agent.agentId));
  const remainingCapacity = 5 - team.members.length;
  function toggle(agentId: string) { setMemberIds((ids) => ids.includes(agentId) ? ids.filter((id) => id !== agentId) : ids.length < remainingCapacity ? [...ids, agentId] : ids); }
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(null); try { await request(`/finance-teams/${encodeURIComponent(team.id)}/members`, { method: "POST", body: JSON.stringify({ agentIds: memberIds }) }); refresh(); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section className="modal team-modal"><header><div><span className="eyebrow">{team.name.toUpperCase()}</span><h2>Add agents</h2></div><button className="icon-button" title="Close add agents" onClick={close}><X size={17} /></button></header><form className="team-form" onSubmit={submit}><div className="team-form-heading"><span>Assigned agents</span><small>{memberIds.length} / {remainingCapacity} selected</small></div><div className="team-picker">{available.length ? available.map((agent) => { const checked = memberIds.includes(agent.agentId); return <label key={agent.agentId}><input type="checkbox" checked={checked} onChange={() => toggle(agent.agentId)} disabled={!checked && memberIds.length >= remainingCapacity} /><span><strong>{agent.displayName}</strong><small>{agent.agentId}{agent.role ? ` · ${agent.role}` : ""}</small></span></label>; }) : <Empty text="All assigned Finance Lab agents are already in this team." />}</div>{error && <p className="form-error">{error}</p>}<button className="button primary" disabled={busy || !memberIds.length}>{busy ? <LoaderCircle size={15} className="spin" /> : <UserPlus size={15} />}Add selected agents</button></form></section></div>;
}

function FinanceTeamMemberDialog({ team, member, busy, promote, remove, close }: {
  team: FinanceTeam;
  member: FinanceTeamMember;
  busy: boolean;
  promote: () => void;
  remove: () => void;
  close: () => void;
}) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section className="modal confirmation-modal"><header><div><span className="eyebrow">{team.name.toUpperCase()} · RANK {member.rank}</span><h2>{member.displayName}</h2></div><button className="icon-button" title="Close member actions" onClick={close} disabled={busy}><X size={17} /></button></header><p>{member.role ?? "Role unset"}{member.lead ? " · leads this team" : ` · reports to ${team.members.find((entry) => entry.lead)?.displayName ?? "no lead"}`}</p><div className="confirmation-actions"><button className="button" onClick={close} disabled={busy}>Cancel</button>{!member.lead && <button className="button" onClick={promote} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Crown size={15} />}Make team lead</button>}<button className="button danger" onClick={remove} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}Remove from team</button></div></section></div>;
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
// Agent-runtime failures arrive as the provider's raw JSON error envelope, so unwrap it to the
// human sentence; anything else is shown verbatim rather than hidden behind a parse failure.
function formatTradingError(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    const message = (parsed as { error?: { message?: unknown }; message?: unknown })?.error?.message
      ?? (parsed as { message?: unknown })?.message;
    if (typeof message === "string" && message.trim()) return message;
  } catch { /* not JSON — fall through to the raw text */ }
  return value;
}
function formatTradingPhase(value: string) { return value.toLowerCase().replaceAll("_", " ").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()); }
function tone(value: number): "positive" | "negative" | "neutral" { return value > 0 ? "positive" : value < 0 ? "negative" : "neutral"; }
