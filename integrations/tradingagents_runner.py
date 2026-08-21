"""Thin JSON bridge to an independently installed TauricResearch/TradingAgents checkout."""

from __future__ import annotations

import copy
import json
import os
import sys
from typing import Any


def serializable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [serializable(item) for item in value]
    return str(value)


def main() -> None:
    request = json.load(sys.stdin)
    repo_path = os.path.abspath(request["repoPath"])
    if repo_path not in sys.path:
        sys.path.insert(0, repo_path)

    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    config = copy.deepcopy(DEFAULT_CONFIG)
    permitted = {
        "deep_think_llm",
        "quick_think_llm",
        "max_debate_rounds",
        "max_risk_discuss_rounds",
        "max_recur_limit",
        "online_tools",
    }
    for key, value in request.get("modelConfig", {}).items():
        if key in permitted:
            config[key] = value

    graph = TradingAgentsGraph(debug=False, config=config)
    state, decision = graph.propagate(request["symbol"], request["date"])
    analyst_keys = [
        "market_report",
        "sentiment_report",
        "news_report",
        "fundamentals_report",
    ]
    analyst_outputs = {key: state.get(key) for key in analyst_keys if state.get(key)}
    result = {
        "decision": serializable(decision),
        "finalRecommendation": serializable(state.get("final_trade_decision", decision)),
        "analystOutputs": serializable(analyst_outputs),
        "debate": serializable({
            "investment": state.get("investment_debate_state"),
            "risk": state.get("risk_debate_state"),
        }),
        "models": [config.get("quick_think_llm"), config.get("deep_think_llm")],
        "state": serializable(state),
    }
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
