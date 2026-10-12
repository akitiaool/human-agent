# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态

仓库权威设计来源为 `docs/human-agent 架构设计与开发规范文档.txt`（v1.0.0）。

已完成的骨架：Git 仓库（main 分支）、`package.json`、`tsconfig.json`（strict + NodeNext ESM，产物到 `dist/`）、`bin/cli.ts`（commander 最小入口）、依赖安装（`pnpm` 管理）。

阶段一类型契约已完成：`src/types/organ.ts`（`ActionResult` + `ok`/`fail`、`RiskLevel`、`EnvSnapshot`、`AgentStatus`/`AgentPhase`、各器官 `*Contract` 接口）、`src/types/index.ts` 与 `src/index.ts` 出口。

阶段二（双手/眼睛/鼻子）已完成（TDD，测试在 `tests/`，vitest 4）：
- `src/nose/risk-checker.ts`：危险特征规则库（rm -rf、DROP TABLE、git push --force 等）→ SAFE/DANGEROUS
- `src/nose/env-checker.ts`：环境快照（OS、CWD、git 分支），`getEnvSnapshot({ cwd })` 可指定目录；`checkPorts(ports)` 探测端口占用（net.connect：可连=占用、ECONNREFUSED=空闲、其余保守视为占用）
- `src/eyes/file-reader.ts`：readFile/readDir/searchCode（searchCode 支持目录参数、跳过 node_modules/.git/dist、相对搜索根返回路径）
- `src/eyes/web-crawler.ts`：WebCrawler（turndown 转 Clean Markdown，atx 标题 + fenced 代码块；可注入 fetchImpl；非 200/网络异常包装为 FETCH_ERROR 不抛错）
- `src/hands/terminal.ts`：execa 10 执行命令，`{ shell: true, encoding: "utf8" }`，错误返回 `EXEC_ERROR` + shortMessage；**单命令超时**：`executeCommand(command, signal?, timeoutMs?)` 第三参透传 execa 原生 `timeout`（conditional spread，`exactOptionalPropertyTypes`），`err.timedOut` → `EXEC_TIMEOUT`（区分于中断的 EXEC_ERROR）；注意 Windows + shell:true 下被杀的是 shell 进程，命令自身子进程可能残留
- `src/hands/file-writer.ts`：writeFile（自动建父目录）+ applyPatch（行级 `- 删除`/`+ 插入` patch 格式，文档见文件头注释）

阶段三（嘴巴/耳朵）已完成（TDD）：
- `src/mouth/text-output.ts`：speak 打字机流式输出（首字符立即、可选 intervalMs）、info/success/warn/error 彩色日志、printDiff 的 +/- 行着色；构造可注入 stdout/chalk 实例（测试用 `new Chalk({ level: 3 })`）
- `src/mouth/ask-user.ts`：confirm(message) 阻塞式 [Y/n] 确认，默认 Y，无效输入循环追问；构造可注入 input/output 流
- `src/ears/text-input.ts`：prompt(question) 读入并 trim；**单实例只创建一个 readline 接口**，空闲期间到达的行进队列不丢失（多行管道输入 `printf "a\n/exit\n" | pnpm dev` 依赖此行为），输入流结束后队列仍可读取、清空后才报错结束会话；提供 `close()` 释放监听

阶段四（大脑/心脏 + 全链路）已完成（TDD，104 tests）：
- `src/brain/llm.ts`：`BrainInference` 统一推理接口（ToolCall/ToolInfo/BrainInferenceResult）
- `src/brain/context.ts`：会话消息队列（system 永不移除，超预算裁剪最旧非 system 消息）
- `src/brain/ollama-brain.ts`：OllamaBrain，走本机 `/api/chat` 协议（`{ baseUrl?: string, model?: string, fetchImpl?: typeof fetch }`），支持工具调用；默认 `http://localhost:11434` + `qwen3:4b`；非 200 抛错（loop 捕获转 ERROR）；assistant 的 toolCalls 序列化为 `tool_calls`（snake_case），工具列表为空时不发 `tools`；`infer(context, tools, signal?)` 第三参为 AbortSignal（fetch 绑定，中断可取消请求）
- `src/heart/interrupt.ts`：AbortController 封装（getSignal/abort/isAborted/reset）
- `src/heart/loop.ts`：生命循环（LISTENING→THINKING→SNIFFING→ACTING→FEEDBACK）；7 个工具的 zod 参数校验（INVALID_ARGS）且 `TOOLS` 携带 JSON Schema `parameters`（ToolInfo 契约）；terminal 危险命令经 mouth.confirm（USER_DENIED）；assistant 消息（含 toolCalls）与 tool 结果都写回上下文（Ollama 续接的前提）；`#processTurn` 返回 boolean（true 表示中断/出错，规避 TS 对私有字段的收窄问题）；`onPhase` 回调；maxIterations 兜底；**任务超时**：`timeoutMs`（默认 5 分钟，0 禁用）每轮 per-turn AbortController + `AbortSignal.any` 组合 signal（推理请求可取消、子进程可被杀），超时终止本轮并继续监听；斜杠命令 `/timeout`（`parseTimeout` 导出：纯数字毫秒 / s/m/h 单位 / 0|off 禁用）会话中动态更新；`terminal` 工具参数含可选 `timeoutMs`（正整数字节，zod 校验），经 `#dispatch` 透传给 `executeCommand` 第三参——大脑可对单条命令声明独立超时；`HandsContract.executeCommand` 签名同步加 `timeoutMs?`
- `src/agent.ts`：HumanAgent 组装器，默认组装 OllamaBrain + 全部器官（鼻子组合 RiskChecker+EnvChecker，显式组合而非对象展开——spread 不复制原型方法）；环境变量 `OLLAMA_BASE_URL`/`OLLAMA_MODEL` 覆盖默认大脑配置
- `bin/cli.ts`：SIGINT/SIGTERM → `agent.interrupt.abort()`；结束后 `ears.close()` 防挂起；退出码 ERROR=1 / INTERRUPTED=130 / IDLE=0

阶段五（Gemini 桥 + 大脑职责模型重构）已完成（TDD，v2：网页对话驱动 · 智能体仅执行工具）：
- `src/brain/knowledge.ts`：大脑知识库——7 个工具的 zod schema 与 description 唯一来源；`TOOLS`（parameters 由 `z.toJSONSchema()` 派生，消除 TOOL_SCHEMAS 与 TOOLS.parameters 双写）、`schemas`、`serializeToolProtocol()`（工具协议文本，经 `GET /protocol` 按需拉取——插件仅对空对话自动注入，不再入队首条消息）
- `src/brain/reflection.ts`：反思层（潜意识）——确定性代码不经模型，逐条裁决（顺序固定，见阶段六）：权限黑名单（BLACKLIST，两模式一致直接拒）→ 存在性（UNKNOWN_TOOL）→ zod 结构（INVALID_ARGS）→ 白名单命中放行 → 其余标 pending（需授权，审批通道由宿主负责——桥下发 GET /task approval、CLI 走嘴巴三选）；不再经嘴巴 confirm（鼻子 risk-checker 保留为独立嗅探模块，不再参与裁决）
- `src/brain/ollama-thinking.ts`：思考层 Ollama 实现（OllamaThinking，原 ollama-brain.ts 改名），extends BaseThinking implements BrainInference（infer + 基类 reflect/classify/addWhitelistEntry/workspaceConstraint/toolProtocol），CLI 对话模式用；system prompt 拼装含基类工作区声明
- `src/brain/gemini-bridge-thinking.ts`：**执行型桥服务（extends BaseThinking，非 BrainInference）**——内嵌 HTTP 服务默认 127.0.0.1:8765：`GET /task` 长轮询（有回填消息立即返回 {message}，无则挂起约 25s 后 204）+ `POST /result`（接收网页最新内容 {reply} → {ok, processed}）；流水线：校验 reply → 与最近一次内容去重（lastContent）→ `parseToolCalls` 严格解析 ```tool_call``` 代码块（**不做容错兜底**——围栏丢失由插件提取层负责还原，见 extensions 条目），无调用不回填（内容自终止）→ `reflect(calls)` 基类统一裁决（BLACKLIST/未知/非法 → 拒绝行；白名单 → 直接执行；pending → 批量审批下发）→ **pending 批量审批**（`GET /task` 下发 `{type:"approval", id, calls}` → `POST /approval` 回 `{allowed, whitelist?}` 逐条裁决，whitelist 条目校验后落盘，拒绝/超时生成 USER_DENIED 拒绝行，兜底超时 600s）→ 放行的经共享执行器 `executeTool` 执行（批级超时 `AbortSignal.timeout` 默认 300s + 全局中断，超时回填「工具执行超时」说明）→ 结果序列化为「工具执行结果」消息入队并唤醒 GET /task；协议文本由 `GET /protocol` 无状态按需提供（关闭后 204）；`close()` 释放全部长轮询并关服务；**工作区一等化新增端点为**：`GET /info`（当前工作区，面板工作区行显示）、`GET /candidates`（信任候选，滤除已被白名单覆盖）、`POST /whitelist`（候选批量入库——全量原子校验，非法全批 400 不落盘；成功后核销候选）、`POST /candidates/dismiss`（清除所选）；桥自记候选两钩子（审批回执落地即记、600s 超时 settle 记拒绝；close 释放不记）；`POST /approval` 的 whitelist 校验扩展读类两粒度（条目须对应本批 allowed=true 的调用）
- `src/brain/llm.ts`：`BrainInference` 统一接口——`reflect(calls)`（可行性裁决）、`addWhitelistEntry(entry)`（白名单落盘）、`workspaceConstraint()`（工作区声明）；`ReflectionVerdict`（allowed / pending / blocked，`pending` 为需授权标记）/`BlockedCall` 契约
- `src/heart/executor.ts`：（新）共享工具执行器——`executeTool(organs, name, args, signal?)` 工具名 → 双手/眼睛方法的映射路由，loop 与桥服务共用（原 loop `#dispatch` 抽取，行为不变）
- `src/heart/loop.ts`：净化——TOOL_SCHEMAS/TOOLS/zod 校验/危险嗅探/嘴巴确认迁出；`#execute` = `brain.reflect(calls)` 基类统一裁决 → BLACKLIST/拦截结果直接反馈；白名单放行 → executeTool；**pending 走嘴巴三选** `mouth.askApproval(prompt)`（允许/拒绝/加入白名单，写类另有「此目录」），whitelist 动作经 `brain.addWhitelistEntry` 落盘；loop 不再直接依赖 nose，mouth 仅承载审批交互；`AgentPhase` 去掉 SNIFFING（嗅探属大脑反思，不再有心脏阶段）
- `src/agent.ts`：`HumanAgent` **恒为 Ollama 模式**（`GEMINI_BRIDGE_PORT` 不再影响 HumanAgent 的大脑）；新增导出 `buildBridgeService(options?)`——组装真实器官（鼻子 RiskChecker+EnvChecker、眼睛 FileReader/WebCrawler、双手 FileWriter/Terminal）的桥服务，`port` 缺省读 `GEMINI_BRIDGE_PORT`（非法值回退 8765），`signal`/`timeoutMs`/`logger` 可注入
- `bin/cli.ts`：`GEMINI_BRIDGE_PORT` 已设置 → **桥模式分支**（对话全在网页，CLI 仅宿主 HTTP 服务 + 状态日志）：建服务 → `getPort()`（失败友好报错 exit 1）→ 打印监听地址与使用说明 → 等 SIGINT/SIGTERM（中断级联）→ `close()` → exit 130；未设置 → 原 HumanAgent REPL 路径
- `extensions/gemini-bridge/`：Chrome/Edge MV3 扩展（v2 已落地，真实 DOM 选择器 2026-08-19 落定）：content 浮动面板（**自动模式开关 + 防检测设置**：模拟人类**分段粘贴 + 错别字纠错**输入——整段粘贴模拟 Ctrl+V、按概率预留错字→退格→逐字重打、段间随机停顿，段长/纠错概率/延迟区间均面板可配，提交前随机延迟默认 3–8s；桥服务地址可编辑）+ 桥不可达「桥未连接（重试中）」指数退避降级；内容监控循环（稳定采样 + announcer 新鲜度判定；**extractReply 还原代码块围栏**——AI Studio 把 markdown 代码块渲染成 `ms-code-block[data-test-language]`，innerText 丢围栏，提取时克隆替换为 ```lang 围栏文本，保证 ```tool_call 识别信号不丢失）、投递循环（长轮询→模拟输入→自动/手动提交）、新对话检测（会话容器重置→协议文本重新注入）；background 全 try/catch 中转（get-task 30s 超时、POST /result 10s 超时）；**权限模型审批**：投递循环识别审批消息 → 面板「未信任处置」三态选择器（默认弹窗/默认拒绝/默认允许，旧 `autoApprove` 开关一次性迁移 true→默认允许 / false→默认弹窗；默认允许档常显警示）——默认弹窗档逐条人工授权（弹窗标题「工具调用授权」+ 按调用类别提示语；路径类两粒度 [白名单(此路径)] [白名单(此目录)]、其余 exact；全部允许/拒绝 + 倒计时自动拒绝，超时面板可配默认 120s；白名单条目并入 POST /approval 的 whitelist 字段，服务端校验对应 allowed=true 的调用）、默认拒绝/默认允许档策略代答；**信任候选面板**：折叠区（拉取 GET /candidates，单/多选、文件/目录粒度一键入库 POST /whitelist、清除所选 POST /candidates/dismiss）；面板「工作区」行显示 GET /info；background 中转 get-info / get-candidates / whitelist-add / candidates-dismiss

阶段六（统一权限模型）已完成（TDD）：
- `src/nose/policy.ts`：`PermissionPolicy`——黑名单判定 + 白名单加载/匹配/冗余清理/持久化（按工作区绝对路径分节）；`classify` 顺序：黑名单 → 白名单 → 未列；匹配键为**规范匹配键管道**（workspace 基准 resolve → realpath 深度归实 → win32 小写；**失败按未信任，绝不回退词法结果**）——`matchKeyFor`（terminal → 命令、路径类 → 管道 matchKey、其余 → 排序参数 JSON）、`buildWhitelistEntry`（exact/path/dir 三粒度，dir 经 `dirEntryKey`：读目录类 = 目标自身 + `/`、其余 = 父目录 + `/`，根级降级文件条目）；`addEntry` 经 `normalizeEntryKey` 条目归一（保留目录尾 `/`）+ 去重 + 加父去子/子被父盖跳过；目录条目自覆盖（`w/` 匹配 `w`）；`WRITE_TOOLS`/`READ_TOOLS` 从 policy 导出为单一来源（写信任蕴含读：写条目覆盖写∪读、读条目仅覆盖读）；`ensureWorkspace`（启动工作区注册 write_file path-dir 条目，跨工具覆盖）；白名单文件 `~/.human-agent/whitelist.json` 损坏/缺失降级空白名单，加载条目级校验（防手改垃圾条目导致 classify 崩溃）
- `src/nose/workspace-path.ts`：规范匹配键管道 + 启动工作区决议——`resolveWorkspacePath`（词法绝对化 → realpath 深度归实：逐段上溯最深已存在祖先、realpath 后拼回尾段 → `matchKey`）、`normalizeMatchKey`（反斜杠转正斜杠 + win32 小写）、`defaultRealpath`/`RealpathFn` 注入位；`resolveStartupWorkspace`（`--workspace` > `HUMAN_AGENT_WORKSPACE` > 启动 CWD；realpath 规范化且必须为已存在目录）
- `src/nose/candidates.ts`：信任候选档案 `CandidatesArchive`——白名单外一切裁决的持久记录（`~/.human-agent/candidates.json`，按工作区分节、镜像 whitelist 分节键），聚合键 `(tool, key)` 计数 denied/allowed + firstSeen/lastSeen；容量帽 200 条 / 30 天（超限按 lastSeen 丢最旧）；`record`/`list`/`removeCovered`（入库核销）/`remove`（清除所选）；损坏降级空白、落盘失败不崩溃
- `src/nose/blacklist.ts`：黑名单内置模式数组（随版本，用户可手改责任自负）——根/系统盘递归删除、系统目录删除、启动文件、格式化、整盘擦除、块设备直写与重定向、mkfs/分区表、Boot 注册表、必崩进程、权限全毁、**写类工具写系统目录**（path 形态锚定开头 `c:/windows/(system32|boot)` 与 `c:/system volume information`，终结符限定子树——`C:\Windows\Temp` 等可恢复目录不入、裸 `C:\Windows` 根级单文件不入；terminal 命令串不以盘符开头天然不命中）
- `src/brain/thinking.ts`：`BaseThinking` 通用基类——持有 Reflection + PermissionPolicy + workspace（启动 CWD 规范化路径），构造接受 `workspace`/`whitelistFile` 注入（测试隔离防污染真实白名单）；统一裁决入口 `reflect(calls)`（黑名单 → 未知/非法 → 白名单 → pending）、`classify`、`addWhitelistEntry`（白名单落盘）、`workspaceConstraint()`（工作区声明文本）、`toolProtocol()`（工作区声明 + 工具协议文本）；`OllamaThinking`/`GeminiBridgeThinking` 继承（桥与 CLI 裁决行为必然一致）
- `src/brain/reflection.ts`：集成 PermissionPolicy——裁决顺序：BLACKLIST（两模式一致）→ UNKNOWN_TOOL → INVALID_ARGS → 白名单放行 → pending（需授权标记，审批通道由宿主负责）
- `src/mouth/ask-user.ts`：新增 `askApproval(prompt)` 三选审批——`[y] 允许 [n] 拒绝 [w] 加入白名单`，写类另有 `[d] 白名单(此目录)`（父目录段级前缀条目），无效输入循环追问；`MouthContract`/`ApprovalPrompt`/`ApprovalChoice` 契约（types/organ.ts）
- 接入：loop `#execute` pending 走嘴巴三选；桥 pending 批量审批 + `POST /approval` 可选 `whitelist` 字段（校验：条目必须对应本批 allowed=true 的调用——exact 与匹配键一致、path 为「此路径」文件条目或「此目录」目录条目（读目录类 = 自身 + `/`、其余 = 父目录 + `/`），不合法 400）；扩展弹窗白名单按钮（内容见阶段五 extensions 条目）；`src/agent.ts` `HumanAgent`/`buildBridgeService` 透传 `whitelistFile`；CLI 启动 system 消息注入 `workspaceConstraint()`（agent.run 装配）

阶段七（API 重设计）已完成（TDD，333 tests）：三域三根（TS：`tool`/`permission`/`bridge`；wire：`task`/`permission`/`agent`）与统一词形规则见「API 词根表」。
- `src/tool/`（工具域）：工具知识唯一来源——`schemas.ts`（schema + 描述 + meta，`ToolName = keyof typeof schemas` 编译期穷尽）、`protocol.ts`（协议文本模板）、`index.ts`（组装面 `tool`：names/meta/schemas/infos/covers/protocol；`covers` 唯一覆盖判定取代旧 toolMatches/keyMatches）；工具 8 个（旧 → 新名对照见词根表）
- `src/permission/`（权限域）：`createPermission` 门面（构造绑定工作区与文件、自动注册工作区写白名单；成员 `workspace`/`key`/`verdict`/`whitelist`/`blacklist`/`candidates`）+ 模块级 `permission.workspace.resolve`（三级决议）；布局：`store.ts`（白名单与候选同容器 `{version:1, workspaces}`，单一读写/校验）、`key.ts`（规范匹配键管道 + 唯一归一器 + entryFor/optionsFor/execPath）、`verdict.ts`（黑名单 → 白名单 → 未列）、`whitelist.ts`（grant/list；AddResult added/duplicate/covered/rejected）、`candidates.ts`、`blacklist.ts`；**文件格式 v1、无迁移**（旧格式/旧工具名条目整档作废属预期）
- `src/bridge/`（桥域）：`createBridge`（组合 permission + `createReflection({permission})` + 共享执行器，内嵌 HTTP 服务 127.0.0.1）、`envelope.ts`（统一信封 `{status:"ok",data?} | {status:"error",error:{code,message}}`；传输错误码 closed；裸 204 仅空长轮询）、`pipeline.ts`（旧桥状态机移植：严格解析、无调用 processed:false 自终止、pending 批量审批（options 预构造）、候选两钩子）
- 集成与退役：`ActionResult` 判别联合（`success` 布尔退役、错误码全面 kebab）；loop options 收 `permission`（与 brain 共持同一实例）、executor context `{permission}`（执行落点 = 判定落点）；CLI 桥模式直接 `createBridge`；扩展 v0.4.0 零手抄（审批按钮按载荷 options 渲染、候选入库 `{items, scope}`）；旧模块 7 个全数删除、无别名 shim

**尚未开始**：voice/image/browser 等预留器官（`eyes/image-viewer.ts`、`ears/voice-input.ts`、`mouth/voice-output.ts`、`hands/browser-action.ts`）。

`human-agent` 是一个拟人化智能体（Humanoid Agent）CLI 工具，技术栈为 TypeScript / Node.js (>= 20.0.0, ESM)。

## 架构核心：器官模型

顶层模块以人类生物学器官抽象，每层只依赖相邻的神经信号，职责专一：

- 🧠 `src/brain/`（大脑）：思考与推理。工具知识唯一来源在 **`src/tool/` 工具域**（`schemas.ts`/`protocol.ts`/`index.ts`，原 `knowledge.ts` 迁入并扩展）；`reflection.ts` 反思层（`createReflection({permission})` 工厂，确定性裁决：黑名单 → 未知工具 → 非法参数 → 白名单放行 → pending）；`ollama-thinking.ts` 思考层（OllamaThinking implements BrainInference，`infer` + 委托反思层 `reflect`）；`ast-parser.ts` 工具调用解析（ASTParser 状态机，桥管道严格解析用）；`context.ts` 会话消息队列（仅 Ollama 模式用）；`llm.ts` 统一推理接口（原 BaseThinking 壳层与 `gemini-bridge-thinking.ts` 已删除——权限归 permission 域、桥归 bridge 域）
- 🫀 `src/heart/`（心脏）：生命循环。`loop.ts` 推进 `听取指令 → 大脑思考 → 反思裁决 → 手眼执行 → 反馈结果 → 循环/结束`，并承担承受力（任务/单命令超时、maxIterations、中断），options 收 `permission` 实例（与 brain 共持同一实例）；`executor.ts` 共享工具执行路由（`executeTool(organs, name, args, signal, context: {permission})`，loop 与桥管道共用；**执行落点 = 判定落点**——路径类经 `permission.key.execPath` 传递）；`interrupt.ts` 持有全局 `AbortController`
- 👁️ `src/eyes/`（眼睛）：**只读**。文件读/目录遍历/代码检索、网页抓取转 Clean Markdown。
- 👂 `src/ears/`（耳朵）：输入。终端 REPL、语音（预留）。
- 🗣️ `src/mouth/`（嘴巴）：输出。流式 Markdown/彩色终端输出、`confirm(message): Promise<boolean>` 交互确认、`askApproval(prompt)` 三选审批（允许/拒绝/加入白名单，写类另有「此目录」）。
- ✋ `src/hands/`（双手）：**写/执行**。文件写入与 Patch、基于 `execa` 的 Shell 执行（绑定中断信号、超时强杀；`Terminal` cwd 钉工作区——相对命令落点 = 判定落点）。
- 👃 `src/nose/`（鼻子）：观察模块（不参与裁决）。`risk-checker.ts`（独立危险特征嗅探，输出 `SAFE`/`DANGEROUS`）、`env-checker.ts`（环境快照：OS、CWD、Git 分支、端口占用）；权限族模块（policy/workspace-path/candidates/blacklist）已全数迁入 `src/permission/` 权限域。

组装入口：`src/agent.ts`——`HumanAgent` 类构造注入器官（brain/eyes/hands/mouth/ears/output，可选覆盖），内部建 `createPermission`（同一实例注入思考层与 loop），恒为 Ollama 模式；器官工厂 `buildDefaultEyes()`/`buildDefaultHands(workspace)` 导出供桥复用；桥服务入口为 `src/bridge/` 的 `bridge.createBridge(options)`（原 `buildBridgeService()` 已删除）。

## 不可违反的设计原则

1. **动静绝对分离**：眼睛只读、无副作用；双手是破坏性操作必须受控；**一切工具调用**（含读取）经统一权限模型裁决——黑名单（确定性系统破坏）直接拒绝、白名单（用户信任）静默执行、未列入的按宿主档位处置（CLI 恒弹窗三选；桥扩展三档：默认弹窗/默认拒绝/默认允许）。读类进路径级信任维度（file_read/dir_list/code_search），方向为**写信任蕴含读**；审批通过可加入白名单（路径两粒度：此路径/此目录）。
2. **异常即反馈，永不崩溃**：双手/眼睛执行失败（退出码非 0、文件不存在、超时等）**严禁抛出未捕获异常**，必须包装成 `ActionResult` 返回给大脑在下一循环中自我修复。
3. **中断第一公民**：`Ctrl+C` 由心脏毫秒级捕获，级联向所有器官下发 `AbortSignal`，停止子进程、取消网络流、保护现场；器官检测到 `signal.aborted` 后迅速退出并将生命体状态置为 `INTERRUPTED`，会话历史不丢失。
4. **轻量起步**：只装基础设施依赖（chalk、commander、execa、zod），大模型 SDK、TTS/ASR 等重度依赖在具体阶段按需引入。

## 关键契约

所有工具（双手/眼睛）操作统一返回 `ActionResult` 判别联合（`success` 布尔已退役，非法态不可构造；`ok()`/`fail()` 保留名返回新形状）：

```typescript
export type ActionResult<T = unknown> =
  | { status: "ok"; data?: T }
  | { status: "error"; error: { code: string; message: string; stack?: string } };
```

## API 词根表（硬规 4）

每个标识符必须带域归属（前缀），全路径命名 `域.子域.动词`（如 `permission.whitelist.grant`）；消费者不占根、主题才占根。词根与词形规则与 spec（`docs/superpowers/specs/2026-10-12-api-redesign-design.md`）§1/§7 同源。

**域根表**：

| 面 | 根 | 内容 |
|---|---|---|
| TS | `tool` | 工具知识域：工具是什么、怎么匹配 |
| TS | `permission` | 权限域：键、工作区、裁决、白名单、黑名单、候选 |
| TS | `bridge` | 桥管道域：HTTP 服务与流水线 |
| wire | `task` | 管道面（长轮询取件 / 回填 / 审批回执） |
| wire | `permission` | 权限面（候选 / 入库 / 清除；查看与撤销预留） |
| wire | `agent` | 宿主信息面（协议 / 信息；状态流预留） |

**词形规则**（全局单一）：

- 判别词唯一 `status`；`ok` / `success` 两个布尔判别词全系统退役。
- 值词（错误码、裁决值、入库状态、`type` 等）一律 **kebab**（原 SCREAMING_SNAKE 退役）。
- 工具名 **snake**（已获批的协议词，独立子表）；JSON 结构键多词一律 kebab（`deny-count`、`write-path`、`first-seen` 等）。
- 唯一例外：Node errno 透传码（`ENOENT` 等）保持原样——外部词表，不属于自有词表。
- 器官生命周期枚举（`AgentStatus`/`AgentPhase`）与 `RiskLevel` 为内部状态机、不跨面，维持原样（spec §7 范围说明）。

**工具名旧 → 新对照**（8 组；不留任何旧名别名 / 兼容 shim）：

| 旧 | 新 |
|---|---|
| `read_file` | `file_read` |
| `write_file` | `file_write` |
| `edit_file` | `file_edit` |
| `apply_patch` | `file_patch` |
| `read_dir` | `dir_list` |
| `search_code` | `code_search` |
| `terminal` | `command_run` |
| `fetch_page` | `page_fetch` |

**自有错误码**（kebab，域结果用）：`blacklist`、`unknown-tool`、`invalid-args`、`user-denied`、`dependency-blocked`、`exec-timeout`、`exec-error`、`read-error`、`write-error`、`patch-not-found`、`empty-search`、`invalid-pattern`、`fetch-error`、`workspace-invalid`；另按同一规则外推：`hunk-not-found`、`ambiguous-match`、`version-mismatch`、`file-not-found`。

**传输错误码**（closed，信封专用）：`invalid-body`、`unknown-endpoint`、`method-not-allowed`、`unknown-approval`、`internal`（对应 HTTP 400/404/405/404/500；message 为中文人话）。

**防漂移硬规 5 条**（全文见 spec §8）：① 编译期耦合（`ToolName = keyof typeof schemas`、`meta` 穷尽——新增工具不补 meta/schema 不通过编译）；② 扩展零手抄（扩展不含工具名语义/键归一/条目构造，一切语义经载荷 options / items+scope 由桥下发）；③ 文件 version + zod strict + 单一序列化器（`src/permission/store.ts`）；④ 词根表进 CLAUDE.md（本节）；⑤ 命名空间成员快照测试（tool 面 / permission 各子命名空间 / bridge 服务面，新增成员必须显式更新快照）。

**词根表 → 命名修改流程**：新增标识符必须归入既有词根或显式修改词根表（本节）；改动词根须显式更新本章节与 spec。

## 编码规范

- `tsconfig.json` 必须 `"strict": true`；**严禁 `any`**，未知结构用 `unknown` + `zod` 校验。
- 全面 ESM；相对路径导入需带扩展名。
- 器官类必须可实例化，**严禁单例/全局状态**，靠 `HumanAgent` 构造注入以便 mock 测试。
- 命名：目录小写名词、文件 kebab-case、类 PascalCase、变量/函数 camelCase。

## 命令与依赖

包管理用 **pnpm**（pnpm 11，配置在 `pnpm-workspace.yaml`，注意 pnpm 11 不再读取 package.json 的 `pnpm` 字段）：

```bash
pnpm dev      # tsx 直接运行 bin/cli.ts
pnpm build    # tsc 编译到 dist/（含 bin/ 与 src/）
pnpm start    # node dist/bin/cli.js
pnpm test     # vitest 全量运行（tests/ 目录，TDD 流程：先写测试并看其失败再实现）
```

已安装版本（均比设计文档 v1.0.0 中规划的版本新一个以上大版本，实现时注意 API 差异）：
- runtime：`chalk` 6（ESM-only）、`commander` 15、`execa` 10、`zod` 4（错误 API 与 v3 不同）、`turndown` 7（CJS，ESM 默认导入可用）
- dev：`typescript` 7（原生编译器，`tsc --init` 生成的现代默认配置）、`tsx` 4、`@types/node` 26

CLI 入口为 `bin/cli.ts`（处理 argv）。

工作区经三级决议（实现 `permission.workspace.resolve`，两种模式启动前先决议再装配）：`--workspace <path>` > `HUMAN_AGENT_WORKSPACE` > 启动 CWD；启动时 realpath 规范化且必须为已存在目录（否则友好报错 exit 1）；一进程一工作区不可变（切换=重启）。注意：`pnpm dev -- --workspace X` 不可用——`--` 连同后续参数被透传给脚本，commander 报 too many arguments；临时指定请用 `pnpm exec tsx bin/cli.ts --workspace X`。

## 开发路线（7 阶段递进）

1. 骨架与类型（`package.json`/`tsconfig.json`、`src/types/` 与 `ActionResult` 契约）✅
2. 双手与眼睛（file-reader、terminal、file-writer、risk-checker）✅
3. 嘴巴与耳朵（text-output、ask-user、text-input）✅
4. 大脑与心脏（loop 状态机、interrupt、接入具体大模型）✅（OllamaBrain + qwen3，`OLLAMA_MODEL` 可换模型）
5. Gemini 桥与职责模型重构（knowledge/ollama-thinking/gemini-bridge-thinking/reflection + 共享执行器、浏览器扩展桥）✅（扩展 v2 重写待真实 AI Studio DOM）
6. 统一权限模型（thinking/policy/blacklist + Reflection 集成 + CLI/桥 pending 审批 + 扩展白名单按钮）✅
7. API 重设计（tool/permission/bridge 三域 + 统一信封 + ActionResult 判别联合 + 扩展零手抄）✅
