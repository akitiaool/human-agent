# gemini-bridge 网络原文捕获（路线 A）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桥服务收到**未渲染的模型原文**：MAIN world 薄 hook 拦截 AI Studio GenerateContent 响应流 → postMessage 转发 → 纯函数解码（JSON 全量 walk / 滤 thought）→ POST /result；DOM 回复捕获通道全套删除，不保留降级。

**Architecture:** 三层职责切分——`extensions/gemini-bridge/inject.js`（MAIN world，document_start，纯运输层：捕获 + 转发，不解码、零页面干扰）；`extensions/gemini-bridge/decode.js`（纯函数层：JSON 解码 + delta 提取 + thought 过滤，零 DOM/chrome 依赖，可单测）；`extensions/gemini-bridge/content.js`（接入层：消息校验、投递、日志；既有投递循环/新对话检测/审批弹窗不动）。桥服务（`src/**`）协议零改动。

**Tech Stack:** Chrome/Edge MV3（`world: "MAIN"`，Chrome 111+）、经典脚本（无 import/export，文件尾 CJS 尾巴供 vitest 直载）、vitest 4（fixture 驱动单测 + 假 window hook 单测）、既有 `ASTParser`（`src/brain/ast-parser.ts`，零改动）。

**Spec:** `docs/gemini-bridge 网络原文捕获设计方案.md`（本计划由其派生；除「相对 spec 的实现澄清」明示的四处偏差外，冲突以 spec 为准）

## Global Constraints

- **Chrome/Edge 111+**：manifest `world: "MAIN"` 的最低版本（spec §7）。
- **`src/**` 零改动**：桥服务与 ASTParser 完全不动；本计划只触碰 `extensions/gemini-bridge/`、`tests/`、`docs/`。
- **经典脚本纪律**：`extensions/gemini-bridge/*.js` 由浏览器以经典脚本加载——文件内**不得出现 `import`/`export` 语句**；与 Node 测试互通的唯一机制是文件尾 CJS 尾巴 `if (typeof module !== "undefined" && module.exports) module.exports = {...};`。**已探针实测**：vitest 直接 `import { x } from "../extensions/gemini-bridge/xxx.js"` 可用（Vite SSR 的 CJS interop，含 IIFE 包裹形态）；`createRequire` 不可用（repo `"type": "module"`，require 到空模块）。浏览器分支（`installCaptureHooks(window)` / 全局函数声明）在 vitest 下不得执行（`window` 在 Node 不存在）。
- **响亮停滞纪律**（spec §2）：捕获层所有逻辑 try/catch、不改实参、不碰响应对象、不向页面抛异常；失败 = 没有消息，绝不降级产出错值。
- **零容错解码**（spec §5.3）：解码失败一律返回 `null` → 本轮不投递（面板记日志），不做任何猜测性修补。
- **fixture 基准数字**（spec §3，已在库，禁止改写）：`probe-samples/generatecontent-plain-reply.txt` = 515 字符 / 15 deltas / 2 thoughts / 以「你好！」开头；`probe-samples/generatecontent-tool-call-reply.txt` = 1215 字符 / 24 deltas / 5 thoughts / `{` 起 `}` 止 / 4 个反引号序列。
- **提交纪律**：仓库里存在与本计划**无关的既有未提交改动**（19 个已修改文件 + 若干未跟踪文件）——每个任务只 `git add` 本任务列出的文件，严禁 `git add -A`/`git add .`。提交信息中文、无署名（不带 Co-Authored-By / Generated with），前缀风格：`捕获：` / `扩展：` / `文档：`。
- 测试命令：全量 `pnpm test`；单文件 `pnpm exec vitest run tests/<file>`。当前基线 22 文件 / 223 测试全绿。

## 相对 spec 的实现澄清（四处偏差，其余照 spec）

1. **postResult 合并统计日志**：spec §5.4 的完成日志「网络捕获：已回传（1215 字符，24 deltas，滤 5 thought）」由 `postResult(reply, stats)` 的成功分支产出（`stats` 即解码结果对象）；日志在其后追加既有判定「已入队执行 / 服务侧忽略（无工具调用/重复）」。
2. **桥不可达时本条丢弃、不重发**：旧行为靠 monitorLoop 持续重采样实现「桥恢复后重发」；monitorLoop 按 spec 删除后无重采样通道，故 `postResult` 失败 = `noteBridgeFailure` 日志（含「桥未连接（重试中）」状态）+ 本条丢弃。这是 spec §2 响亮停滞哲学的自然推论（失败可见、可诊，不产出错值），不新增重试机制。
3. **`tests/inject-hooks.test.ts` 为 spec §6 清单外新增**（spec 只列 `tests/bridge-decode.test.ts`）：运输层是重灾区（XHR 包装、透明性、协议字段），假 window harness 可零成本覆盖，按项目 TDD 纪律补上。
4. **deltaCount 口径精确化**：`deltaCount` = 参与拼接的**非空、非 thought** part 数；`thoughtCount` = thought part 数；空文本的非 thought part（样本各 1 个，signature/usage 尾块）两侧过滤、不计入任何统计。这正是 spec §3 「15 / 24 deltas」的口径（原文总文本 part 数为 18 / 30）。

## 文件结构（改动落点）

| 动作 | 路径 | 职责 |
|---|---|---|
| 新增 | `extensions/gemini-bridge/decode.js` | 纯函数解码器（经典脚本全局 + CJS 尾巴） |
| 新增 | `extensions/gemini-bridge/inject.js` | MAIN world 捕获层（IIFE 隔离，CJS 尾巴导出 install） |
| 新增 | `tests/bridge-decode.test.ts` | fixture 驱动解码单测 + decode→AST 贯通 |
| 新增 | `tests/inject-hooks.test.ts` | 假 window 驱动 hook 行为单测 |
| 修改 | `extensions/gemini-bridge/manifest.json` | v0.3.0；MAIN world 条目 + decode.js 声明 |
| 修改 | `extensions/gemini-bridge/content.js` | 消息接入 + DOM 回复捕获全套删除 |
| 修改 | `extensions/gemini-bridge/README.md` | v3 结构说明 + 排查表更新 |
| 不动 | `src/**`、`background.js`、`probe-samples/` | 桥服务协议零改动；background 中转不动；fixture 已入库 |

---

### Task 1: decode.js —— 响应原文解码器（纯函数）

**Files:**
- Create: `extensions/gemini-bridge/decode.js`
- Test: `tests/bridge-decode.test.ts`

**Interfaces:**
- Consumes: `probe-samples/generatecontent-plain-reply.txt`、`probe-samples/generatecontent-tool-call-reply.txt`（已在库）；`ASTParser`（`../src/brain/ast-parser.js`，仅贯通测试用）
- Produces: `haDecodeGenerateContent(rawText) → { answer: string, deltaCount: number, thoughtCount: number } | null`
  - 浏览器侧：经典脚本顶层函数声明（与 content.js 同 content_scripts 数组、先加载，隔离世界全局名可调）
  - Node 侧：CJS 尾巴 `module.exports = { haDecodeGenerateContent }`（vitest 具名导入）

- [ ] **Step 1: 写失败测试 `tests/bridge-decode.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { haDecodeGenerateContent } from "../extensions/gemini-bridge/decode.js";
import { ASTParser } from "../src/brain/ast-parser.js";

const plainRaw = readFileSync(new URL("../probe-samples/generatecontent-plain-reply.txt", import.meta.url), "utf8");
const toolRaw = readFileSync(new URL("../probe-samples/generatecontent-tool-call-reply.txt", import.meta.url), "utf8");

describe("haDecodeGenerateContent：普通回复样本", () => {
  it("解码成功：515 字符 / 15 deltas / 2 thoughts / 以「你好！」开头且无 { 头", () => {
    const d = haDecodeGenerateContent(plainRaw);
    expect(d).not.toBeNull();
    expect(d?.answer.length).toBe(515);
    expect(d?.deltaCount).toBe(15);
    expect(d?.thoughtCount).toBe(2);
    expect(d?.answer.startsWith("你好！")).toBe(true);
    expect(d?.answer.startsWith("{")).toBe(false);
  });
});

describe("haDecodeGenerateContent：工具调用回复样本", () => {
  it("解码成功：1215 字符 / 24 deltas / 5 thoughts / { 起 } 止 / 两对围栏逐字节在", () => {
    const d = haDecodeGenerateContent(toolRaw);
    expect(d).not.toBeNull();
    expect(d?.answer.length).toBe(1215);
    expect(d?.deltaCount).toBe(24);
    expect(d?.thoughtCount).toBe(5);
    expect(d?.answer.startsWith("{")).toBe(true);
    expect(d?.answer.endsWith("}")).toBe(true);
    expect(d?.answer.includes("<::: TOOL_CALL[1]")).toBe(true);
    expect(d?.answer.includes(":::> TOOL_CALL[1]")).toBe(true);
    // ```js 与 ```bash 两对围栏 = 4 个反引号序列
    expect(d?.answer.split("```").length - 1).toBe(4);
    expect(d?.answer.includes("```js")).toBe(true);
    expect(d?.answer.includes("```bash")).toBe(true);
  });
});

describe("贯通：网络原文 → 解码 → 无转义 AST 解析", () => {
  it("工具调用样本：toolTree 1 个 write_file，content 内嵌围栏原文、于 CONTENT 闭合符前终止", () => {
    const d = haDecodeGenerateContent(toolRaw);
    if (d === null) throw new Error("工具调用样本解码失败");
    const inf = new ASTParser().parseToInference(d.answer);
    if (inf === null) throw new Error("AST 解析失败");
    expect(inf.toolTree.length).toBe(1);
    expect(inf.toolCalls.length).toBe(1);
    const call = inf.toolCalls[0];
    expect(call?.name).toBe("write_file");
    expect(call?.arguments.path).toBe("docs/example.md");
    const content = call?.arguments.content;
    expect(typeof content).toBe("string");
    expect((content as string).includes("```js")).toBe(true);
    expect((content as string).includes("```bash")).toBe(true);
    expect((content as string).includes(":::>")).toBe(false); // 标记未漏进内容：于终结符前终止
  });
});

describe("健壮性：失败一律 null（响亮停滞，不做猜测性修补）", () => {
  it("非 JSON → null", () => {
    expect(haDecodeGenerateContent("这不是 JSON")).toBeNull();
  });

  it("合法 JSON 但无文本 part → null", () => {
    expect(haDecodeGenerateContent("{}")).toBeNull();
    expect(haDecodeGenerateContent("[]")).toBeNull();
  });

  it("空文本 part → null", () => {
    expect(haDecodeGenerateContent(JSON.stringify([[null, ""]]))).toBeNull();
  });

  it("仅 thought part → null", () => {
    // 长度 13 且 index 12 === 1 = thought
    const thought = [null, "思考内容", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(haDecodeGenerateContent(JSON.stringify([thought]))).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/bridge-decode.test.ts`
Expected: FAIL —— `Failed to load ... .probe / Cannot find module '../extensions/gemini-bridge/decode.js'`（文件尚未创建）

- [ ] **Step 3: 创建 `extensions/gemini-bridge/decode.js`**

```js
// gemini-bridge 响应解码器（经典脚本：content_scripts js 数组中先于 content.js 加载，隔离世界共享全局名）。
// 输入：MAIN world 捕获的 GenerateContent 响应原文（application/json+protobuf 的 JSON 增量流，全量一次性）。
// 输出：{ answer, deltaCount, thoughtCount } | null —— 任何异常一律 null（响亮停滞：本轮不投递，绝不修补）。
// 两条铁律：必须 JSON.parse 全量后一次 walk（delta 切分任意——可切词中/token 中/跨 chunk，逐片解析必死）；
// parse 同时消化 < 转义，喂给 AST 的才是原文（正则抠原始字节会失配 AST 的标记正则）。
function haDecodeGenerateContent(rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return null;
  }

  let deltaCount = 0; // 参与拼接的正文 delta 数（非空、非 thought）
  let thoughtCount = 0; // 被过滤的 thinking delta 数
  const answerParts = [];

  const walk = (x) => {
    if (!Array.isArray(x)) return;
    if (x[0] === null && typeof x[1] === "string") {
      // thought 判据：数组长度 > 12 且 index 12 === 1（探针校准，spec §3）
      if (x.length > 12 && x[12] === 1) {
        thoughtCount += 1;
      } else if (x[1].length > 0) {
        // 空文本 part（signature / usage 尾块）自然滤除
        answerParts.push(x[1]);
        deltaCount += 1;
      }
      return;
    }
    for (const item of x) walk(item);
  };
  walk(data);

  const answer = answerParts.join("");
  if (answer === "") return null;
  return { answer, deltaCount, thoughtCount };
}

// CJS 尾巴：vitest 直接 import 单测；浏览器经典脚本下 module 不存在，走全局函数声明
if (typeof module !== "undefined" && module.exports) module.exports = { haDecodeGenerateContent };
```

- [ ] **Step 4: 运行测试确认通过 + 全量回归**

Run: `pnpm exec vitest run tests/bridge-decode.test.ts` → Expected: 7 passed
Run: `pnpm test` → Expected: 全绿（23 文件 / 230 测试）

- [ ] **Step 5: 提交**

```bash
git add extensions/gemini-bridge/decode.js tests/bridge-decode.test.ts
git commit -m "捕获：decode.js 网络原文解码器（JSON 全量 walk / 滤 thought）+ fixture 单测与 AST 贯通"
```

---

### Task 2: inject.js —— MAIN world 捕获层

**Files:**
- Create: `extensions/gemini-bridge/inject.js`
- Test: `tests/inject-hooks.test.ts`

**Interfaces:**
- Consumes: 无（纯自包含）
- Produces: `installCaptureHooks(win)`（CJS 尾巴导出；浏览器分支自动 `installCaptureHooks(window)`），及 postMessage 消息协议（content.js 按此消费）：
  - 所有消息：`{ __ha: "gemini-bridge-capture", v: 1, kind, ... }`，`win.postMessage(msg, "*")`
  - `hello`：安装即发；收到同窗 `ping` 再答一次；无其他字段
  - `start`：`{ reqId, urlTail }`——XHR `send` / fetch 调用命中时
  - `done`：`{ reqId, raw }`——XHR `loadend` 全量 `responseText` / fetch `clone().text()` 完成
  - `error`：`{ reqId, urlTail, reason }`——responseType 非 text、读取抛错、clone/text 失败（诊断用）
  - `reqId`：自增序号，配对 start↔done/error

- [ ] **Step 1: 写失败测试 `tests/inject-hooks.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { installCaptureHooks } from "../extensions/gemini-bridge/inject.js";

const MARKER = "gemini-bridge-capture";
const HIT_URL =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
const MISS_URL = "https://aistudio.google.com/u/0/prompts";

type Posted = Record<string, unknown>;

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeFakeXHRClass() {
  return class FakeXHR {
    listeners: Record<string, Array<() => void>> = {};
    responseText = "";
    responseType = "";
    openedUrl: unknown = null;
    sent = false;
    open(_method: unknown, url: unknown): void {
      this.openedUrl = url;
    }
    send(): void {
      this.sent = true;
    }
    addEventListener(type: string, fn: () => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    fireLoadEnd(): void {
      for (const fn of this.listeners.loadend ?? []) fn();
    }
  };
}

class FakeWindow {
  posted: Posted[] = [];
  messageListeners: Array<(ev: { source: unknown; data: unknown }) => void> = [];
  XMLHttpRequest = makeFakeXHRClass();
  fetch: (input: unknown, init?: unknown) => Promise<unknown>;
  constructor(fetchImpl?: (input: unknown, init?: unknown) => Promise<unknown>) {
    this.fetch = fetchImpl ?? (() => Promise.resolve({}));
  }
  postMessage(msg: Posted, _origin: string): void {
    this.posted.push(msg);
  }
  addEventListener(type: string, fn: (ev: { source: unknown; data: unknown }) => void): void {
    if (type === "message") this.messageListeners.push(fn);
  }
  dispatchMessage(ev: { source: unknown; data: unknown }): void {
    for (const fn of this.messageListeners) fn(ev);
  }
}

describe("installCaptureHooks：握手", () => {
  it("安装即发 hello", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    expect(win.posted).toContainEqual({ __ha: MARKER, v: 1, kind: "hello" });
  });

  it("同窗 ping → 补答 hello；异窗 / 非 ping / 无关消息一律忽略", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const before = win.posted.length;
    win.dispatchMessage({ source: win, data: { __ha: MARKER, v: 1, kind: "ping" } });
    expect(win.posted.length).toBe(before + 1);
    expect(win.posted[win.posted.length - 1]).toEqual({ __ha: MARKER, v: 1, kind: "hello" });
    win.dispatchMessage({ source: {}, data: { __ha: MARKER, v: 1, kind: "ping" } }); // 异窗
    win.dispatchMessage({ source: win, data: { __ha: MARKER, v: 1, kind: "done" } }); // 非 ping
    win.dispatchMessage({ source: win, data: { hello: "world" } }); // 无关
    expect(win.posted.length).toBe(before + 1);
  });

  it("重复安装不重复 hook（hello 也只发一次）", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    installCaptureHooks(win);
    expect(win.posted.filter((m) => m.kind === "hello").length).toBe(1);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.fireLoadEnd();
    expect(win.posted.filter((m) => m.kind === "start").length).toBe(1);
    expect(win.posted.filter((m) => m.kind === "done").length).toBe(1);
  });
});

describe("installCaptureHooks：XHR 主通道", () => {
  it("非命中 URL 完全透明：无消息、行为不变", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("GET", MISS_URL);
    xhr.send();
    xhr.fireLoadEnd();
    expect(win.posted.filter((m) => m.kind !== "hello")).toEqual([]);
    expect(xhr.sent).toBe(true);
    expect(xhr.openedUrl).toBe(MISS_URL);
  });

  it("命中 URL：start（urlTail）→ loadend 全量原文 done（reqId 配对）", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    const start = win.posted.find((m) => m.kind === "start");
    expect(start).toBeTruthy();
    expect(start?.urlTail).toBe(HIT_URL.slice(-80));
    xhr.responseText = '{"sample":true}';
    xhr.fireLoadEnd();
    const done = win.posted.find((m) => m.kind === "done");
    expect(done).toBeTruthy();
    expect(done?.raw).toBe('{"sample":true}');
    expect(done?.reqId).toBe(start?.reqId);
  });

  it("responseType 非 text：发 error 诊断（无 done）", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.responseType = "arraybuffer";
    xhr.fireLoadEnd();
    const err = win.posted.find((m) => m.kind === "error");
    expect(err).toBeTruthy();
    expect(String(err?.reason)).toContain("arraybuffer");
    expect(win.posted.some((m) => m.kind === "done")).toBe(false);
  });
});

describe("installCaptureHooks：fetch 薄兜底", () => {
  it("非命中完全透明：原响应原样返回、无消息", async () => {
    const response = { marker: "orig" };
    const win = new FakeWindow(() => Promise.resolve(response));
    installCaptureHooks(win);
    const got = await win.fetch(MISS_URL);
    await tick();
    expect(got).toBe(response);
    expect(win.posted.filter((m) => m.kind !== "hello")).toEqual([]);
  });

  it("命中（字符串 URL）：start → clone().text() 后 done 全量原文；调用方仍拿到原响应", async () => {
    const raw = '{"fetch":true}';
    const response = { clone: () => ({ text: () => Promise.resolve(raw) }) };
    const win = new FakeWindow(() => Promise.resolve(response));
    installCaptureHooks(win);
    const got = await win.fetch(HIT_URL);
    await tick();
    expect(got).toBe(response);
    const start = win.posted.find((m) => m.kind === "start");
    const done = win.posted.find((m) => m.kind === "done");
    expect(start).toBeTruthy();
    expect(done?.raw).toBe(raw);
    expect(done?.reqId).toBe(start?.reqId);
  });

  it("命中（Request 形态输入）：按 input.url 判定", async () => {
    const raw = '{"req":true}';
    const response = { clone: () => ({ text: () => Promise.resolve(raw) }) };
    const win = new FakeWindow(() => Promise.resolve(response));
    installCaptureHooks(win);
    await win.fetch({ url: HIT_URL });
    await tick();
    expect(win.posted.some((m) => m.kind === "done" && m.raw === raw)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/inject-hooks.test.ts`
Expected: FAIL —— `Cannot find module '../extensions/gemini-bridge/inject.js'`

- [ ] **Step 3: 创建 `extensions/gemini-bridge/inject.js`**

```js
// gemini-bridge MAIN world 捕获层（manifest: document_start + world:"MAIN"，先于页面任何脚本运行）。
// 纯运输：钩 XMLHttpRequest / fetch，URL 命中 GenerateContent 时把响应原文经 window.postMessage 转发给隔离世界。
// 零干扰纪律：全部逻辑 try/catch、不改实参、不碰响应对象、不向页面抛异常；捕获层失手 = 没有消息（响亮停滞）。
// 必须 IIFE：经典脚本顶层 const/function 会进页面全局词法环境，与页面脚本重名将炸页面。
(function () {
  "use strict";

  const MARKER = "gemini-bridge-capture";
  const VERSION = 1;

  function installCaptureHooks(win) {
    if (win.__haCaptureInstalled) return;
    win.__haCaptureInstalled = true;

    let seq = 0;

    const emit = (msg) => {
      try {
        win.postMessage({ __ha: MARKER, v: VERSION, ...msg }, "*");
      } catch {}
    };

    const urlTail = (url) => url.slice(-80);
    const urlMatch = (url) => typeof url === "string" && url.includes("GenerateContent");

    // XHR 主通道（探针确认 AI Studio 走 XHR）：open 记 URL → send 挂 loadend 读全量 responseText
    const OrigXHR = win.XMLHttpRequest;
    if (OrigXHR && OrigXHR.prototype) {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;

      OrigXHR.prototype.open = function (method, url, ...rest) {
        try {
          this.__haUrl = typeof url === "string" ? url : String(url);
        } catch {}
        return origOpen.call(this, method, url, ...rest);
      };

      OrigXHR.prototype.send = function (...args) {
        try {
          const url = this.__haUrl || "";
          if (urlMatch(url)) {
            const reqId = ++seq;
            emit({ kind: "start", reqId, urlTail: urlTail(url) });
            // 先挂监听再 send：同步 XHR 的 loadend 在 send 内就会派发，后挂会漏
            this.addEventListener("loadend", () => {
              try {
                const rt = this.responseType;
                if (rt !== "" && rt !== "text") {
                  emit({ kind: "error", reqId, urlTail: urlTail(url), reason: "responseType=" + rt });
                  return;
                }
                emit({ kind: "done", reqId, raw: this.responseText });
              } catch (err) {
                emit({ kind: "error", reqId, urlTail: urlTail(url), reason: String((err && err.message) || err) });
              }
            });
          }
        } catch {}
        return origSend.apply(this, args);
      };
    }

    // fetch 薄兜底（传输迁移预挂）：命中则响应到达时同步 clone，异步 text() 后发 done；不命中完全透明
    const origFetch = win.fetch;
    if (typeof origFetch === "function") {
      win.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
          const input = args[0];
          let url = "";
          if (typeof input === "string") url = input;
          else if (input && typeof input.url === "string") url = input.url; // Request
          else if (input && typeof input.href === "string") url = input.href; // URL
          if (urlMatch(url)) {
            const reqId = ++seq;
            emit({ kind: "start", reqId, urlTail: urlTail(url) });
            p.then(
              (resp) => {
                try {
                  const clone = resp.clone(); // 响应一到就 clone，抢在页面消费 body 前
                  clone.text().then(
                    (raw) => emit({ kind: "done", reqId, raw }),
                    (err) =>
                      emit({ kind: "error", reqId, urlTail: urlTail(url), reason: String((err && err.message) || err) }),
                  );
                } catch (err) {
                  emit({ kind: "error", reqId, urlTail: urlTail(url), reason: String((err && err.message) || err) });
                }
              },
              () => {}, // 请求本身失败：无需捕获
            );
          }
        } catch {}
        return p;
      };
    }

    // 握手：安装即发 hello；content.js document_idle 才就位会错过首包，其发 ping 时补答
    win.addEventListener("message", (ev) => {
      try {
        if (ev.source !== win) return;
        const d = ev.data;
        if (d && d.__ha === MARKER && d.v === VERSION && d.kind === "ping") {
          emit({ kind: "hello" });
        }
      } catch {}
    });
    emit({ kind: "hello" });
  }

  // CJS 尾巴：vitest 导出供假 window 单测；浏览器经典脚本走 else 自动安装
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { installCaptureHooks };
  } else {
    installCaptureHooks(window);
  }
})();
```

- [ ] **Step 4: 运行测试确认通过 + 语法检查 + 全量回归**

Run: `pnpm exec vitest run tests/inject-hooks.test.ts` → Expected: 9 passed
Run: `node --check extensions/gemini-bridge/inject.js` → Expected: 无输出（语法合法）
Run: `pnpm test` → Expected: 全绿（24 文件 / 239 测试）

- [ ] **Step 5: 提交**

```bash
git add extensions/gemini-bridge/inject.js tests/inject-hooks.test.ts
git commit -m "捕获：inject.js MAIN world 捕获层（XHR 主通道 + fetch 兜底 + postMessage 协议），假 window 单测"
```

---

### Task 3: manifest.json —— v0.3.0 双条目

**Files:**
- Modify: `extensions/gemini-bridge/manifest.json`（全量替换为下述内容）

**Interfaces:**
- Consumes: `inject.js`（Task 2）、`decode.js`（Task 1）——`content_scripts.js` 数组顺序加载是 decode.js 全局名可被 content.js 调用的前提
- Produces: 浏览器加载的 v0.3.0 扩展（MAIN world 条目 + 隔离世界双文件条目）

- [ ] **Step 1: 全量替换 `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "gemini-bridge",
  "version": "0.3.0",
  "description": "human-agent 与 AI Studio 网页版 Gemini 的桥：网络原文捕获模型回复回传桥服务，长轮询取回填消息模拟人类输入。",
  "permissions": ["storage"],
  "host_permissions": ["http://127.0.0.1/*"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://aistudio.google.com/*"],
      "js": ["inject.js"],
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["https://aistudio.google.com/*"],
      "js": ["decode.js", "content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: 校验 JSON 合法 + 全量回归**

Run: `node -e "JSON.parse(require('node:fs').readFileSync('extensions/gemini-bridge/manifest.json','utf8')); console.log('manifest ok')"`
Expected: `manifest ok`
Run: `pnpm test` → Expected: 全绿（不依赖 manifest；纯回归）

- [ ] **Step 3: 提交**

```bash
git add extensions/gemini-bridge/manifest.json
git commit -m "扩展：manifest v0.3.0（MAIN world inject.js 条目 + decode.js 声明）"
```

---

### Task 4: content.js —— 接入网络通道 + 删除 DOM 回复捕获全套

**Files:**
- Modify: `extensions/gemini-bridge/content.js`

**Interfaces:**
- Consumes: `haDecodeGenerateContent`（decode.js 全局名，同数组先加载）；捕获协议（Task 2 的 Interfaces 块）
- Produces: 完整接入的 content script——`done` 消息 → 解码 → `postResult(answer, stats)`；面板日志四态（hello/start/done/error）

**说明**：content.js 依赖 chrome.\* 与真实 DOM，不在 vitest 覆盖范围（与扩展既有实践一致）——验证 = `node --check` 语法 + 残留符号 grep + 全量回归 + Task 5 手动 E2E。**编辑以内容匹配为准，不要按行号**（编辑过程中行号会漂移）。

- [ ] **Step 1: 头注释替换（文件顶 L1–L8 整块）**

旧：

```js
// gemini-bridge v2 content script —— 网页对话驱动。
// 两个循环：
//   内容监控循环：AI Studio 最新模型回复 → 稳定采样 → POST /result {reply}
//   投递循环：长轮询 GET /task → 模拟人类逐字回填 → 自动/手动提交
// 选择器为 AI Studio 真实 DOM（2026-08-19 落定，task-13-brief 附录 A）。
// 页面是 Angular SPA + cdk-virtual-scroll：元素频繁创建/销毁，
// 所有抓取基于 MutationObserver 且每次现查 DOM，禁止缓存元素引用跨轮复用。
// 面板样式统一 ha-* 前缀，避免与页面样式冲突。
```

新：

```js
// gemini-bridge v3 content script —— 网页对话驱动。
// 回复回传走网络原文捕获（路线 A）：MAIN world inject.js 钩 GenerateContent 响应 → postMessage
// → 本脚本用 haDecodeGenerateContent（decode.js，同 content_scripts 数组先加载）解码 → POST /result。
// 投递循环：长轮询 GET /task → 模拟人类逐字回填 → 自动/手动提交。
// 选择器为 AI Studio 真实 DOM（2026-08-19 落定，task-13-brief 附录 A）。
// 页面是 Angular SPA + cdk-virtual-scroll：元素频繁创建/销毁，
// 所有抓取基于 MutationObserver 且每次现查 DOM，禁止缓存元素引用跨轮复用。
// 面板样式统一 ha-* 前缀，避免与页面样式冲突。
```

- [ ] **Step 2: 删除稳定采样常量（两行）**

删除：

```js
const STABLE_SAMPLES = 3; // 稳定采样次数（连续 2–3 次，取 3）
const SAMPLE_INTERVAL_MS = 700; // 采样间隔（500ms–1s 区间）
```

- [ ] **Step 3: 更新 lastPostedReply 注释（语义变更：去重依据）**

旧：

```js
let lastPostedReply = ""; // 最近一次回传的回复（避免无谓重发，服务侧亦去重）
```

新：

```js
let lastPostedReply = ""; // 最近一次成功回传的回复（网络捕获去重用，服务侧亦去重）
```

- [ ] **Step 4: 删除 findLastModelTurn + extractReply + announcer 三整块**

删除块 1（含注释）：

```js
// A2/A3：最后一个内容轮且内部含模型角色的 turn
function findLastModelTurn() {
  const turns = document.querySelectorAll("ms-chat-turn.text-chunk-host");
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].querySelector('[data-turn-role="Model"]')) return turns[i];
  }
  return null;
}
```

删除块 2（含注释，从 `// A2：提取模型回复文本` 到 `extractReply` 函数结束）：

```js
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
	  for (const br of clone.querySelectorAll("br")) {
        br.replaceWith("\n");
      }
      return clone.innerText.trim();
    })
    .filter(Boolean)
    .join("\n");
}
```

删除块 3（含注释，announcer 完成信号）：

```js
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
```

- [ ] **Step 5: 替换内容监控区（section 注释 + postResult + monitorLoop 三块）为网络捕获接入区**

旧区域 = 下述三块**连续**内容，整段删除（定界明确，不会误删相邻块）：

1. section 注释行：`// ---------- 内容监控循环：最新模型回复 → 稳定采样 → POST /result ----------`
2. 现有 `postResult` 函数全文（`async function postResult(reply) {` 起，至其闭合大括号）
3. 现有 `monitorLoop` 函数全文（`async function monitorLoop() {` 起，至其闭合大括号）

新（在原位置完整替换为下述三段）：

```js
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
```

- [ ] **Step 6: init() 挂接替换（原 `deliveryLoop(); monitorLoop();` 两行）**

旧：

```js
  deliveryLoop(); // 投递循环：长轮询取回填消息
  monitorLoop(); // 内容监控循环：最新回复 → POST /result
```

新：

```js
  setupCaptureListener(); // 网络捕获接入：等 MAIN world 捕获消息（document_start 已发 hello，此处补 ping）
  deliveryLoop(); // 投递循环：长轮询取回填消息
```

- [ ] **Step 7: 语法检查 + 残留符号扫描 + 全量回归**

Run: `node --check extensions/gemini-bridge/content.js` → Expected: 无输出
Run: `grep -nE "monitorLoop|extractReply|findLastModelTurn|announcerReady|STABLE_SAMPLES|SAMPLE_INTERVAL_MS|announcerPrevReady|announcerReadySince" extensions/gemini-bridge/content.js` → Expected: 无匹配（退出码 1）
Run: `pnpm test` → Expected: 全绿（不依赖 content.js；纯回归）

- [ ] **Step 8: 提交**

```bash
git add extensions/gemini-bridge/content.js
git commit -m "捕获：content.js 接入网络原文通道，DOM 回复捕获全套删除（响亮停滞，无降级）"
```

---

### Task 5: README v3 + 手动 E2E

**Files:**
- Modify: `extensions/gemini-bridge/README.md`

**Interfaces:**
- Consumes: Tasks 1–4 全部产物
- Produces: 与 v3 行为一致的文档（结构说明 + 排查表），及人工执行的 E2E 验收

- [ ] **Step 1: 标题与简介更新**

旧标题行：

```markdown
# gemini-bridge 浏览器扩展（v2 网页对话驱动）
```

新：

```markdown
# gemini-bridge 浏览器扩展（v3 网络原文捕获 · 网页对话驱动）
```

旧简介段（`human-agent 与 AI Studio 网页版 Gemini 之间的桥。` 起至功能列表第 1 条）：

```markdown
human-agent 与 AI Studio 网页版 Gemini 之间的桥。v2 形态：**对话发生在网页**
（Google AI Studio），智能体仅执行工具。插件做三件事：

1. **内容监控**：抓取网页上最新的模型回复，POST 给本机桥服务
   （`POST /result {reply}`），桥服务解析 ```tool_call``` 交给智能体执行；
```

新：

```markdown
human-agent 与 AI Studio 网页版 Gemini 之间的桥。**对话发生在网页**
（Google AI Studio），智能体仅执行工具。插件做三件事：

1. **网络原文捕获**：页面主世界（MAIN world）薄 hook 拦截 GenerateContent 响应流，
   取**未渲染的模型原文**解码后 POST 给本机桥服务（`POST /result {reply}`），
   桥服务解析 ```tool_call``` 交给智能体执行。DOM 抓取通道已整体删除——
   渲染失真不可靠；捕获失手时任务「响亮停滞」（面板不再出现「已回传」日志，
   一眼可诊、可修复），绝不降级产出错值；
```

在简介流水线行（`整个流水线内容驱动、无 id 握手：…`）之后插入结构说明：

```markdown
扩展文件：`manifest.json`（v0.3.0）、`background.js`（全 try/catch 中转）、
`inject.js`（MAIN world 捕获层，document_start）、`decode.js`（响应流解码，纯函数）、
`content.js`（隔离世界接入层：面板 / 投递循环 / 审批弹窗 / 新对话检测）。
```

- [ ] **Step 2: 排查表更新（三处）**

旧行（页面结构变化导致失效）：

```markdown
| 页面结构变化导致失效 | 现象：日志「未找到输入框」「未找到发送按钮」，或监控循环抓不到回复。打开 DevTools 检查元素，更新 `content.js` 顶部选择器常量区域：输入框 `ms-prompt-box textarea.cdk-textarea-autosize.textarea`、发送按钮 `ms-run-button button[type="submit"].ms-button-primary`、模型轮 `ms-chat-turn.text-chunk-host` + `[data-turn-role="Model"]`、完成信号 `#cdk-live-announcer-0`。AI Studio 为 Angular SPA + 虚拟滚动，元素频繁创建/销毁，抓取必须每次现查 DOM |
```

新（拆为两行，删去已不存在的模型轮/announcer 选择器）：

```markdown
| 回填失效（未找到输入框/发送按钮） | 打开 DevTools 检查元素，更新 `content.js` 顶部选择器常量区域：输入框 `ms-prompt-box textarea.cdk-textarea-autosize.textarea`、发送按钮 `ms-run-button button[type="submit"].ms-button-primary`。AI Studio 为 Angular SPA + 虚拟滚动，元素频繁创建/销毁，抓取必须每次现查 DOM |
| 回复不再回传（无「已回传」日志） | 响亮停滞诊断：无「网络捕获已挂载」→ 注入层未生效（Chrome < 111 不支持 `world:"MAIN"`；或扩展代码更新后未刷新 AI Studio 页面，content script 不热重载）；有「检测到 GenerateContent 请求」但无「已回传」→ 解码失败（看「解码失败（原文 N 字符）」日志）或 AI Studio 端点迁移（更新 `inject.js` 的 URL 命中判据） |
```

旧行（插件加载报错）：

```markdown
| 插件加载时报错 | `chrome://extensions` 页面点「错误」查看 background 日志；确认三个文件无语法错误 |
```

新：

```markdown
| 插件加载时报错 | `chrome://extensions` 页面点「错误」查看 background 日志；确认四个文件（background.js、content.js、inject.js、decode.js）无语法错误 |
```

并在排查表末尾（或「注意」段附近）追加扩展重载说明：

```markdown
**扩展重载**：修改扩展代码后需在 `chrome://extensions` 点刷新，并**刷新 AI Studio 页面**（content script 不热重载），否则仍跑旧代码。
```

- [ ] **Step 3: 提交**

```bash
git add extensions/gemini-bridge/README.md
git commit -m "文档：gemini-bridge README v3（网络捕获结构、响亮停滞排查、扩展重载说明）"
```

- [ ] **Step 4: 手动 E2E（需真实浏览器 + 桥服务；由人工执行 / 请用户配合）**

逐项验收（spec §5.5 手动 E2E）：

1. 扩展重载 → 刷新 AI Studio 对话页 → 面板日志出现「网络捕获已挂载（注入侧握手）」。
2. 启动桥服务 `GEMINI_BRIDGE_PORT=8765 pnpm dev` → 协议文本自动回填提交 → 对 Gemini 提一个需工具调用的任务 → 面板日志依次出现「检测到 GenerateContent 请求」→「网络捕获：已回传（N 字符，M deltas，滤 K thought，已入队执行）」→ 工具执行 → 结果回填 → 下一轮捕获。
3. **响亮停滞演练**：临时在 `decode.js` 里让 `haDecodeGenerateContent` 直接 `return null`（或改坏 `JSON.parse` 调用）→ 刷新扩展与页面 → 发一条消息 → 确认日志「网络捕获解码失败（原文 N 字符），本轮不投递」且页面显示正常 → **撤销该临时改动**。
4. 打开含历史工具调用的旧对话 → 刷新页面 → 确认无任何捕获/投递日志（加载历史不发 GenerateContent，无历史重放风险）。

- [ ] **Step 5: 最终全量回归**

Run: `pnpm test` → Expected: 全绿（24 文件 / 239 测试）
Run: `git log --oneline -5` → Expected: 五个任务提交齐（捕获×3、扩展×1、文档×1）

---

## 验收对照（spec §5.5 → 本计划）

| spec 验收项 | 落点 |
|---|---|
| 单测 1：普通回复 515 字符 / 「你好！」开头 / 无 `{` 头 | Task 1 Step 1（+ 15 deltas / 2 thoughts） |
| 单测 2：工具调用 1215 字符 / `{`起`}`止 / 两对围栏在 | Task 1 Step 1（+ 24 deltas / 5 thoughts / `<::: TOOL_CALL[1]` 配对） |
| 单测 3：decode → ASTParser 贯通（write_file / docs/example.md / CONTENT 前终止） | Task 1 Step 1 贯通 describe |
| 单测 4：非 JSON / 空 part / 仅 thought → null | Task 1 Step 1 健壮性 describe |
| 手动 E2E：全链一轮 / 解码失败响亮停滞 / 历史不触发 | Task 5 Step 4 |
| §6 改动清单（inject/decode/manifest/content/README） | Task 2 / Task 1 / Task 3 / Task 4 / Task 5 |
| §5.5 外补强：运输层单测（假 window） | Task 2 Step 1（`tests/inject-hooks.test.ts`） |
