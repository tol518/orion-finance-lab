import { FinanceError, isoDate, normalizeSymbol } from "../api/validation.js";

const CACHE_LIMIT = 200;
const MAX_HISTORY_DAYS = 3_660;
const MAX_HISTORY_BARS = 5_000;

export class MarketDataService {
  constructor({ provider, recordMetadata = () => {}, now = () => Date.now(), limitPerMinute = 120 }) {
    this.provider = provider;
    this.recordMetadata = recordMetadata;
    this.now = now;
    this.limitPerMinute = limitPerMinute;
    this.cache = new Map();
    this.requestTimes = [];
  }

  quote(symbol) {
    const normalized = normalizeSymbol(symbol);
    return this.#read(`quote:${normalized}`, 30_000, () => this.provider.quote(normalized));
  }

  async history(symbol, { from, to = new Date(this.now()).toISOString(), interval = "1d" } = {}) {
    const normalized = normalizeSymbol(symbol);
    const end = isoDate(to, "to");
    const start = isoDate(from ?? new Date(new Date(end).getTime() - 180 * 86_400_000).toISOString(), "from");
    if (new Date(start) >= new Date(end)) {
      throw new FinanceError("from must be earlier than to", { code: "INVALID_DATE_RANGE" });
    }
    const spanDays = (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
    if (spanDays > MAX_HISTORY_DAYS) {
      throw new FinanceError("Price history is limited to ten years per request", {
        code: "HISTORY_RANGE_LIMIT",
      });
    }
    if (!new Set(["1d", "1wk", "1mo"]).has(interval)) {
      throw new FinanceError("interval must be 1d, 1wk, or 1mo", { code: "INVALID_INTERVAL" });
    }
    const result = await this.#read(`history:${normalized}:${start}:${end}:${interval}`, 300_000, () =>
      this.provider.history(normalized, { from: start, to: end, interval }),
    );
    if (!Array.isArray(result?.data) || result.data.length > MAX_HISTORY_BARS) {
      throw new FinanceError("Price history exceeded the 5,000-bar evidence limit", {
        code: "HISTORY_BAR_LIMIT",
      });
    }
    return result;
  }

  fundamentals(symbol) {
    const normalized = normalizeSymbol(symbol);
    return this.#read(`fundamentals:${normalized}`, 300_000, () => this.provider.fundamentals(normalized));
  }

  news(symbol, { count = 10 } = {}) {
    const normalized = normalizeSymbol(symbol);
    const boundedCount = Math.max(1, Math.min(30, Number(count) || 10));
    return this.#read(`news:${normalized}:${boundedCount}`, 120_000, () =>
      this.provider.news(normalized, { count: boundedCount }),
    );
  }

  async context() {
    const symbols = ["^GSPC", "^IXIC", "^VIX", "^TNX"];
    const settled = await Promise.allSettled(symbols.map((symbol) => this.quote(symbol)));
    return settled.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : { symbol: symbols[index], error: String(result.reason?.message ?? result.reason) },
    );
  }

  async #read(key, ttlMs, fetcher) {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    this.#consumeRateLimit();
    const value = await fetcher();
    this.recordMetadata(value);
    this.cache.set(key, { expiresAt: this.now() + ttlMs, value });
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  #consumeRateLimit() {
    const cutoff = this.now() - 60_000;
    this.requestTimes = this.requestTimes.filter((time) => time > cutoff);
    if (this.requestTimes.length >= this.limitPerMinute) {
      throw new FinanceError("Market-data rate limit reached; retry shortly", {
        code: "MARKET_RATE_LIMIT",
        status: 429,
      });
    }
    this.requestTimes.push(this.now());
  }
}
