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

    def nextValidId(self, order_id):
        self.next_order_id = int(order_id)
        self.ready.set()

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


def main():
    request = json.loads(sys.stdin.readline())
    operation = request.get("operation")
    app = connect(request)
    try:
        if operation == "probe":
            data = probe(app)
        elif operation == "snapshot":
            data = snapshot(app, request)
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
