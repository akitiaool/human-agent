# API 重设计 spec：三域三根（tool / permission / bridge）

日期：2026-10-12
状态：待审阅
前置：`docs/superpowers/specs/2026-10-11-workspace-permission-design.md`（本 spec 取代其 API 形态部分；行为语义除本文另有规定，一律保持不变）

## 0. 背景与目标

现状问题（终审与用户评审发现）：

1. **载荷形态混乱**——半信封 `{ok:true,<payload>}`（/protocol /info /candidates /result）、裸载荷（GET /task 的 `{type:...}`）、空回执 `{ok:true}`（/whitelist /approval /candidates/dismiss）、字符串错误 `{error:"人话"}`、裸 204 五种形态并存。
2. **信任编辑 API 契约粗糙**——`addEntry` 布尔语义塌陷（duplicate/covered/rejected 不可分）、空键哨兵、双归一器、乐观日志；⑯（入库即核销与落盘脱钩）与 6 条缓办 minor 同根。
3. **命名无分类**——无域前缀，同类 API 散落（policy / workspace-path / candidates / blacklist / knowledge / bridge 各说各话）。
4. **扩展侧手抄语义**——`content.js` 的载荷键近似归一与镜像集合（工具名列表、kind 推导、补键逻辑），与桥侧语义双份维护。

目标：唯一可信来源，统一规则——每个标识符有域归属（前缀），每个判别有唯一词（status），扩展零手抄，格式防漂移（硬规见 §8）。

## 1. 分类与命名法

**顶层域定稿**：

| 面 | 根 | 内容 |
|---|---|---|
| TS | `tool` | 工具知识域：工具是什么、怎么匹配 |
| TS | `permission` | 权限域：键、工作区、裁决、白名单、黑名单、候选 |
| TS | `bridge` | 桥管道域：HTTP 服务与流水线 |
| wire | `task` | 管道面（长轮询取件 / 回填 / 审批回执） |
| wire | `permission` | 权限面（候选 / 入库 / 清除；查看与撤销预留） |
| wire | `agent` | 宿主信息面（协议 / 信息；状态流预留） |

- **消费者不占根，主题才占根**：extension 与（未来）前端都消费 `permission` / `agent` 面，根按主题切分。
- **全路径命名**：`域.子域.动词`（如 `permission.whitelist.grant`）；每个标识符带域前缀。
- **词形规则**（全局单一）：
  - 判别词唯一 `status`；`ok` / `success` 两个布尔判别词全系统退役。
  - 值词（错误码、裁决值、入库状态、`type` 等）全部 **kebab**（原 SCREAMING_SNAKE 退役）。
  - 工具名 **snake**（已获批的协议词，独立子表）。
  - JSON 结构键多词一律 kebab（`deny-count`、`write-path`）。
  - 唯一例外：Node errno 透传码（`ENOENT` 等）保持原样——外部词表，不属于自有词表。

## 2. tool 域（src/tool/）

工具知识的唯一来源（原 `src/brain/knowledge.ts` 迁入并扩展）。

```ts
type ToolName =
  | "file_read" | "file_write" | "file_edit" | "file_patch"
  | "dir_list" | "code_search" | "command_run" | "page_fetch";   // 有序，= 协议展示顺序

interface ToolMeta { target: "path" | "command" | "url"; access: "read" | "write"; }

interface ToolDomain {
  names: readonly ToolName[];              // 有序
  meta: Record<ToolName, ToolMeta>;        // 编译期穷尽
  schemas: Record<ToolName, ZodType>;      // zod 唯一来源；ToolName = keyof typeof schemas（编译期耦合）
  infos: readonly ToolInfo[];              // 供 infer 的工具列表（name/description/parameters）
  covers(entry: TrustEntry, call: { name: string; key: string }): boolean;
  protocol(): string;                      // 【human-agent 工具协议】文本
}
```

**工具元数据表**（8 个）：

| 工具名 | target | access |
|---|---|---|
| file_read / dir_list / code_search | path | read |
| file_write / file_edit / file_patch | path | write |
| command_run | command | write |
| page_fetch | url | read |

**covers 规则**（唯一覆盖判定，取代 `toolMatches` / `keyMatches` 两个旧判定）：

- **工具方向**：同名 → 覆盖；否则同 `target` 且「条目 access=write 或调用 access=read」→ 覆盖（即写条目覆盖同 target 一切调用、读条目覆盖同 target 读调用；跨 target 仅同名）。表外工具名：仅同名。
- **键方向**：`scope:"self"` → `entry.key === call.key`；`scope:"subtree"` → `call.key === entry.key`（目录条目自覆盖）`|| call.key === entry.key 去尾 "/" || call.key.startsWith(entry.key)`。
- 二者同时成立才覆盖。

**文件布局**（对外面以本文档为准，内部拆分随实现）：`index.ts`（组装）+ `schemas.ts`（schema + 描述 + meta，唯一来源）+ `protocol.ts`（协议文本模板，规则正文只做工具名逐字替换）。

**类型归属**：`ToolName` / `ToolMeta` / `TrustEntry` 定义于 tool 域，permission / bridge / 扩展契约从 tool 导入。

## 3. permission 域（src/permission/）

### 3.1 门面

```ts
createPermission(options: {
  workspace: string;            // 已 realpath 规范的绝对路径
  whitelistFile?: string;       // 缺省 ~/.human-agent/whitelist.json
  candidatesFile?: string;      // 缺省 ~/.human-agent/candidates.json
  realpathFn?: RealpathFn;      // 测试注入
  logger?: (message: string) => void;  // 缺省 console.error；落盘失败经此报告（原静默行为废除）
}): Permission
```

构造时绑定工作区与文件，**成员不再收 workspace 参数**；构造即自动注册工作区写白名单（等价原 `ensureWorkspace`，幂等：`{tool:"file_write", key:"<工作区键>/", scope:"subtree"}`）。

```ts
interface Permission {
  workspace: { constraint(): string };   // 工作区声明文本（沿用现文案）
  key: {
    of(call: ToolCall): string | undefined;          // 规范匹配键：workspace 基准 resolve → realpath 深度归实 → win32 小写；失败/参数缺失 undefined
    normalize(entry: Pick<TrustEntry,"tool"|"key">): string;   // 唯一条目键归一（原三件套合一）
    entryFor(tool: string, key: string, scope: Scope): TrustEntry | null;  // 构造条目；非法 → null
    optionsFor(call: ToolCall): TrustEntry[];        // 该调用合法选项集（审批载荷预构造用）
    execPath(input: string): string;                 // 执行落点：realpath 归实优先，失败回退词法绝对化（永不为 null）
  };
  verdict: { decide(call: ToolCall): PermissionVerdict };
  whitelist: { grant(entry: TrustEntry): GrantResult; list(): TrustEntry[] };
  blacklist: { list(): { command: string[]; "write-path": string[] } };
  candidates: {
    record(tool: string, key: string, outcome: "allowed" | "denied"): void;
    list(): CandidateRecord[];
    dropCoveredBy(entry: TrustEntry): number;        // 返回核销条数
    drop(items: readonly { tool: string; key: string }[]): number;  // 返回清除条数
  };
}
```

**模块级成员**（构造前使用——鸡生蛋：实例需要先有 workspace）：

```ts
permission.workspace.resolve(cliValue?: string, envValue?: string, cwd: string, realpathFn?):
  | { status: "ok"; workspace: string }
  | { status: "error"; error: { code: "workspace-invalid"; message: string } }
```

三级决议 `--workspace` > `HUMAN_AGENT_WORKSPACE` > 启动 CWD；realpath 规范化；必须为已存在目录。

### 3.2 关键语义

- **`key.of`**：command_run → 命令归一；路径类 → 管道匹配键（`code_search` 缺 dir 按 `"."` 计）；其余 → 排序参数 JSON。**管道失败按未信任，绝不回退词法结果用于匹配**（不变量）。
- **`key.normalize`**（单一归一器，取代 `normalizePath` / `normalizeMatchKey` / `normalizeEntryKey`）：command_run → 命令归一（trim + 空白折叠 + 反斜杠转正斜杠）；path 类 → 路径归一（段级解析 + win32 小写；目录条目尾 `/` 保留）；其余 → 原样 trim。
- **`key.entryFor(tool, key, scope)`**：`self` → `{tool, key, scope:"self"}`；`subtree` → 子树根 = 读目录类（dir_list / code_search）目标自身 + `/`、其余父目录 + `/`；根级/盘符根降级为 `self`；非路径类 + `subtree` → `null`；空键 → `null`。**读目录类「此目录」= 目标自身 + `/` 的语义就此成文**（清 2026-10-11 spec 遗留注记）。
- **`key.optionsFor(call)`**：键缺失 → `[]`；路径类 → `[self, subtree?]`（subtree 可用且不与 self 重合时第二项）；command/url → `[self]`。顺序即展示顺序。
- **`key.execPath`**：与 `of` 同一管道；它专门服务执行落点（执行落点 = 判定落点的既有不变量由此保持）。
- **`verdict.decide`**：黑名单 → 白名单 → 未列；写形态黑名单对调用的命中条件为 `meta.target==="path" && meta.access==="write"`（等价原 WRITE_TOOLS 行为）。返回 `{ status: "blacklisted" | "whitelisted" | "unlisted", key? }`（`PermissionVerdict`；2026-10-14 更名：恢复名单根、三值同为过去分词）。
- **行为不变量**（保持不变）：裁决顺序（黑名单 → 未知工具 → 非法参数 → 白名单放行 → pending，顺序与判定归 reflection 层）；写信任蕴含读；目录条目 `w/` 覆盖 `w`；白名单冗余清理方向语义（加父去子、子被父盖跳过）；候选容量帽 200 条 / 30 天；候选不入档三情形（黑名单命中、白名单命中、close 释放）；落盘失败不崩溃。

### 3.3 grant 面（⑯ 结构修复）

```ts
type Scope = "self" | "subtree";
interface TrustEntry { tool: string; key: string; scope: Scope; }   // 取代 WhitelistEntry {tool,key,kind}

type AddResult =
  | { status: "added" }
  | { status: "duplicate" }
  | { status: "covered"; by: TrustEntry }      // 已有父条目覆盖
  | { status: "rejected"; reason: "unknown-tool" | "empty-key" };

interface GrantResult { entry: TrustEntry; add: AddResult; retired: number; }
```

- `grant` = 归一（`key.normalize`）→ 校验（未知工具 / 空键 → rejected）→ 去重（duplicate）→ 被覆盖（covered）→ 加父去子 → 落盘。
- **核销只在 add 生效（`status==="added"`）时执行**：`retired = candidates.dropCoveredBy(归一后条目)`；其余状态 `retired = 0`。落盘失败经注入 logger 报告（内存条目仍生效）。
- 原布尔返回、空键哨兵、双归一器、乐观日志随本面重做一并消解（6 条缓办 minor 的结构根因）。

### 3.4 文件格式 v1 与共享存储

两个文件统一为同一容器（`src/permission/store.ts` 单一读写/校验模块）：

```json
{ "version": 1, "workspaces": { "<工作区匹配键>": [ ...条目或记录... ] } }
```

- 白名单条目：`{ tool, key, scope }`；候选记录：`{ tool, key, "deny-count", "allow-count", "first-seen", "last-seen" }`（六字段语义不变，拼写随词形规则）。
- 加载：严格 zod 逐条校验（结构 + tool 名 ∈ tool.names），不符即丢；`version !== 1` → 整档空。
- **无迁移代码**：旧格式 / 旧工具名条目整档作废属预期（工具重命名本就使其全部失效）。

## 4. bridge 域（src/bridge/）

```ts
bridge.createBridge(options: {
  workspace: string;                    // 已决议
  port?: number;                        // 缺省 8765；CLI 读 GEMINI_BRIDGE_PORT 解析后传入（非法回退 8765）
  signal?: AbortSignal;                 // 全局中断
  timeoutMs?: number;                   // 批级执行超时，缺省 300_000
  logger?: (text: string) => void;
  whitelistFile?: string;
  candidatesFile?: string;
  eyes?: EyesContract;                  // 缺省组装（agent.ts 的共享器官工厂）
  hands?: HandsContract;
}): BridgeService                        // 构造即绑定监听 127.0.0.1

interface BridgeService { getPort(): Promise<number>; close(): void; }
```

内部组合：`createPermission` 一枚实例 + `createReflection({permission})` + 执行器。管道不变量保持不变：`parseToolCalls` 严格解析（无容错兜底）、无调用 `processed:false` 自终止、pending 批量审批（600s 兜底超时）、批级执行超时、候选两钩子（审批回执落地即记、600s 超时 settle 记拒绝）、close 释放不记候选。

**审批载荷（扩展零手抄的载体）**：

```ts
{ type: "approval", id: number, calls: ToolCall[], options: TrustEntry[][] }
```

`options[i]` = `permission.key.optionsFor(calls[i])` 预构造的合法选项；扩展只渲染按钮并原样回显所选条目，桥侧按批校验（回显条目须 deep-equal 某 `allowed[i]===true` 调用的选项集成员）。

`buildBridgeService` 与 `GeminiBridgeThinking` 类删除：CLI 直接 `bridge.createBridge(...)`；HumanAgent 保持独立（REPL 路径），器官缺省工厂（eyes/hands）由 agent.ts 导出供桥复用。

## 5. wire 协议

### 5.1 信封（传输层判定，每响应一封）

```ts
type Envelope<T> =
  | { status: "ok"; data?: T }                    // 无载荷省略 data
  | { status: "error"; error: { code: string; message: string } };
```

- `status` = 传输判定（这次 HTTP 交换本身成没成）；域判定装在 `data` 里（域结果自带 `status`）。消息-数据-状态映射：`status`=判定、`data`=载荷、`message` 仅存在于失败侧（`error.message`）——成功响应不写人话，业务说明一律进 `data`。
- 决定性语义：`command_run` 超时 → 信封 `status:"ok"`、data 里域结果 `status:"error", error.code:"exec-timeout"`；body 畸形 → 信封 `status:"error", error.code:"invalid-body"`、域结果不存在。**域失败永不抬升为信封失败。**
- 传输错误码（closed）：`invalid-body` / `unknown-endpoint` / `method-not-allowed` / `unknown-approval` / `internal`；message 为中文人话。HTTP 状态：400 / 404 / 405 / 404 / 500 对应。
- **裸 204 仅用于空长轮询**；其余一切响应（含空回执）都是信封。

### 5.2 端点全表

```
task/（管道面）
GET  /task                    长轮询 ~25s：200 信封 data={type:"message",message} | {type:"approval",id,calls,options}；空 → 204
POST /task/reply              {reply} → 200 data:{processed}                 ← 原 /result
POST /task/approval           {id, allowed: boolean[], whitelist?: TrustEntry[]}
                              → 200（空回执，data 省略）；id 无效 → 404 unknown-approval  ← 原 /approval

permission/（权限面）
POST /permission/whitelist    {items:[{tool,key}], scope} → 200 data:{grants:[{entry,add,retired}]}
                              全量原子校验：任一非法（结构/未知工具/scope/子树不适用/空键）→ 400 invalid-body，整批不落盘
GET  /permission/candidates   → 200 data:{candidates:[…]}（滤除已被白名单覆盖）  ← 原 /candidates
POST /permission/candidates/dismiss  {items:[{tool,key}]} → 200 data:{dropped}  ← 原 /candidates/dismiss

agent/（宿主信息面）
GET  /agent/protocol          → 200 data:{protocol}   // permission.workspace.constraint() + "\n\n" + tool.protocol()  ← 原 /protocol
GET  /agent/info              → 200 data:{workspace}  ← 原 /info
```

路由驱动：路径 → 允许方法表；命中路径方法不符 → 405 method-not-allowed；未命中路径 → 404 unknown-endpoint；处理器异常 → 500 internal。

### 5.3 请求校验

- body 解析失败 / 字段校验失败 → 400 `invalid-body`，message 说明具体字段。
- 审批回执 `whitelist`：条目须 deep-equal 本批某 `allowed=true` 调用的 `options[i]` 成员，否则 400。
- 候选入库 `items` 为空或非数组 → 400（原子校验含空批）。

## 6. 扩展契约（零手抄）

- **删除**：`content.js` 的载荷键近似归一、工具名列表 / kind 推导 / 补键镜像集——扩展不再知道任何键语义。
- **审批弹窗**：按 `options[i]` 渲染——两项 → `[白名单(此路径)]` `[白名单(此目录)]`；一项 → `[白名单]`；零项（键缺失）→ 仅允许/拒绝。回执 `whitelist` = 所选 option 条目原样回显。
- **候选面板**：发送 `{items:[{tool,key}], scope}`（scope 由面板粒度选择提供），桥物化条目；响应 `grants` 记入日志；400 的 message 直接呈现。
- **三档未信任处置**：机制不变（默认拒绝/默认允许档仍为策略代答：自动 fill `allowed` 数组，whitelist 空）——桥侧候选记录对两档同样生效（补种清单 / 放行审计）。
- **端点改名**：background.js 八个中转路径同步；面板「工作区」行取 `GET /agent/info`；协议拉取取 `GET /agent/protocol`。
- manifest 版本号随实现递增（v0.4.0）；`README.md` 端点 / 载荷 / 权限模型章节同步更新。

## 7. 统一词表（全表）

**工具名**：file_read / file_write / file_edit / file_patch / dir_list / code_search / command_run / page_fetch（旧：read_file / write_file / edit_file / apply_patch / read_dir / search_code / terminal / fetch_page）。

**判别值**：

| 词表 | 值 |
|---|---|
| 信封 status | ok / error |
| 裁决（PermissionVerdict） | blacklisted / whitelisted / unlisted |
| 反思（ReflectionVerdict） | allowed / pending / blocked |
| 拦截原因（blocked.reason） | blacklist / unknown-tool / invalid-args |
| 入库（AddResult） | added / duplicate / covered / rejected |
| 拒绝原因（rejected.reason） | unknown-tool / empty-key |
| 候选记录 | allowed / denied |
| 条目类型（task item type） | message / approval |
| 粒度（TrustEntry.scope） | self / subtree |

**自有错误码**（kebab，原 SCREAMING 退役）：blacklist、unknown-tool、invalid-args、user-denied、dependency-blocked、exec-timeout、exec-error、read-error、write-error、patch-not-found、empty-search、invalid-pattern、fetch-error、workspace-invalid。

**传输错误码**（closed）：invalid-body、unknown-endpoint、method-not-allowed、unknown-approval、internal。

**外部透传**：Node errno 码（ENOENT 等）原样。

**范围说明**：器官生命周期枚举（AgentStatus/AgentPhase）与 RiskLevel 为内部状态机、不跨面、非结果判别词，维持原样。

## 8. 防漂移硬规（5 条）

1. **编译期耦合**：`ToolName = keyof typeof schemas`；`meta: Record<ToolName, ToolMeta>` 穷尽——新增工具不补 meta / schema 不通过编译。
2. **扩展零手抄**：扩展代码不含任何工具名语义、键归一、条目构造；一切语义经载荷（options / items+scope）由桥提供。
3. **文件 version + zod strict + 单一序列化器**：两文件同容器 `{version:1, workspaces}`；写入只经 `store.ts`。
4. **词根表进 CLAUDE.md**：域根（tool / permission / bridge）、wire 根（task / permission / agent）、词形规则、判别词唯一 status——新增标识符必须归入既有词根或显式修改本文档。
5. **命名空间成员快照测试**：tool 面、permission 实例各子命名空间、bridge 服务面的成员列表冻结断言——新增成员必须显式更新快照（有意识决定归属）。

## 9. 旧 → 新映射（实施对照）

**TS**：

| 旧 | 新 |
|---|---|
| `src/brain/knowledge.ts`（schemas/descriptions/TOOLS/serializeToolProtocol） | tool 域（schemas / infos / protocol） |
| `BaseThinking`（thinking.ts 整类） | 解散：成员按下表落户，壳层删除 |
| `BaseThinking.reflect` | `createReflection({permission}).reflect`（BrainInference.reflect 保留；OllamaThinking 委托） |
| `BaseThinking.classify` / `policy.classify` | `permission.verdict.decide` |
| `BaseThinking.keyFor` / `matchKeyFor` / `policy.keyFor` | `permission.key.of` |
| `BaseThinking.whitelistEntries` / `policy.entries` | `permission.whitelist.list` |
| `BaseThinking.addWhitelistEntry` / `policy.addEntry` | `permission.whitelist.grant` |
| `BaseThinking.workspaceConstraint` | `permission.workspace.constraint` |
| `BaseThinking.toolProtocol` | `permission.workspace.constraint() + "\n\n" + tool.protocol()`（归属端组合） |
| `resolveStartupWorkspace` | `permission.workspace.resolve` |
| `resolveWorkspacePath` / `normalizeMatchKey` | `permission.key.of` / `key.execPath` 内部管道 |
| `normalizePath` / `normalizeEntryKey` | `permission.key.normalize` |
| `buildWhitelistEntry` / `dirEntryKey` | `permission.key.entryFor` / `key.optionsFor` |
| `WRITE_TOOLS` / `READ_TOOLS` / `toolMatches` / `keyMatches` / `covers` | `tool.meta` + `tool.covers` |
| `BLACKLIST_PATTERNS` / `BLACKLIST_WRITE_PATH_PATTERNS` / `isPathTool` | `permission.blacklist.list`（模式源串视图；命中判定在 permission 内部）；isPathTool 删除（optionsFor 取代） |
| `CandidatesArchive.record / removeCovered / remove` | `permission.candidates.record / dropCoveredBy / drop` |
| `GeminiBridgeThinking` / `buildBridgeService` | `bridge.createBridge` |
| `WhitelistEntry {tool,key,kind}` | `TrustEntry {tool,key,scope}` |
| `ActionResult.success:boolean` | `{status:"ok",data?} \| {status:"error",error:{code,message,stack?}}`（判别联合，非法态消失） |
| `ok()/fail()` | 保留名，返回新形状；全部域错误码换 kebab 表 |
| `AgentLoopOptions.workspace` | `AgentLoopOptions.permission`（同一实例必须与 brain 共持） |
| `executeTool` context `{workspace,realpathFn}` | `{permission}`（execPath 出自实例；缺省原透传） |
| `BrainInference.addWhitelistEntry / workspaceConstraint` | 从接口删除（消费方直取 `permission.*`） |
| `ApprovalPrompt.kind` | `ApprovalPrompt {tool, key, options: TrustEntry[]}`；`ApprovalChoice.whitelist.entry: TrustEntry` |
| `HumanAgentOptions.whitelistFile/workspace` | 保留（HumanAgent 内部建 permission，注入 brain 与 loop） |

**wire**：GET /task（载荷加 options，不变）；/result → POST /task/reply；/approval → POST /task/approval；/protocol → GET /agent/protocol；/info → GET /agent/info；/candidates → GET /permission/candidates；/whitelist → POST /permission/whitelist（载荷改 items+scope）；/candidates/dismiss → POST /permission/candidates/dismiss。

**不留任何旧名别名 / 兼容 shim**；既有测试按上表重写。

**文档同步**：CLAUDE.md（词根表 + 阶段七记录）、extensions/gemini-bridge/README.md（端点 / 载荷 / 权限模型）。

## 10. 预留（本轮不建，仅登记形态意图）

- `GET /permission/whitelist` → `data:{entries}`（查看）
- `POST /permission/whitelist/revoke` → `data:{revoked}`（撤销）
- `GET /permission/blacklist` → `data:{command, write-path}`（查看）
- `GET /agent/status`（状态 / 日志流）——形态待定
- 前端页面：桥同源 serve（同源无 CORS、单进程）；页面位随实现定（如 /console）
- 前端审批转移：前置条件 = 管道单消费者仲裁（extension 与前端同时长轮询 `GET /task` 会互抢回填消息）

## 11. 非目标

- 不建前端页面；不做沙盒；不做多工作区（一进程一工作区不变）。
- 不迁移旧 whitelist.json / candidates.json / 旧工具名条目（version≠1 视同空白）。
- 不动器官内部实现（eyes / hands / mouth / ears / loop 节拍）；仅按 §9 更新调用点与契约字段。
- 不动协议文本规则正文（仅工具名逐字替换）；不动扩展视觉 / 交互设计（除 §6 所列）。
- 不动器官生命周期枚举与 RiskLevel（§7 范围说明）。

## 12. 验收

1. `pnpm test` 全绿（按映射重写后）+ `pnpm build` 干净（strict、无 any）。
2. 硬规 5 落地：快照测试存在且断言成员表；`content.js` 经人工 review 确认无键语义（硬规 2 无法自动化断言，列入 review 清单）。
3. 桥真实 E2E 手动验收（新面）：`GEMINI_BRIDGE_PORT=8765 pnpm dev` 起桥 → curl `GET /agent/protocol`、`GET /agent/info` 信封正确、`GET /task` 约 25s 后 204；扩展装 v0.4.0：先对目录授权（subtree）再对同树文件授权（self），`whitelist.json` version 1 两条均在；路径穿越相对值归实后命中黑名单；界内写入静默；候选面板单选/多选入库并核销；三档（默认弹窗 / 默认拒绝 / 默认允许）逐一验证。
4. 词根表已进 CLAUDE.md；extensions README 与端点表核准一致。
