export function performanceFromValues(values, { periodsPerYear = 252 } = {}) {
  const series = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (series.length === 0) return emptyPerformance();
  const returns = series.slice(1).map((value, index) => value / series[index] - 1);
  const totalReturn = series.at(-1) / series[0] - 1;
  const average = mean(returns);
  const volatility = standardDeviation(returns) * Math.sqrt(periodsPerYear);
  const downside = returns.filter((value) => value < 0);
  const downsideDeviation = standardDeviation(downside) * Math.sqrt(periodsPerYear);
  return {
    observations: series.length,
    totalReturn,
    annualizedReturn: returns.length ? average * periodsPerYear : 0,
    volatility: finite(volatility),
    sharpe: volatility > 0 ? average * periodsPerYear / volatility : null,
    sortino: downsideDeviation > 0 ? average * periodsPerYear / downsideDeviation : null,
    maximumDrawdown: drawdown(series),
  };
}
export function predictionPerformance(predictions) {
  const evaluated = predictions.filter((prediction) => prediction.result);
  const correct = evaluated.filter((prediction) => prediction.result.directionCorrect).length;
  const rangeCorrect = evaluated.filter((prediction) => prediction.result.rangeCorrect).length;
  const actualReturns = evaluated.map((prediction) => prediction.result.actualReturn);
  const alpha = evaluated.map((prediction) => prediction.result.alpha).filter(Number.isFinite);
  return {
    totalPredictions: predictions.length,
    evaluatedPredictions: evaluated.length,
    pendingPredictions: predictions.length - evaluated.length,
    directionalAccuracy: evaluated.length ? correct / evaluated.length : null,
    rangeAccuracy: evaluated.length ? rangeCorrect / evaluated.length : null,
    averageActualReturn: actualReturns.length ? mean(actualReturns) : null,
    averageAlpha: alpha.length ? mean(alpha) : null,
    confidenceCalibration: confidenceCalibration(evaluated),
  };
}

export function confidenceCalibration(predictions) {
  const bins = Array.from({ length: 10 }, (_, index) => ({
    from: index / 10,
    to: (index + 1) / 10,
    count: 0,
    averageConfidence: 0,
    successRate: null,
    gap: null,
  }));
  for (const prediction of predictions) {
    const confidence = Math.max(0, Math.min(1, Number(prediction.confidence)));
    const index = Math.min(9, Math.floor(confidence * 10));
    const bin = bins[index];
    bin.count += 1;
    bin.averageConfidence += confidence;
    bin.successRate = Number(bin.successRate ?? 0) + (prediction.result.directionCorrect ? 1 : 0);
  }
  for (const bin of bins) {
    if (bin.count === 0) continue;
    bin.averageConfidence /= bin.count;
    bin.successRate /= bin.count;
    bin.gap = bin.successRate - bin.averageConfidence;
  }
  const populated = bins.filter((bin) => bin.count > 0);
  const weightedGap = populated.length
    ? populated.reduce((sum, bin) => sum + Math.abs(bin.gap) * bin.count, 0) /
      populated.reduce((sum, bin) => sum + bin.count, 0)
    : null;
  return {
    status: weightedGap === null ? "INSUFFICIENT_DATA" : weightedGap <= 0.08 ? "WELL_CALIBRATED" :
      weightedAverageGap(populated) < 0 ? "OVERCONFIDENT" : "UNDERCONFIDENT",
    expectedCalibrationError: weightedGap,
    bins,
  };
}

function weightedAverageGap(bins) {
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  return total ? bins.reduce((sum, bin) => sum + bin.gap * bin.count, 0) / total : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function drawdown(values) {
  let peak = values[0];
  let result = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    result = Math.min(result, value / peak - 1);
  }
  return result;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function emptyPerformance() {
  return {
    observations: 0,
    totalReturn: 0,
    annualizedReturn: 0,
    volatility: null,
    sharpe: null,
    sortino: null,
    maximumDrawdown: 0,
  };
}
