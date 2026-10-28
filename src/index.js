/**
 * InstaBox 外部保活。
 *
 * 每 5 分钟续一次 15 分钟活动租约，避开 30 分钟闲置暂停。
 * 连续运行满 6 小时则主动暂停，确认睡眠后再恢复，让 runStartedAt 重新计算，
 * 从而避开免费版 8 小时运行上限。租约本身取消不了这个上限。
 *
 * 面板上的手动暂停、关机、归档和回收都不会被自动撤销。
 */

import {
  RESET_AFTER_MS,
  RESET_LABEL,
  SLEEP_SETTLE_MS,
  decideRuntime,
  encodeMark,
  metadataOf,
  parseMark,
  settleDelayMs,
  withoutLabel,
} from "./runtime.js";

const API_BASE = "https://api.instabox.sh";
const INTERVAL_SECONDS = 300;
const LEASE_PREFIX = "ib";
const STATE_WAIT_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(lines, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  lines.push(line);
  return line;
}

function sandboxName(env) {
  return (env.SANDBOX_NAME || "baka").trim();
}

function leaseTtl() {
  return Math.min(3600, Math.max(900, INTERVAL_SECONDS * 3));
}

function controllerId(env) {
  const configured = (env.CONTROLLER_ID || "cfd0a7e1b0c4d4e5f8091a2b3c4d5e6f").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(configured)) {
    throw new Error("CONTROLLER_ID 格式无效");
  }
  return configured;
}

async function sha256Prefix(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function leaseId(env, machineId) {
  return `${LEASE_PREFIX}-${controllerId(env)}-${await sha256Prefix(machineId)}`;
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(env, method, path, options = {}) {
  const headers = {
    "X-API-Key": env.INSTABOX_API_KEY,
    Accept: "application/json",
    "User-Agent": "instabox-watchdog/1.1",
    ...options.headers,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(API_BASE + path, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text.slice(0, 300) };
        }
      }
      if (response.ok) return json ?? {};
      const code = json?.error?.code || `http_${response.status}`;
      const message = json?.error?.message || text.slice(0, 300) || response.statusText;
      const error = new ApiError(response.status, code, `${method} ${path} -> ${response.status} ${code}: ${message}`);
      const retryable = response.status === 502 || response.status === 503 || response.status === 504;
      if (!retryable || attempt === 2) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      lastError = error;
      if (attempt === 2) throw new ApiError(0, "network_error", `${method} ${path} 网络失败: ${error.message}`);
    }
    await sleep(500 * 2 ** attempt);
  }
  throw lastError;
}

async function findMachine(env) {
  const name = sandboxName(env);
  const listed = await api(env, "GET", "/v1/machines");
  const items = listed.machines || listed.items || [];
  const found = items.find((item) => item.name === name || item.id === name);
  if (found?.id) return api(env, "GET", `/v1/machines/${encodeURIComponent(found.id)}`);
  return api(env, "GET", `/v1/machines/${encodeURIComponent(name)}`);
}

async function writeMetadata(env, machine, metadata) {
  await api(env, "PATCH", `/v1/machines/${encodeURIComponent(machine.id)}`, { body: { metadata } });
  return api(env, "GET", `/v1/machines/${encodeURIComponent(machine.id)}`);
}

async function postLifecycle(env, id, action) {
  try {
    return await api(env, "POST", `/v1/machines/${encodeURIComponent(id)}/${action}`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "operation_conflict") return null;
    throw error;
  }
}

async function waitForState(env, id, states, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let machine = await api(env, "GET", `/v1/machines/${encodeURIComponent(id)}`);
  while (!states.includes(String(machine.state || "")) && Date.now() < deadline) {
    await sleep(3000);
    machine = await api(env, "GET", `/v1/machines/${encodeURIComponent(id)}`);
  }
  return machine;
}

async function resumeMachine(env, machine, lines) {
  try {
    await postLifecycle(env, machine.id, "resume");
  } catch (error) {
    if (error instanceof ApiError && error.code === "machine_cooldown") {
      log(lines, "平台仍在冷却，本轮不恢复");
      return { machine, hold: true };
    }
    throw error;
  }
  let current = await waitForState(env, machine.id, ["running", "resuming"], STATE_WAIT_MS);
  if (String(current.state) === "resuming") current = await waitForState(env, machine.id, ["running"], STATE_WAIT_MS);
  if (String(current.state) !== "running") {
    log(lines, `恢复未完成，当前状态 ${current.state || "未知"}，下轮再试`);
    return { machine: current, hold: true };
  }
  log(lines, "机器已恢复");
  return { machine: current, hold: false };
}

async function rememberOutcome(env, beforeRunStartedAt, machine, lines) {
  if (String(machine.state) !== "running") return machine;
  const meta = metadataOf(machine);
  if (machine.runStartedAt && machine.runStartedAt !== beforeRunStartedAt) {
    log(lines, "连续运行计时已重置");
    return writeMetadata(env, machine, withoutLabel(meta));
  }
  const mark = parseMark(meta[RESET_LABEL]);
  log(lines, "暂停后计时未重置，这一轮不再重复暂停");
  return writeMetadata(env, machine, {
    ...meta,
    [RESET_LABEL]: encodeMark(beforeRunStartedAt, mark.requestedAt || Date.now(), "gaveup"),
  });
}

async function resetMachine(env, machine, decision, lines) {
  const beforeRunStartedAt = machine.runStartedAt || "";
  try {
    if (decision.action === "start-reset") {
      const age = Date.now() - Date.parse(beforeRunStartedAt);
      log(lines, `已连续运行 ${Math.floor(age / 60000)} 分钟，主动暂停以重置计时`);
      const requestedAt = Date.now();
      machine = await writeMetadata(env, machine, {
        ...metadataOf(machine),
        [RESET_LABEL]: encodeMark(beforeRunStartedAt, requestedAt, "suspend"),
      });
      await postLifecycle(env, machine.id, "suspend");
      machine = await waitForState(env, machine.id, ["suspended", "suspending"], STATE_WAIT_MS);
    }

    if (String(machine.state) === "suspending") {
      machine = await waitForState(env, machine.id, ["suspended"], STATE_WAIT_MS);
    }
    if (String(machine.state) === "resuming") {
      machine = await waitForState(env, machine.id, ["running"], STATE_WAIT_MS);
      machine = await rememberOutcome(env, beforeRunStartedAt, machine, lines);
      return { machine, hold: String(machine.state) !== "running" };
    }
    if (String(machine.state) !== "suspended") {
      log(lines, `暂停未完成，当前状态 ${machine.state || "未知"}，下轮再试`);
      return { machine, hold: true };
    }

    const delay = decision.action === "start-reset" ? SLEEP_SETTLE_MS : settleDelayMs(machine);
    if (delay > 0) {
      log(lines, "已确认暂停，等待 15 秒");
      await sleep(delay);
    }
    const resumed = await resumeMachine(env, machine, lines);
    if (resumed.hold) return resumed;
    return { machine: await rememberOutcome(env, beforeRunStartedAt, resumed.machine, lines), hold: false };
  } catch (error) {
    if (error instanceof ApiError && error.code === "machine_cooldown") {
      log(lines, "平台仍在冷却，本轮不恢复");
      return { machine, hold: true };
    }
    throw error;
  }
}

async function relaxRuntime(env, machine, lines) {
  const decision = decideRuntime(machine);
  if (decision.action === "skip-stopped") return { machine, hold: true };
  if (decision.action === "lease") return { machine, hold: false };
  if (decision.action === "reset-failed") {
    log(lines, "上一轮暂停没有重置计时，本轮只续租");
    return { machine, hold: false };
  }
  if (decision.action === "wait-cooldown") {
    log(lines, `运行上限冷却中，还要等 ${Math.ceil(decision.cooldownMs / 1000)} 秒`);
    return { machine, hold: true };
  }
  if (decision.action === "clear-mark") {
    log(lines, "计时已重置，清除暂停标记");
    return { machine: await writeMetadata(env, machine, withoutLabel(metadataOf(machine))), hold: false };
  }
  if (decision.action === "resume-after-max-run") {
    log(lines, "运行上限冷却已结束，开始恢复");
    return resumeMachine(env, machine, lines);
  }
  if (decision.action === "start-reset" || decision.action === "finish-reset") {
    return resetMachine(env, machine, decision, lines);
  }
  return { machine, hold: false };
}

async function renewLease(env, machine, lines) {
  const id = machine.id;
  const state = String(machine.state || "");
  const idForLease = await leaseId(env, id);
  const ttlSeconds = leaseTtl();
  const started = Date.now();
  const lease = await api(env, "PUT", `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(idForLease)}`, {
    body: { ttlSeconds },
  });

  if (lease.id !== idForLease || lease.machineId !== id) {
    throw new ApiError(502, "invalid_response", "平台响应与目标机器不一致");
  }
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new ApiError(502, "invalid_response", "平台返回的租约有效期无效");
  }

  log(lines, `租约已续，TTL ${ttlSeconds} 秒，有效到 ${lease.expiresAt}，耗时 ${Date.now() - started} 毫秒`);
  return {
    ok: true,
    name: machine.name || sandboxName(env),
    state,
    ttlSeconds,
    expiresAt: lease.expiresAt,
    lines,
  };
}

async function renew(env) {
  const lines = [];
  if (!env.INSTABOX_API_KEY) {
    log(lines, "缺少 INSTABOX_API_KEY，本轮跳过");
    return { ok: false, lines };
  }

  let machine = await findMachine(env);
  const state = String(machine.state || "");
  const id = machine.id;
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new ApiError(502, "invalid_response", "机器标识格式异常");
  }
  log(lines, `探测 ${machine.name || id}，状态 ${state || "未知"}`);

  if (decideRuntime(machine).action === "skip-stopped") {
    log(lines, `状态 ${state} 不续租。看门狗不会自动开机`);
    return { ok: true, skipped: true, state, lines };
  }

  const relaxed = await relaxRuntime(env, machine, lines);
  machine = relaxed.machine;
  if (relaxed.hold) return { ok: true, skipped: true, state: String(machine.state || state), lines };

  return renewLease(env, machine, lines);
}

function authorized(request, env) {
  const expected = env.WATCHDOG_TOKEN || "";
  if (!expected) return false;
  const header = request.headers.get("X-Watchdog-Token") || "";
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < header.length; index++) mismatch |= header.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        sandbox: sandboxName(env),
        intervalSeconds: INTERVAL_SECONDS,
        resetAfterHours: RESET_AFTER_MS / 3_600_000,
      });
    }
    if (url.pathname === "/tick") {
      if (!authorized(request, env)) return Response.json({ error: "需要请求头 X-Watchdog-Token" }, { status: 401 });
      try {
        const result = await renew(env);
        return Response.json(result, { status: result.ok ? 200 : 500 });
      } catch (error) {
        console.log(`[${new Date().toISOString()}] 本轮失败 ${error.message}`);
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }
    return Response.json({ error: "未知路径" }, { status: 404 });
  },

  async scheduled(_controller, env) {
    try {
      await renew(env);
    } catch (error) {
      console.log(`[${new Date().toISOString()}] 本轮失败 ${error.message}`);
      throw error;
    }
  },
};
