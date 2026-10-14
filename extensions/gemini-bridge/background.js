// gemini-bridge v0.4 background service worker。
// HTTP 中转（十路，统一信封收口）：GET /task 长轮询（30s 超时）、POST /task/reply、POST /task/approval、
// POST /permission/whitelist、GET /permission/whitelist（查看）、POST /permission/whitelist/revoke（撤销）、
// GET /permission/candidates、POST /permission/candidates/dismiss、GET /agent/protocol、GET /agent/info。
// 约定：桥服务的统一信封 {status:"ok", data?} | {status:"error", error:{code, message}} 原样透传 content.js；
// GET /task 30s 超时或 204 → {status:"ok", data:null}（空轮询）；网络错误/超时（未拿到响应）→ 扩展本地伪码
// {status:"error", error:{code:"bridge-unreachable", message:"桥未连接或请求超时"}}（非桥面词表，README 说明）。
// host_permissions 规避页面 CSP/CORS 限制；全部 try/catch 答信封，不抛未处理异常。
// content 侧可在消息中带 baseUrl（面板可编辑桥服务地址），缺省回落 DEFAULT_BASE_URL。

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const GET_TASK_TIMEOUT_MS = 30_000; // 服务端长轮询约 25s 后 204，30s 超时兜底
const SHORT_TIMEOUT_MS = 10_000; // 其余端点为即时短请求，10s 超时兜底，避免服务端挂起时 sendResponse 悬置

function resolveBase(baseUrl) {
  if (typeof baseUrl === "string" && /^https?:\/\//i.test(baseUrl)) {
    return baseUrl.replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

function okEnvelope(data) {
  return data === undefined ? { status: "ok" } : { status: "ok", data };
}

function errorEnvelope(code, message) {
  return { status: "error", error: { code, message } };
}

// 扩展本地伪码：网络错误/超时（fetch 未拿到响应）
function unreachableEnvelope() {
  return errorEnvelope("bridge-unreachable", "桥未连接或请求超时");
}

// 统一请求：fetch 成功 → {kind:"response"（含信封）| "empty"（204）}；
// 网络错误/超时 → {kind:"network", name, message}；响应体非 JSON → {kind:"bad-body", status}
async function request(base, path, options) {
  const { method, body, timeoutMs } = options;
  const init = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (method === "GET") init.cache = "no-store";
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (err) {
    return { kind: "network", name: err?.name, message: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 204) return { kind: "empty", status: 204 };
  try {
    return { kind: "response", status: res.status, envelope: await res.json() };
  } catch {
    return { kind: "bad-body", status: res.status };
  }
}

// 非 /task 端点的失败收口：网络错误/超时 → bridge-unreachable；意外 204 / 响应体非 JSON → internal
function relayFailure(result, label) {
  if (result.kind === "network") return unreachableEnvelope();
  if (result.kind === "empty") return errorEnvelope("internal", `${label} 返回意外空响应（204）`);
  return errorEnvelope("internal", `${label} 响应不是合法 JSON（HTTP ${result.status}）`);
}

// GET /task：30s 超时与 204 均视为空轮询（服务端约 25s 无消息即 204），其余情况透传/收口
async function relayTask(base) {
  const result = await request(base, "/task", { method: "GET", timeoutMs: GET_TASK_TIMEOUT_MS });
  if (result.kind === "network") {
    // 30s 超时 ≈ 服务端无消息（与 204 同义），按空轮询返回；真实网络错误如实上报
    if (result.name === "TimeoutError" || result.name === "AbortError") return okEnvelope(null);
    return unreachableEnvelope();
  }
  if (result.kind === "empty") return okEnvelope(null);
  if (result.kind === "bad-body") {
    return errorEnvelope("internal", `GET /task 响应不是合法 JSON（HTTP ${result.status}）`);
  }
  return result.envelope; // 信封原样透传（消息/审批任务，或桥侧 error 信封）
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      const base = resolveBase(message?.baseUrl);

      if (message.type === "get-task") {
        sendResponse(await relayTask(base));
        return;
      }

      if (message.type === "get-protocol") {
        const result = await request(base, "/agent/protocol", { method: "GET", timeoutMs: SHORT_TIMEOUT_MS });
        sendResponse(result.kind === "response" ? result.envelope : relayFailure(result, "GET /agent/protocol"));
        return;
      }

      if (message.type === "get-info") {
        const result = await request(base, "/agent/info", { method: "GET", timeoutMs: SHORT_TIMEOUT_MS });
        sendResponse(result.kind === "response" ? result.envelope : relayFailure(result, "GET /agent/info"));
        return;
      }

      if (message.type === "get-candidates") {
        const result = await request(base, "/permission/candidates", { method: "GET", timeoutMs: SHORT_TIMEOUT_MS });
        sendResponse(
          result.kind === "response" ? result.envelope : relayFailure(result, "GET /permission/candidates"),
        );
        return;
      }

      if (message.type === "get-whitelist") {
        const result = await request(base, "/permission/whitelist", { method: "GET", timeoutMs: SHORT_TIMEOUT_MS });
        sendResponse(
          result.kind === "response" ? result.envelope : relayFailure(result, "GET /permission/whitelist"),
        );
        return;
      }

      if (message.type === "submit-result") {
        const reply = message?.reply;
        if (typeof reply !== "string" || reply.trim() === "") {
          sendResponse(errorEnvelope("invalid-body", "reply 不能为空"));
          return;
        }
        const result = await request(base, "/task/reply", { method: "POST", body: { reply }, timeoutMs: SHORT_TIMEOUT_MS });
        sendResponse(result.kind === "response" ? result.envelope : relayFailure(result, "POST /task/reply"));
        return;
      }

      if (message.type === "approve") {
        const id = Number(message?.id);
        const allowed = Array.isArray(message?.allowed) ? message.allowed.map((v) => v === true) : [];
        if (!Number.isInteger(id) || allowed.length === 0) {
          sendResponse(errorEnvelope("invalid-body", "审批回执不合法（id/allowed）"));
          return;
        }
        const body = { id, allowed };
        const whitelist = Array.isArray(message?.whitelist) ? message.whitelist : [];
        if (whitelist.length > 0) body.whitelist = whitelist; // 选项条目原样回显（桥侧按批校验成员资格）
        const result = await request(base, "/task/approval", { method: "POST", body, timeoutMs: SHORT_TIMEOUT_MS });
        sendResponse(result.kind === "response" ? result.envelope : relayFailure(result, "POST /task/approval"));
        return;
      }

      if (message.type === "whitelist-add") {
        const items = Array.isArray(message?.items) ? message.items : [];
        const scope = message?.scope;
        if (items.length === 0) {
          sendResponse(errorEnvelope("invalid-body", "items 不能为空"));
          return;
        }
        if (scope !== "self" && scope !== "subtree") {
          sendResponse(errorEnvelope("invalid-body", "scope 必须为 self 或 subtree"));
          return;
        }
        const result = await request(base, "/permission/whitelist", {
          method: "POST",
          body: { items, scope },
          timeoutMs: SHORT_TIMEOUT_MS,
        });
        sendResponse(result.kind === "response" ? result.envelope : relayFailure(result, "POST /permission/whitelist"));
        return;
      }

      if (message.type === "whitelist-revoke") {
        const items = Array.isArray(message?.items) ? message.items : [];
        if (items.length === 0) {
          sendResponse(errorEnvelope("invalid-body", "items 不能为空"));
          return;
        }
        const result = await request(base, "/permission/whitelist/revoke", {
          method: "POST",
          body: { items },
          timeoutMs: SHORT_TIMEOUT_MS,
        });
        sendResponse(
          result.kind === "response" ? result.envelope : relayFailure(result, "POST /permission/whitelist/revoke"),
        );
        return;
      }

      if (message.type === "candidates-dismiss") {
        const items = Array.isArray(message?.items) ? message.items : [];
        if (items.length === 0) {
          sendResponse(errorEnvelope("invalid-body", "items 不能为空"));
          return;
        }
        const result = await request(base, "/permission/candidates/dismiss", {
          method: "POST",
          body: { items },
          timeoutMs: SHORT_TIMEOUT_MS,
        });
        sendResponse(
          result.kind === "response" ? result.envelope : relayFailure(result, "POST /permission/candidates/dismiss"),
        );
        return;
      }

      sendResponse(errorEnvelope("internal", `unknown message type: ${message?.type}`));
    } catch (err) {
      sendResponse(errorEnvelope("internal", err instanceof Error ? err.message : String(err)));
    }
  })();
  return true; // 异步 sendResponse
});
