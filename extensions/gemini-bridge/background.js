// HTTP 桥：长轮询取任务、回传结果。host_permissions 规避页面 CSP/CORS 限制。
const BASE = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "get-task") {
      const res = await fetch(`${BASE}/task`, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 204) {
        sendResponse({ task: null });
        return;
      }
      sendResponse({ task: await res.json() });
      return;
    }
    if (message.type === "submit-result") {
      const res = await fetch(`${BASE}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: message.id, reply: message.reply }),
      });
      sendResponse({ ok: res.ok });
      return;
    }
    sendResponse({ error: "unknown message type" });
  })();
  return true; // 异步 sendResponse
});
