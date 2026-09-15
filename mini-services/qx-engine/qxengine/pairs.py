"""Pair definitions — identical to the TS engine."""

ALL_PAIRS = [
    {"symbol": "EURUSD", "name": "EUR/USD", "digits": 5, "pip": 0.0001, "basePrice": 1.0842, "volPips": 8},
    {"symbol": "USDJPY", "name": "USD/JPY", "digits": 3, "pip": 0.01, "basePrice": 149.352, "volPips": 10},
    {"symbol": "AUDUSD", "name": "AUD/USD", "digits": 5, "pip": 0.0001, "basePrice": 0.65415, "volPips": 7},
    {"symbol": "GBPUSD", "name": "GBP/USD", "digits": 5, "pip": 0.0001, "basePrice": 1.26575, "volPips": 9},
    {"symbol": "EURJPY", "name": "EUR/JPY", "digits": 3, "pip": 0.01, "basePrice": 162.148, "volPips": 12},
    {"symbol": "GBPJPY", "name": "GBP/JPY", "digits": 3, "pip": 0.01, "basePrice": 189.024, "volPips": 15},
    {"symbol": "USDCAD", "name": "USD/CAD", "digits": 5, "pip": 0.0001, "basePrice": 1.35155, "volPips": 7},
    {"symbol": "USDCHF", "name": "USD/CHF", "digits": 5, "pip": 0.0001, "basePrice": 0.88425, "volPips": 6},
]

DEFAULT_PAIRS = [p["symbol"] for p in ALL_PAIRS]

_BY_SYMBOL = {p["symbol"]: p for p in ALL_PAIRS}


def get_pair_def(symbol: str) -> dict:
    return _BY_SYMBOL.get(symbol, ALL_PAIRS[0])
