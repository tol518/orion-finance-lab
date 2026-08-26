import express from "express";
import { serializeError } from "./validation.js";
import { OPERATOR_ACTOR } from "../service/finance-lab.js";

export function createFinanceRouter({ service, actorForRequest = () => OPERATOR_ACTOR }) {
  const router = express.Router();
  const route = (handler) => async (req, res) => {
    try {
      const data = await handler(req, actorForRequest(req));
      res.json({ ok: true, data });
    } catch (error) {
      const serialized = serializeError(error);
      res.status(serialized.status).json({
        ok: false,
        error: { code: serialized.code, message: serialized.message, details: serialized.details },
      });
    }
  };

  router.get("/health", (_req, res) => {
    res.json({ ok: true, data: { status: "ok", mode: "paper", version: "0.1.0" } });
  });
  router.get("/overview", route((_req, actor) => service.overview(actor)));
  router.get("/broker/status", route((_req, actor) => service.getBrokerStatus(actor)));
  router.get("/market/context", route((_req, actor) => service.getMarketContext(actor)));
  router.get("/market/:symbol/quote", route((req, actor) => service.getQuote(actor, req.params.symbol)));
  router.get("/market/:symbol/history", route((req, actor) => service.getPriceHistory(actor, req.params.symbol, req.query)));
  router.get("/market/:symbol/fundamentals", route((req, actor) => service.getFundamentals(actor, req.params.symbol)));
  router.get("/market/:symbol/news", route((req, actor) => service.getNews(actor, req.params.symbol, req.query)));

  router.get("/strategies", route((_req, actor) => service.listStrategies(actor)));
  router.post("/strategies/:strategyId/run", route((req, actor) => service.runStrategy(actor, req.params.strategyId, req.body ?? {})));
  router.post("/quant/run", route((req, actor) => service.runQuantAnalysis(actor, req.body ?? {})));
  router.post("/strategies/compare", route((req, actor) => service.compareStrategies(actor, req.body?.strategyIds)));

  router.get("/portfolios", route((_req, actor) => service.listPortfolios(actor)));
  router.get("/portfolios/:portfolioId", route((req, actor) => service.getPortfolio(actor, req.params.portfolioId)));
  router.get("/trades", route((req, actor) => service.listTrades(actor, req.query)));
  router.get("/proposals", route((req, actor) => service.listProposals(actor, req.query)));
  router.post("/proposals", route((req, actor) => service.createTradeProposal(actor, req.body ?? {})));
  router.post("/proposals/:proposalId/approve", route((req, actor) => service.approveTradeProposal(actor, req.params.proposalId)));
  router.post("/proposals/:proposalId/execute", route((req, actor) => service.executePaperTrade(actor, req.params.proposalId)));
  router.post("/broker/reconcile", route((req, actor) => service.reconcileBrokerOrders(actor, req.body ?? {})));
  router.get("/broker/orders", route((req, actor) => service.listBrokerOrders(actor, req.query)));
  router.get("/risk/:portfolioId", route((req, actor) => service.getRiskState(actor, req.params.portfolioId)));

  router.get("/predictions", route((req, actor) => service.listPredictions(actor, req.query)));
  router.post("/predictions", route((req, actor) => service.recordPrediction(actor, req.body ?? {})));
  router.post("/predictions/evaluate", route((_req, actor) => service.evaluatePredictions(actor)));
  router.get("/agents", route((_req, actor) => service.listAgentPerformance(actor)));
  router.get("/agents/:agentId", route((req, actor) => service.getAgentPerformance(actor, req.params.agentId)));
  router.get("/finance-agents", route((_req, actor) => service.listFinanceAgents(actor)));
  router.post("/finance-agents", route((req, actor) => service.assignFinanceAgent(actor, req.body ?? {})));
  router.delete("/finance-agents/:agentId", route((req, actor) => service.removeFinanceAgent(actor, req.params.agentId)));
  router.get("/finance-teams", route((_req, actor) => service.listFinanceTeams(actor)));
  router.get("/finance-teams/portfolios", route((_req, actor) => service.listTeamPortfolios(actor)));
  router.get("/finance-teams/context", route((req, actor) => service.getFinanceTeamContext(actor, req.query.agentId)));
  router.post("/finance-teams", route((req, actor) => service.createFinanceTeam(actor, req.body ?? {})));
  router.post("/finance-teams/:teamId/members", route((req, actor) => service.addFinanceTeamMembers(actor, req.params.teamId, req.body ?? {})));
  router.delete("/finance-teams/:teamId/members/:agentId", route((req, actor) => service.removeFinanceTeamMember(actor, req.params.teamId, req.params.agentId)));
  router.post("/finance-teams/:teamId/lead", route((req, actor) => service.promoteFinanceTeamLead(actor, req.params.teamId, req.body?.agentId)));
  router.delete("/finance-teams/:teamId", route((req, actor) => service.removeFinanceTeam(actor, req.params.teamId)));

  router.get("/experiments", route((_req, actor) => service.listExperiments(actor)));
  router.post("/experiments", route((req, actor) => service.createExperiment(actor, req.body ?? {})));
  router.get("/evidence/:evidenceId", route((req, actor) => service.getEvidence(actor, req.params.evidenceId)));
  router.get("/audit", route((req, actor) => service.getAudit(actor, req.query)));

  return router;
}
