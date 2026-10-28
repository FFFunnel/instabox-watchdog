/**
 * InstaBox 外部保活。
 *
 * 机制与 Pretic/InstaBox-Tool 相同：定时续官方活动租约，而不是在沙箱里跑 systemd，
 * 也不是每隔几小时主动挂起。活动租约才会被平台算成活动，用来避开 30 分钟闲置暂停，
 * 并按平台规则唤醒因闲置而暂停的机器。
 *
 * PUT /v1/machines/{id}/activity-leases/{leaseId}
 * {"ttlSeconds": 900}
 *
 * 租约不取消手动暂停、关机、运行时长上限、归档或回收。
 */

const API_BASE = "https://api.instabox.sh";
const INTERVAL_SECONDS = 300;
const LEASE_PREFIX = "ib";

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
    "User-Agent": "instabox-watchdog/1.0",
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
  if (found) return found;
  return api(env, "GET", `/v1/machines/${encodeURIComponent(name)}`);
}

async function renew(env) {
  const lines = [];
  if (!env.INSTABOX_API_KEY) {
    log(lines, "缺少 INSTABOX_API_KEY，本轮跳过");
    return { ok: false, lines };
  }

  const machine = await findMachine(env);
  const state = String(machine.state || "");
  const id = machine.id;
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new ApiError(502, "invalid_response", "机器标识格式异常");
  }
  log(lines, `探测 ${machine.name || id}，状态 ${state || "未知"}`);

  if (state === "stopped" || state === "stopping" || state === "deleting" || state === "deleted" || state === "error") {
    log(lines, `状态 ${state} 不续租。活动租约不会取消手动关机或故障`);
    return { ok: true, skipped: true, state, lines };
  }

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
      return Response.json({ ok: true, sandbox: sandboxName(env), intervalSeconds: INTERVAL_SECONDS });
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
