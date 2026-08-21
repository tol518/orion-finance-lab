export class MarketDataProvider {
  constructor(id) {
    this.id = id;
  }

  async quote() {
    throw new Error(`${this.id} does not implement quote()`);
  }

  async history() {
    throw new Error(`${this.id} does not implement history()`);
  }

  async fundamentals() {
    throw new Error(`${this.id} does not implement fundamentals()`);
  }

  async news() {
    throw new Error(`${this.id} does not implement news()`);
  }
}
export function marketEnvelope({ provider, source, symbol, requestedRange = null, data }) {
  const timestamps = Array.isArray(data)
    ? data.map((item) => new Date(item.date ?? item.timestamp ?? 0).getTime()).filter(Number.isFinite)
    : [];
  return {
    provider,
    source,
    symbol,
    retrievedAt: new Date().toISOString(),
    requestedRange,
    actualRange: timestamps.length
      ? {
          from: new Date(Math.min(...timestamps)).toISOString(),
          to: new Date(Math.max(...timestamps)).toISOString(),
        }
      : null,
    data,
  };
}
