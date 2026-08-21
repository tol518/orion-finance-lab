import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBars,
  annualizedVolatility,
  maximumDrawdown,
  relativeStrengthIndex,
  simpleMovingAverage,
} from "../src/quant/indicators.js";

test("deterministic indicators preserve expected trend and drawdown semantics", () => {
  const closes = Array.from({ length: 80 }, (_, index) => 100 + index);
  const bars = closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
  }));
  const analysis = analyzeBars(bars);
  assert.equal(simpleMovingAverage([1, 2, 3, 4], 2), 3.5);
  assert.equal(relativeStrengthIndex(closes), 100);
  assert.ok(analysis.sma20 > analysis.sma50);
  assert.ok(analysis.signalScore > 0);
  assert.ok(annualizedVolatility(closes) > 0);
  assert.equal(maximumDrawdown([100, 120, 90, 110]), -0.25);
});
test("insufficient history is reported rather than fabricated", () => {
  assert.deepEqual(analyzeBars([]), { sampleSize: 0, insufficientData: true });
  assert.equal(relativeStrengthIndex([1, 2, 3]), null);
});

test("flat histories produce neutral indicators and signals", () => {
  const bars = Array.from({ length: 80 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1_000,
  }));
  const analysis = analyzeBars(bars);
  assert.equal(relativeStrengthIndex(bars.map((bar) => bar.close)), 50);
  assert.equal(analysis.signalScore, 0);
});
