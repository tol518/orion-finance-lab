import YahooFinance from "yahoo-finance2";
import { MarketDataProvider, marketEnvelope } from "./provider.js";

export class YahooMarketDataProvider extends MarketDataProvider {
  constructor({ client = new YahooFinance({ suppressNotices: ["yahooSurvey"] }) } = {}) {
    super("yahoo-finance2");
    this.client = client;
  }

  async quote(symbol) {
    const quote = await this.client.quote(symbol);
    return marketEnvelope({
      provider: this.id,
      source: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
      symbol,
      data: normalizeQuote(quote),
    });
  }

  async history(symbol, { from, to, interval = "1d" }) {
    const result = await this.client.chart(symbol, {
      period1: new Date(from),
      period2: new Date(to),
      interval,
    });
    const bars = (result?.quotes ?? []).map((bar) => ({
      date: new Date(bar.date).toISOString(),
      open: finite(bar.open),
      high: finite(bar.high),
      low: finite(bar.low),
      close: finite(bar.close),
      adjustedClose: finite(bar.adjclose),
      volume: finite(bar.volume),
    })).filter((bar) => bar.close !== null);
    return marketEnvelope({
      provider: this.id,
      source: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history`,
      symbol,
      requestedRange: { from, to, interval },
      data: bars,
    });
  }

  async fundamentals(symbol) {
    const modules = [
      "assetProfile",
      "summaryDetail",
      "financialData",
      "defaultKeyStatistics",
      "calendarEvents",
      "earnings",
      "earningsHistory",
    ];
    const [summary, statements] = await Promise.all([
      this.client.quoteSummary(symbol, { modules }),
      this.client.fundamentalsTimeSeries(symbol, {
        period1: new Date(Date.now() - 5 * 365 * 86_400_000),
        period2: new Date(),
        type: "annual",
        module: "all",
      }),
    ]);
    return marketEnvelope({
      provider: this.id,
      source: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/financials`,
      symbol,
      data: { summary, statements },
    });
  }

  async news(symbol, { count = 10 } = {}) {
    const result = await this.client.search(symbol, { newsCount: count, quotesCount: 0 });
    const data = (result?.news ?? []).slice(0, count).map((item) => ({
      title: item.title,
      publisher: item.publisher,
      link: item.link,
      publishedAt: item.providerPublishTime ? new Date(item.providerPublishTime).toISOString() : null,
      type: item.type ?? null,
      relatedTickers: item.relatedTickers ?? [],
    }));
    return marketEnvelope({
      provider: this.id,
      source: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/news`,
      symbol,
      data,
    });
  }
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeQuote(quote) {
  return {
    symbol: quote.symbol,
    name: quote.longName ?? quote.shortName ?? quote.symbol,
    exchange: quote.fullExchangeName ?? quote.exchange ?? null,
    assetType: quote.quoteType ?? null,
    currency: quote.currency ?? null,
    price: finite(quote.regularMarketPrice),
    previousClose: finite(quote.regularMarketPreviousClose),
    change: finite(quote.regularMarketChange),
    changePercent: finite(quote.regularMarketChangePercent),
    marketState: quote.marketState ?? null,
    marketTime: quote.regularMarketTime ? new Date(quote.regularMarketTime).toISOString() : null,
    dayHigh: finite(quote.regularMarketDayHigh),
    dayLow: finite(quote.regularMarketDayLow),
    volume: finite(quote.regularMarketVolume),
    marketCap: finite(quote.marketCap),
  };
}
