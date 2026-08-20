# 设计文档：危险命令人工授权（Gemini 桥 v3）

日期：2026-08-19
状态：已确认（用户 2026-08-19 拍板：批量弹窗 / 超时可配置 / 自建暗色弹窗 / 面板开关默认关）

> **从属关系（2026-08-20 修订）**：本文档定义审批**通道与交互**——`GET /task` approval + `POST /approval`、
> 双层超时策略、弹窗形态。**判定范围**已由 `docs/superpowers/specs/2026-08-20-permission-model-design.md`
> （统一权限模型）取代：不再按「危险命令清单」判审批，裁决矩阵（黑名单 / 白名单 / pending）以后者为准；
> 本文档与后者冲突处以**后者为准**。

## 1. 背景与动机

v2 桥模式（`docs/superpowers/specs/2026-08-19-gemini-bridge-design.md`）Ruling ④ 规定：桥模式注入「永远拒绝」的嘴巴，危险命令**自动拒绝**、无人值守。用户在实际使用后改变决定：

- 危险命令自动拒绝后无法执行，用户确认安全时没有执行通道
- 危险命令应由**人工授权**（默认），并可选开启**自动授权**替代人工操作
- 授权交互应发生在**网页插件侧**（弹窗），避免网页 ⇄ CLI 切换

本设计推翻 v2 Ruling ④，定义审批协议与两侧实现。

## 2. 需授权范围（2026-08-20 修订：判定由统一矩阵取代）

**本文初版以鼻子 `DANGEROUS` 清单（9 类模式）判定「危险命令」**：`rm -rf` / `rm -r -f` / `sudo rm`、`DROP TABLE`、`git push --force|-f`、`git reset --hard`、`rmdir /s`、`del /f /s`、`format X:`、`taskkill /f`、`kill -9`（规则库变更时审批自动跟随，鼻子判定曾是唯一事实源）。

该判定已被统一权限模型取代（见首部从属关系）：

- 审批范围 = **未命中白名单的全部调用**（`NEEDS_APPROVAL` / pending），不再按命令分类；
- 黑名单（内置 `src/nose/blacklist.ts`，确定性系统破坏）命中直接拒绝（`BLACKLIST`），**不进审批**；
- 鼻子 `risk-checker.ts` 保留为独立嗅探模块，不再参与裁决。

## 3. 审批协议（桥 ⇄ 扩展）

### 3.1 GET /task 响应改为联合类型

```json
{ "type": "message", "message": "工具执行结果（human-agent）：…" }
{ "type": "approval", "id": 1, "calls": [ { "name": "terminal", "arguments": { "command": "rm -rf /" } } ] }
```

- `message`：原回填消息（含工具协议首条），行为不变
- `approval`：审批请求，`calls` 为本批**全部**危险命令（批量弹窗）；`id` 为单调递增整数

### 3.2 新端点 POST /approval

请求：`{ "id": 1, "allowed": [true, false, …], "whitelist": […] }`（`allowed` 与 `calls` 逐条对齐）。

- `whitelist`：**可选**字段（2026-08-20 新增），条目 `{ tool, key, kind }[]`，由弹窗「加入白名单」按钮产生。桥侧校验：条目必须对应本批中 `allowed=true` 的调用——`exact` 条目的 tool/key 必须与该调用的匹配串完全一致；`path` 条目分两粒度——「此路径」key = 该写调用的 path 自身（文件条目）、「此目录」key = 父目录 + `/`（目录条目）；校验通过才写入白名单文件，不合法 → 400 `{ "error": "whitelist 条目不合法" }`。

响应：已知且未处理的 id → `{ "ok": true }`；未知 id（已超时 / 已处理 / 不存在）→ 404 `{ "error": "unknown approval" }`。

### 3.3 超时策略（双层）

| 层 | 超时值 | 判定位置 | 触发时行为 |
|---|---|---|---|
| 插件层（主） | 面板「审批超时（秒）」可配置，默认 120，范围 10–600 | 扩展弹窗倒计时 | 到点自动 POST 全拒绝 → 桥服务生成「审批超时，未执行」拒绝行 |
| 桥服务层（兜底） | 固定 600s（`approvalTimeoutMs` 可注入，测试用短值） | 桥服务审批等待表 | 全部按拒绝处理，防插件崩溃/断网时审批永久挂起与等待表泄漏；文案同为「审批超时，未执行」 |

正常路径插件 120s 先行触发，桥服务兜底仅作安全网。

## 4. 桥服务流水线（src/brain/gemini-bridge-thinking.ts）

`#process` 改为四段（2026-08-20 修订：预筛与反思裁决合并为基类统一 `reflect`）：

1. **统一裁决**：`this.reflect(calls)`（BaseThinking / Reflection，基类持有 PermissionPolicy）——黑名单命中 → `BLACKLIST` 拒绝行（不进审批）；未知工具 / 参数非法 → 拦截拒绝行；白名单命中 → 直接放行；其余 → pending
2. **批量审批**：pending 非空 → 审批请求（一条，含全部）入 outbox → 等待审批结果：`Promise.race(审批结果, 兜底超时, 批 signal 中断)`。中断/兜底超时 → 全部拒绝；`POST /approval` 到达 → 逐条放行/拒绝 + `whitelist` 条目校验落盘（见 §3.2）。审批等待表（`Map<id, resolver>`）在 `close()` 时全部按拒绝释放
3. **执行与输出**：批准的并入执行序列（共享执行器 `executeTool`，批超时 `timeoutMs` 仍约束执行阶段），**执行顺序 = 原 calls 顺序**（逐条串行）；拒绝/超时的生成拒绝行 `已拒绝（USER_DENIED：用户未授权/审批超时，未执行）`。结果行按**原 calls 顺序**排列输出，回填照旧

### 4.1 消息队列结构

`#outbox` 从 `string[]` 改为 `Array<{type:"message",message:string} | {type:"approval",id:number,calls:ToolCall[]}>`；`#serveMessage` 按类型序列化。协议首条（工具协议文本）为 `message` 类型。

### 4.2 拒绝文案

- 黑名单命中：`已拒绝（BLACKLIST：系统破坏操作，禁止执行）`——不下发审批（2026-08-20 新增）
- 用户拒绝：`已拒绝（USER_DENIED：用户未授权，未执行）`
- 插件超时 / 桥兜底超时：`已拒绝（USER_DENIED：审批超时，未执行）`
- `serializeBlockedLine` 对 USER_DENIED 分支改用 `error.message` 承载具体原因（现有「危险命令自动拒绝」固定文案删除，相关测试同步更新）

## 5. 扩展侧（extensions/gemini-bridge/）

### 5.1 面板新增

| 设置 | 说明 |
|---|---|
| 自动授权危险命令 | checkbox，默认**关**；开=收到审批请求静默 POST 全允许，不弹窗；storage.sync 持久化 |
| 审批超时（秒） | 数字输入，默认 120，范围 10–600；倒计时与自动拒绝按此值 |

### 5.2 审批弹窗

- 自建暗色 DOM 弹窗（页面遮罩 + 居中卡片，ha-* 风格，与面板一致）：标题「工具授权」；逐条显示调用（monospace）+ 通用风险提示；每条 [允许本次] [拒绝] + 白名单动作——非写类 [加入白名单（exact）]、写类 [白名单(此路径)] [白名单(此目录)]；「全部允许 / 全部拒绝」保留
- **白名单按钮是显式动作**：点击即视为允许该条，条目并入本次 POST /approval 的 `whitelist` 数组；「全部允许」不自动入白名单；拒绝/超时同步撤销同条白名单条目（保证载荷与 `allowed` 一致，不触发桥侧 400）
- 弹窗顶部显示倒计时「Xs 后自动拒绝」（1s 刷新，按面板审批超时配置），到点自动 POST 全拒绝并关闭弹窗
- 用户操作 → POST /approval（经 background 中转，沿用现有 POST /result 的 10s 超时与降级模式）→ 关闭弹窗
- 弹窗期间状态行「等待授权」（琥珀色，加入 statusTone 体系）；桥不可达时审批请求到达不了插件，兜底超时兜住

### 5.3 兼容性

桥服务与扩展**同一提交内同步更新**（本地工具，无版本协商）；老扩展遇 approval 类型会因缺 `message` 字段回填失败——提示用户同步重载。

## 6. 安全语义变更

- v2 Ruling ④「危险命令自动拒绝」→ 本 spec「默认人工授权（弹窗），面板可开启自动授权（静默放行）」→ **统一权限模型**（2026-08-20）：黑名单两模式一致直接拒绝（BLACKLIST，不可入白名单）、白名单命中静默、未列入默认弹窗 / 自动模式静默（详见 `docs/superpowers/specs/2026-08-20-permission-model-design.md`，以该文档为准）
- 同步更新：`docs/superpowers/specs/2026-08-19-gemini-bridge-design.md`（Ruling ④ 章节）、扩展 README、项目 CLAUDE.md
- 审批等待不阻塞其他消息：审批期间新 POST /result 照常入串行队列（`#busy` 链），批处理完成后才处理下一批

## 7. 测试（TDD）

`tests/gemini-bridge-thinking.test.ts` 新增：

1. 危险命令产生 approval 类型出队消息（`GET /task` 返回 `{type:"approval",…}`，含全部危险 calls）
2. POST /approval 全允许 → 命令执行，结果行回填
3. POST /approval 逐条 [true,false] → 允许的执行、拒绝的生成 USER_DENIED 拒绝行
4. 未知 id → 404
5. 兜底超时（注入 `approvalTimeoutMs: 50`）→ 全部拒绝、「审批超时」文案、等待表清理
6. `close()` 释放挂起审批（按拒绝）
7. 批 signal 中断时审批作废、批次丢弃
8. 参数非法的危险命令不进审批，直接 INVALID_ARGS 拒绝行
9. 纯安全命令批不产生审批消息（回归）
10. 既有「危险命令自动拒绝」测试改写为审批流程语义

扩展弹窗/倒计时无测试基建，浏览器手动 E2E 验证。

（2026-08-20 修订：上表对应初版预筛语义，实现已按统一矩阵改写——黑名单拦截不审批、白名单静默不下发、NEEDS_APPROVAL 下发审批、whitelist 校验写入、自动模式黑名单外全放行。）

## 8. 改动范围

| 文件 | 改动 |
|---|---|
| `src/brain/gemini-bridge-thinking.ts` | 联合消息类型、预筛、审批等待表、POST /approval、流水线四段、close 释放 |
| `tests/gemini-bridge-thinking.test.ts` | 上述 10 项测试 |
| `extensions/gemini-bridge/content.js` | 面板两设置、审批弹窗、倒计时、POST /approval、状态 tone「等待授权」 |
| `extensions/gemini-bridge/background.js` | POST /approval 中转 |
| `extensions/gemini-bridge/README.md` | 设置表、审批说明 |
| `docs/superpowers/specs/2026-08-19-gemini-bridge-design.md` | Ruling ④ 修订 |
| `CLAUDE.md` | 桥模式安全语义更新 |
