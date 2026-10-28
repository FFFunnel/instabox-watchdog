/**
 * 运行计时决策。不访问网络，方便单独测试。
 *
 * 免费版 maxRunMinutes 固定 480，密钥改不了。runStartedAt 只在确认睡眠后重置，
 * 所以连续运行满 6 小时就主动暂停再恢复。平台已经因上限暂停时，冷却结束后再恢复。
 * 面板上手动暂停没有冷却截止时间，也不会带上我们的标记，不会被自动恢复。
 */

export const RESET_AFTER_MS = 6 * 60 * 60 * 1000;
export const SLEEP_SETTLE_MS = 15_000;
export const COOLDOWN_RESUME_WINDOW_MS = 30 * 60 * 1000;
export const RESET_LABEL = "watchdog_reset";

const TERMINAL_STATES = new Set(["stopped", "stopping", "deleting", "deleted", "error"]);

export function metadataOf(machine) {
  const raw = machine && machine.metadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...raw };
}

export function encodeMark(runStartedAt, requestedAt, phase) {
  return `${runStartedAt}|${requestedAt}|${phase}`;
}

export function parseMark(value) {
  const [runStartedAt = "", requested = "", phase = ""] = String(value || "").split("|");
  const requestedAt = Number(requested);
  return {
    runStartedAt,
    requestedAt: Number.isFinite(requestedAt) ? requestedAt : 0,
    phase,
  };
}

export function withoutLabel(metadata) {
  const next = { ...metadata };
  delete next[RESET_LABEL];
  return next;
}

export function runAgeMs(machine, now) {
  const started = Date.parse(machine.runStartedAt || "");
  if (!Number.isFinite(started)) return null;
  return now - started;
}

export function cooldownRemainingMs(machine, now) {
  const until = Date.parse(machine.cooldownUntil || "");
  if (!Number.isFinite(until)) return null;
  return until - now;
}

/**
 * 刚确认暂停时再等 15 秒。恢复轮次里标记已超过 60 秒，睡眠早已确认，不再等待。
 */
export function settleDelayMs(machine, now) {
  if (String(machine.state || "") !== "suspended") return 0;
  const mark = parseMark(metadataOf(machine)[RESET_LABEL]);
  if (!mark.requestedAt) return SLEEP_SETTLE_MS;
  if (now - mark.requestedAt >= 60_000) return 0;
  return SLEEP_SETTLE_MS;
}

export function decideRuntime(machine, now = Date.now()) {
  const state = String(machine.state || "");
  const mark = parseMark(metadataOf(machine)[RESET_LABEL]);
  const runStartedAt = machine.runStartedAt || "";
  const ours = mark.runStartedAt !== "" && mark.runStartedAt === runStartedAt;
  const age = runAgeMs(machine, now);
  const cooldown = cooldownRemainingMs(machine, now);

  if (TERMINAL_STATES.has(state)) return { action: "skip-stopped", state };

  if ((state === "suspended" || state === "suspending") && cooldown !== null && cooldown > 0 && !ours) {
    return { action: "wait-cooldown", state, cooldownMs: cooldown };
  }

  if (state === "suspended" && cooldown !== null && cooldown <= 0 && -cooldown <= COOLDOWN_RESUME_WINDOW_MS && !ours) {
    return { action: "resume-after-max-run", state };
  }

  if (state === "running" && ours && mark.phase === "gaveup") {
    return { action: "reset-failed", state };
  }

  if (state === "running" && mark.runStartedAt && !ours && age !== null && age < RESET_AFTER_MS) {
    return { action: "clear-mark", state };
  }

  if (state === "running" && age !== null && age >= RESET_AFTER_MS && !(ours && mark.phase === "gaveup")) {
    return { action: "start-reset", state, runStartedAt };
  }

  if (ours && (state === "suspending" || state === "suspended" || state === "resuming")) {
    return { action: "finish-reset", state };
  }

  return { action: "lease", state };
}
