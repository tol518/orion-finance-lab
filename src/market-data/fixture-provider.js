import { MarketDataProvider, marketEnvelope } from "./provider.js";

export class FixtureMarketDataProvider extends MarketDataProvider {
  constructor({ quotes = {}, histories = {}, fundamentals = {}, news = {} } = {}) {
    super("fixture");
    this.quotes = quotes;
    this.histories = histories;
    this.fundamentalData = fundamentals;
    this.newsData = news;
  }

  async quote(symbol) {
    const data = this.quotes[symbol];
    if (!data) throw new Error(`No fixture quote for ${symbol}`);
    return marketEnvelope({ provider: this.id, source: `fixture://${symbol}/quote`, symbol, data });
  }

  async history(symbol, requestedRange) {
    const data = this.histories[symbol] ?? [];
    return marketEnvelope({
      provider: this.id,
      source: `fixture://${symbol}/history`,
      symbol,
      requestedRange,
      data,
    });
  }

  async fundamentals(symbol) {
    return marketEnvelope({
      provider: this.id,
      source: `fixture://${symbol}/fundamentals`,
      symbol,
      data: this.fundamentalData[symbol] ?? {},
    });
  }

  async news(symbol) {
    return marketEnvelope({
      provider: this.id,
      source: `fixture://${symbol}/news`,
      symbol,
      data: this.newsData[symbol] ?? [],
    });
  }
}
