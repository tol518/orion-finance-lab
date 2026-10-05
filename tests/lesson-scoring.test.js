import assert from "node:assert/strict";
import test from "node:test";
import { MIN_LESSON_TRIALS, scoreLesson } from "../src/evaluation/lesson-scoring.js";

const decision = (correct, lessonIds = []) => ({ correct, lessonIds });
const repeat = (count, make) => Array.from({ length: count }, make);

test("a lesson stays learning until it has been shown on enough graded decisions", () => {
  const score = scoreLesson({ id: "L" }, repeat(MIN_LESSON_TRIALS - 1, () => decision(false, ["L"])));
  assert.equal(score.verdict, "LEARNING");
  assert.equal(score.trials, MIN_LESSON_TRIALS - 1);
});

test("a lesson helps only when decisions made with it beat decisions made without it", () => {
  const baseline = [decision(true), decision(false), decision(false), decision(true)];
  const helping = scoreLesson({ id: "L" }, [...baseline, ...repeat(6, (_, index) => decision(index < 4, ["L"]))]);
  assert.equal(helping.verdict, "HELPING");
  assert.equal(helping.baselineRate, 0.5);

  const tied = scoreLesson({ id: "L" }, [...baseline, ...repeat(6, (_, index) => decision(index < 3, ["L"]))]);
  assert.equal(tied.verdict, "NOT_HELPING");
});

test("without unexposed decisions a lesson is compared with a coin flip", () => {
  const score = scoreLesson({ id: "L" }, repeat(6, (_, index) => decision(index < 2, ["L"])));
  assert.equal(score.baselineTrials, 0);
  assert.equal(score.baselineRate, 0.5);
  assert.equal(score.verdict, "NOT_HELPING");
});
