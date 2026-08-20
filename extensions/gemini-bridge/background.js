// gemini-bridge v2 background service worker。
// HTTP 中转：GET /task 长轮询（30s 超时）、POST /result {reply}。
// host_permissions 规避页面 CSP/CORS 限制；全部 try/catch 答 {error}，不抛未处理异常。
// content 侧可在消息中带 baseUrl（面板可编辑桥服务地址），缺省回落 DEFAULT_BASE_URL。

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const GET_TASK_TIMEOUT_MS = 30_000; // 服务端长轮询约 25s 后 204，30s 超时兜底
const POST_RESULT_TIMEOUT_MS = 10_000; // POST /result 超时兜底，避免服务端挂起时 sendResponse 悬置

function resolveBase(baseUrl) {
  if (typeof baseUrl === "string" && /^https?:\/\//i.test(baseUrl)) {
    return baseUrl.replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      const base = resolveBase(message?.baseUrl);

      if (message.type === "get-task") {
        let res;
        try {
          res = await fetch(`${base}/task`, {
            signal: AbortSignal.timeout(GET_TASK_TIMEOUT_MS),
            cache: "no-store",
          });
        } catch (err) {
          // 30s 超时 ≈ 服务端无消息（与 204 同义），静默返回无任务；网络错误如实上报
          if (err?.name === "TimeoutError" || err?.name === "AbortError") {
            sendResponse({ task: null });
          } else {
            sendResponse({ error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }
        if (res.status === 204) {
          sendResponse({ task: null });
          return;
        }
        if (!res.ok) {
          sendResponse({ error: `GET /task → HTTP ${res.status}` });
          return;
        }
        sendResponse({ task: await res.json() });
        return;
      }

      if (message.type === "submit-result") {
        const reply = message?.reply;
        if (typeof reply !== "string" || reply.trim() === "") {
          sendResponse({ ok: false, error: "empty reply" });
          return;
        }
        let res;
        try {
          res = await fetch(`${base}/result`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reply }),
            signal: AbortSignal.timeout(POST_RESULT_TIMEOUT_MS),
          });
        } catch (err) {
          // 超时/中断统一答 {ok:false, error}，不悬置 sendResponse
          sendResponse({
            ok: false,
            error:
              err?.name === "TimeoutError" || err?.name === "AbortError"
                ? "POST /result 超时"
                : err instanceof Error
                  ? err.message
                  : String(err),
          });
          return;
        }
        if (res.ok) {
          let processed = false;
          try {
            const data = await res.json();
            processed = data?.processed === true;
          } catch {
            // 响应体非 JSON 时按未处理计（服务端异常，不抛）
          }
          sendResponse({ ok: true, processed });
        } else {
          sendResponse({
            ok: false,
            status: res.status,
            error: `POST /result → HTTP ${res.status}`,
          });
        }
        return;
      }

      if (message.type === "approve") {
        const id = Number(message?.id);
        const allowed = Array.isArray(message?.allowed) ? message.allowed.map((v) => v === true) : [];
        if (!Number.isInteger(id) || allowed.length === 0) {
          sendResponse({ ok: false, error: "invalid approval" });
          return;
        }
        const body = { id, allowed };
        const whitelist = Array.isArray(message?.whitelist) ? message.whitelist : [];
        if (whitelist.length > 0) body.whitelist = whitelist;
        let res;
        try {
          res = await fetch(`${base}/approval`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(POST_RESULT_TIMEOUT_MS),
          });
        } catch (err) {
          sendResponse({
            ok: false,
            error:
              err?.name === "TimeoutError" || err?.name === "AbortError"
                ? "POST /approval 超时"
                : err instanceof Error
                  ? err.message
                  : String(err),
          });
          return;
        }
        if (res.ok) {
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, status: res.status, error: `POST /approval → HTTP ${res.status}` });
        return;
      }

      sendResponse({ error: `unknown message type: ${message?.type}` });
    } catch (err) {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // 异步 sendResponse
});
