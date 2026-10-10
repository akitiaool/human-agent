// gemini-bridge v3 content script —— 网页对话驱动。
// 回复回传走网络原文捕获（路线 A）：MAIN world inject.js 钩 GenerateContent 响应 → postMessage
// → 本脚本用 haDecodeGenerateContent（decode.js，同 content_scripts 数组先加载）解码 → POST /result。
// 投递循环：长轮询 GET /task → 模拟人类逐字回填 → 自动/手动提交。
// 选择器为 AI Studio 真实 DOM（2026-08-19 落定，task-13-brief 附录 A）。
// 页面是 Angular SPA + cdk-virtual-scroll：元素频繁创建/销毁，
// 所有抓取基于 MutationObserver 且每次现查 DOM，禁止缓存元素引用跨轮复用。
// 面板样式统一 ha-* 前缀，避免与页面样式冲突。

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const PROTOCOL_PREFIX = "【human-agent 工具协议】";
const TASK_RETRY_MS = 1_000; // GET /task 无消息后的重试间隔
const BRIDGE_RETRY_ATTEMPTS = 5; // 桥不可达自动重试次数；第 N 次失败后等 N 秒（1/2/3/4/5s），全部失败转手动重试
const TYPING_MIN_MS = 200; // 纠错重打每字符延时下限（真人键入节奏 200–500ms/字）
const TYPING_MAX_MS = 500;
const TYPO_MAX = 2; // 每段最多错字数（模拟粘贴后纠错）
const PASTE_GAP_MIN_MS = 400; // 段间停顿下限（模拟人工粘贴节奏）
const PASTE_GAP_MAX_MS = 900; // 段间停顿上限
const BACKSPACE_MIN_MS = 150; // 退格延时下限（退格键点按间隔 150–450ms）
const BACKSPACE_MAX_MS = 450;
const CORRECT_PAUSE_MIN_MS = 1_000; // 纠错前停顿下限（发现错字→思考→开始修改）
const CORRECT_PAUSE_MAX_MS = 2_500;
const THINK_MIN_MS = 300; // 退格后重打前的「想字」停顿下限
const THINK_MAX_MS = 800;
const COMMON_CJK = "的了一是在不和有这大为中上国个"; // 中文错字候选（同音/高频字近似）
const KB_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]; // 键盘相邻键（模拟手误）
const REINJECT_SUPPRESS_MS = 5_000; // 新对话重新注入防抖窗口
const BODY_CHECK_THROTTLE_MS = 200; // body 变更检查节流（虚拟滚动高频 churn 下不每次跑 querySelector）
const LOG_MAX_LINES = 50;

const SETTINGS_KEY = "geminiBridgeSettings";
const PROTOCOL_KEY = "geminiBridgeProtocol";

const defaultSettings = {
  baseUrl: DEFAULT_BASE_URL,
  autoMode: true,
  simulateTyping: true,
  delayMinSec: 3,
  delayMaxSec: 8,
  segmentLenMin: 2, // 分块长度下限（字符，每块在区间内随机，避免等长分段暴露自动化）
  segmentLenMax: 1024, // 分块长度上限（正常文本回填尽量少分块）
  typoChance: 40, // 每段触发「粘贴错字→退格→重打」纠错的概率（%）
  speed: 1, // 回填速度倍率（0.5/1/2/4/10，回填过程中可即时修改）
  autoApprove: false, // 自动授权危险命令：开=静默放行不弹窗
  approvalTimeoutSec: 120, // 审批超时（秒），到点自动全部拒绝
};

let settings = { ...defaultSettings };
let protocolText = ""; // 已保存的工具协议文本（新对话时重新注入）
let lastPostedReply = ""; // 最近一次成功回传的回复（网络捕获去重用，服务侧亦去重）
let delivering = false; // 投递循环串行占用标志（同一时刻只回填一条消息）
let reinjectPending = false; // 待投递循环处理的协议重新注入
let pendingTask = null; // 输入框未就绪时暂存的消息 {text, source}，就绪后补投
let protocolChecked = false; // 本页是否已完成「对话中无协议 → 自动注入」检查
let reinjectSuppressUntil = 0; // 新对话触发防抖时间戳
let currentStatus = "待命";
let bridgeDown = false; // 桥服务不可达标志（进入置位、成功复位）
let bridgeFailCount = 0; // 连续失败次数（5 次后转手动重试）
let manualRetryResolve = null; // 手动重试按钮的唤醒函数（挂起投递循环时非空）
let settingsTimer = null; // 面板设置保存防抖

// ---------- 工具函数 ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 回填节奏延时：按当前速度倍率缩放。循环中每步重新读取 settings，
// 所以回填过程中修改「回填速度」立即生效（已切分好的块长度不变）。
function pacedSleep(ms) {
  const rate = settings.speed > 0 ? settings.speed : 1;
  return sleep(ms / rate);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeBaseUrl(raw) {
  const input = String(raw ?? "").trim();
  if (/^\d+$/.test(input)) return `http://127.0.0.1:${input}`; // 纯端口 → 默认地址
  if (/^https?:\/\//i.test(input)) return input.replace(/\/+$/, "");
  if (input !== "") return `http://${input.replace(/\/+$/, "")}`; // host:port 形式
  return DEFAULT_BASE_URL;
}

function clampDelay(min, max) {
  let lo = Number.isFinite(min) ? Math.max(0, Math.min(600, min)) : defaultSettings.delayMinSec;
  let hi = Number.isFinite(max) ? Math.max(0, Math.min(600, max)) : defaultSettings.delayMaxSec;
  if (lo > hi) [lo, hi] = [hi, lo]; // 区间反转时对调
  return { delayMinSec: lo, delayMaxSec: hi };
}

// ---------- 面板（ha-* 前缀） ----------

const panel = document.createElement("div");
panel.id = "ha-panel";
panel.innerHTML = `
<style>
#ha-panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 280px; padding: 10px 12px; border-radius: 10px;
  background: #1f1f1f; color: #e8e8e8; font: 12px/1.6 system-ui, sans-serif;
  border: 1px solid #4b5563; user-select: none;
  max-height: 70vh; display: flex; flex-direction: column;
  color-scheme: dark; /* 原生控件（数字 spinner、select 下拉、滚动条）走暗色绘制 */
}
#ha-panel .ha-title {
  font-weight: 700; display: flex; align-items: center; justify-content: space-between;
  cursor: grab; background: #191919; border-bottom: 1px solid #333;
  margin: -10px -12px 8px; padding: 8px 12px; border-radius: 9px 9px 0 0;
}
#ha-panel #ha-collapse {
  background: #111; color: #9ca3af; border: 1px solid #4b5563;
  border-radius: 4px; width: 20px; height: 20px; line-height: 1;
  font: inherit; cursor: pointer; padding: 0;
}
#ha-panel #ha-collapse:hover { color: #e8e8e8; border-color: #6b7280; }
#ha-ball {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 40px; height: 40px; border-radius: 50%;
  background: #1f1f1f; border: 1px solid #4b5563;
  display: none; align-items: center; justify-content: center;
  cursor: grab; user-select: none; color-scheme: dark;
}
#ha-ball:hover { border-color: #6b7280; }
#ha-ball .ha-dot {
  width: 12px; height: 12px; border-radius: 50%;
  background: var(--dot, #3b82f6); box-shadow: 0 0 8px var(--dot, #3b82f6);
  animation: ha-pulse 1.8s ease-in-out infinite; /* 呼吸律动 */
}
@keyframes ha-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.4); opacity: .7; }
}
#ha-panel .ha-badge {
  font-size: 10px; font-weight: 400; color: #9ca3af;
  border: 1px solid #4b5563; border-radius: 4px; padding: 0 4px; margin-left: 4px;
}
#ha-panel .ha-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
#ha-panel input[type="number"], #ha-panel input[type="text"], #ha-panel select {
  background: #111; color: #e8e8e8; border: 1px solid #4b5563;
  border-radius: 4px; padding: 2px 6px; width: 56px; font: inherit;
}
#ha-panel input[type="text"] { width: 150px; flex: 1; }
#ha-panel select { width: 64px; }
#ha-panel input[type="checkbox"] { accent-color: #3b82f6; }
#ha-panel .ha-status {
  margin-top: 6px; padding: 4px 8px; border-radius: 6px;
  background: #111827; border: 1px solid #374151;
  color: var(--dot, #93c5fd);
}
#ha-panel #ha-retry {
  margin-top: 6px; width: 100%; background: #111; color: #fca5a5;
  border: 1px solid #7f1d1d; border-radius: 4px; padding: 4px 0;
  font: inherit; cursor: pointer;
}
#ha-panel #ha-retry:hover { border-color: #b91c1c; color: #fecaca; }
}
/* 状态色调：待命蓝 / 已抓取青 / 回填橙 / 倒计时绿 / 等待紫 / 桥断琥珀 / 错误红 */
.ha-tone-idle  { --dot: #3b82f6; }
.ha-tone-ready { --dot: #22d3ee; }
.ha-tone-busy  { --dot: #f97316; }
.ha-tone-go    { --dot: #22c55e; }
.ha-tone-wait  { --dot: #a78bfa; }
.ha-tone-warn  { --dot: #f59e0b; }
.ha-tone-err   { --dot: #ef4444; }
#ha-panel .ha-log-bar {
  margin-top: 6px; display: flex; align-items: center; justify-content: flex-end; gap: 6px;
}
#ha-panel .ha-log-bar button {
  background: #111; color: #9ca3af; border: 1px solid #4b5563;
  border-radius: 4px; font: inherit; padding: 0 8px; cursor: pointer;
}
#ha-panel .ha-log-bar button:hover { color: #e8e8e8; border-color: #6b7280; }
#ha-panel .ha-log {
  margin-top: 4px; max-height: 160px; overflow-y: auto;
  border-top: 1px solid #333; padding-top: 6px; color: #b0b0b0;
  white-space: pre-wrap; word-break: break-all;
}
#ha-log::-webkit-scrollbar { width: 8px; }
#ha-log::-webkit-scrollbar-track { background: #111827; }
#ha-log::-webkit-scrollbar-thumb { background: #4b5563; border-radius: 4px; }
#ha-log::-webkit-scrollbar-thumb:hover { background: #6b7280; }
.ha-approval-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
  background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center;
}
.ha-approval-box {
  width: 420px; max-height: 70vh; overflow-y: auto; border-radius: 10px;
  background: #1f1f1f; color: #e8e8e8; border: 1px solid #4b5563;
  padding: 12px 14px; font: 13px/1.6 system-ui, sans-serif; color-scheme: dark;
}
.ha-approval-title { font-weight: 700; margin-bottom: 8px; }
.ha-approval-count { font-weight: 400; font-size: 12px; color: #f59e0b; }
.ha-approval-row { border: 1px solid #374151; border-radius: 6px; padding: 8px; margin: 6px 0; }
.ha-approval-cmd {
  font-family: ui-monospace, monospace; background: #111;
  padding: 4px 8px; border-radius: 4px; word-break: break-all;
}
.ha-approval-hint { color: #fca5a5; font-size: 12px; margin: 4px 0; }
.ha-approval-btns { display: flex; gap: 8px; }
.ha-approval-btns button, .ha-approval-foot button {
  background: #111; color: #e8e8e8; border: 1px solid #4b5563;
  border-radius: 4px; padding: 3px 10px; font: inherit; cursor: pointer;
}
.ha-approval-btns .ha-allow, .ha-approval-foot .ha-allow-all { border-color: #166534; color: #86efac; }
.ha-approval-btns .ha-deny, .ha-approval-foot .ha-deny-all { border-color: #7f1d1d; color: #fca5a5; }
.ha-approval-btns .ha-btn-wl { border-color: #1d4ed8; color: #93c5fd; }
.ha-approval-row.ha-approval-wl { border-color: #166534; }
.ha-approval-row.ha-approval-wl .ha-approval-hint { color: #86efac; }
.ha-approval-foot { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }
</style>
<div class="ha-title">
  <span>gemini-bridge<span class="ha-badge">v3 网页对话驱动</span></span>
  <button id="ha-collapse" title="收起为悬浮球">–</button>
</div>
<label class="ha-row">
  <input type="checkbox" id="ha-auto-mode"> 自动模式（自动提交回填消息）
</label>
<label class="ha-row">
  <input type="checkbox" id="ha-simulate"> 模拟人类逐字输入
</label>
<label class="ha-row">
  <input type="checkbox" id="ha-auto-approve"> 自动授权危险命令
</label>
<div class="ha-row">
  <span>审批超时</span>
  <input type="number" id="ha-approval-timeout" min="10" max="600" step="10">
  <span>秒</span>
</div>
<div class="ha-row">
  <span>提交延迟</span>
  <input type="number" id="ha-delay-min" min="0" max="600" step="0.5">
  <span>~</span>
  <input type="number" id="ha-delay-max" min="0" max="600" step="0.5">
  <span>秒</span>
</div>
<div class="ha-row">
  <span>分块长度</span>
  <input type="number" id="ha-segment-min" min="2" max="1024" step="1">
  <span>~</span>
  <input type="number" id="ha-segment-max" min="2" max="1024" step="1">
  <span>字符</span>
</div>
<div class="ha-row">
  <span>纠错概率</span>
  <input type="number" id="ha-typo-chance" min="0" max="100" step="5">
  <span>%</span>
</div>
<div class="ha-row">
  <span>回填速度</span>
  <select id="ha-speed" title="回填过程中修改立即生效（分块长度已切分，本次不变）">
    <option value="0.5">0.5x</option>
    <option value="1">1x</option>
    <option value="2">2x</option>
    <option value="4">4x</option>
    <option value="10">10x</option>
  </select>
</div>
<div class="ha-row">
  <span>桥服务</span>
  <input type="text" id="ha-base-url" spellcheck="false" placeholder="http://127.0.0.1:8765">
</div>
<div class="ha-status" id="ha-status">待命</div>
<button id="ha-retry" hidden>手动重试</button>
<div class="ha-log-bar">
  <button id="ha-log-export" title="导出日志为文本文件">导出</button>
  <button id="ha-log-clear" title="清除日志">清除</button>
</div>
<div class="ha-log" id="ha-log"></div>
`;
document.documentElement.appendChild(panel);

// 悬浮球：面板收起后的最小形态（状态圆点），双击展开完整面板
const ball = document.createElement("div");
ball.id = "ha-ball";
ball.title = "双击展开面板";
ball.innerHTML = `<span class="ha-dot" id="ha-ball-dot"></span>`;
document.documentElement.appendChild(ball);

const statusEl = panel.querySelector("#ha-status");
const logEl = panel.querySelector("#ha-log");
const ballDot = ball.querySelector("#ha-ball-dot");
const retryBtn = panel.querySelector("#ha-retry");

// 手动重试：重置计数并唤醒挂起的投递循环
retryBtn.addEventListener("click", () => {
  retryBtn.hidden = true;
  bridgeFailCount = 0;
  bridgeDown = false;
  setStatus("待命");
  log("手动重试：重新连接桥服务…");
  if (manualRetryResolve) {
    manualRetryResolve();
    manualRetryResolve = null;
  }
});

const TONE_CLASSES = [
  "ha-tone-idle", "ha-tone-ready", "ha-tone-busy",
  "ha-tone-go", "ha-tone-wait", "ha-tone-warn", "ha-tone-err",
];

// 状态 → 色调：面板状态栏与悬浮球圆点共用一套
function statusTone(text) {
  if (text === "错误") return "ha-tone-err";
  if (text === "桥未连接" || text === "桥未连接（重试中）") return "ha-tone-warn";
  if (text === "等待授权") return "ha-tone-warn";
  if (text.includes("回填中")) return "ha-tone-busy";
  if (text.includes("自动提交")) return "ha-tone-go";
  if (text.includes("等待 Gemini")) return "ha-tone-wait";
  if (text.includes("已抓取")) return "ha-tone-ready";
  return "ha-tone-idle";
}

function setStatus(text) {
  currentStatus = text;
  statusEl.textContent = text;
  const tone = statusTone(text);
  statusEl.classList.remove(...TONE_CLASSES);
  statusEl.classList.add(tone);
  ballDot.classList.remove(...TONE_CLASSES);
  ballDot.classList.add(tone);
}

// ---------- 面板拖拽与悬浮球 ----------

// 从 right/bottom 定位迁移到 left/top（getBoundingClientRect 当前坐标），此后拖拽只改 left/top
function migrateToXY(el) {
  const rect = el.getBoundingClientRect();
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}

// 拖 handle 移动 target（指针按住移动，松开结束；不拦截按钮点击）
function makeDraggable(handle, target) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    migrateToXY(target);
    const startX = e.clientX;
    const startY = e.clientY;
    const baseLeft = parseFloat(target.style.left);
    const baseTop = parseFloat(target.style.top);
    const move = (ev) => {
      target.style.left = `${baseLeft + ev.clientX - startX}px`;
      target.style.top = `${baseTop + ev.clientY - startY}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

// 收起为悬浮球：面板与球共享位置，球显示在当前面板位置
function collapsePanel() {
  migrateToXY(panel);
  ball.style.left = panel.style.left;
  ball.style.top = panel.style.top;
  ball.style.right = "auto";
  ball.style.bottom = "auto";
  panel.style.display = "none";
  ball.style.display = "flex";
}

function expandPanel() {
  if (ball.style.left) {
    // 球被拖过：展开时面板落在球的位置
    panel.style.left = ball.style.left;
    panel.style.top = ball.style.top;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }
  ball.style.display = "none";
  panel.style.display = "flex";
}

makeDraggable(panel.querySelector(".ha-title"), panel);
makeDraggable(ball, ball);
panel.querySelector("#ha-collapse").addEventListener("click", collapsePanel);
let lastBallClick = 0;
ball.addEventListener("click", () => {
  const now = Date.now();
  if (now - lastBallClick < 300) {
    expandPanel();
    lastBallClick = 0; // 防展开后同位置快速单击再触发
    return;
  }
  lastBallClick = now;
});

// 桥不可达降级：进入时状态切「桥未连接（重试中）」；每次失败都记一条日志（重试进度由调用方经 detail 给出）
function noteBridgeFailure(errText, detail = "") {
  if (!bridgeDown) {
    bridgeDown = true;
    setStatus("桥未连接（重试中）");
  }
  log(`桥服务不可达：${errText}${detail ? `（${detail}）` : ""}`);
}

function noteBridgeSuccess() {
  bridgeFailCount = 0;
  if (bridgeDown) {
    bridgeDown = false;
    setStatus("待命");
    log("桥服务已连接");
  }
}

// 挂起投递循环直到手动重试按钮被点击
function waitForManualRetry() {
  return new Promise((resolve) => {
    manualRetryResolve = resolve;
  });
}

function log(text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  const lines = logEl.textContent ? logEl.textContent.split("\n") : [];
  lines.unshift(line);
  logEl.textContent = lines.slice(0, LOG_MAX_LINES).join("\n");
}

// ---------- 设置持久化（chrome.storage.sync） ----------

function clampSegment(min, max) {
  let lo = Number.isFinite(min) ? Math.min(1024, Math.max(2, Math.round(min))) : defaultSettings.segmentLenMin;
  let hi = Number.isFinite(max) ? Math.min(1024, Math.max(2, Math.round(max))) : defaultSettings.segmentLenMax;
  if (lo > hi) [lo, hi] = [hi, lo]; // 区间反转时对调
  return { segmentLenMin: lo, segmentLenMax: hi };
}

function clampTypoChance(v) {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : defaultSettings.typoChance;
}

function clampSpeed(v) {
  const s = Number(v);
  return [0.5, 1, 2, 4, 10].includes(s) ? s : defaultSettings.speed;
}

function clampApprovalTimeout(v) {
  return Number.isFinite(v) ? Math.min(600, Math.max(10, Math.round(v))) : defaultSettings.approvalTimeoutSec;
}

function applySettingsToPanel() {
  panel.querySelector("#ha-auto-mode").checked = settings.autoMode;
  panel.querySelector("#ha-simulate").checked = settings.simulateTyping;
  panel.querySelector("#ha-delay-min").value = settings.delayMinSec;
  panel.querySelector("#ha-delay-max").value = settings.delayMaxSec;
  panel.querySelector("#ha-segment-min").value = settings.segmentLenMin;
  panel.querySelector("#ha-segment-max").value = settings.segmentLenMax;
  panel.querySelector("#ha-typo-chance").value = settings.typoChance;
  panel.querySelector("#ha-speed").value = settings.speed;
  panel.querySelector("#ha-base-url").value = settings.baseUrl;
  panel.querySelector("#ha-auto-approve").checked = settings.autoApprove;
  panel.querySelector("#ha-approval-timeout").value = settings.approvalTimeoutSec;
}

function scheduleSaveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings }).catch(() => log("设置保存失败"));
  }, 200);
}

function setupPanelEvents() {
  panel.querySelector("#ha-auto-mode").addEventListener("change", (e) => {
    settings.autoMode = e.target.checked;
    scheduleSaveSettings();
    log(`自动模式：${settings.autoMode ? "开" : "关"}`);
  });
  panel.querySelector("#ha-simulate").addEventListener("change", (e) => {
    settings.simulateTyping = e.target.checked;
    scheduleSaveSettings();
    log(`模拟逐字输入：${settings.simulateTyping ? "开" : "关"}`);
  });
  panel.querySelector("#ha-delay-min").addEventListener("change", (e) => {
    const { delayMinSec, delayMaxSec } = clampDelay(Number(e.target.value), settings.delayMaxSec);
    settings.delayMinSec = delayMinSec;
    settings.delayMaxSec = delayMaxSec;
    applySettingsToPanel();
    scheduleSaveSettings();
  });
  panel.querySelector("#ha-delay-max").addEventListener("change", (e) => {
    const { delayMinSec, delayMaxSec } = clampDelay(settings.delayMinSec, Number(e.target.value));
    settings.delayMinSec = delayMinSec;
    settings.delayMaxSec = delayMaxSec;
    applySettingsToPanel();
    scheduleSaveSettings();
  });
  panel.querySelector("#ha-segment-min").addEventListener("change", (e) => {
    const { segmentLenMin, segmentLenMax } = clampSegment(Number(e.target.value), settings.segmentLenMax);
    settings.segmentLenMin = segmentLenMin;
    settings.segmentLenMax = segmentLenMax;
    applySettingsToPanel();
    scheduleSaveSettings();
  });
  panel.querySelector("#ha-segment-max").addEventListener("change", (e) => {
    const { segmentLenMin, segmentLenMax } = clampSegment(settings.segmentLenMin, Number(e.target.value));
    settings.segmentLenMin = segmentLenMin;
    settings.segmentLenMax = segmentLenMax;
    applySettingsToPanel();
    scheduleSaveSettings();
  });
  panel.querySelector("#ha-typo-chance").addEventListener("change", (e) => {
    settings.typoChance = clampTypoChance(Number(e.target.value));
    applySettingsToPanel();
    scheduleSaveSettings();
  });
  panel.querySelector("#ha-speed").addEventListener("change", (e) => {
    settings.speed = clampSpeed(e.target.value);
    applySettingsToPanel();
    scheduleSaveSettings();
    log(`回填速度：${settings.speed}x（下次节奏立即生效）`);
  });
  panel.querySelector("#ha-auto-approve").addEventListener("change", (e) => {
    settings.autoApprove = e.target.checked;
    applySettingsToPanel();
    scheduleSaveSettings();
    log(`自动授权危险命令：${settings.autoApprove ? "开" : "关"}`);
  });
  panel.querySelector("#ha-approval-timeout").addEventListener("change", (e) => {
    settings.approvalTimeoutSec = clampApprovalTimeout(Number(e.target.value));
    applySettingsToPanel();
    scheduleSaveSettings();
  });
  panel.querySelector("#ha-log-clear").addEventListener("click", () => {
    logEl.textContent = "";
  });
  panel.querySelector("#ha-log-export").addEventListener("click", () => {
    const blob = new Blob([logEl.textContent || "(空日志)"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gemini-bridge-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
  panel.querySelector("#ha-base-url").addEventListener("change", (e) => {
    settings.baseUrl = normalizeBaseUrl(e.target.value);
    panel.querySelector("#ha-base-url").value = settings.baseUrl;
    scheduleSaveSettings();
    log(`桥服务地址：${settings.baseUrl}`);
  });
}

// ---------- AI Studio DOM 操作（每次现查，禁止缓存跨轮复用） ----------

// A1：对话容器根（其子元素全部为 ms-chat-turn）
function findChatSessionContent() {
  return (
    document.querySelector("ms-chat-session > ms-autoscroll-container > div > div.chat-session-content") ??
    document.querySelector(".chat-session-content") ??
    null
  );
}

// A4：输入框（普通 textarea，非 contenteditable）
function findInput() {
  return document.querySelector('ms-prompt-box textarea.cdk-textarea-autosize.textarea');
}

// A5：发送按钮（"Run"，空内容时 aria-disabled="true"）
function findSendButton() {
  return document.querySelector('ms-run-button button[type="submit"].ms-button-primary');
}

// A4：模拟人类分段粘贴输入。整段瞬间填入（模拟 Ctrl+V），
// 按概率在段内预留错别字 → 退格删除 → 逐字重打正确字符，段间随机停顿。
// 不做匀速逐字输入（无防检测意义且回填慢）。
// 分块长度在 [minLen, maxLen] 区间内逐块随机（等长分段会暴露自动化）；
// 剩余不足 minLen 时并入当前块收尾，不产生碎片块。
function splitSegments(text, minLen, maxLen) {
  const segs = [];
  let i = 0;
  while (i < text.length) {
    const remaining = text.length - i;
    let len = randInt(minLen, maxLen);
    if (remaining <= maxLen) {
      segs.push(text.slice(i)); // 收尾块
      break;
    }
    if (remaining - len < minLen) len = remaining; // 剩余太少则并入本块（可能略超上限，真实粘贴本就无精确边界）
    let end = Math.min(i + len, text.length);
    const nl = text.lastIndexOf("\n", end); // 就近行断点分段
    if (nl > i + minLen / 2) end = nl + 1;
    segs.push(text.slice(i, end));
    i = end;
  }
  return segs;
}

// 模拟手误：字母 → 同行相邻键；数字 → ±1；中文 → 高频字近似；其余不替换
function neighborKey(ch) {
  const lower = ch.toLowerCase();
  for (const row of KB_ROWS) {
    const idx = row.indexOf(lower);
    if (idx >= 0) {
      const n = row[idx + (Math.random() < 0.5 ? -1 : 1)] ?? row[idx - 1] ?? row[idx + 1];
      return ch === lower ? n : n.toUpperCase();
    }
  }
  if (/\d/.test(ch)) return String((Number(ch) + (Math.random() < 0.5 ? 1 : 9)) % 10);
  if (/[一-鿿]/.test(ch)) return COMMON_CJK[randInt(0, COMMON_CJK.length - 1)];
  return ch; // 符号等无法近似 → 不制造错字
}

// 写入一段：粘贴（可能带错字）→ 按序退格删除错字 → 逐字重打正确字符。segStartCp 为本段起点的码点偏移。
async function pasteSegment(input, segStartCp, seg) {
  const fixes = [];
  if (Math.random() * 100 < settings.typoChance) {
    const n = randInt(1, Math.min(TYPO_MAX, seg.length));
    const positions = new Set();
    while (positions.size < n) positions.add(randInt(0, seg.length - 1));
    for (const pos of positions) {
      const correct = seg[pos];
      const typo = neighborKey(correct);
      if (typo !== correct) fixes.push({ pos, correct, typo });
    }
  }
  const chars = [...seg];
  for (const f of fixes) chars[f.pos] = f.typo;
  const written = chars.join("");
  input.value += written;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: written }));
  if (fixes.length === 0) return;
  await pacedSleep(randInt(CORRECT_PAUSE_MIN_MS, CORRECT_PAUSE_MAX_MS)); // 纠错前停顿：发现错字→思考→开始修改
  let all = Array.from(input.value); // 码点数组（避免代理对与 slice 偏移不一致）
  for (const f of [...fixes].sort((a, b) => b.pos - a.pos)) {
    const at = segStartCp + f.pos;
    all.splice(at, 1); // 退格删除错字
    input.value = all.join("");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    await pacedSleep(randInt(BACKSPACE_MIN_MS, BACKSPACE_MAX_MS));
    await pacedSleep(randInt(THINK_MIN_MS, THINK_MAX_MS)); // 退格后停顿：想正确字
    all.splice(at, 0, f.correct); // 重打正确字符
    input.value = all.join("");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: f.correct }));
    await pacedSleep(randInt(TYPING_MIN_MS, TYPING_MAX_MS));
  }
}

async function typeIntoInput(text) {
  const input = findInput();
  if (!input) return false;
  input.focus();
  // 回填前若已有内容（用户手输未清），先清空再写入
  if (input.value !== "") {
    input.value = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  }
  if (settings.simulateTyping) {
    await pacedSleep(randInt(300, 800)); // 初始停顿，模拟人类开始输入前的思考
    let segStartCp = 0;
    for (const seg of splitSegments(text, settings.segmentLenMin, settings.segmentLenMax)) {
      await pasteSegment(input, segStartCp, seg);
      segStartCp += [...seg].length; // 码点偏移（length 为 UTF-16 单位，非 BMP 字符会漂移）
      await pacedSleep(randInt(PASTE_GAP_MIN_MS, PASTE_GAP_MAX_MS)); // 段间停顿
    }
  } else {
    input.value = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
  // 输入完成后的最终 input 事件（同步 cdk-textarea-autosize 高度与表单状态）
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  return true;
}

// A5：等待按钮 aria-disabled 解除后 click()；不可用则回退 Ctrl+Enter。
async function clickSendWhenReady() {
  const btn = findSendButton();
  if (btn) {
    for (let i = 0; i < 50; i++) {
      if (btn.getAttribute("aria-disabled") !== "true") {
        btn.click();
        return true;
      }
      await sleep(100);
    }
  }
  const input = findInput();
  if (!input) return false;
  log("发送按钮不可用，回退 Ctrl+Enter 提交");
  for (const type of ["keydown", "keyup"]) {
    input.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }
  return true;
}

// ---------- 审批：危险命令授权（弹窗/自动授权）→ POST /approval ----------

// 白名单键归一化：与服务端 src/nose/policy.ts 对齐——写类路径反斜杠转正斜杠 + 斜杠折叠 + win32 小写；
// terminal 命令空白折叠（无斜杠折叠）；其余工具完整参数深归一 + 键排序（exact 键必须与桥侧 serializeArgs 一致）
function deepNorm(value) {
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ").replace(/\\/g, "/");
  }
  if (Array.isArray(value)) return value.map(deepNorm);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = deepNorm(value[k]);
    return out;
  }
  return value;
}

function normalizeKey(call, granularity) {
  const args = call.arguments ?? {};
  if (call.name === "write_file" || call.name === "apply_patch") {
    const p = String(args.path ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/");
    // 段级解析：折叠 . 与 ..（与服务端 normalizePath 一致——防 c:/ws/../../windows 穿越绕过黑名单锚定/工作区边界）
    const isAbs = p.startsWith("/");
    const isDrive = /^[a-z]:\//i.test(p);
    const out = [];
    for (const s of p.split("/")) {
      if (s === "" || s === ".") continue;
      if (s === "..") {
        if (out.length > (isDrive ? 1 : 0)) out.pop();
        continue;
      }
      out.push(s);
    }
    const resolved = (isAbs ? "/" : "") + out.join("/");
    const lower = /^win/i.test(navigator.platform) ? resolved.toLowerCase() : resolved;
    if (granularity === "dir") {
      const i = lower.lastIndexOf("/");
      // 根级/盘符根：dir 条目=全部绝对路径/整盘超授权，降级为文件条目（与 buildWhitelistEntry 一致）
      if (i <= 0 || (i === 2 && lower[1] === ":")) return { key: lower, kind: "path" };
      return { key: `${lower.slice(0, i)}/`, kind: "path" };
    }
    return { key: lower, kind: "path" };
  }
  if (call.name === "terminal") {
    return {
      key: String(args.command ?? "").trim().replace(/\s+/g, " ").replace(/\\/g, "/"),
      kind: "exact",
    };
  }
  return { key: JSON.stringify(deepNorm(args)), kind: "exact" };
}

function buildEntry(call, granularity) {
  const { key, kind } = normalizeKey(call, granularity);
  return { tool: call.name, key, kind };
}

async function postApproval(payload) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "approve", ...payload, baseUrl: settings.baseUrl });
    if (resp?.ok === true) return true;
    if (resp?.status === 404) {
      log("审批请求已过期（桥服务已按超时拒绝），跳过");
      return true; // 桥已兜底处理并回填拒绝行，流程继续
    }
    noteBridgeFailure(resp?.error ?? "POST /approval 失败");
    return false;
  } catch (err) {
    noteBridgeFailure(err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function handleApproval(item) {
  if (settings.autoApprove) {
    log(`自动授权已开启：静默放行 ${item.calls.length} 条危险命令`);
    if (!(await postApproval({ id: item.id, allowed: item.calls.map(() => true) }))) setStatus("错误");
    return;
  }
  setStatus("等待授权");
  log(`收到审批请求（${item.calls.length} 条危险命令），等待授权…`);
  const decision = await showApprovalDialog(item);
  const payload = { id: item.id, allowed: decision.allowed };
  const wl = decision.whitelist ?? [];
  if (wl.length > 0) payload.whitelist = wl;
  if (!(await postApproval(payload))) {
    setStatus("错误");
    log("审批结果提交失败——桥服务将在审批超时后按拒绝兜底");
    return;
  }
  setStatus("待命");
}

// 审批弹窗：遮罩 + 居中卡片；逐条 [允许][拒绝][白名单] + 全部允许/全部拒绝；
// 白名单按钮是显式动作：条目并入本次提交的 whitelist 数组并自动勾选该条允许（弹窗保持打开，可继续处理其余行）；
// 顶部倒计时按面板审批超时配置，到点自动全部拒绝（白名单条目一并撤销，保证载荷与 allowed 一致）。
function showApprovalDialog(item) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ha-approval-overlay";
    const box = document.createElement("div");
    box.className = "ha-approval-box";
    const secondsLeft = { value: settings.approvalTimeoutSec };
    const rows = item.calls
      .map(
        (call, i) => `
      <div class="ha-approval-row" data-i="${i}">
        <div class="ha-approval-cmd">${escapeHtml(call.arguments?.command ?? JSON.stringify(call.arguments))}</div>
        <div class="ha-approval-hint">该命令可能删除或覆盖数据，请确认后授权</div>
        <div class="ha-approval-btns">
          <button class="ha-allow" data-i="${i}">允许</button>
          <button class="ha-deny" data-i="${i}">拒绝</button>
        </div>
      </div>`,
      )
      .join("");
    box.innerHTML = `
      <div class="ha-approval-title">危险命令授权 <span class="ha-approval-count" id="ha-approval-count"></span></div>
      ${rows}
      <div class="ha-approval-foot">
        <button class="ha-allow-all" id="ha-approval-allow-all">全部允许</button>
        <button class="ha-deny-all" id="ha-approval-deny-all">全部拒绝</button>
      </div>`;
    overlay.appendChild(box);
    document.documentElement.appendChild(overlay);

    const decisions = item.calls.map(() => false); // 逐条允许标记（白名单点击即视为允许）
    const whitelist = []; // 逐条白名单条目（按调用 index 记录；仅显式按钮动作填充）
    const countEl = box.querySelector("#ha-approval-count");
    const refreshRow = (row, index) => {
      row.classList.add("ha-approval-wl");
      const hint = row.querySelector(".ha-approval-hint");
      if (hint) hint.textContent = "已加入白名单（允许执行），后续同类调用自动放行";
    };
    const finish = () => {
      clearInterval(timer);
      overlay.remove();
      resolve({ allowed: decisions, whitelist: Object.values(whitelist).filter(Boolean) });
    };
    const timer = setInterval(() => {
      secondsLeft.value -= 1;
      countEl.textContent = `${secondsLeft.value}s 后自动拒绝`;
      if (secondsLeft.value <= 0) {
        decisions.fill(false); // 超时：全部拒绝（白名单条目同步撤销，提交载荷才不会 400）
        whitelist.length = 0;
        finish();
      }
    }, 1000);
    countEl.textContent = `${secondsLeft.value}s 后自动拒绝`;

    // 每行追加白名单按钮：非写类 [白名单]；写类（write_file/apply_patch）额外 [白名单(此目录)]
    [...box.querySelectorAll(".ha-approval-row")].forEach((row, index) => {
      const call = item.calls[index];
      const rowActions = row.querySelector(".ha-approval-btns");
      const isWrite = call.name === "write_file" || call.name === "apply_patch";
      const wlBtn = document.createElement("button");
      wlBtn.textContent = isWrite ? "白名单(此路径)" : "白名单";
      wlBtn.className = "ha-btn ha-btn-wl";
      wlBtn.onclick = () => {
        decisions[index] = true; // 白名单即允许
        whitelist[index] = buildEntry(call, isWrite ? "path" : "exact");
        refreshRow(row, index);
      };
      if (isWrite) {
        const dirBtn = document.createElement("button");
        dirBtn.textContent = "白名单(此目录)";
        dirBtn.className = "ha-btn ha-btn-wl";
        dirBtn.onclick = () => {
          decisions[index] = true;
          whitelist[index] = buildEntry(call, "dir");
          refreshRow(row, index);
        };
        rowActions.appendChild(dirBtn);
      }
      rowActions.appendChild(wlBtn);
    });

    box.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const i = Number(btn.dataset.i);
      if (btn.classList.contains("ha-allow")) {
        decisions[i] = true;
        finish();
      } else if (btn.classList.contains("ha-deny")) {
        decisions[i] = false;
        whitelist[i] = undefined; // 拒绝撤销同条白名单（服务端校验：条目必须对应 allowed=true 的调用）
        finish();
      } else if (btn.id === "ha-approval-allow-all") {
        decisions.fill(true); // 全部允许不自动填 whitelist——白名单始终是显式按钮动作
        finish();
      } else if (btn.id === "ha-approval-deny-all") {
        decisions.fill(false);
        whitelist.length = 0; // 全部拒绝撤销全部白名单条目
        finish();
      }
    });
  });
}

// ---------- 投递循环：GET /task → 模拟输入 → 自动/手动提交 ----------

async function deliverMessage(text, source) {
  delivering = true;
  try {
    setStatus(settings.simulateTyping ? "回填中（模拟粘贴）" : "回填中");
    log(`${source === "reinject" ? "重新注入协议文本" : "任务消息到达"}：${truncate(text.replace(/\n/g, " "), 80)}`);
    if (!(await typeIntoInput(text))) {
      setStatus("待命");
      pendingTask = { text, source }; // 输入框未就绪：消息暂存待补投，不丢弃
      log("输入框未就绪（ms-prompt-box textarea），消息已暂存，页面就绪后自动补投");
      return;
    }
    if (!settings.autoMode) {
      setStatus("待命");
      log("手动模式：已回填输入框，请点击页面发送按钮提交");
      return;
    }
    const delayMs = randRange(settings.delayMinSec, settings.delayMaxSec) * 1000;
    const deadline = Date.now() + delayMs;
    const tick = () => setStatus(`自动提交（${Math.max(0, (deadline - Date.now()) / 1000).toFixed(1)}s 后）`);
    tick();
    const countdown = setInterval(tick, 100); // 动态倒计时，逐 0.1s 递减
    await sleep(delayMs);
    clearInterval(countdown);
    // 竞态守卫：延迟回调触发时开关已关闭 → 跳过点击（A7）
    if (!settings.autoMode) {
      setStatus("待命");
      log("延迟期间自动模式已关闭，跳过自动提交（请在输入框手动发送）");
      return;
    }
    if (await clickSendWhenReady()) {
      setStatus("等待 Gemini 回复");
      log("已提交，等待 Gemini 回复…");
    } else {
      setStatus("错误");
      log("未找到发送按钮且 Ctrl+Enter 回退失败，请手动提交");
    }
  } finally {
    delivering = false;
  }
}

async function deliveryLoop() {
  while (true) {
    if (!delivering) {
      // 待投队列优先：输入框已就绪时补投暂存消息（不丢弃、不插队丢失）
      if (pendingTask && findInput()) {
        const task = pendingTask;
        pendingTask = null;
        await deliverMessage(task.text, task.source);
        continue;
      }
      // 页面就绪协议补投：进已有对话/刷新后，若对话历史中无协议消息则注入（本页一次）
      if (!protocolChecked && protocolText && findInput()) {
        protocolChecked = true;
        const input = findInput();
        // 输入框有未提交内容（可能正是协议）时跳过，避免重复注入
        if (input.value.trim() === "") {
          const hasProtocol = [...document.querySelectorAll("ms-chat-turn")].some((t) =>
            t.textContent.includes(PROTOCOL_PREFIX),
          );
          if (!hasProtocol) {
            log("当前对话尚无协议消息，自动注入协议文本");
            await deliverMessage(protocolText, "reinject");
            continue;
          }
        }
      }
      // 新对话触发的协议重新注入（pendingTask 已含协议时跳过，避免重复注入）
      if (reinjectPending) {
        reinjectPending = false;
        if (pendingTask && pendingTask.text.startsWith(PROTOCOL_PREFIX)) {
          log("协议文本已在待投队列，跳过重复注入");
          continue;
        }
        await deliverMessage(protocolText, "reinject");
        continue;
      }
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: "get-task", baseUrl: settings.baseUrl });
      } catch (err) {
        resp = { error: err instanceof Error ? err.message : String(err) };
      }
      if (resp?.error) {
        bridgeFailCount += 1;
        if (bridgeFailCount <= BRIDGE_RETRY_ATTEMPTS) {
          noteBridgeFailure(resp.error, `第 ${bridgeFailCount}/${BRIDGE_RETRY_ATTEMPTS} 次失败，${bridgeFailCount}s 后重试`);
          await sleep(bridgeFailCount * 1000);
          continue;
        }
        noteBridgeFailure(resp.error, "5 次重试均失败，请点击面板「手动重试」");
        setStatus("桥未连接");
        retryBtn.hidden = false;
        await waitForManualRetry();
        continue;
      }
      noteBridgeSuccess();
      if (resp?.task?.type === "approval") {
        await handleApproval(resp.task);
        continue; // 审批处理完立即拉取下一条（执行结果回填消息）
      }
      if (resp?.task?.message) {
        const msg = resp.task.message;
        if (msg.startsWith(PROTOCOL_PREFIX)) {
          // 首条任务消息即工具协议文本：保存供新对话重新注入（存储持久化，刷新后仍可用）
          protocolText = msg;
          chrome.storage.sync.set({ [PROTOCOL_KEY]: protocolText }).catch(() => log("协议文本保存失败"));
          log("已保存工具协议文本（检测到新对话时自动重新注入）");
        }
        await deliverMessage(msg, "task");
        continue; // 有消息时立即拉取下一条
      }
      // 无消息：仅把错误状态恢复为待命，不覆盖「已抓取回复」等有效状态
      if (currentStatus === "错误") setStatus("待命");
    }
    await sleep(TASK_RETRY_MS);
  }
}

// ---------- 网络捕获接入（路线 A）：MAIN world → postMessage → 解码 → POST /result ----------

const CAPTURE_MARKER = "gemini-bridge-capture";
let captureMounted = false; // 「网络捕获已挂载」只记一次（hello 或首条捕获消息先到者）

function noteCaptureMounted(how) {
  if (captureMounted) return;
  captureMounted = true;
  log(`网络捕获已挂载（${how}）`);
}

async function postResult(reply, stats) {
  setStatus("已抓取回复（等待执行）");
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "submit-result", reply, baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { error: err instanceof Error ? err.message : String(err) };
  }
  if (resp?.error) {
    noteBridgeFailure(resp.error); // 响亮停滞：本条丢弃不重发（无重采样通道），日志可诊
    return;
  }
  if (resp.ok) {
    noteBridgeSuccess();
    lastPostedReply = reply; // 仅成功回传才更新去重标记
    log(
      `网络捕获：已回传（${reply.length} 字符，${stats.deltaCount} deltas，滤 ${stats.thoughtCount} thought，` +
        `${resp.processed ? "已入队执行" : "服务侧忽略（无工具调用/重复）"}）`,
    );
    if (!resp.processed) setStatus("待命");
    // processed 时保持「已抓取回复（等待执行）」，直到回填消息到达
  } else {
    setStatus("错误");
    log(`回传被拒：HTTP ${resp.status ?? "?"}`);
  }
}

function setupCaptureListener() {
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return; // 只收本窗口消息
    const d = ev.data;
    if (!d || d.__ha !== CAPTURE_MARKER || d.v !== 1) return; // 非捕获协议一律忽略（含本脚本自己发的 ping）
    if (d.kind === "hello") {
      noteCaptureMounted("注入侧握手");
    } else if (d.kind === "start") {
      noteCaptureMounted("经捕获消息");
      log("网络捕获：检测到 GenerateContent 请求");
    } else if (d.kind === "error") {
      noteCaptureMounted("经捕获消息");
      log(`网络捕获异常：${d.reason ?? "未知原因"}（…${d.urlTail ?? ""}）`);
    } else if (d.kind === "done") {
      noteCaptureMounted("经捕获消息");
      const decoded = haDecodeGenerateContent(d.raw);
      if (decoded === null) {
        log(`网络捕获解码失败（原文 ${typeof d.raw === "string" ? d.raw.length : 0} 字符），本轮不投递`);
        return;
      }
      if (decoded.answer === lastPostedReply) {
        log("网络捕获：与上次回传内容相同，跳过投递");
        return;
      }
      postResult(decoded.answer, decoded);
    }
  });
  // inject.js 在 document_start 已发过 hello，本监听 document_idle 才就位（错过首包）——发 ping 请它补答
  window.postMessage({ __ha: CAPTURE_MARKER, v: 1, kind: "ping" }, "*");
}

// ---------- 新对话检测（A1）：观察器随容器变化重挂，触发协议文本重新注入 ----------

let bodyObserver = null;
let lastBodyCheck = 0; // body 变更回调节流时间戳
let contentObserver = null;
let observedContent = null;
let lastTurnCount = 0;
let lastFirstTurn = null;
let hadSession = false;

function setupNewConversationWatcher() {
  hadSession = Boolean(document.querySelector("ms-chat-session"));
  rehangContentObserver();
  bodyObserver = new MutationObserver(() => {
    const now = Date.now();
    if (now - lastBodyCheck < BODY_CHECK_THROTTLE_MS) return; // 节流：虚拟滚动高频变更不每次现查
    lastBodyCheck = now;
    const hasSession = Boolean(document.querySelector("ms-chat-session"));
    if (hadSession && !hasSession) onNewConversation("对话会话已移除"); // ① session 从 DOM 移除
    hadSession = hasSession;
    rehangContentObserver();
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
}

// 每次取到新的 .chat-session-content 后在其上重建 childList 观察器
function rehangContentObserver() {
  const content = findChatSessionContent();
  if (!content) {
    if (observedContent && lastTurnCount > 0) onNewConversation("对话容器已消失");
    if (contentObserver) {
      contentObserver.disconnect();
      contentObserver = null;
    }
    observedContent = null;
    lastTurnCount = 0;
    lastFirstTurn = null;
    return;
  }
  if (content === observedContent) return;
  if (contentObserver) contentObserver.disconnect();
  observedContent = content;
  lastTurnCount = content.children.length; // 子元素全部为 ms-chat-turn
  lastFirstTurn = content.firstElementChild;
  contentObserver = new MutationObserver(onContentMutation);
  contentObserver.observe(content, { childList: true });
}

function onContentMutation() {
  const content = observedContent;
  if (!content) return;
  const count = content.children.length;
  const first = content.firstElementChild;
  if (lastTurnCount > 0 && (count === 0 || first !== lastFirstTurn)) {
    onNewConversation("对话轮次已清空/重置"); // ② 计数清空或首个子元素变化
  }
  lastTurnCount = count;
  lastFirstTurn = first;
}

function onNewConversation(reason) {
  if (Date.now() < reinjectSuppressUntil) return; // 防抖：级联变更只触发一次
  reinjectSuppressUntil = Date.now() + REINJECT_SUPPRESS_MS;
  if (!protocolText) {
    log(`检测到新对话（${reason}）：尚无协议文本，跳过重新注入`);
    return;
  }
  log(`检测到新对话（${reason}）：排队重新注入协议文本`);
  reinjectPending = true; // 经投递循环执行（同普通回填消息）
}

// ---------- 启动 ----------

async function init() {
  const stored = await chrome.storage.sync.get([SETTINGS_KEY, PROTOCOL_KEY]).catch(() => ({}));
  const saved = stored[SETTINGS_KEY];
  if (saved && typeof saved === "object") {
    const { delayMinSec, delayMaxSec } = clampDelay(Number(saved.delayMinSec), Number(saved.delayMaxSec));
    // 旧版 segmentLen 单值迁移：以旧值 ±20 生成区间
    const legacy = Number(saved.segmentLen);
    const { segmentLenMin, segmentLenMax } = clampSegment(
      Number.isFinite(Number(saved.segmentLenMin)) ? Number(saved.segmentLenMin) : legacy - 20,
      Number.isFinite(Number(saved.segmentLenMax)) ? Number(saved.segmentLenMax) : legacy + 20,
    );
    settings = {
      ...defaultSettings,
      ...saved,
      baseUrl: normalizeBaseUrl(saved.baseUrl),
      delayMinSec,
      delayMaxSec,
      segmentLenMin,
      segmentLenMax,
      typoChance: clampTypoChance(Number(saved.typoChance)),
      speed: clampSpeed(Number(saved.speed)),
      autoMode: typeof saved.autoMode === "boolean" ? saved.autoMode : defaultSettings.autoMode,
      simulateTyping:
        typeof saved.simulateTyping === "boolean" ? saved.simulateTyping : defaultSettings.simulateTyping,
      autoApprove: typeof saved.autoApprove === "boolean" ? saved.autoApprove : defaultSettings.autoApprove,
      approvalTimeoutSec: clampApprovalTimeout(Number(saved.approvalTimeoutSec)),
    };
  }
  if (typeof stored[PROTOCOL_KEY] === "string" && stored[PROTOCOL_KEY].startsWith(PROTOCOL_PREFIX)) {
    protocolText = stored[PROTOCOL_KEY];
  }
  applySettingsToPanel();
  setupPanelEvents();
  setupNewConversationWatcher();
  setStatus("待命");
  log(`gemini-bridge v3 已就绪：桥服务 ${settings.baseUrl}，自动模式 ${settings.autoMode ? "开" : "关"}`);
  setupCaptureListener(); // 网络捕获接入：等 MAIN world 捕获消息（document_start 已发 hello，此处补 ping）
  deliveryLoop(); // 投递循环：长轮询取回填消息
}

init();
