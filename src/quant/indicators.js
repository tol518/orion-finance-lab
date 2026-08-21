function clean(values) {
  return values.map(Number).filter(Number.isFinite);
}

export function simpleMovingAverage(values, period) {
  const source = clean(values);
  if (source.length < period || period < 1) return null;
  const window = source.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function exponentialMovingAverage(values, period) {
  const source = clean(values);
  if (source.length < period || period < 1) return null;
  const multiplier = 2 / (period + 1);
  let ema = source.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of source.slice(period)) ema = value * multiplier + ema * (1 - multiplier);
  return ema;
}

export function relativeStrengthIndex(values, period = 14) {
  const source = clean(values);
  if (source.length <= period) return null;
  const changes = source.slice(1).map((value, index) => value - source[index]);
  const recent = changes.slice(-period);
  const gain = recent.reduce((sum, value) => sum + Math.max(value, 0), 0) / period;
  const loss = recent.reduce((sum, value) => sum + Math.max(-value, 0), 0) / period;
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const source = clean(values);
  if (source.length < slow + signal) return null;
  const lineSeries = [];
  for (let index = slow; index <= source.length; index += 1) {
    const subset = source.slice(0, index);
    lineSeries.push(exponentialMovingAverage(subset, fast) - exponentialMovingAverage(subset, slow));
  }
  const line = lineSeries.at(-1);
  const signalLine = exponentialMovingAverage(lineSeries, signal);
  return { line, signal: signalLine, histogram: signalLine === null ? null : line - signalLine };
}

export function annualizedVolatility(values, periods = 252) {
  const source = clean(values);
  if (source.length < 3) return null;
  const returns = source.slice(1).map((value, index) => value / source[index] - 1);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * periods);
}

export function maximumDrawdown(values) {
  const source = clean(values);
  if (source.length === 0) return null;
  let peak = source[0];
  let maximum = 0;
  for (const value of source) {
    peak = Math.max(peak, value);
    maximum = Math.min(maximum, value / peak - 1);
  }
  return maximum;
}

export function averageTrueRange(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length <= period) return null;
  const ranges = bars.slice(1).map((bar, index) => {
    const previousClose = Number(bars[index].close);
    return Math.max(
      Number(bar.high) - Number(bar.low),
      Math.abs(Number(bar.high) - previousClose),
      Math.abs(Number(bar.low) - previousClose),
    );
  });
  return simpleMovingAverage(ranges, period);
}

export function analyzeBars(bars) {
  if (!Array.isArray(bars) || bars.length < 2) {
    return { sampleSize: Array.isArray(bars) ? bars.length : 0, insufficientData: true };
  }
  const closes = clean(bars.map((bar) => bar.close));
  const latest = closes.at(-1);
  const first = closes[0];
  const high20 = Math.max(...bars.slice(-20).map((bar) => Number(bar.high)).filter(Number.isFinite));
  const low20 = Math.min(...bars.slice(-20).map((bar) => Number(bar.low)).filter(Number.isFinite));
  const sma20 = simpleMovingAverage(closes, 20);
  const sma50 = simpleMovingAverage(closes, 50);
  const momentum20 = closes.length > 20 ? latest / closes.at(-21) - 1 : null;
  const rsi14 = relativeStrengthIndex(closes);
  const scoreParts = [
    sma20 === null ? null : latest === sma20 ? 0 : latest > sma20 ? 1 : -1,
    sma20 === null || sma50 === null ? null : sma20 === sma50 ? 0 : sma20 > sma50 ? 1 : -1,
    momentum20 === null ? null : momentum20 === 0 ? 0 : momentum20 > 0 ? 1 : -1,
    rsi14 === null ? null : rsi14 === 50 ? 0 : rsi14 < 70 ? 0.5 : -0.5,
  ].filter(Number.isFinite);
  const score = scoreParts.length ? scoreParts.reduce((sum, value) => sum + value, 0) / scoreParts.length : 0;

  return {
    sampleSize: closes.length,
    insufficientData: closes.length < 20,
    latest,
    totalReturn: latest / first - 1,
    momentum20,
    sma20,
    sma50,
    ema20: exponentialMovingAverage(closes, 20),
    rsi14,
    macd: macd(closes),
    atr14: averageTrueRange(bars, 14),
    annualizedVolatility: annualizedVolatility(closes),
    maximumDrawdown: maximumDrawdown(closes),
    support20: Number.isFinite(low20) ? low20 : null,
    resistance20: Number.isFinite(high20) ? high20 : null,
    signalScore: Math.max(-1, Math.min(1, score)),
  };
}

export function positionSize({ portfolioValue, price, riskBudgetPct, stopDistancePct }) {
  const budget = Number(portfolioValue) * Number(riskBudgetPct);
  const riskPerShare = Number(price) * Number(stopDistancePct);
  if (![budget, riskPerShare].every(Number.isFinite) || budget <= 0 || riskPerShare <= 0) return 0;
  return Math.max(0, Math.floor(budget / riskPerShare));
}
