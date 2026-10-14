// gemini-bridge v0.4 content script —— 网页对话驱动。
// 零手抄：扩展不含任何工具名/键归一/条目构造——审批白名单按钮按载荷 task.options[i] 渲染、所选条目原样回显，
// 候选入库只发 {items, scope} 由桥服务物化条目并校验（wire v1：统一信封 + task/permission/agent 三面）。
// 回复回传走网络原文捕获（路线 A）：MAIN world inject.js 钩 GenerateContent 响应 → postMessage
// → 本脚本用 haDecodeGenerateContent（decode.js，同 content_scripts 数组先加载）解码 → POST /task/reply。
// 投递循环：长轮询 GET /task → 模拟人类逐字回填 → 自动/手动提交。
// 协议注入：GET /agent/protocol 按需拉取（无本地存储）；「新对话自动注入协议」开关（默认开）控制自动注入——
// 会话切换检测 = URL 轮询（/prompts/<id> ⇄ /prompts/new_chat 逐对话唯一），仅空对话页自动注入，
// 页面加载不自动检查（防刷新旧对话渲染期误判为空导致重放），面板按钮随时可手动注入（无条件）。
// 选择器为 AI Studio 真实 DOM（2026-08-19 落定，task-13-brief 附录 A）。
// 页面是 Angular SPA + cdk-virtual-scroll：元素频繁创建/销毁，
// 所有 DOM 抓取每次现查、禁止缓存元素引用跨轮复用。
// 面板样式统一 ha-* 前缀，避免与页面样式冲突。

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const TASK_RETRY_MS = 1_000; // GET /task 无消息后的重试间隔
const POLL_TICK_MS = 500; // 长轮询在途时的 tick 间隔（回顶重查队列/状态，手动按钮与切对话即时响应）
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
const HREF_POLL_MS = 400; // 会话地址轮询间隔（会话切换检测）
const LOG_MAX_LINES = 50;

const SETTINGS_KEY = "geminiBridgeSettings";

const defaultSettings = {
  baseUrl: DEFAULT_BASE_URL,
  autoMode: true,
  autoInject: true, // 新对话自动注入协议（仅空对话页自动拉取注入；关=只用面板按钮手动注入）
  simulateTyping: true,
  delayMinSec: 3,
  delayMaxSec: 8,
  segmentLenMin: 2, // 分块长度下限（字符，每块在区间内随机，避免等长分段暴露自动化）
  segmentLenMax: 1024, // 分块长度上限（正常文本回填尽量少分块）
  typoChance: 40, // 每段触发「粘贴错字→退格→重打」纠错的概率（%）
  speed: 1, // 回填速度倍率（0.5/1/2/4/10，回填过程中可即时修改）
  untrustedTier: "popup", // 未信任调用处置：popup 默认弹窗 / deny 默认拒绝 / allow 默认允许（黑名单三档一致直接拒绝）
  approvalTimeoutSec: 120, // 审批超时（秒），到点自动全部拒绝
};

const TIER_LABELS = { popup: "默认弹窗", deny: "默认拒绝", allow: "默认允许" };
let bridgeWorkspace = ""; // 当前桥工作区（GET /agent/info；仅面板显示，不持久化）

let settings = { ...defaultSettings };
let pendingInjectText = ""; // 已取得、待投递循环回填的协议文本（空串=无）
// 协议自动补投状态机（仅「新对话自动注入协议」开关开启时运行）：
// idle 待检查（新对话事件 / 开关打开时置位）/ wait-bridge 拉取失败待重试 / done 已了结。
// 初始 done：页面加载不自动检查——旧对话刷新时渲染未完成会被误判为空对话从而重放（事故护栏）。
let autoInjectState = "done";
let autoInjectWaitLogged = false; // 「容器存在但暂无消息」保守等待日志只记一次（新对话事件复位）
let delivering = false; // 投递循环串行占用标志（同一时刻只回填一条消息）
let inflightPoll = null; // 在途的 get-task 长轮询（跨 tick 保留，消费前不置空——返回的消息不丢）
let pendingTask = null; // 输入框未就绪时暂存的消息 {text, source}，就绪后补投
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
  width: 364px; max-width: calc(100vw - 32px); /* 固定宽度：容纳候选操作行（全选/粒度/入库/清除）的最小值 */
  height: 794px; max-height: min(794px, calc(100vh - 32px)); /* 固定高度：卡展开 + 重试按钮 + 档位警示的最坏态也不挤（含数像素余量） */
  padding: 10px 12px; border-radius: 10px;
  background: #1f1f1f; color: #e8e8e8; font: 12px/1.6 system-ui, sans-serif;
  border: 1px solid #4b5563; user-select: none;
  display: flex; flex-direction: column;
  overflow-y: auto; /* 固定尺寸 + 小窗口兜底滚动；常态下尺寸不随内容变化 */
  box-sizing: border-box; /* 尺寸含内边距/边框（页面若有全局 border-box 规则也不受其影响） */
  color-scheme: dark; /* 原生控件（数字 spinner、select 下拉、滚动条）走暗色绘制 */
}
#ha-panel > * { flex: none; } /* 高度流式：子项按内容定高、不随面板压缩（日志区单独控高） */
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
#ha-panel .ha-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
#ha-panel .ha-group-card {
  margin: 4px 0 6px; padding: 4px 8px 4px;
  background: #181818; border: 1px solid #333; border-radius: 6px;
}
#ha-panel .ha-group-card .ha-group-title {
  font-size: 11px; font-weight: 600; color: #9ca3af; margin: 2px 0 4px;
}
#ha-panel .ha-group-card .ha-row { margin: 3px 0; }
#ha-panel input[type="number"], #ha-panel input[type="text"], #ha-panel select {
  background: #111; color: #e8e8e8; border: 1px solid #4b5563;
  border-radius: 4px; padding: 2px 6px; width: 56px; font: inherit;
}
#ha-panel input[type="text"] { width: 150px; flex: 1; }
#ha-panel select { width: auto; } /* 宽度随最长选项（中文档位文本不再截断） */
#ha-panel #ha-untrusted-tier { flex: 1; }
#ha-panel input[type="checkbox"] { accent-color: #3b82f6; }
/* 按钮基底（与既有 .ha-log-bar/#ha-collapse 同款中性样式；各 id 规则按特异性覆盖） */
#ha-panel button {
  background: #111; color: #9ca3af; border: 1px solid #4b5563;
  border-radius: 4px; font: inherit; padding: 2px 8px; cursor: pointer;
}
#ha-panel button:hover { color: #e8e8e8; border-color: #6b7280; }
#ha-panel .ha-status {
  margin-top: 6px; padding: 4px 8px; border-radius: 6px;
  background: #111827; border: 1px solid #374151;
  color: var(--dot, #93c5fd);
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
#ha-panel .ha-status-dot {
  flex: none; width: 8px; height: 8px; border-radius: 50%;
  background: var(--dot, #3b82f6); box-shadow: 0 0 6px var(--dot, #3b82f6);
  animation: ha-pulse 1.8s ease-in-out infinite; /* 与悬浮球同款呼吸律动 */
}
#ha-panel #ha-retry {
  margin-top: 6px; width: 100%; background: #111; color: #fca5a5;
  border: 1px solid #7f1d1d; border-radius: 4px; padding: 4px 0;
  font: inherit; cursor: pointer;
}
#ha-panel #ha-retry:hover { border-color: #b91c1c; color: #fecaca; }
#ha-panel #ha-inject-protocol {
  margin-top: 6px; width: 100%; background: #111; color: #93c5fd;
  border: 1px solid #1d4ed8; border-radius: 4px; padding: 4px 0;
  font: inherit; cursor: pointer;
}
#ha-panel #ha-inject-protocol:hover { border-color: #2563eb; color: #bfdbfe; }
#ha-panel #ha-submit-now {
  margin-left: auto; background: #111; color: #93c5fd;
  border: 1px solid #1d4ed8; border-radius: 4px; padding: 1px 8px;
  font: inherit; font-size: 11px; cursor: pointer; flex: none;
}
#ha-panel #ha-submit-now:hover { border-color: #2563eb; color: #bfdbfe; }
#ha-panel #ha-submit-now:disabled {
  color: #6b7280; border-color: #374151; background: #161616;
  cursor: not-allowed; opacity: .6;
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
#ha-panel > .ha-log {
  flex: 1 1 auto; min-height: 72px; /* 弹性填充剩余空间；候选区展开/重试出现时让位（面板整体不动） */
  margin-top: 4px; overflow-y: auto;
  border-top: 1px solid #333; padding-top: 6px; color: #b0b0b0;
  white-space: pre-wrap; word-break: break-all;
  contain: inline-size; /* 长行不撑宽面板 */
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
.ha-tier-label, .ha-tier-warning { flex: none; white-space: nowrap; } /* 中文可逐字折断：禁止收缩换行，让弹性给 select */
.ha-tier-warning { color: #fbbf24; font-size: 12px; width: 14px; text-align: center; cursor: default; }
.ha-tier-warning.ha-tier-off { visibility: hidden; } /* 非默认允许档：占位不显示——三档下拉宽度恒定 */
.ha-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; contain: inline-size; }
#ha-workspace { direction: rtl; }
.ha-fold { border: 1px solid #374151; border-radius: 6px; margin-top: 6px; }
.ha-fold-head { display: flex; width: 100%; align-items: center; gap: 6px; background: none; border: none; color: #e8e8e8; font: inherit; padding: 5px 8px; cursor: pointer; }
.ha-fold-count { color: #9ca3af; }
.ha-fold-arrow { margin-left: auto; }
.ha-fold-ops { display: flex; align-items: center; gap: 6px; padding: 4px 8px; flex-wrap: wrap; }
.ha-fold-list { max-height: 60px; overflow-y: auto; padding: 0 8px 6px; contain: inline-size; } /* 两卡同帽：最坏态（卡展开+重试+警示）零溢出 */
.ha-fold-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; font-size: 12px; }
.ha-cand-tool { color: #93c5fd; flex: none; }
.ha-cand-key { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ha-cand-counts { color: #9ca3af; flex: none; }
.ha-wl-scope { color: #9ca3af; flex: none; font-size: 11px; border: 1px solid #374151; border-radius: 3px; padding: 0 4px; }
/* 折叠卡操作按钮：入库=蓝（主操作）、清除/撤销=红（破坏性），与既有按钮色调词汇一致 */
#ha-panel #ha-cand-add { color: #93c5fd; border-color: #1d4ed8; }
#ha-panel #ha-cand-add:hover { border-color: #2563eb; color: #bfdbfe; }
#ha-panel #ha-cand-dismiss { color: #fca5a5; border-color: #7f1d1d; }
#ha-panel #ha-cand-dismiss:hover { border-color: #b91c1c; color: #fecaca; }
#ha-panel #ha-wl-revoke { color: #fca5a5; border-color: #7f1d1d; }
#ha-panel #ha-wl-revoke:hover { border-color: #b91c1c; color: #fecaca; }
/* 统一悬浮气泡：data-ha-tip 承载文本，深色主题与面板一致（替代原生白底 title） */
.ha-tip {
  position: fixed; z-index: 2147483647; max-width: 280px;
  background: #111; color: #e8e8e8; border: 1px solid #4b5563;
  border-radius: 6px; padding: 4px 8px; font: 12px/1.6 system-ui, sans-serif;
  box-shadow: 0 4px 12px rgba(0,0,0,.55); pointer-events: none;
  white-space: normal; word-break: break-word; color-scheme: dark;
}
</style>
<div class="ha-title">
  <span>gemini-bridge<span class="ha-badge">v0.4 网页对话驱动</span></span>
  <button id="ha-collapse" data-ha-tip="收起为悬浮球">–</button>
</div>
<div class="ha-group-card">
  <div class="ha-group-title">自动模式</div>
  <div class="ha-row">
    <label><input type="checkbox" id="ha-auto-mode"> 自动提交回填消息</label>
    <button id="ha-submit-now" data-ha-tip="立即提交输入框当前内容（非空即提交，无论内容来源；回填进行中暂不可用）">立即提交</button>
  </div>
  <div class="ha-row">
    <label><input type="checkbox" id="ha-auto-inject"> 新对话自动注入协议</label>
  </div>
  <div class="ha-row">
    <span class="ha-tier-label">未信任处置</span>
    <select id="ha-untrusted-tier" data-ha-tip="未信任（黑名单/白名单外）调用的去向；黑名单三档一致直接拒绝">
      <option value="popup">默认弹窗（逐条授权）</option>
      <option value="deny">默认拒绝（无人值守推荐）</option>
      <option value="allow">默认允许（仅黑名单拦截）</option>
    </select>
    <span id="ha-tier-warning" class="ha-tier-warning ha-tier-off" data-ha-tip="默认允许档仅靠黑名单兜底：未信任调用除黑名单命中外一律放行">⚠</span>
  </div>
</div>
<div class="ha-row">
  <label><input type="checkbox" id="ha-simulate"> 模拟人类逐字输入</label>
</div>
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
  <select id="ha-speed" data-ha-tip="回填过程中修改立即生效（分块长度已切分，本次不变）">
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
<div class="ha-row">
  <span>工作区</span>
  <span id="ha-workspace" class="ha-value" data-ha-tip="">（未获取）</span>
</div>
<button id="ha-inject-protocol" data-ha-tip="手动把工具协议（规则）文本填入输入框（自动提交开=填好后自动提交）">填入规则文本</button>
<div class="ha-fold">
  <button id="ha-cand-toggle" class="ha-fold-head" data-ha-tip="白名单外裁决的持久记录：默认拒绝档=补种清单，默认允许档=放行审计">
    信任候选 <span id="ha-cand-count" class="ha-fold-count">(0)</span><span class="ha-fold-arrow">▸</span>
  </button>
  <div class="ha-fold-body" id="ha-cand-body" hidden>
    <div class="ha-fold-ops">
      <button id="ha-cand-all">全选</button>
      <span>粒度</span>
      <select id="ha-cand-gran" data-ha-tip="入库粒度：此路径=仅目标自身（self）/ 此目录=目标所在子树（subtree）；桥服务按工具类型校验并物化条目">
        <option value="self">此路径</option>
        <option value="subtree">此目录</option>
      </select>
      <button id="ha-cand-add">入库所选 (0)</button>
      <button id="ha-cand-dismiss">清除所选</button>
    </div>
    <div class="ha-fold-list" id="ha-cand-list"></div>
  </div>
</div>
<div class="ha-fold">
  <button id="ha-wl-toggle" class="ha-fold-head" data-ha-tip="当前工作区已信任条目；撤销立即生效（工作区条目会在桥服务重启时重建）">
    白名单 <span id="ha-wl-count" class="ha-fold-count">(0)</span><span class="ha-fold-arrow">▸</span>
  </button>
  <div class="ha-fold-body" id="ha-wl-body" hidden>
    <div class="ha-fold-ops">
      <button id="ha-wl-all">全选</button>
      <button id="ha-wl-revoke">撤销所选 (0)</button>
    </div>
    <div class="ha-fold-list" id="ha-wl-list"></div>
  </div>
</div>
<div class="ha-status" id="ha-status"><span id="ha-status-text">待命</span><span class="ha-status-dot" data-ha-tip="状态指示灯"></span></div>
<button id="ha-retry" hidden>手动重试</button>
<div class="ha-log-bar">
  <button id="ha-log-export" data-ha-tip="导出日志为文本文件">导出</button>
  <button id="ha-log-clear" data-ha-tip="清除日志">清除</button>
</div>
<div class="ha-log" id="ha-log"></div>
`;
document.documentElement.appendChild(panel);

// 悬浮球：面板收起后的最小形态（状态圆点），双击展开完整面板
const ball = document.createElement("div");
ball.id = "ha-ball";
ball.setAttribute("data-ha-tip", "双击展开面板");
ball.innerHTML = `<span class="ha-dot" id="ha-ball-dot"></span>`;
document.documentElement.appendChild(ball);

// 统一悬浮气泡：委托监听 [data-ha-tip]，面板上方展示、越界翻转、视口夹取（替代原生白底 title）
const tip = document.createElement("div");
tip.className = "ha-tip";
tip.hidden = true;
document.documentElement.appendChild(tip);
document.addEventListener("mouseover", (e) => {
  const t = e.target;
  const el = t && typeof t.closest === "function" ? t.closest("[data-ha-tip]") : null;
  const text = el && el.getAttribute("data-ha-tip");
  if (!text) { tip.hidden = true; return; }
  tip.textContent = text;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const b = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - b.width / 2;
  left = Math.max(8, Math.min(left, innerWidth - b.width - 8));
  const above = r.top - b.height - 6;
  tip.style.left = `${left}px`;
  tip.style.top = `${above >= 8 ? above : r.bottom + 6}px`;
});
document.addEventListener("mouseout", (e) => {
  const t = e.target;
  const el = t && typeof t.closest === "function" ? t.closest("[data-ha-tip]") : null;
  if (!el) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return; // 在自身子节点间移动不隐藏
  tip.hidden = true;
});
document.addEventListener("mousedown", () => { tip.hidden = true; });
window.addEventListener("scroll", () => { tip.hidden = true; }, true);

const statusEl = panel.querySelector("#ha-status");
const statusTextEl = panel.querySelector("#ha-status-text");
const logEl = panel.querySelector("#ha-log");
const ballDot = ball.querySelector("#ha-ball-dot");
const submitNowBtn = panel.querySelector("#ha-submit-now");
const retryBtn = panel.querySelector("#ha-retry");

// 手动重试：重置计数并唤醒挂起的投递循环
retryBtn.addEventListener("click", () => {
  retryBtn.hidden = true;
  bridgeFailCount = 0;
  bridgeDown = false;
  setStatus("待命");
  log("手动重试：重新连接桥服务…");
  if (autoInjectState === "wait-bridge") {
    autoInjectState = "idle"; // 手动重试后重走协议拉取检查
    log("协议自动补投：将重试拉取");
  }
  if (manualRetryResolve) {
    manualRetryResolve();
    manualRetryResolve = null;
  }
});

// 手动填入规则文本：从桥服务按需拉取（GET /agent/protocol）→ 排队注入（跟随自动提交）
const injectProtocolBtn = panel.querySelector("#ha-inject-protocol");
injectProtocolBtn.addEventListener("click", async () => {
  if (pendingInjectText) {
    log("填入规则文本：已在排队等待注入，无需重复");
    return;
  }
  injectProtocolBtn.disabled = true;
  log("填入规则文本：正在从桥服务拉取协议文本…");
  const got = await fetchProtocolText();
  injectProtocolBtn.disabled = false;
  if (got.error) {
    log(`填入规则文本：拉取失败（${got.error}）`);
    return;
  }
  autoInjectState = "done"; // 手动注入即视为本页自动补投已了结，避免与自动检查两路同时注入
  pendingInjectText = got.text;
  log(`填入规则文本：已取得协议文本（${got.text.length} 字符），排队注入`);
});

const TONE_CLASSES = [
  "ha-tone-idle", "ha-tone-ready", "ha-tone-busy",
  "ha-tone-go", "ha-tone-wait", "ha-tone-warn", "ha-tone-err",
];

// 状态 → 色调：面板状态栏与悬浮球圆点共用一套
// 状态标准（跨网页通用：描述「捕获 → 后端执行 → 回填 → 提交」桥流水线，与具体前端无关；
// 将来接 ChatGPT 等其他网页复用同一套，自动/手动的差异只体现在「待提交」阶段的渲染上）：
// 待命（蓝·静息）→ 回填中（橙）→ 待提交（绿：自动=倒计时 / 手动=「待提交（手动发送）」）
// → 等待回复（紫：请求发出即置位，原文到手结束）→ 已抓取回复（等待执行）（青：后端处理）→ 回填中（下一轮）
// 横向：等待授权 / 桥未连接（琥珀）、错误（红，投递循环空闲时清回待命）
function statusTone(text) {
  if (text === "错误") return "ha-tone-err";
  if (text === "桥未连接" || text === "桥未连接（重试中）") return "ha-tone-warn";
  if (text === "等待授权") return "ha-tone-warn";
  if (text.includes("回填中")) return "ha-tone-busy";
  if (text.includes("自动提交") || text.includes("待提交")) return "ha-tone-go";
  if (text.includes("等待回复")) return "ha-tone-wait";
  if (text.includes("已抓取")) return "ha-tone-ready";
  return "ha-tone-idle";
}

function setStatus(text) {
  currentStatus = text;
  statusTextEl.textContent = text; // 写内层文本节点：状态元素还挂着右侧呼吸灯
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
    if (autoInjectState === "wait-bridge") {
      autoInjectState = "idle"; // 拉取失败期间桥已恢复：重试自动补投
      log("协议自动补投：桥服务可用，将重试拉取");
    }
    void refreshWorkspace(); // 连接恢复补拉工作区（幂等：已有值则直接返回）
  }
}

// 挂起投递循环直到手动重试按钮被点击
function waitForManualRetry() {
  return new Promise((resolve) => {
    manualRetryResolve = resolve;
  });
}

// 从桥服务按需拉取协议文本（GET /agent/protocol，经 background 中继）；返回 {text} 或 {error}
async function fetchProtocolText() {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "get-protocol", baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
  }
  if (resp?.status === "ok") {
    const protocol = resp.data?.protocol;
    if (typeof protocol === "string" && protocol !== "") return { text: protocol };
    return { error: "协议文本为空" };
  }
  const error = resp?.error;
  if (error?.code === "unknown-endpoint") {
    return { error: "桥服务无 /agent/protocol 端点（旧版本），请重启桥服务加载新代码" };
  }
  return { error: error?.message ?? "协议文本为空" };
}

// 桥工作区（GET /agent/info）：仅面板显示；已取得则不重复拉取，失败静默（桥未就绪时启动即拉，连接成功后补拉）
async function refreshWorkspace() {
  if (bridgeWorkspace !== "") return;
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "get-info", baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
  }
  const workspace = resp?.status === "ok" ? resp.data?.workspace : null;
  if (typeof workspace === "string" && workspace !== "") {
    bridgeWorkspace = workspace;
    const el = panel.querySelector("#ha-workspace");
    el.textContent = bridgeWorkspace;
    el.setAttribute("data-ha-tip", bridgeWorkspace);
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
  panel.querySelector("#ha-auto-inject").checked = settings.autoInject;
  panel.querySelector("#ha-simulate").checked = settings.simulateTyping;
  panel.querySelector("#ha-delay-min").value = settings.delayMinSec;
  panel.querySelector("#ha-delay-max").value = settings.delayMaxSec;
  panel.querySelector("#ha-segment-min").value = settings.segmentLenMin;
  panel.querySelector("#ha-segment-max").value = settings.segmentLenMax;
  panel.querySelector("#ha-typo-chance").value = settings.typoChance;
  panel.querySelector("#ha-speed").value = settings.speed;
  panel.querySelector("#ha-base-url").value = settings.baseUrl;
  panel.querySelector("#ha-untrusted-tier").value = settings.untrustedTier;
  panel.querySelector("#ha-tier-warning").classList.toggle("ha-tier-off", settings.untrustedTier !== "allow");
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
    log(`自动提交回填消息：${settings.autoMode ? "开" : "关"}`);
  });
  // 立即提交：无条件手动动作（点击即授权）——输入框非空就点页面发送，无论内容是回填还是用户自输入；
  // 回填进行中按钮被禁用（deliverMessage 置灰），点击事件不会到达这里
  panel.querySelector("#ha-submit-now").addEventListener("click", async () => {
    const input = findInput();
    if (!input || !input.value.trim()) {
      log("立即提交：输入框为空，无需提交");
      return;
    }
    if (await clickSendWhenReady()) {
      setStatus("等待回复");
      log("已提交（立即提交），等待回复…");
    } else {
      setStatus("待提交（手动发送）");
      log("未找到发送按钮且 Ctrl+Enter 回退失败，请手动提交");
    }
  });
  panel.querySelector("#ha-auto-inject").addEventListener("change", (e) => {
    settings.autoInject = e.target.checked;
    scheduleSaveSettings();
    if (settings.autoInject) {
      autoInjectState = "idle"; // 打开开关即检查当前对话（空对话页才会实际注入）
      autoInjectWaitLogged = false;
      log("新对话自动注入协议：开（将检查当前对话的协议补投）");
    } else {
      log("新对话自动注入协议：关（需要时点「填入规则文本」手动注入）");
    }
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
  panel.querySelector("#ha-untrusted-tier").addEventListener("change", (e) => {
    settings.untrustedTier = ["popup", "deny", "allow"].includes(e.target.value) ? e.target.value : "popup";
    applySettingsToPanel();
    scheduleSaveSettings();
    log(`未信任处置：${TIER_LABELS[settings.untrustedTier]}`);
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
  panel.querySelector("#ha-cand-toggle").addEventListener("click", () => {
    toggleFold(0, refreshCandidates); // 展开时刷新
  });
  panel.querySelector("#ha-wl-toggle").addEventListener("click", () => {
    toggleFold(1, refreshWhitelist); // 展开时刷新
  });
  panel.querySelector("#ha-cand-all").addEventListener("click", () => {
    const boxes = [...panel.querySelectorAll("#ha-cand-list input[type=checkbox]")];
    const target = boxes.some((b) => !b.checked);
    for (const b of boxes) b.checked = target;
    updateAddButton();
  });
  panel.querySelector("#ha-wl-all").addEventListener("click", () => {
    const boxes = [...panel.querySelectorAll("#ha-wl-list input[type=checkbox]")];
    const target = boxes.some((b) => !b.checked);
    for (const b of boxes) b.checked = target;
    updateRevokeButton();
  });
  panel.querySelector("#ha-cand-add").addEventListener("click", async () => {
    const rows = checkedCandidateRows();
    if (rows.length === 0) {
      log("信任候选：未选择任何行");
      return;
    }
    const scope = panel.querySelector("#ha-cand-gran").value; // self / subtree：桥服务按工具类型校验并物化条目
    const items = rows.map((r) => ({ tool: r.tool, key: r.key }));
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "whitelist-add", items, scope, baseUrl: settings.baseUrl });
    } catch (err) {
      resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
    }
    if (resp?.status === "ok") {
      const grants = Array.isArray(resp.data?.grants) ? resp.data.grants : [];
      const counts = { added: 0, duplicate: 0, covered: 0, rejected: 0 };
      for (const grant of grants) {
        const status = grant?.add?.status;
        if (Object.hasOwn(counts, status)) counts[status] += 1;
      }
      log(
        `信任候选：提交 ${items.length} 条 → 新增 ${counts.added} / 重复 ${counts.duplicate} / ` +
          `已被覆盖 ${counts.covered} / 被拒 ${counts.rejected}`,
      );
      void refreshCandidates();
      void refreshWhitelist(); // 新增条目同步到白名单卡（计数徽标即时更新）
    } else if (resp?.error?.code === "bridge-unreachable") {
      noteBridgeFailure(resp.error.message);
    } else {
      log(`信任候选入库失败：${resp?.error?.message ?? "未知错误"}`); // 桥侧 400 的 message 直接呈现
    }
  });
  panel.querySelector("#ha-cand-dismiss").addEventListener("click", async () => {
    const items = checkedCandidateRows();
    if (items.length === 0) {
      log("信任候选：未选择任何行");
      return;
    }
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "candidates-dismiss", items, baseUrl: settings.baseUrl });
    } catch (err) {
      resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
    }
    if (resp?.status === "ok") {
      log(`信任候选：清除 ${resp.data?.dropped ?? 0} 条`);
      void refreshCandidates();
    } else if (resp?.error?.code === "bridge-unreachable") {
      noteBridgeFailure(resp.error.message);
    } else {
      log(`信任候选清除失败：${resp?.error?.message ?? "未知错误"}`);
    }
  });
  panel.querySelector("#ha-wl-revoke").addEventListener("click", async () => {
    const items = checkedWlRows();
    if (items.length === 0) {
      log("白名单：未选择任何行");
      return;
    }
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "whitelist-revoke", items, baseUrl: settings.baseUrl });
    } catch (err) {
      resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
    }
    if (resp?.status === "ok") {
      const revoked = Array.isArray(resp.data?.revoked) ? resp.data.revoked.length : 0;
      log(`白名单：已撤销 ${revoked} 条`);
      void refreshWhitelist();
    } else if (resp?.error?.code === "bridge-unreachable") {
      noteBridgeFailure(resp.error.message);
    } else {
      log(`白名单撤销失败：${resp?.error?.message ?? "未知错误"}`);
    }
  });
}

// 折叠卡手风琴：同时只展开一张（打开一张自动收起另一张；箭头随开合翻转）
const foldCards = [
  { body: "#ha-cand-body", arrow: "#ha-cand-toggle .ha-fold-arrow" },
  { body: "#ha-wl-body", arrow: "#ha-wl-toggle .ha-fold-arrow" },
];

function toggleFold(index, onExpand) {
  const willOpen = panel.querySelector(foldCards[index].body).hidden;
  foldCards.forEach((card, i) => {
    const open = i === index && willOpen;
    panel.querySelector(card.body).hidden = !open;
    panel.querySelector(card.arrow).textContent = open ? "▾" : "▸";
  });
  if (willOpen) void onExpand(); // 展开时刷新
}

// ---------- AI Studio DOM 操作（每次现查，禁止缓存跨轮复用） ----------

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

// ---------- 审批：未信任调用授权（弹窗/三档代答）→ POST /task/approval ----------

async function postApproval(payload) {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "approve", ...payload, baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
  }
  if (resp?.status === "ok") return true;
  const error = resp?.error ?? { code: "internal", message: "未知错误" };
  if (error.code === "unknown-approval") {
    log(`审批结果提交：${error.message}`); // 桥侧未受理（如已按超时兜底拒绝）：显示服务端 message，流程继续
    return true;
  }
  if (error.code === "bridge-unreachable") noteBridgeFailure(error.message);
  else log(`审批结果提交失败：${error.message}`);
  return false;
}

async function handleApproval(item) {
  if (settings.untrustedTier === "allow") {
    // 默认允许档：策略代答放行（桥不感知档位——同一回执通道）
    log(`默认允许档：放行 ${item.calls.length} 条未信任调用`);
    if (!(await postApproval({ id: item.id, allowed: item.calls.map(() => true) }))) setStatus("错误");
    log(`[信任候选] +${item.calls.length}（默认允许）`);
    void refreshCandidates();
    return;
  }
  if (settings.untrustedTier === "deny") {
    // 默认拒绝档：策略代答拒绝（即时回决，无弹窗倒计时空耗）
    log(`默认拒绝档：拒绝 ${item.calls.length} 条未信任调用`);
    if (!(await postApproval({ id: item.id, allowed: item.calls.map(() => false) }))) setStatus("错误");
    log(`[信任候选] +${item.calls.length}（默认拒绝）`);
    void refreshCandidates();
    return;
  }
  setStatus("等待授权");
  log(`收到审批请求（${item.calls.length} 条未信任调用），等待授权…`);
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
  log(`[信任候选] +${item.calls.length - wl.length}（默认弹窗）`);
  void refreshCandidates();
  if (wl.length > 0) void refreshWhitelist(); // 弹窗内加白的条目同步到白名单卡
}

let candRows = []; // 最近一次拉取的候选列表

function checkedCandidateRows() {
  return [...panel.querySelectorAll("#ha-cand-list input[type=checkbox]:checked")].map((el) => ({
    tool: el.dataset.tool,
    key: el.dataset.key,
  }));
}

function updateAddButton() {
  const n = checkedCandidateRows().length;
  panel.querySelector("#ha-cand-add").textContent = `入库所选 (${n})`;
}

function renderCandidates(list) {
  candRows = list;
  panel.querySelector("#ha-cand-count").textContent = `(${list.length})`;
  const host = panel.querySelector("#ha-cand-list");
  host.textContent = "";
  for (const c of list) {
    const row = document.createElement("label");
    row.className = "ha-fold-row";
    row.setAttribute("data-ha-tip", `${c.tool} ${c.key}`);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.tool = c.tool;
    input.dataset.key = c.key;
    input.addEventListener("change", updateAddButton);
    const tool = document.createElement("span");
    tool.className = "ha-cand-tool";
    tool.textContent = c.tool;
    const key = document.createElement("span");
    key.className = "ha-cand-key";
    key.textContent = c.key;
    const counts = document.createElement("span");
    counts.className = "ha-cand-counts";
    counts.textContent = `拒 ${c["deny-count"] ?? 0} / 放 ${c["allow-count"] ?? 0}`;
    row.append(input, tool, key, counts);
    host.appendChild(row);
  }
  updateAddButton();
}

// 拉取方语义：展开时 + 操作后拉取；桥不推送（未展开时也顺带更新计数徽标）
async function refreshCandidates() {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "get-candidates", baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
  }
  if (resp?.status === "ok") {
    renderCandidates(Array.isArray(resp.data?.candidates) ? resp.data.candidates : []);
    return;
  }
  const error = resp?.error;
  if (!error) return;
  if (error.code === "bridge-unreachable") {
    noteBridgeFailure(error.message);
  } else if (error.code === "unknown-endpoint") {
    log(`信任候选拉取失败：${error.message}（桥服务可能为旧版本，请重启加载新代码）`);
  } else {
    log(`信任候选拉取失败：${error.message}`);
  }
}

// ---------- 白名单卡（查看 + 撤销；条目三字段原样回显，扩展不感知工具语义） ----------

let wlRows = []; // 最近一次拉取的白名单条目

function checkedWlRows() {
  return [...panel.querySelectorAll("#ha-wl-list input[type=checkbox]:checked")].map((el) => ({
    tool: el.dataset.tool,
    key: el.dataset.key,
    scope: el.dataset.scope,
  }));
}

function updateRevokeButton() {
  const n = checkedWlRows().length;
  panel.querySelector("#ha-wl-revoke").textContent = `撤销所选 (${n})`;
}

function renderWhitelist(list) {
  wlRows = list;
  panel.querySelector("#ha-wl-count").textContent = `(${list.length})`;
  const host = panel.querySelector("#ha-wl-list");
  host.textContent = "";
  for (const entry of list) {
    const row = document.createElement("label");
    row.className = "ha-fold-row";
    row.setAttribute("data-ha-tip", `${entry.tool} ${entry.key}`);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.tool = entry.tool;
    input.dataset.key = entry.key;
    input.dataset.scope = entry.scope;
    input.addEventListener("change", updateRevokeButton);
    const tool = document.createElement("span");
    tool.className = "ha-cand-tool";
    tool.textContent = entry.tool;
    const key = document.createElement("span");
    key.className = "ha-cand-key";
    key.textContent = entry.key;
    row.append(input, tool, key);
    if (entry.scope === "subtree") {
      const tag = document.createElement("span");
      tag.className = "ha-wl-scope";
      tag.textContent = "目录";
      tag.setAttribute("data-ha-tip", "子树条目：覆盖该目录下全部路径");
      row.append(tag);
    }
    host.appendChild(row);
  }
  updateRevokeButton();
}

// 拉取方语义：展开时 + 入库/撤销/审批加白后刷新；桥不推送（未展开时也顺带更新计数徽标）
async function refreshWhitelist() {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "get-whitelist", baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
  }
  if (resp?.status === "ok") {
    renderWhitelist(Array.isArray(resp.data?.entries) ? resp.data.entries : []);
    return;
  }
  const error = resp?.error;
  if (!error) return;
  if (error.code === "bridge-unreachable") {
    noteBridgeFailure(error.message);
  } else if (error.code === "unknown-endpoint") {
    log(`白名单拉取失败：${error.message}（桥服务可能为旧版本，请重启加载新代码）`);
  } else {
    log(`白名单拉取失败：${error.message}`);
  }
}

// 审批提示语由载荷选项数量驱动（零手抄：扩展不感知工具语义，不出现任何工具名）
function approvalHint(optionCount) {
  if (optionCount >= 2) return "未信任调用：可授权本次，或将此路径/此目录加入白名单后自动放行";
  if (optionCount === 1) return "未信任调用：可授权本次，或加入白名单后自动放行";
  return "未信任调用（无法生成白名单条目）：请确认后授权";
}

// 审批参数展示（零手抄：不读特定参数键）：唯一字符串值直显（命令/路径等主参数），否则回退 JSON。
function approvalArgsText(args) {
  const values = args !== null && typeof args === "object" ? Object.values(args) : [];
  if (values.length === 1 && typeof values[0] === "string") return values[0];
  if (args === undefined) return "";
  return JSON.stringify(args);
}

// 审批弹窗：遮罩 + 居中卡片；逐条 [允许][拒绝] + 白名单按钮（按载荷选项渲染）+ 全部允许/全部拒绝；
// 白名单按钮是显式动作：选项条目原样回显并入本次提交的 whitelist 数组并自动勾选该条允许（弹窗保持打开，可继续处理其余行）；
// 顶部倒计时按面板审批超时配置，到点自动全部拒绝（白名单条目一并撤销，保证载荷与 allowed 一致；全部允许不自动填白名单）。
function showApprovalDialog(item) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ha-approval-overlay";
    const box = document.createElement("div");
    box.className = "ha-approval-box";
    const secondsLeft = { value: settings.approvalTimeoutSec };
    const optionsByCall = Array.isArray(item.options) ? item.options : [];
    const rows = item.calls
      .map(
        (call, i) => `
      <div class="ha-approval-row" data-i="${i}">
        <div class="ha-approval-cmd">${escapeHtml(approvalArgsText(call.arguments))}</div>
        <div class="ha-approval-hint">${escapeHtml(
          approvalHint(Array.isArray(optionsByCall[i]) ? optionsByCall[i].length : 0),
        )}</div>
        <div class="ha-approval-btns">
          <button class="ha-allow" data-i="${i}">允许</button>
          <button class="ha-deny" data-i="${i}">拒绝</button>
        </div>
      </div>`,
      )
      .join("");
    box.innerHTML = `
      <div class="ha-approval-title">工具调用授权 <span class="ha-approval-count" id="ha-approval-count"></span></div>
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

    // 白名单按钮按载荷选项渲染（零手抄）：两项 → [白名单(此路径)] [白名单(此目录)]；一项 → [白名单]；零项 → 无按钮。
    // 点击 = 该条允许且所选选项条目原样回显（条目由桥侧预构造，回执按批校验成员资格）
    [...box.querySelectorAll(".ha-approval-row")].forEach((row, index) => {
      const options = Array.isArray(optionsByCall[index]) ? optionsByCall[index] : [];
      const labels = options.length === 2 ? ["白名单(此路径)", "白名单(此目录)"] : options.map(() => "白名单");
      const rowActions = row.querySelector(".ha-approval-btns");
      options.forEach((option, k) => {
        const wlBtn = document.createElement("button");
        wlBtn.textContent = labels[k];
        wlBtn.className = "ha-btn ha-btn-wl";
        wlBtn.onclick = () => {
          decisions[index] = true; // 白名单即允许
          whitelist[index] = option; // 原样回显
          refreshRow(row, index);
        };
        rowActions.appendChild(wlBtn);
      });
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

// 「立即提交」可用性：输入框为空（或不存在）→ 禁用；回填期间跳过（由 deliverMessage 控制禁用）。
// 轮询而非监听/观察器：输入框元素随页面渲染频繁重建，观察器路线此前已裁定删除（轮询是房子风格）。
function updateSubmitNowState() {
  if (delivering) return;
  const input = findInput();
  submitNowBtn.disabled = !input || !input.value.trim();
}

async function deliverMessage(text, source) {
  delivering = true;
  submitNowBtn.disabled = true; // 回填进行中禁用「立即提交」：防发出半截消息（倒计时阶段同禁，防重复提交）
  try {
    setStatus(settings.simulateTyping ? "回填中（模拟粘贴）" : "回填中");
    log(`${source === "reinject" ? "协议文本注入" : "任务消息到达"}：${truncate(text.replace(/\n/g, " "), 80)}`);
    if (!(await typeIntoInput(text))) {
      setStatus("待命");
      pendingTask = { text, source }; // 输入框未就绪：消息暂存待补投，不丢弃
      log("输入框未就绪（ms-prompt-box textarea），消息已暂存，页面就绪后自动补投");
      return;
    }
    if (!settings.autoMode) {
      setStatus("待提交（手动发送）");
      log("自动提交未开：已回填输入框，请点击页面发送按钮提交");
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
      setStatus("待提交（手动发送）");
      log("延迟期间自动提交已关闭，跳过提交（请在输入框手动发送）");
      return;
    }
    if (await clickSendWhenReady()) {
      setStatus("等待回复");
      log("已提交，等待回复…");
    } else {
      setStatus("待提交（手动发送）"); // 消息已在输入框，等待用户手动发送（与手动模式同一阶段状态）
      log("未找到发送按钮且 Ctrl+Enter 回退失败，请手动提交");
    }
  } finally {
    delivering = false;
    updateSubmitNowState(); // 按输入框实际状态恢复（提交后页面可能已清空输入框，而非无条件启用）
  }
}

// 长轮询 tick 化：get-task 在途时每 POLL_TICK_MS 回到循环顶重查队列/状态，
// 手动按钮与新对话检查即时响应；in-flight 轮询跨 tick 保留（promise 里的消息不丢，消费前不置空）。
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
      // 已取得的协议文本（手动按钮/自动检查共用队列）：输入框就绪即注入
      if (pendingInjectText && findInput()) {
        const text = pendingInjectText;
        pendingInjectText = "";
        await deliverMessage(text, "reinject");
        continue;
      }
      // 协议自动补投：「新对话自动注入协议」开 且 空对话（双采样确认）才执行
      if (settings.autoInject && autoInjectState === "idle") {
        if (await autoInjectProtocolIfEligible()) continue;
      }
      if (!inflightPoll) {
        inflightPoll = (async () => {
          try {
            return await chrome.runtime.sendMessage({ type: "get-task", baseUrl: settings.baseUrl });
          } catch (err) {
            return { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
          }
        })();
      }
      const raced = await Promise.race([
        inflightPoll.then((resp) => ({ kind: "poll", resp })),
        sleep(POLL_TICK_MS).then(() => ({ kind: "tick" })),
      ]);
      if (raced.kind === "tick") continue; // 轮询仍在途：回顶重查队列/状态
      inflightPoll = null; // 本轮询已消费，下轮重新发起
      const resp = raced.resp;
      // 信封消费：仅 status:"ok" 携带任务（空轮询 data:null）；
      // bridge-unreachable（扩展本地伪码）走退避重试，其余错误记日志下轮再拉
      if (resp?.status !== "ok") {
        const error = resp?.error ?? { code: "bridge-unreachable", message: "桥未连接或请求超时" };
        if (error.code === "bridge-unreachable") {
          bridgeFailCount += 1;
          if (bridgeFailCount <= BRIDGE_RETRY_ATTEMPTS) {
            noteBridgeFailure(error.message, `第 ${bridgeFailCount}/${BRIDGE_RETRY_ATTEMPTS} 次失败，${bridgeFailCount}s 后重试`);
            await sleep(bridgeFailCount * 1000);
            continue;
          }
          noteBridgeFailure(error.message, "5 次重试均失败，请点击面板「手动重试」");
          setStatus("桥未连接");
          retryBtn.hidden = false;
          await waitForManualRetry();
          continue;
        }
        log(`取任务失败：${error.message}`);
        await sleep(TASK_RETRY_MS);
        continue;
      }
      noteBridgeSuccess();
      const task = resp.data;
      if (task?.type === "approval") {
        await handleApproval(task);
        continue; // 审批处理完立即拉取下一条（执行结果回填消息）
      }
      if (typeof task?.message === "string") {
        await deliverMessage(task.message, "task");
        continue; // 有消息时立即拉取下一条
      }
      // 无消息：仅把错误状态恢复为待命，不覆盖「已抓取回复」等有效状态
      if (currentStatus === "错误") setStatus("待命");
    }
    await sleep(TASK_RETRY_MS);
  }
}

// 对话轮次计数：文档级统计 ms-chat-turn 元素，排除思考轮（页面实测：思考轮额外挂
// .thought-activity-host 类，与消息轮同用 ms-chat-turn 标签，不排除会虚计）。
// 不用容器子元素计数——容器 children 混有非轮次 UI（幻觉免责声明、Drive 提示等），会虚高；
// 空对话无容器也无轮次元素，恒为 0，不再出现「容器缺失 -1」把空对话判定卡死的状态。
function liveTurnCount() {
  return document.querySelectorAll("ms-chat-turn:not(.thought-activity-host)").length;
}

// 协议自动补投（仅「新对话自动注入协议」开关开启时运行）：仅新对话页（URL 含 /prompts/new_chat）
// 且对话为空（无消息轮次、双采样确认）时拉取并注入。仅由会话切换（onNewConversation，URL 轮询）
// 或开关打开置 idle 触发；页面加载初始 done 不检查（防刷新旧对话重放）。
// 已有消息 → 销记跳过；不在新对话页 → 销记跳过（历史对话渲染中也不注入——URL 即证据）；
// 草稿占位 → 不销记，下轮再查；新对话页显示会话元素 → 首条消息提交过渡态，保守等待（日志一次，不销记）。
// 返回 true 表示本轮已了结（注入排队/销记/等待桥恢复），false 表示保持 idle 下轮重试。
async function autoInjectProtocolIfEligible() {
  if (!settings.autoInject) {
    autoInjectState = "done"; // 开关已关：销记（重新打开时由开关事件复位 idle）
    return true;
  }
  const input = findInput();
  if (!input) return false; // 输入框未就绪：保持 idle，下轮再看
  if (input.value.trim() !== "") return false; // 草稿占位：不销记，等下轮（草稿清空后自然继续）
  const s1 = liveTurnCount();
  if (s1 > 0) {
    autoInjectState = "done";
    log(`协议自动补投：跳过（当前对话已有 ${s1} 轮消息）`);
    return true;
  }
  await sleep(800); // 双采样：旧对话消息可能在 SPA 渲染队列中尚未落盘
  const s2 = liveTurnCount();
  if (s2 > 0) {
    autoInjectState = "done"; // 采样间隔内旧对话消息载入完成 → 判定非空
    log(`协议自动补投：跳过（检测到对话已有 ${s2} 轮消息）`);
    return true;
  }
  if (!location.href.includes("/prompts/new_chat")) {
    // 不在新对话页：历史对话渲染中（轮次尚未落盘）或已切走——注入只发生在空对话页
    autoInjectState = "done";
    log("协议自动补投：跳过（当前不在新对话页）");
    return true;
  }
  if (document.querySelector("ms-chat-session")) {
    // 新对话页却有会话元素：首条消息提交瞬间的过渡态 → 保守等待，不销记
    if (!autoInjectWaitLogged) {
      autoInjectWaitLogged = true;
      log("协议自动补投：会话容器已存在但暂无消息（可能在渲染），保守等待…");
    }
    return false;
  }
  if (findInput()?.value.trim() !== "") return false; // 采样期间出现草稿：取消本次注入，不销记
  if (!settings.autoInject) {
    autoInjectState = "done"; // 采样期间开关被关：销记，不再注入
    return true;
  }
  const got = await fetchProtocolText();
  if (got.error) {
    autoInjectState = "wait-bridge";
    log(`协议自动补投：拉取失败（${got.error}）；桥恢复后自动重试，或点「填入规则文本」手动注入`);
    return true;
  }
  autoInjectState = "done";
  pendingInjectText = got.text;
  log(`协议自动补投：空对话确认（双采样），已取得协议文本（${got.text.length} 字符），排队注入`);
  return true;
}

// ---------- 网络捕获接入（路线 A）：MAIN world → postMessage → 解码 → POST /task/reply ----------

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
    resp = { status: "error", error: { code: "bridge-unreachable", message: err instanceof Error ? err.message : String(err) } };
  }
  if (resp?.status === "ok") {
    const processed = resp.data?.processed === true;
    noteBridgeSuccess();
    log(
      `网络捕获：已回传（${reply.length} 字符，${stats.deltaCount} deltas，滤 ${stats.thoughtCount} thought，` +
        `${processed ? "已入队执行" : "服务侧忽略（无工具调用）"}）`,
    );
    if (!processed) setStatus("待命");
    // processed 时保持「已抓取回复（等待执行）」，直到回填消息到达
    return;
  }
  const error = resp?.error;
  if (error?.code === "bridge-unreachable") {
    noteBridgeFailure(error.message); // 响亮停滞：本条丢弃不重发（无重采样通道），日志可诊
    return;
  }
  setStatus("错误");
  log(`回传被拒：${error?.message ?? "未知错误"}`);
}

function setupCaptureListener() {
  window.addEventListener("message", (ev) => {
    try {
      if (ev.source !== window) return; // 只收本窗口消息
      const d = ev.data;
      if (!d || d.__ha !== CAPTURE_MARKER || d.v !== 1) return; // 非捕获协议一律忽略（含本脚本自己发的 ping）
      if (d.kind === "hello") {
        noteCaptureMounted("注入侧握手");
      } else if (d.kind === "start") {
        noteCaptureMounted("经捕获消息");
        // 状态标准统一入口：请求发出 = 回复在途（与提交方式无关、与前端页面无关）
        setStatus("等待回复");
        log("网络捕获：检测到 GenerateContent 请求");
      } else if (d.kind === "error") {
        noteCaptureMounted("经捕获消息");
        log(`网络捕获异常：${d.reason ?? "未知原因"}（…${d.urlTail ?? ""}）`);
      } else if (d.kind === "done") {
        noteCaptureMounted("经捕获消息");
        // 诊断留痕：完成信号已送达隔离世界（控制台 [ha-capture] 可过滤）
        console.log("[ha-capture] content 收到完成信号", typeof d.raw === "string" ? `${d.raw.length} 字符` : typeof d.raw);
        const decoded = haDecodeGenerateContent(d.raw);
        if (decoded === null) {
          setStatus("待命"); // 回复已结束但本轮无产出：回静息态（详情在日志，响亮停滞）
          log(`网络捕获解码失败（原文 ${typeof d.raw === "string" ? d.raw.length : 0} 字符），本轮不投递`);
          return;
        }
        postResult(decoded.answer, decoded);
      }
    } catch (err) {
      // 响亮停滞：处理器自身异常不再无声，控制台 + 面板双通道留痕
      console.error("[ha-capture] 捕获消息处理异常", err);
      log(`捕获消息处理异常：${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // inject.js 在 document_start 已发过 hello，本监听 document_idle 才就位（错过首包）——发 ping 请它补答
  window.postMessage({ __ha: CAPTURE_MARKER, v: 1, kind: "ping" }, "*");
}

// ---------- 会话切换检测（A1）：URL 轮询（/prompts/<id> 逐对话唯一），触发协议文本重新注入 ----------

let lastHref = null; // URL 轮询基线
let lastTriggerHref = null; // 上次触发补投检查的地址（重复信号合并）

function setupNewConversationWatcher() {
  lastHref = location.href;
  lastTriggerHref = location.href; // 初始同步：页面加载自身的路由变化不触发检查
  // AI Studio 每个对话有唯一地址（历史对话 /prompts/<id>，空对话 /prompts/new_chat），
  // 地址一变即切换，逐次必中；启动期首次路由（裸域 → /prompts/…）不算切换（页面加载护栏）。
  setInterval(() => {
    const href = location.href;
    if (href === lastHref) return;
    const prev = lastHref;
    lastHref = href;
    if (!prev.includes("/prompts/")) {
      lastTriggerHref = href; // 启动期路由：同步基线，不触发
      return;
    }
    onNewConversation("会话地址已变更");
  }, HREF_POLL_MS);
}

// 会话切换统一入口（URL 轮询）：按当前地址去重——同一地址重复信号只触发一次检查，
// 不吞真实切换（切一次址变一次；启动期首次路由在轮询侧同步基线）。
function onNewConversation(reason) {
  const href = location.href;
  if (href === lastTriggerHref) return;
  lastTriggerHref = href;
  autoInjectState = "idle"; // 新对话：若自动注入开启则重走补投检查（仅空对话才会实际注入）
  autoInjectWaitLogged = false; // 保守等待日志按对话重记
  log(
    settings.autoInject
      ? `检测到新对话（${reason}）：将检查协议自动补投`
      : `检测到新对话（${reason}）：自动注入未开，需要时点「填入规则文本」`,
  );
}

// ---------- 启动 ----------

async function init() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY).catch(() => ({}));
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
      autoInject: typeof saved.autoInject === "boolean" ? saved.autoInject : defaultSettings.autoInject,
      simulateTyping:
        typeof saved.simulateTyping === "boolean" ? saved.simulateTyping : defaultSettings.simulateTyping,
      untrustedTier:
        saved.untrustedTier === "popup" || saved.untrustedTier === "deny" || saved.untrustedTier === "allow"
          ? saved.untrustedTier
          : typeof saved.autoApprove === "boolean"
            ? saved.autoApprove
              ? "allow"
              : "popup" // 一次性迁移：旧 autoApprove true→默认允许 / false→默认弹窗（行为不变）
            : defaultSettings.untrustedTier,
      approvalTimeoutSec: clampApprovalTimeout(Number(saved.approvalTimeoutSec)),
    };
  }
  applySettingsToPanel();
  setupPanelEvents();
  updateSubmitNowState(); // 「立即提交」初始可用性（页面加载时输入框通常为空 → 置灰）
  setInterval(updateSubmitNowState, 500); // 轮询输入框空/存在性：元素随渲染重建，观察器路线已废弃
  setupNewConversationWatcher();
  setStatus("待命");
  log(
    `gemini-bridge v0.4 已就绪：桥服务 ${settings.baseUrl}，自动提交 ${settings.autoMode ? "开" : "关"}，新对话自动注入 ${settings.autoInject ? "开" : "关"}`,
  );
  void refreshWorkspace(); // 启动即拉一次工作区（桥未就绪时静默失败，连接成功后补拉）
  void refreshWhitelist(); // 启动即拉一次白名单（计数徽标；折叠态不出列表）
  setupCaptureListener(); // 网络捕获接入：等 MAIN world 捕获消息（document_start 已发 hello，此处补 ping）
  deliveryLoop(); // 投递循环：长轮询取回填消息
}

init();
