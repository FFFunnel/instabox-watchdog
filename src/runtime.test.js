import assert from "node:assert/strict";
import test from "node:test";
import {
  COOLDOWN_RESUME_WINDOW_MS,
  RESET_AFTER_MS,
  RESET_LABEL,
  decideRuntime,
  encodeMark,
  settleDelayMs,
} from "./runtime.js";

const NOW = Date.parse("2026-10-28T08:00:00Z");

function machine(overrides) {
  return {
    state: "running",
    runStartedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    metadata: {},
    ...overrides,
  };
}

test("运行不足 6 小时只续租", () => {
  assert.equal(decideRuntime(machine(), NOW).action, "lease");
});

test("连续运行满 6 小时开始重置", () => {
  const current = machine({ runStartedAt: new Date(NOW - RESET_AFTER_MS).toISOString() });
  assert.equal(decideRuntime(current, NOW).action, "start-reset");
});

test("没有运行起点时不暂停", () => {
  assert.equal(decideRuntime(machine({ runStartedAt: null }), NOW).action, "lease");
});

test("同一轮计时未能重置后不再重复暂停", () => {
  const runStartedAt = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
  const current = machine({
    runStartedAt,
    metadata: { [RESET_LABEL]: encodeMark(runStartedAt, NOW - 60_000, "gaveup") },
  });
  assert.equal(decideRuntime(current, NOW).action, "reset-failed");
});

test("暂停请求失败后，机器仍在运行就重试", () => {
  const runStartedAt = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
  const current = machine({
    runStartedAt,
    metadata: { [RESET_LABEL]: encodeMark(runStartedAt, NOW - 60_000, "suspend") },
  });
  assert.equal(decideRuntime(current, NOW).action, "start-reset");
});

test("我们发起的暂停还没恢复完就继续", () => {
  const runStartedAt = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
  const current = machine({
    state: "suspended",
    runStartedAt,
    metadata: { [RESET_LABEL]: encodeMark(runStartedAt, NOW - 5 * 60 * 1000, "suspend") },
  });
  assert.equal(decideRuntime(current, NOW).action, "finish-reset");
});

test("计时已经换新后清除旧标记", () => {
  const current = machine({
    metadata: { [RESET_LABEL]: encodeMark("2026-10-27T00:00:00Z", NOW - 86_400_000, "suspend") },
  });
  assert.equal(decideRuntime(current, NOW).action, "clear-mark");
});

test("运行上限冷却期间等待", () => {
  const current = machine({
    state: "suspended",
    cooldownUntil: new Date(NOW + 8 * 60 * 1000).toISOString(),
  });
  const decision = decideRuntime(current, NOW);
  assert.equal(decision.action, "wait-cooldown");
  assert.equal(decision.cooldownMs, 8 * 60 * 1000);
});

test("冷却结束后的半小时内自动恢复", () => {
  const current = machine({
    state: "suspended",
    cooldownUntil: new Date(NOW - 5 * 60 * 1000).toISOString(),
  });
  assert.equal(decideRuntime(current, NOW).action, "resume-after-max-run");
});

test("冷却结束太久不再自动恢复，避免误取消手动暂停", () => {
  const current = machine({
    state: "suspended",
    cooldownUntil: new Date(NOW - COOLDOWN_RESUME_WINDOW_MS - 1000).toISOString(),
  });
  assert.equal(decideRuntime(current, NOW).action, "lease");
});

test("面板手动暂停只续租，不恢复", () => {
  assert.equal(decideRuntime(machine({ state: "suspended" }), NOW).action, "lease");
});

test("关机不自动开机", () => {
  assert.equal(decideRuntime(machine({ state: "stopped" }), NOW).action, "skip-stopped");
});

test("刚暂停再等 15 秒，恢复轮次不再等", () => {
  const runStartedAt = new Date(NOW - RESET_AFTER_MS).toISOString();
  const fresh = machine({
    state: "suspended",
    runStartedAt,
    metadata: { [RESET_LABEL]: encodeMark(runStartedAt, NOW - 10_000, "suspend") },
  });
  const later = machine({
    state: "suspended",
    runStartedAt,
    metadata: { [RESET_LABEL]: encodeMark(runStartedAt, NOW - 5 * 60 * 1000, "suspend") },
  });
  assert.equal(settleDelayMs(fresh, NOW), 15_000);
  assert.equal(settleDelayMs(later, NOW), 0);
});
