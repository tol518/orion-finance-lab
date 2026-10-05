// A lesson must be shown on this many graded decisions before it can be judged; fewer
// outcomes are mostly noise and would retire good lessons on bad luck.
export const MIN_LESSON_TRIALS = 6;

// Every active lesson is shown together, so this is attribution by exposure, not a
// controlled trial: a lesson earns its place only if decisions made while it was in the
// prompt beat the team's decisions made without it.
export function scoreLesson(lesson, decisions) {
  const shown = decisions.filter((decision) => decision.lessonIds.includes(lesson.id));
  const baseline = decisions.filter((decision) => !decision.lessonIds.includes(lesson.id));
  const correctRate = rate(shown);
  // Without unexposed decisions to compare against, a directional call is held to a coin flip.
  const baselineRate = rate(baseline) ?? 0.5;
  const verdict = shown.length < MIN_LESSON_TRIALS
    ? "LEARNING"
    : correctRate > baselineRate ? "HELPING" : "NOT_HELPING";
  return {
    trials: shown.length,
    correct: shown.filter((decision) => decision.correct).length,
    correctRate,
    baselineTrials: baseline.length,
    baselineRate,
    verdict,
  };
}

function rate(decisions) {
  return decisions.length ? decisions.filter((decision) => decision.correct).length / decisions.length : null;
}
