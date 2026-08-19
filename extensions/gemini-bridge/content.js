// 浮动面板 + AI Studio 页面双向收发。选择器随页面结构可能失效，见 README 排查节。
const POLL_INTERVAL = 5_000;
const SEND_DELAY_MIN = 3_000; // 自动发送随机延迟下限
const SEND_DELAY_MAX = 8_000; // 自动发送随机延迟上限（防止机器人检测）
const REPLY_STABLE_SAMPLES = 3;

let autoSend = true;
let pendingTask = null; // 已取到、尚未回传的任务
let awaitingReply = false; // 已发送、等待 Gemini 回复中
let lastReply = ""; // 最近一次回传的回复（「回填」使用）

// ---------- 面板 ----------
const panel = document.createElement("div");
panel.id = "gemini-bridge-panel";
panel.innerHTML = `
<style>
#gemini-bridge-panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 260px; padding: 10px 12px; border-radius: 10px;
  background: #1f1f1f; color: #e8e8e8; font: 12px/1.6 system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.35); user-select: none;
}
#gemini-bridge-panel .gb-title { font-weight: 700; margin-bottom: 6px; }
#gemini-bridge-panel .gb-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
#gemini-bridge-panel button {
  background: #3b82f6; color: #fff; border: 0; border-radius: 6px;
  padding: 4px 10px; cursor: pointer; font-size: 12px;
}
#gemini-bridge-panel button:active { opacity: .7; }
#gemini-bridge-panel .gb-status { color: #9ca3af; }
#gemini-bridge-panel .gb-log {
  margin-top: 6px; max-height: 120px; overflow-y: auto;
  border-top: 1px solid #333; padding-top: 6px; color: #b0b0b0;
  white-space: pre-wrap; word-break: break-all;
}
</style>
<div class="gb-title">gemini-bridge</div>
<label class="gb-row">
  <input type="checkbox" id="gb-autosend" checked> 自动发送
</label>
<div class="gb-row gb-status" id="gb-status">待命中</div>
<div class="gb-row">
  <button id="gb-instruct">交给智能体</button>
  <button id="gb-refill">回填</button>
</div>
<div class="gb-log" id="gb-log"></div>
`;
document.documentElement.appendChild(panel);

const checkbox = panel.querySelector("#gb-autosend");
const statusEl = panel.querySelector("#gb-status");
const logEl = panel.querySelector("#gb-log");
const instructBtn = panel.querySelector("#gb-instruct");
const refillBtn = panel.querySelector("#gb-refill");

chrome.storage.sync.get("geminiBridgeAutoSend", ({ geminiBridgeAutoSend }) => {
  if (typeof geminiBridgeAutoSend === "boolean") {
    autoSend = geminiBridgeAutoSend;
    checkbox.checked = autoSend;
  }
});
checkbox.addEventListener("change", () => {
  autoSend = checkbox.checked;
  chrome.storage.sync.set({ geminiBridgeAutoSend: autoSend });
  setStatus(autoSend ? "自动发送" : "手动模式");
});

function setStatus(text) {
  statusEl.textContent = text;
}

function log(text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.textContent = `${line}\n${logEl.textContent}`;
}

// ---------- AI Studio DOM 操作 ----------
function findInput() {
  return (
    document.querySelector('rich-textarea div[contenteditable="true"]') ??
    document.querySelector('[contenteditable="true"]')
  );
}

function findSendButton() {
  return (
    document.querySelector('button[data-test-id="send-button"]') ??
    document.querySelector('button[aria-label*="发送"]') ??
    document.querySelector('button[aria-label*="Send"]')
  );
}

function findStopButton() {
  return (
    document.querySelector('[data-test-id="stop-generation-button"]') ??
    document.querySelector('button[aria-label*="停止"]') ??
    document.querySelector('button[aria-label*="Stop"]')
  );
}

function findLastReply() {
  const marks = document.querySelectorAll(".markdown");
  return marks.length > 0 ? marks[marks.length - 1].innerText : "";
}

function setInput(text) {
  const el = findInput();
  if (!el) return false;
  el.textContent = text;
  el.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
  );
  return true;
}

function clickSend() {
  const btn = findSendButton();
  if (!btn) return false;
  btn.click();
  return true;
}

function isSendButton(btn) {
  return Boolean(
    btn.matches('button[data-test-id="send-button"]') ||
      btn.matches('button[aria-label*="发送"]') ||
      btn.matches('button[aria-label*="Send"]'),
  );
}

async function waitReplyReady(timeoutMs = 120_000) {
  const start = Date.now();
  let stable = 0;
  let lastText = "";
  while (Date.now() - start < timeoutMs) {
    const stop = findStopButton();
    const text = findLastReply();
    if (!stop && text !== "" && text === lastText) {
      stable += 1;
      if (stable >= REPLY_STABLE_SAMPLES) return text;
    } else {
      stable = 0;
      lastText = text;
    }
    await sleep(500);
  }
  return findLastReply();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 双向通道 ----------
async function submit(task, reply) {
  await chrome.runtime.sendMessage({ type: "submit-result", id: task.id, reply });
  lastReply = reply;
  pendingTask = null;
  awaitingReply = false;
  setStatus("已回传");
  log("已回传回复给 brain");
}

async function poll() {
  if (pendingTask !== null || awaitingReply) return;
  const resp = await chrome.runtime.sendMessage({ type: "get-task" });
  if (!resp?.task) return;
  pendingTask = resp.task;
  log(`任务到达：${resp.task.message.slice(0, 100)}${resp.task.message.length > 100 ? "…" : ""}`);
  if (!setInput(resp.task.message)) {
    log("未找到输入框，稍后重试");
    pendingTask = null;
    return;
  }
  if (autoSend) {
    const delay = SEND_DELAY_MIN + Math.random() * (SEND_DELAY_MAX - SEND_DELAY_MIN);
    setStatus(`自动发送（${Math.round(delay / 1000)}s 后）`);
    setTimeout(() => {
      if (pendingTask === null || awaitingReply) return;
      if (!clickSend()) log("未找到发送按钮，请手动点击页面发送按钮");
    }, delay);
  } else {
    setStatus("待发送（手动）");
    log("已填入输入框，请点击页面发送按钮提交");
  }
}

// 发送事件监控：自动点击与用户手动点击页面发送按钮统一进入等待回复 → 回传。
document.addEventListener(
  "click",
  (event) => {
    const btn = event.target.closest("button");
    if (!btn || !isSendButton(btn) || pendingTask === null || awaitingReply) return;
    awaitingReply = true;
    setStatus("等待 Gemini 回复…");
    const task = pendingTask;
    waitReplyReady()
      .then((reply) => submit(task, reply))
      .catch(() => {
        awaitingReply = false;
        log("等待回复超时，可重新发送");
      });
  },
  true,
);

instructBtn.addEventListener("click", async () => {
  if (pendingTask === null) {
    log("当前没有待发送的任务");
    return;
  }
  const el = findInput();
  const draft = el ? el.innerText.trim() : "";
  if (draft === "") {
    log("输入框为空");
    return;
  }
  await submit(pendingTask, draft);
});

refillBtn.addEventListener("click", () => {
  const source = lastReply !== "" ? lastReply : pendingTask?.message;
  if (!source) {
    log("暂无可回填的内容");
    return;
  }
  if (setInput(source)) log("已回填到输入框，可编辑后发送");
});

setInterval(poll, POLL_INTERVAL);
poll();
