#!/usr/bin/env python3
"""One-shot JSON bridge from Finance Lab to the official IBKR Python API."""

import json
import sys
import threading
import time

try:
    from ibapi.client import EClient
    from ibapi.wrapper import EWrapper
except ImportError:
    print(
        json.dumps(
            {
                "ok": False,
                "error": {
                    "code": "IBKR_API_NOT_INSTALLED",
                    "message": "Official IBKR Python API is not installed for this interpreter",
                },
            }
        )
    )
    sys.exit(2)


SETTLED_ORDER_STATUS = {"Filled", "Submitted", "Cancelled", "ApiCancelled", "Inactive"}
ORDER_TYPES = {"MKT", "LMT"}

ACCOUNT_TAGS = ",".join(
    [
        "NetLiquidation",
        "TotalCashValue",
        "AvailableFunds",
        "BuyingPower",
        "RealizedPnL",
        "UnrealizedPnL",
    ]
)


class FinanceIbkrApp(EWrapper, EClient):
    def __init__(self):
        EClient.__init__(self, self)
        self.ready = threading.Event()
        self.accounts_ready = threading.Event()
        self.summary_ready = threading.Event()
        self.positions_ready = threading.Event()
        self.accounts = []
        self.summary = {}
        self.positions = []
        self.errors = []
        self.next_order_id = None
        self.contract_details = []
        self.contract_ready = threading.Event()
        self.order_state = None
        self.order_contract = None
        self.order_perm_id = None
        self.order_acknowledged = threading.Event()
        self.order_status = None
        self.order_settled = threading.Event()
        self.pending_order_id = None
        self.executions = []
        self.commissions = {}
        self.open_orders = []
        self.open_orders_ready = threading.Event()
        self.completed_orders = []
        self.completed_orders_ready = threading.Event()
        self.executions_ready = threading.Event()

    def nextValidId(self, order_id):
        self.next_order_id = int(order_id)
        self.ready.set()

    def contractDetails(self, req_id, details):
        contract = details.contract
        self.contract_details.append(
            {
                "contractId": contract.conId,
                "symbol": contract.symbol,
                "securityType": contract.secType,
                "currency": contract.currency,
                "exchange": contract.exchange,
                "primaryExchange": contract.primaryExchange,
                "tradingClass": contract.tradingClass,
                "longName": getattr(details, "longName", ""),
            }
        )

    def contractDetailsEnd(self, req_id):
        self.contract_ready.set()

    def openOrder(self, order_id, contract, order, order_state):
        self.open_orders.append(
            {
                "orderId": int(order_id),
                "permId": int(getattr(order, "permId", 0) or 0),
                "accountId": str(getattr(order, "account", "") or ""),
                "symbol": contract.symbol,
                "side": str(order.action),
                "quantity": float(order.totalQuantity),
                "orderType": str(order.orderType),
                "orderRef": text_value(getattr(order, "orderRef", "") or ""),
                "status": text_value(order_state.status),
            }
        )
        if self.pending_order_id is None or int(order_id) != self.pending_order_id:
            return
        self.order_state = order_state
        self.order_contract = contract
        self.order_perm_id = int(getattr(order, "permId", 0) or 0)
        self.order_acknowledged.set()

    def openOrderEnd(self):
        self.open_orders_ready.set()

    def completedOrder(self, contract, order, order_state):
        self.completed_orders.append(
            {
                "orderId": int(getattr(order, "orderId", 0) or 0),
                "permId": int(getattr(order, "permId", 0) or 0),
                "accountId": str(getattr(order, "account", "") or ""),
                "symbol": contract.symbol,
                "side": str(order.action),
                "quantity": float(order.totalQuantity),
                "orderType": str(order.orderType),
                "orderRef": text_value(getattr(order, "orderRef", "") or ""),
                "status": text_value(order_state.status),
            }
        )

    def completedOrdersEnd(self):
        self.completed_orders_ready.set()

    def orderStatus(self, order_id, status, filled, remaining, avg_fill_price, perm_id, parent_id,
                    last_fill_price, client_id, why_held, mkt_cap_price):
        if self.pending_order_id is None or int(order_id) != self.pending_order_id:
            return
        self.order_status = {
            "orderId": int(order_id),
            "status": str(status),
            "filled": float(filled),
            "remaining": float(remaining),
            "averageFillPrice": float(avg_fill_price),
            "lastFillPrice": float(last_fill_price),
            "permId": int(perm_id),
            "whyHeld": str(why_held or ""),
        }
        self.order_acknowledged.set()
        # Only a resting or finished order is a settled answer; transient states keep the
        # bridge waiting so a fill that lands milliseconds later is still reported.
        if str(status) in SETTLED_ORDER_STATUS:
            self.order_settled.set()

    def execDetails(self, req_id, contract, execution):
        self.executions.append(
            {
                "executionId": execution.execId,
                "orderId": int(execution.orderId),
                # permId is the only order identifier IBKR keeps stable across API
                # sessions, so reconciliation matches on it rather than on orderId.
                "permId": int(getattr(execution, "permId", 0) or 0),
                "accountId": execution.acctNumber,
                "symbol": contract.symbol,
                "side": execution.side,
                "quantity": float(execution.shares),
                "price": float(execution.price),
                "cumulativeQuantity": float(getattr(execution, "cumQty", execution.shares)),
                "averagePrice": float(getattr(execution, "avgPrice", execution.price)),
                "time": str(execution.time),
                "exchange": execution.exchange,
                "orderRef": text_value(getattr(execution, "orderRef", "") or ""),
            }
        )

    def execDetailsEnd(self, req_id):
        self.executions_ready.set()

    # Commission arrives on its own callback after the execution, so the real fee is only
    # knowable once both have landed; the ledger must not invent one.
    def commissionAndFeesReport(self, report):
        self.commissions[str(report.execId)] = {
            "commission": float_or_none(report.commissionAndFees),
            "currency": text_value(getattr(report, "currency", "") or ""),
            "realizedPnl": float_or_none(getattr(report, "realizedPNL", None)),
        }

    def managedAccounts(self, accounts_list):
        self.accounts = [item.strip() for item in accounts_list.split(",") if item.strip()]
        self.accounts_ready.set()

    def accountSummary(self, req_id, account, tag, value, currency):
        self.summary.setdefault(account, {})[tag] = {"value": value, "currency": currency}

    def accountSummaryEnd(self, req_id):
        self.summary_ready.set()

    def position(self, account, contract, position, average_cost):
        self.positions.append(
            {
                "accountId": account,
                "symbol": contract.symbol,
                "securityType": contract.secType,
                "currency": contract.currency,
                "exchange": contract.exchange or contract.primaryExchange,
                "contractId": contract.conId,
                "quantity": float(position),
                "averageCost": float(average_cost),
            }
        )

    def positionEnd(self):
        self.positions_ready.set()

    def error(self, req_id, *args):
        error_code, error_string = parse_error_args(args)
        if error_code in {2104, 2106, 2107, 2108, 2158}:
            return
        self.errors.append({"requestId": req_id, "code": error_code, "message": error_string})
        # A rejected order never produces openOrder or orderStatus, so the error itself has
        # to release the waiters or the bridge would sit until its timeout. Advisory codes
        # arrive on the same callback with requestId -1 though, and treating one of those as
        # a rejection would report "no fill" for an order that is actually working.
        if is_advisory_error(error_code, error_string):
            return
        if self.pending_order_id is not None and req_id == self.pending_order_id:
            self.order_acknowledged.set()
            self.order_settled.set()


# IBKR reports connectivity notices (1100-1102) and market-data/pacing warnings (2100-2999)
# through the error callback; neither is an order rejection.
def is_advisory_error(code, message=""):
    # Code 399 carries both order errors and warnings. A warning must not end the
    # acknowledgement wait before the following openOrder/orderStatus callback arrives.
    return (
        1100 <= code <= 1102
        or 2100 <= code <= 2999
        or (code == 399 and "warning:" in str(message).lower())
    )


def parse_error_args(args):
    if len(args) >= 3 and isinstance(args[1], int):
        return int(args[1]), str(args[2])
    if len(args) >= 2:
        return int(args[0]), str(args[1])
    return -1, "Unknown IBKR API error"


def wait_for(event, timeout, label):
    if not event.wait(timeout):
        raise RuntimeError(f"Timed out waiting for IBKR {label}")


def number(summary, tag):
    item = summary.get(tag)
    if not item:
        return None
    try:
        return float(item["value"])
    except (TypeError, ValueError):
        return None


def currency(summary):
    for tag in ("NetLiquidation", "TotalCashValue", "AvailableFunds"):
        value = summary.get(tag, {}).get("currency")
        if value and value != "BASE":
            return value
    return "USD"


def connect(request):
    app = FinanceIbkrApp()
    app.connect(
        str(request.get("host", "127.0.0.1")),
        int(request.get("port", 4002)),
        clientId=int(request.get("clientId", 91)),
    )
    thread = threading.Thread(target=app.run, name="ibkr-api-reader", daemon=True)
    thread.start()
    wait_for(app.ready, 8, "connection handshake")
    if not app.accounts_ready.wait(1):
        app.reqManagedAccts()
        wait_for(app.accounts_ready, 4, "managed accounts")
    return app


def probe(app):
    return {
        "connected": app.isConnected(),
        "accounts": app.accounts,
        "serverVersion": app.serverVersion(),
        "connectionTime": text_value(app.twsConnectionTime()),
    }


def text_value(value):
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)


def snapshot(app, request):
    account_id = str(request.get("accountId", "")).strip()
    if not account_id or account_id not in app.accounts:
        raise RuntimeError("Configured account is not available in this IB Gateway session")

    request_id = 9101
    app.reqAccountSummary(request_id, "All", ACCOUNT_TAGS)
    app.reqPositions()
    wait_for(app.summary_ready, 8, "account summary")
    wait_for(app.positions_ready, 8, "positions")
    app.cancelAccountSummary(request_id)
    app.cancelPositions()

    values = app.summary.get(account_id, {})
    net_liquidation = number(values, "NetLiquidation")
    cash = number(values, "TotalCashValue")
    if net_liquidation is None or cash is None:
        raise RuntimeError("IBKR did not return required paper-account balances")
    return {
        "accountId": account_id,
        "currency": currency(values),
        "netLiquidation": net_liquidation,
        "cash": cash,
        "availableFunds": number(values, "AvailableFunds"),
        "buyingPower": number(values, "BuyingPower"),
        "realisedPnl": number(values, "RealizedPnL"),
        "unrealisedPnl": number(values, "UnrealizedPnL"),
        "positions": [item for item in app.positions if item["accountId"] == account_id],
    }


def qualify_contract(app, request):
    from ibapi.contract import Contract

    contract = Contract()
    contract.symbol = str(request["symbol"]).strip().upper()
    contract.secType = "STK"
    contract.currency = str(request.get("currency", "USD")).strip().upper()
    contract.exchange = str(request.get("exchange", "SMART")).strip().upper()
    app.reqContractDetails(9301, contract)
    wait_for(app.contract_ready, 8, "contract details")
    matches = [item for item in app.contract_details if item["currency"] == contract.currency]
    if not matches:
        raise RuntimeError(f"IBKR did not resolve a {contract.currency} stock contract for {contract.symbol}")
    primary = matches[0]
    # Pin the resolved contract id so the order cannot re-resolve to a different listing.
    contract.conId = primary["contractId"]
    contract.primaryExchange = primary["primaryExchange"] or ""
    return contract, primary


def place_order(app, request):
    from ibapi.order import Order

    account_id = str(request.get("accountId", "")).strip()
    if not account_id or account_id not in app.accounts:
        raise RuntimeError("Configured account is not available in this IB Gateway session")
    side = str(request.get("side", "")).strip().upper()
    if side not in {"BUY", "SELL"}:
        raise RuntimeError("Order side must be BUY or SELL")
    order_type = str(request.get("orderType", "MKT")).strip().upper()
    if order_type not in ORDER_TYPES:
        raise RuntimeError("Order type must be MKT or LMT")
    quantity = float(request.get("quantity", 0))
    if quantity <= 0:
        raise RuntimeError("Order quantity must be positive")
    what_if = bool(request.get("whatIf", True))

    contract, resolved = qualify_contract(app, request)
    if app.next_order_id is None:
        raise RuntimeError("IBKR did not deliver a valid order id")

    order = Order()
    order.action = side
    order.orderType = order_type
    order.totalQuantity = quantity
    order.tif = str(request.get("timeInForce", "DAY")).strip().upper()
    # The account is pinned by the caller allowlist; IBKR must never infer it.
    order.account = account_id
    order.orderRef = str(request.get("orderRef", "")).strip()[:128]
    order.transmit = True
    order.whatIf = what_if
    order.eTradeOnly = False
    order.firmQuoteOnly = False
    if order_type == "LMT":
        limit_price = request.get("limitPrice")
        if limit_price is None:
            raise RuntimeError("A limit order requires limitPrice")
        order.lmtPrice = float(limit_price)

    order_id = app.next_order_id
    app.pending_order_id = order_id
    app.placeOrder(order_id, contract, order)
    timeout = float(request.get("orderTimeoutSeconds", 12))
    if what_if:
        wait_for(app.order_acknowledged, timeout, "order preview")
    elif not app.order_settled.wait(timeout):
        wait_for(app.order_acknowledged, 1, "order acknowledgement")

    order_errors = [item for item in app.errors if item["requestId"] in {order_id, -1}]
    state = app.order_state
    result = {
        "accountId": account_id,
        "orderId": order_id,
        "permId": app.order_perm_id,
        "whatIf": what_if,
        "symbol": contract.symbol,
        "side": side,
        "quantity": quantity,
        "orderType": order_type,
        "contract": resolved,
        "status": app.order_status["status"] if app.order_status else ("PREVIEWED" if state else "UNKNOWN"),
        "fill": app.order_status,
        "executions": with_commissions(app, [item for item in app.executions if item["orderId"] == order_id]),
        "errors": order_errors,
    }
    if state is not None:
        result["preview"] = {
            "status": text_value(state.status),
            "initMarginChange": float_or_none(state.initMarginChange),
            "maintMarginChange": float_or_none(state.maintMarginChange),
            "equityWithLoanChange": float_or_none(state.equityWithLoanChange),
            "commissionAndFees": float_or_none(state.commissionAndFees),
            "commissionAndFeesCurrency": text_value(state.commissionAndFeesCurrency or ""),
            "rejectReason": text_value(state.rejectReason or ""),
            "warningText": text_value(state.warningText or ""),
        }
    return result


def with_commissions(app, executions):
    merged = []
    for item in executions:
        report = app.commissions.get(item["executionId"])
        merged.append({**item, "commission": report} if report else {**item, "commission": None})
    return merged


# Asynchronous fills need a second look after the order was accepted, so reconcile reports
# what IBKR still holds open plus every execution it has for the account today.
def reconcile(app, request):
    from ibapi.execution import ExecutionFilter

    account_id = str(request.get("accountId", "")).strip()
    if not account_id or account_id not in app.accounts:
        raise RuntimeError("Configured account is not available in this IB Gateway session")
    app.reqAllOpenOrders()
    wait_for(app.open_orders_ready, 8, "open orders")
    app.reqCompletedOrders(True)
    wait_for(app.completed_orders_ready, 8, "completed orders")
    app.reqExecutions(9401, ExecutionFilter())
    wait_for(app.executions_ready, 8, "executions")
    # Commission reports trail their execution, so give the pending ones a moment to land
    # rather than writing a zero fee onto the ledger.
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and any(
        item["executionId"] not in app.commissions for item in app.executions
    ):
        time.sleep(0.05)
    return {
        "accountId": account_id,
        "openOrders": [item for item in app.open_orders if not item["accountId"] or item["accountId"] == account_id],
        "completedOrders": [
            item for item in app.completed_orders
            if not item["accountId"] or item["accountId"] == account_id
        ],
        "executions": with_commissions(
            app, [item for item in app.executions if item["accountId"] == account_id]
        ),
        "errors": [
            item
            for item in app.errors
            if not is_advisory_error(item["code"], item["message"])
        ],
    }


def float_or_none(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    # IBKR pads unset margin and commission fields with a sentinel maximum double.
    return None if parsed > 1e307 else parsed


def main():
    request = json.loads(sys.stdin.readline())
    operation = request.get("operation")
    app = connect(request)
    try:
        if operation == "probe":
            data = probe(app)
        elif operation == "snapshot":
            data = snapshot(app, request)
        elif operation == "place_order":
            data = place_order(app, request)
        elif operation == "reconcile":
            data = reconcile(app, request)
        else:
            raise RuntimeError("Unsupported IBKR bridge operation")
        print(json.dumps({"ok": True, "data": data}, separators=(",", ":")))
    finally:
        app.disconnect()
        time.sleep(0.05)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {"code": "IBKR_BRIDGE_ERROR", "message": str(error)},
                },
                separators=(",", ":"),
            )
        )
        sys.exit(1)
