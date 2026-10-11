# human-agent 局部读写、快照版本控制与无转义 Diff 语法设计方案

## 一、 背景与核心目标

### 1. 痛点分析
- **Token 消耗巨大**：长代码文件（上千行）每次微调都需要全量读写，单次往返消耗 5k~20k Tokens，会话历史迅速膨胀。
- **转义地狱与解析脆弱**：标准 JSON 强制将代码中的所有换行转义为 \n、双引号转义为 \"，导致大模型极易因漏反斜杠而发生 JSON 解析错误，可读性极差。
- **缺乏版本基线与冲突保护**：修改文件时缺乏上下文版本锚定，容易发生幻觉修改或覆盖未预期的内容。

### 2. 核心目标
1. **快照版本控制（Snapshot & Version ID）**：建立乐观锁与版本锚定机制，读写均产生并校验 version_id。
2. **切片读取（Slice Read）**：read_file 支持按行号范围切片读取，并输出带绝对行号的代码，降低读取开销。
3. **专属无转义 Diff 语法（`<::: BEFORE` / `:::> AFTER` / `<::: END`）**：在工具调用围栏内直接书写原生多行代码，彻底消灭 \n 和 \" 转义。
4. **局部精准替换（`edit_file`）**：支持单文件单处或多处精确替换，配合空白容错与原子回滚。

---

## 二、 human-agent 专属标准语法体系规范

### 1. 结构总览
所有工具调用遵循**「纯粹性铁律（零歧义原则）」**：外层除了工具围栏外严禁任何自然语言；围栏内部由 **顶部元数据 JSON + 底部原生 Diff 块** 构成。

### 2. 核心语法标记定义

| 标记符 | 语义 | 说明 |
|---|---|---|
| `<::: TOOL_CALL[ID]` | **工具调用起始标记** | 声明工具块开始，ID 唯一 |
| `:::> TOOL_CALL[ID]` | **工具调用结束标记** | 必须与起始 ID 完全配对闭合 |
| `<::: BEFORE` | **起始旧代码块** | 独占一行。其后至 `:::> AFTER` 之间的所有文本为待匹配的原始代码片段 |
| `:::> AFTER` | **转换到新代码块** | 独占一行。其后至 `<::: END` 之间的所有文本为替换后的目标代码片段 |
| `<::: END` | **结束当前 Diff 块** | 独占一行。标志当前代码块替换单元结束 |

---

## 三、 系统架构与实现完成度

1. `src/hands/diff-engine.ts`：实现 `computeVersionId`、`extractDiffHunks` 与 `applyHunks`；
2. `src/eyes/file-reader.ts`：实现 `start_line` / `line_count` 切片读取，带行号格式化与快照 ID；
3. `src/hands/file-writer.ts`：实现 `editFile`，支持 `base_version` 乐观锁校验与原子多 Hunk 应用；
4. `src/nose/policy.ts`：将 `edit_file` 纳入写白名单机制；
5. `src/heart/executor.ts`：支持 `read_file` 选项透传与 `edit_file` 执行路由；
6. `src/brain/gemini-bridge-thinking.ts`：支持 `<::: TOOL_CALL[ID]` 配对围栏与原生 Diff 块解析。
