// gemini-bridge v2 content script —— 网页对话驱动。
// 两个循环：
//   内容监控循环：AI Studio 最新模型回复 → 稳定采样 → POST /result {reply}
//   投递循环：长轮询 GET /task → 模拟人类逐字回填 → 自动/手动提交
// 选择器为 AI Studio 真实 DOM（2026-08-19 落定，task-13-brief 附录 A）。
// 页面是 Angular SPA + cdk-virtual-scroll：元素频繁创建/销毁，
// 所有抓取基于 MutationObserver 且每次现查 DOM，禁止缓存元素引用跨轮复用。
// 面板样式统一 ha-* 前缀，避免与页面样式冲突。

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const PROTOCOL_PREFIX = "【human-agent 工具协议】";
const STABLE_SAMPLES = 3; // 稳定采样次数（连续 2–3 次，取 3）
const SAMPLE_INTERVAL_MS = 700; // 采样间隔（500ms–1s 区间）
const TASK_RETRY_MS = 1_000; // GET /task 无消息后的重试间隔
const BRIDGE_RETRY_MIN_MS = 1_000; // 桥不可达时的初始重试间隔
const BRIDGE_RETRY_MAX_MS = 30_000; // 桥不可达时的重试间隔上限（指数退避）
const TYPING_MIN_MS = 120; // 纠错重打每字符延时下限（真人键入节奏 120–350ms/字）
const TYPING_MAX_MS = 350;
const TYPO_MAX = 2; // 每段最多错字数（模拟粘贴后纠错）
const PASTE_GAP_MIN_MS = 400; // 段间停顿下限（模拟人工粘贴节奏）
const PASTE_GAP_MAX_MS = 900; // 段间停顿上限
const BACKSPACE_MIN_MS = 120; // 退格延时下限（退格键点按间隔 120–320ms）
const BACKSPACE_MAX_MS = 320;
const CORRECT_PAUSE_MIN_MS = 600; // 纠错前停顿下限（发现错字→思考→开始修改）
const CORRECT_PAUSE_MAX_MS = 1_500;
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
  segmentLenMin: 25, // 分块长度下限（字符，每块在区间内随机，避免等长分段暴露自动化）
  segmentLenMax: 80, // 分块长度上限
  typoChance: 40, // 每段触发「粘贴错字→退格→重打」纠错的概率（%）
};

let settings = { ...defaultSettings };
let protocolText = ""; // 已保存的工具协议文本（新对话时重新注入）
let lastPostedReply = ""; // 最近一次回传的回复（避免无谓重发，服务侧亦去重）
let delivering = false; // 投递循环串行占用标志（同一时刻只回填一条消息）
let reinjectPending = false; // 待投递循环处理的协议重新注入
let reinjectSuppressUntil = 0; // 新对话触发防抖时间戳
let currentStatus = "待命";
let bridgeDown = false; // 桥服务不可达标志（进入置位、成功复位）
let bridgeRetryMs = BRIDGE_RETRY_MIN_MS; // 当前退避间隔
let settingsTimer = null; // 面板设置保存防抖

// ---------- 工具函数 ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  box-shadow: 0 4px 16px rgba(0,0,0,.35); user-select: none;
  max-height: 70vh; display: flex; flex-direction: column;
}
#ha-panel .ha-title { font-weight: 700; margin-bottom: 6px; }
#ha-panel .ha-badge {
  font-size: 10px; font-weight: 400; color: #9ca3af;
  border: 1px solid #4b5563; border-radius: 4px; padding: 0 4px; margin-left: 4px;
}
#ha-panel .ha-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
#ha-panel input[type="number"], #ha-panel input[type="text"] {
  background: #111; color: #e8e8e8; border: 1px solid #4b5563;
  border-radius: 4px; padding: 2px 6px; width: 56px; font: inherit;
}
#ha-panel input[type="text"] { width: 150px; flex: 1; }
#ha-panel input[type="checkbox"] { accent-color: #3b82f6; }
#ha-panel .ha-status {
  margin-top: 6px; padding: 4px 8px; border-radius: 6px;
  background: #111827; color: #93c5fd; border: 1px solid #374151;
}
#ha-panel .ha-status.ha-err { color: #fca5a5; border-color: #7f1d1d; }
#ha-panel .ha-log {
  margin-top: 6px; max-height: 160px; overflow-y: auto;
  border-top: 1px solid #333; padding-top: 6px; color: #b0b0b0;
  white-space: pre-wrap; word-break: break-all;
}
</style>
<div class="ha-title">gemini-bridge<span class="ha-badge">v2 网页对话驱动</span></div>
<label class="ha-row">
  <input type="checkbox" id="ha-auto-mode"> 自动模式（自动提交回填消息）
</label>
<label class="ha-row">
  <input type="checkbox" id="ha-simulate"> 模拟人类逐字输入
</label>
<div class="ha-row">
  <span>提交延迟</span>
  <input type="number" id="ha-delay-min" min="0" max="600" step="0.5">
  <span>~</span>
  <input type="number" id="ha-delay-max" min="0" max="600" step="0.5">
  <span>秒</span>
</div>
<div class="ha-row">
  <span>分块长度</span>
  <input type="number" id="ha-segment-min" min="10" max="500" step="10">
  <span>~</span>
  <input type="number" id="ha-segment-max" min="10" max="500" step="10">
  <span>字符</span>
</div>
<div class="ha-row">
  <span>纠错概率</span>
  <input type="number" id="ha-typo-chance" min="0" max="100" step="5">
  <span>%</span>
</div>
<div class="ha-row">
  <span>桥服务</span>
  <input type="text" id="ha-base-url" spellcheck="false" placeholder="http://127.0.0.1:8765">
</div>
<div class="ha-status" id="ha-status">待命</div>
<div class="ha-log" id="ha-log"></div>
`;
document.documentElement.appendChild(panel);

const statusEl = panel.querySelector("#ha-status");
const logEl = panel.querySelector("#ha-log");

function setStatus(text) {
  currentStatus = text;
  statusEl.textContent = text;
  statusEl.classList.toggle("ha-err", text === "错误" || text === "桥未连接（重试中）");
}

// 桥不可达降级：进入时状态切「桥未连接」并只记一条日志；返回本次退避间隔（调用方 sleep 后翻倍）
function noteBridgeFailure(errText) {
  if (!bridgeDown) {
    bridgeDown = true;
    setStatus("桥未连接（重试中）");
    log(`桥服务不可达：${errText}（${bridgeRetryMs / 1000}s 后重试）`);
  }
  return bridgeRetryMs;
}

function noteBridgeSuccess() {
  bridgeRetryMs = BRIDGE_RETRY_MIN_MS;
  if (bridgeDown) {
    bridgeDown = false;
    setStatus("待命");
    log("桥服务已连接");
  }
}

function log(text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  const lines = logEl.textContent ? logEl.textContent.split("\n") : [];
  lines.unshift(line);
  logEl.textContent = lines.slice(0, LOG_MAX_LINES).join("\n");
}

// ---------- 设置持久化（chrome.storage.sync） ----------

function clampSegment(min, max) {
  let lo = Number.isFinite(min) ? Math.min(500, Math.max(10, Math.round(min))) : defaultSettings.segmentLenMin;
  let hi = Number.isFinite(max) ? Math.min(500, Math.max(10, Math.round(max))) : defaultSettings.segmentLenMax;
  if (lo > hi) [lo, hi] = [hi, lo]; // 区间反转时对调
  return { segmentLenMin: lo, segmentLenMax: hi };
}

function clampTypoChance(v) {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : defaultSettings.typoChance;
}

function applySettingsToPanel() {
  panel.querySelector("#ha-auto-mode").checked = settings.autoMode;
  panel.querySelector("#ha-simulate").checked = settings.simulateTyping;
  panel.querySelector("#ha-delay-min").value = settings.delayMinSec;
  panel.querySelector("#ha-delay-max").value = settings.delayMaxSec;
  panel.querySelector("#ha-segment-min").value = settings.segmentLenMin;
  panel.querySelector("#ha-segment-max").value = settings.segmentLenMax;
  panel.querySelector("#ha-typo-chance").value = settings.typoChance;
  panel.querySelector("#ha-base-url").value = settings.baseUrl;
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

// A2/A3：最后一个内容轮且内部含模型角色的 turn
function findLastModelTurn() {
  const turns = document.querySelectorAll("ms-chat-turn.text-chunk-host");
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].querySelector('[data-turn-role="Model"]')) return turns[i];
  }
  return null;
}

// A2：提取模型回复文本（排除 ms-thought-chunk 思考摘要），拼接为 reply。
// 关键：AI Studio 把 markdown 代码块渲染成 ms-code-block（含 data-test-language 语言标记），
// innerText 只含代码内容、围栏被渲染器消费——必须把代码块还原为 ```lang 围栏文本，
// 否则回传给桥服务的内容丢失 ```tool_call 识别信号。
function extractReply(turn) {
  return [...turn.querySelectorAll("ms-text-chunk")]
    .map((chunk) => {
      const clone = chunk.cloneNode(true); // 克隆后替换，不影响页面
      for (const block of clone.querySelectorAll("ms-code-block")) {
        const lang = block.getAttribute("data-test-language") ?? "";
        const code = block.querySelector("pre code")?.textContent ?? "";
        const pre = document.createElement("pre");
        pre.textContent = `\`\`\`${lang}\n${code}\n\`\`\``;
        block.replaceWith(pre);
      }
      return clone.innerText.trim();
    })
    .filter(Boolean)
    .join("\n");
}

// A3：完成信号。announcer 的 "Response ready." 文本跨轮残留，
// 仅当它在本轮内容最后一次变化之后才转为 ready（上升沿时间戳晚于 lastContentChangeAt）才算完成信号；
// 残留的旧 ready 状态不生效，只依赖连续稳定采样计数。
let announcerPrevReady = false; // 上一轮采样时 announcer 是否已显示 "Response ready."
let announcerReadySince = 0; // 最近一次 announcer 转为 ready 的时间戳

function announcerReady(lastContentChangeAt) {
  const el = document.getElementById("cdk-live-announcer-0");
  const ready = Boolean(el && el.textContent.includes("Response ready."));
  if (ready && !announcerPrevReady) announcerReadySince = Date.now(); // 上升沿才刷新时间戳
  announcerPrevReady = ready;
  return ready && announcerReadySince > lastContentChangeAt;
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
  await sleep(randInt(CORRECT_PAUSE_MIN_MS, CORRECT_PAUSE_MAX_MS)); // 纠错前停顿：发现错字→思考→开始修改
  let all = Array.from(input.value); // 码点数组（避免代理对与 slice 偏移不一致）
  for (const f of [...fixes].sort((a, b) => b.pos - a.pos)) {
    const at = segStartCp + f.pos;
    all.splice(at, 1); // 退格删除错字
    input.value = all.join("");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    await sleep(randInt(BACKSPACE_MIN_MS, BACKSPACE_MAX_MS));
    all.splice(at, 0, f.correct); // 重打正确字符
    input.value = all.join("");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: f.correct }));
    await sleep(randInt(TYPING_MIN_MS, TYPING_MAX_MS));
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
    await sleep(randInt(300, 800)); // 初始停顿，模拟人类开始输入前的思考
    let segStartCp = 0;
    for (const seg of splitSegments(text, settings.segmentLenMin, settings.segmentLenMax)) {
      await pasteSegment(input, segStartCp, seg);
      segStartCp += [...seg].length; // 码点偏移（length 为 UTF-16 单位，非 BMP 字符会漂移）
      await sleep(randInt(PASTE_GAP_MIN_MS, PASTE_GAP_MAX_MS)); // 段间停顿
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

// ---------- 投递循环：GET /task → 模拟输入 → 自动/手动提交 ----------

async function deliverMessage(text, source) {
  delivering = true;
  try {
    setStatus(settings.simulateTyping ? "回填中（模拟粘贴）" : "回填中");
    log(`${source === "reinject" ? "重新注入协议文本" : "任务消息到达"}：${truncate(text.replace(/\n/g, " "), 80)}`);
    if (!(await typeIntoInput(text))) {
      setStatus("错误");
      log("未找到输入框（ms-prompt-box textarea），消息丢失——请确认页面在 AI Studio 对话页");
      return;
    }
    if (!settings.autoMode) {
      setStatus("待命");
      log("手动模式：已回填输入框，请点击页面发送按钮提交");
      return;
    }
    const delaySec = Math.round(randRange(settings.delayMinSec, settings.delayMaxSec) * 10) / 10;
    setStatus(`自动提交（${delaySec}s 后）`);
    await sleep(delaySec * 1000);
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
      // 新对话触发的协议重新注入优先于取任务，走同一投递流程
      if (reinjectPending) {
        reinjectPending = false;
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
        await sleep(noteBridgeFailure(resp.error));
        bridgeRetryMs = Math.min(bridgeRetryMs * 2, BRIDGE_RETRY_MAX_MS); // 指数退避
        continue;
      }
      noteBridgeSuccess();
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

// ---------- 内容监控循环：最新模型回复 → 稳定采样 → POST /result ----------

async function postResult(reply) {
  setStatus("已抓取回复（等待执行）");
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "submit-result", reply, baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { error: err instanceof Error ? err.message : String(err) };
  }
  if (resp?.error) {
    noteBridgeFailure(resp.error); // 桥不可达：静默降级，回复保留待桥恢复后重发
    return;
  }
  if (resp.ok) {
    noteBridgeSuccess();
    lastPostedReply = reply; // 仅成功回传才更新去重标记；失败时保持旧值，下轮采样继续重发
    log(`已回传回复（${reply.length} 字符，${resp.processed ? "已入队执行" : "服务侧忽略（无工具调用/重复）"}）`);
    if (!resp.processed) setStatus("待命");
    // processed 时保持「已抓取回复（等待执行）」，直到回填消息到达
  } else {
    setStatus("错误");
    log(`回传被拒：HTTP ${resp.status ?? "?"}`);
  }
}

async function monitorLoop() {
  let lastText = "";
  let stable = 0;
  let lastContentChangeAt = 0; // 当前内容最后一次变化的时间戳
  while (true) {
    try {
      const turn = findLastModelTurn();
      const text = turn ? extractReply(turn) : "";
      if (text !== "" && text === lastText) {
        stable += 1;
        if (announcerReady(lastContentChangeAt)) stable = STABLE_SAMPLES; // 完成信号可提前确认（A3）
      } else {
        stable = 0;
        lastText = text;
        lastContentChangeAt = Date.now();
      }
      if (stable >= STABLE_SAMPLES && text !== "" && text !== lastPostedReply) {
        stable = 0;
        await postResult(text);
      }
    } catch (err) {
      log(`监控循环异常：${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(SAMPLE_INTERVAL_MS);
  }
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
      autoMode: typeof saved.autoMode === "boolean" ? saved.autoMode : defaultSettings.autoMode,
      simulateTyping:
        typeof saved.simulateTyping === "boolean" ? saved.simulateTyping : defaultSettings.simulateTyping,
    };
  }
  if (typeof stored[PROTOCOL_KEY] === "string" && stored[PROTOCOL_KEY].startsWith(PROTOCOL_PREFIX)) {
    protocolText = stored[PROTOCOL_KEY];
  }
  applySettingsToPanel();
  setupPanelEvents();
  setupNewConversationWatcher();
  setStatus("待命");
  log(`gemini-bridge v2 已就绪：桥服务 ${settings.baseUrl}，自动模式 ${settings.autoMode ? "开" : "关"}`);
  deliveryLoop(); // 投递循环：长轮询取回填消息
  monitorLoop(); // 内容监控循环：最新回复 → POST /result
}

init();
