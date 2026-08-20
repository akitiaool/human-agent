# 权限模型设计（2026-08-20）

统一黑白名单裁决矩阵：所有智能体工具调用（terminal、writeFile、applyPatch、readFile、readDir、searchCode、webCrawler）一律走「匹配」裁决，不做命令分类、不做路径分析、无内置只读豁免。工作区通过「启动时自动注册写白名单」实现，约束层（协议文本 / system prompt）告知智能体边界。

## 1. 背景与动机

现状（v3 审批）：只有鼻子 DANGEROUS 清单（黑名单式）命中的命令才弹窗，其余全部静默执行——漏判一条即危险命令无授权执行；无工作区概念，访问范围无界。

参考（Claude Code / Codex）：默认从严——只读内置集免确认，其余全部弹窗；白名单（"Yes, always"）成长；OS 沙箱兜底（Windows 无原生沙箱，Claude Code 在 Windows 上即纯规则 + 弹窗形态）。

目标：默认模式默认从严（未信任即弹窗），白名单让确认过的操作静默；自动模式给足权限但黑名单兜底；工作区约束智能体活动范围。

## 2. 核心裁决矩阵

**两个模式，固定顺序，黑名单优先级最高。**

| 判定层（按顺序） | 默认模式 | 自动授权模式 |
|---|---|---|
| ① 黑名单（确定性系统破坏） | 直接拒绝，无弹窗、不可入白名单 | 直接拒绝 |
| ② 白名单命中 | 静默执行 | 跳过白名单（直接执行） |
| ③ 其余所有调用 | 弹窗（允许 / 拒绝 / 加入白名单） | —（即 ② 的「跳过」→ 执行） |

- 默认模式：未命中白名单的**任何**调用（含 `ls`、`git status`、`readFile`）都弹窗，直到加入白名单。
- 自动授权模式：黑名单之外**全部**执行。
- 黑名单两模式一致，是唯一的绝对禁止层。

## 3. 匹配串规范

所有调用序列化为匹配串参与比对：

```
<工具名> <归一化参数 JSON>
```

- 归一化：参数键按字母序排序后 `JSON.stringify`（消除键序差异）；字符串内连续空白归一。
- **写类工具（writeFile / applyPatch）：只匹配 `path` 参数**（content / operations 不参与）。
- 其余工具（terminal / readFile / readDir / searchCode / webCrawler）：完整参数。
  - terminal 的匹配串即命令串本身（如 `terminal {"command":"rm -rf /tmp/x"}`），白名单条目为精确整串。

**白名单条目的 key 语义**（`tool` 字段独立比对，key 只存参数部分）：

- `kind: "exact"` 且工具为 terminal：key = 命令串本身（如 `git status`），不含工具名包装。
- `kind: "exact"` 其余工具：key = 归一化参数 JSON（如 `{"path":"src/a.ts"}`）。
- `kind: "path"`：key = 路径。

## 4. 白名单

**存储**：用户级文件 `~/.human-agent/whitelist.json`（`os.homedir() + ".human-agent"`），按工作区绝对路径分节：

```json
{
  "/path/to/workspace": [
    { "tool": "writeFile", "key": "src/", "kind": "path" },
    { "tool": "terminal", "key": "git status", "kind": "exact" }
  ]
}
```

**条目形态**：`{ tool, key, kind }`

- `kind: "exact"`：归一化后逐字符相等才命中（terminal 等）。
- `kind: "path"`：写类工具按 path 匹配。
  - 目录条目：key 以 `/`（规范化后）结尾，**段级前缀**匹配——`src/` 覆盖 `src/utils.ts`、`src/components/button.tsx`，不覆盖 `src-evil/secret.txt`。
  - 文件条目：key 无尾斜杠，仅匹配自身（`src/utils.ts` 只命中该文件）。
  - **跨工具生效**：path 条目对 writeFile 与 applyPatch 都命中（"允许写 src/" 是写权限概念，不按工具拆分，避免重复弹窗）。

**冗余清理**（只在写 path 条目间执行；exact 条目无层级，不参与）：

- 加父条目：新增 `src/` 时自动删除已被覆盖的子条目（`src/utils.ts`、`src/components/`）。
- 加子被父盖：已有 `src/` 时添加 `src/utils.ts` 直接跳过不存。

**工作区条目**：启动时自动注册 `writeFile`/`applyPatch` 的 path-dir 条目 `key = CWD 规范化路径 + "/"`（如 `/path/to/workspace/`）。持久化于该工作区分节。

**修改权限**：只有用户能扩展——弹窗「加入白名单」或手改文件；智能体无任何修改白名单的工具，启动后不可被智能体更改。

## 5. 黑名单

**原则**：只禁用**确定性系统破坏**操作——与用户、机器无关，执行必然破坏系统（根目录/系统盘删除、格式化系统盘、整盘擦除、块设备直写、Boot 关键文件/注册表、杀之必崩的系统进程）。达不到「破坏系统」不归黑名单（`rm -rf /tmp/x`、删用户注册表键、`shutdown`、`taskkill` 普通进程一律不管，走正常流程）。

**存储**：内置数据文件 `src/nose/blacklist.ts`（TS 常量模式数组），随软件版本更新；同一版本内所有用户一致。用户可手动编辑该文件，后果自负（升级会被新版本覆盖，属已知行为）。

**匹配**：正则模式，目标锚定（命中即拒）。对所有工具生效——写类工具按 path 匹配系统目标（如写 `C:\Windows\system32` 下）。

**v1 初始内容**（详见附录 A）：Windows（系统盘/根目录递归删除、系统目录删除、启动文件、格式化、diskpart/Clear-Disk/cipher /w、块设备 dd、Boot 注册表子树、lsass/csrss/wininit/winlogon 强杀）+ Linux/macOS（根/系统目录删除、块设备 dd/shred/重定向、mkfs 指向块设备、分区表操作、chmod -R 000 系统目录）。

## 6. 工作区绑定

- 启动时（桥服务构建 / CLI 启动）把 CWD 规范化路径注册为写白名单 path-dir 条目 → 界内写入静默；界外写入未入白名单 → 默认模式弹窗、自动模式直接执行（无黑名单则放行——自动模式语义就是给足权限，工作区只是默认信任面）。
- **提示词约束**（软约束，配合硬性匹配）：
  - 桥模式：工具协议文本（首条注入消息）增加一行工作区声明：「你的工作区是 <CWD>，工具调用请保持在界内；界外操作需要用户授权」。
  - CLI 模式：Ollama system prompt 增加同样声明。
- 启动后不可更改（无智能体侧修改渠道；用户手改白名单文件除外）。

## 7. 审批弹窗与协议演进

**弹窗按钮**：

- 非写类调用：[允许本次] [拒绝] [允许并加入白名单（exact）]
- 写类调用：[允许本次] [拒绝] [加入白名单：此路径] [加入白名单：此目录]
- 批量弹窗保留「全部允许 / 全部拒绝」；白名单动作逐条选择（每条调用行内按钮）。

**协议**：

- `GET /task` 下发 approval 已携带完整 ToolCall（不变）。
- `POST /approval` 请求扩展可选字段：`whitelist?: { tool, key, kind }[]`。桥侧校验：条目必须对应本批中 `allowed=true` 的调用——`exact` 条目的 tool/key 必须与该调用的匹配串完全一致；`path` 条目分两粒度——「此路径」key = 该写调用的 path 自身（文件条目），「此目录」key = 该 path 的父目录 + `/`（目录条目）；校验通过才写入白名单文件。

**自动授权模式**：桥侧对判「需授权」的调用仍下发审批，扩展按面板开关决定弹窗或静默回全部允许；黑名单命中桥侧直接拒绝回填（`已拒绝（BLACKLIST：系统破坏操作，禁止执行）`），**不下发**审批。扩展开关语义不变。

## 8. 通用 Thinking 基类（架构）

确定性层收敛为单一实现，桥与 CLI 行为必然一致：

```
src/brain/thinking.ts（新）
abstract class BaseThinking
  ├─ 持有：Reflection + PermissionPolicy + workspace（启动时 CWD 规范化路径）
  ├─ reflect(calls)：统一裁决入口，顺序——
  │   ① 黑名单命中 → 拒绝（BLACKLIST，两模式一致）
  │   ② 白名单命中 → 放行（静默）
  │   ③ 未知工具 / 参数非法 → 拦截（沿用现有 UNKNOWN_TOOL / INVALID_ARGS）
  │   ④ 其余（未命中白名单）→ 需授权（NEEDS_APPROVAL）
  ├─ classify(call)：单调用权限分类（blacklist / whitelist / unlisted，reflect 内部复用）
  └─ toolProtocol()：工具协议文本（含工作区声明行）

OllamaThinking extends BaseThinking implements BrainInference
  ├─ infer()：Ollama /api/chat（现有实现不动）
  └─ system prompt 拼装使用基类工作区声明

GeminiBridgeThinking extends BaseThinking
  ├─ HTTP 服务 / outbox / 审批协议（现有实现不动）
  ├─ #process 改为：parse → 去重 → reflect 裁决 → 按裁决执行/拦截/下发审批
  └─ 首条协议消息 = 基类 toolProtocol()
```

**反射裁决契约扩展**：`ReflectionVerdict` 增加拒绝原因 `BLACKLIST` 与需授权标记 `NEEDS_APPROVAL`（现有 UNKNOWN_TOOL / INVALID_ARGS / USER_DENIED 沿用）；裁决后的「审批通道」由宿主负责——桥下发 GET /task approval，CLI 走嘴巴三选。

**构造**：两子类构造函数均接受 `workspace`（缺省 `process.cwd()`）与白名单文件路径选项（缺省 `~/.human-agent/whitelist.json`），测试可注入。

## 9. 桥服务裁决链改造（gemini-bridge-thinking）

`#process` 简化为：

1. `parseToolCalls` + 去重（现状不动）。
2. `this.reflect(calls)`（基类统一裁决）。
3. 按裁决分发：`BLACKLIST` / 拦截 → 生成拒绝行回填；白名单放行 → 直接执行；`NEEDS_APPROVAL` → 批量审批下发（现状流程）。
4. 审批返回：allowed → 执行；拒绝 → `USER_DENIED` 拒绝行。
5. 执行顺序保持原调用顺序；执行仍走共享 `executeTool`。

现状的「鼻子 DANGEROUS 预筛摘出」逻辑删除——不再有「危险清单」概念，未命中白名单一律进审批通道。`RiskChecker` 保留（黑名单模式的来源模块）。

## 10. CLI 模式接入（Ollama REPL）

- `loop.ts #execute`：`brain.reflect(calls)`（基类统一裁决）→ `BLACKLIST`/拦截直接反馈；白名单放行 → `executeTool`；`NEEDS_APPROVAL` → 嘴巴三选交互。
- `mouth/ask-user.ts` 升级：`confirm` 扩展为三选（允许 / 拒绝 / 加入白名单），写类调用提供路径/目录两粒度。返回裁决 + 可选白名单条目，写入白名单文件。
- 工作区声明加入 system prompt（基类提供文本）。

## 11. 共享裁决模块

- `src/nose/policy.ts`（新）：`PermissionPolicy` 类——黑名单判定（正则规则集）+ 白名单加载/匹配/冗余清理/持久化（按工作区分节）。纯函数、可注入文件路径与规则集（测试友好），无单例。
- `src/nose/blacklist.ts`（新）：黑名单模式数组（随版本内置）。
- `src/brain/thinking.ts`（新）：`BaseThinking`（见 §8）——桥与 loop 共用。
- `Reflection` 扩展（reflection.ts）：集成 PermissionPolicy 层，裁决顺序见 §8。

## 12. 文件存储与加载

| 项 | 位置 | 内容 | 变更方式 |
|---|---|---|---|
| 白名单 | `~/.human-agent/whitelist.json` | 按工作区分节的条目数组 | 弹窗 / 手改 |
| 黑名单 | `src/nose/blacklist.ts`（内置） | 系统破坏模式数组 | 随版本 / 手改（责任自负） |
| 工作区 | 启动时 CWD | 自动注册 writeFile/applyPatch path-dir 条目 | 启动时 |

白名单文件不存在时静默创建；读写失败降级为「空白名单」（默认模式全弹窗、自动模式黑名单外全放行），不崩溃。

## 13. 测试策略

- `policy.test.ts`：黑名单命中（含变体：`rm -rf C:\Windows` 命中、`rm -rf C:\Windows\Temp` 不命中）、exact 匹配（空白归一、键序无关）、path 匹配（段级前缀、`src-evil` 反例、目录/文件条目、跨工具生效）、冗余清理（加父去子、加子被父盖跳过）、持久化（加载/保存/损坏降级）。
- `thinking.test.ts`：BaseThinking reflect 裁决顺序（黑名单 → 白名单 → 未知/非法 → NEEDS_APPROVAL）、toolProtocol 含工作区声明。
- 桥流程测试：黑名单拦截回填文案（不审批）、白名单命中静默执行（不下发）、NEEDS_APPROVAL 下发审批、审批带回 whitelist 校验写入、自动模式（黑名单外全放行）。
- CLI 流程测试：嘴巴三选（允许/拒绝/白名单写入）。
- 扩展（content.js）：弹窗按钮形态、白名单 payload 构造——手动 E2E 验证（无测试框架）。

## 14. 文档更新

- `extensions/gemini-bridge/README.md`：审批节改为权限模型说明（矩阵、白名单、黑名单、弹窗按钮）。
- 根 `README.md` / `CLAUDE.md`：架构与裁决链描述更新（含 BaseThinking 章节）。
- v2 spec：审批机制章节修订。

## 15. 已知限制

- **无 OS 沙箱**（Windows 无原生沙箱，Claude Code 亦然）：匹配只作用于文本层面，`bash -c '...'`、PowerShell 混淆等可绕过文本分析。需要真隔离的 Windows 用户应走 WSL2——那是用户侧选择，不在本设计范围。
- 默认模式弹窗噪音是**设计选择**（默认从严），白名单成长后自然安静。
- 黑名单「目标锚定」模式的精确度由内置规则质量决定；误伤面通过锚定系统级目标最小化。

## 附录 A：黑名单 v1 初始内容

### Windows（系统盘按 %SystemDrive% 与常见盘符锚定）

| 类别 | 模式（示例） |
|---|---|
| 根/系统盘递归删除 | `rm -rf C:\`、`rd /s /q C:\`、`del /f /s C:\`、`Remove-Item -Recurse -Force C:\` |
| 系统目录删除 | `...C:\Windows`、`...System32`、`...Windows\Boot`、`...System Volume Information` |
| 启动文件删除 | `del bootmgr`、`del boot.ini`、`del C:\boot`、`bcdedit /delete` |
| 系统盘格式化 | `format c:`、`format %SystemDrive%`、`Format-Volume -DriveLetter C` |
| 整盘擦除 | `diskpart clean`、`Clear-Disk`、`cipher /w:c:` |
| 块设备直写 | `dd ... of=\\.\PhysicalDrive0`、`of=\\.\C:` |
| Boot 关键注册表 | `reg delete HKLM\SYSTEM`、`reg delete HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`、`Remove-Item HKLM:\SYSTEM` |
| 系统关键进程强杀 | `taskkill /f /im lsass.exe`、`...csrss.exe`、`...wininit.exe`、`...winlogon.exe` |
| 写类工具写系统目录（path 匹配） | `write_file C:\Windows\System32\...`、`write_file C:\Windows\Boot\...`、`write_file ...\System Volume Information\...` |

「写类工具写系统目录」按 path 匹配（实现为锚定开头的两条形态：`c:/windows/(system32|boot)` 与 `c:/system volume information`，各跟终结符 `\/` 或 `$`）：只拦 system32/boot 子树（含裸目录本身），**不**拦 `C:\Windows\Temp` 等可恢复目录；裸 `C:\Windows` 根级单文件（非 system32/boot 子树）不入。terminal 命令串不以盘符开头，天然不命中该类别（该形态只对写类工具生效）。

### Linux / macOS

| 类别 | 模式（示例） |
|---|---|
| 根目录删除 | `rm -rf /`、`rm -rf /*`、`rm -rf /boot` |
| 系统目录删除 | `rm -rf /etc`、`/usr`、`/bin`、`/sbin`、`/lib`、`/lib64` |
| 块设备直写 | `dd ... of=/dev/sda`、`of=/dev/nvme0n1`、`shred /dev/sda`、`> /dev/sda` 重定向 |
| 文件系统重建 | `mkfs` / `mkfs.ext4` / `mke2fs` 指向 `/dev/sd*`、`/dev/nvme*` |
| 分区表操作 | `parted ... mklabel`、`fdisk ... delete` 指向系统盘、`diskutil eraseDisk /dev/disk0` |
| 权限全毁 | `chmod -R 000 /`、`chmod -R 000 /etc` |

明确**不**入黑名单：`rm -rf /tmp/...`、`rm -rf node_modules`、`shutdown`、普通 `taskkill`、`kill -9`（默认模式弹窗、自动模式放行）。
