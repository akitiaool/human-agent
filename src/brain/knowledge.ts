// 大脑知识库（认知层）："工具如何使用"的知识——8 个工具的 schema + description。
// 当前是唯一知识来源；未来 RAG 系统将作为新的知识来源在此聚合。
import { z } from "zod";
import type { ToolInfo } from "./llm.js";

export const schemas = {
  read_file: z.object({
    path: z.string().describe("文件路径"),
    start_line: z.number().int().positive().optional().describe("起始行号（从 1 开始，可选切片读取）"),
    line_count: z.number().int().positive().optional().describe("读取行数（可选切片读取）"),
  }),
  read_dir: z.object({ path: z.string().describe("目录路径") }),
  search_code: z.object({
    pattern: z.string().describe("检索正则表达式"),
    dir: z.string().optional().describe("检索目录（默认工作区）"),
  }),
  write_file: z.object({
    path: z.string().describe("文件路径"),
    content: z.string().describe("完整写入内容"),
  }),
  edit_file: z.object({
    path: z.string().describe("文件路径"),
    base_version: z.string().optional().describe("基准快照版本号（例如 v-a1b2c3d4，用于乐观锁校验）"),
  }),
  apply_patch: z.object({
    path: z.string().describe("文件路径"),
    patch: z.string().describe("行级 patch 内容"),
  }),
  terminal: z.object({
    command: z.string().describe("待执行命令"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe("命令超时毫秒数（可选，默认由任务超时控制）")
      .optional(),
  }),
  fetch_page: z.object({ url: z.string().describe("网页 URL") }),
} as const;

const descriptions = {
  read_file: "读取指定文件的内容（支持 start_line 与 line_count 切片读取，返回带行号与 version_id 的快照）",
  read_dir: "列出指定目录的条目",
  search_code: "在目录中检索匹配正则表达式的文件内容",
  write_file: "全量写入文件内容（自动创建父目录）",
  edit_file: "局部精确代码替换（配合 <::: BEFORE ... <::> AFTER 语法，支持 base_version 快照锁）",
  apply_patch: "对文件应用行级补丁",
  terminal: "执行 shell 命令（可指定 timeoutMs 毫秒超时，超时自动终止）",
  fetch_page: "抓取网页并转换为 Markdown",
} as const;

export const TOOLS: readonly ToolInfo[] = (
  Object.keys(schemas) as (keyof typeof schemas)[]
).map((name) => ({
  name,
  description: descriptions[name],
  parameters: z.toJSONSchema(schemas[name]) as Record<string, unknown>,
}));

const PROTOCOL_HEADER =
  "【human-agent 工具协议】你是 human-agent 智能体的大脑，通过调用工具与本地环境交互。";

const PROTOCOL_RULES = [
  "调用规则：",
  "- 需要读取/修改/执行才能完成用户任务时，必须调用工具，不得假装完成",
  "- 【纯粹性铁律】：若要调用工具，整个回复必须且只能包含 { <::: TOOL_CALL[ID] ... :::> TOOL_CALL[ID] } 容器块与空白，严禁附带任何自然语言解释、前缀、问候或说明（包含任何额外文字的回复均会被系统视为普通对话，工具将不会被执行）",
  "- 如需向用户解释思路或讨论方案，请输出纯文本对话（不含工具调用）；需要执行时再单独输出工具调用",
  "- 标准工具调用格式（外层 { ... } 容器，内层 <::: TOOL_CALL[ID] 配对）：",
  "{",
  "<::: TOOL_CALL[1]",
  "tool: read_file",
  "path: package.json",
  "start_line: 1",
  "line_count: 15",
  ":::> TOOL_CALL[1]",
  "}",
  "- 全量写入文件（write_file 原生无转义 CONTENT 语法）：",
  "{",
  "<::: TOOL_CALL[2]",
  "tool: write_file",
  "path: src/agent.ts",
  "<::: CONTENT",
  "// 这里直接书写完整代码，零转义",
  ":::> CONTENT",
  ":::> TOOL_CALL[2]",
  "}",
  "- 局部代码精确替换（edit_file 原生无转义 N+1 流式 Diff 语法）：",
  "{",
  "<::: TOOL_CALL[3]",
  "tool: edit_file",
  "path: src/heart/loop.ts",
  "base_version: v-xxxx",
  "<::: BEFORE[1]",
  "待替换的原始旧代码 1（原生多行，直接换行，无需转义）",
  "<::> AFTER[1]",
  "替换后的目标新代码 1（原生多行，直接换行，无需转义）",
  "<::> BEFORE[2]",
  "待替换的原始旧代码 2",
  "<::> AFTER[2]",
  "替换后的目标新代码 2",
  ":::> AFTER[2]",
  ":::> TOOL_CALL[3]",
  "}",
  "- 终端命令执行（terminal 原生无转义 COMMAND 语法）：",
  "{",
  "<::: TOOL_CALL[4]",
  "tool: terminal",
  "timeout_ms: 10000",
  "<::: COMMAND",
  "pnpm build && pnpm test",
  ":::> COMMAND",
  ":::> TOOL_CALL[4]",
  "}",
  "- 复合工具调用格式（支持 pipeline 链式依赖与 batch 独立执行）：",
  "{",
  "<::: PIPELINE[p1]",
  "  <::: TOOL_CALL[step1]",
  "  tool: terminal",
  "  <::: COMMAND",
  "  pnpm build",
  "  :::> COMMAND",
  "  :::> TOOL_CALL[step1]",
  "  <::: TOOL_CALL[step2]",
  "  tool: terminal",
  "  <::: COMMAND",
  "  pnpm test",
  "  :::> COMMAND",
  "  :::> TOOL_CALL[step2]",
  ":::> PIPELINE[p1]",
  "}",
  "- 执行语义：",
  "  * BATCH（批处理）：子工具相互独立执行，单项失败或被拒绝不影响其他子工具执行",
  "  * PIPELINE（流水线）：子工具按序依赖执行，前序步骤失败或被拒绝将立即阻断后续步骤（标记为 DEPENDENCY_BLOCKED）",
  "  * 支持在 PIPELINE 内部嵌套 BATCH，或在 BATCH 内部嵌套 PIPELINE",
  "- 工具结果将以「工具执行结果（human-agent）：1. ... 2. ...」的格式统一反馈",
  "- 任务完成或无需工具时，直接输出最终回答文本",
].join("\n");

/** 序列化工具协议文本：每轮思考完整注入（可靠性优先，不做首轮后精简）。 */
export function serializeToolProtocol(): string {
  const toolLines = TOOLS.map(
    (tool, index) =>
      `${index + 1}. ${tool.name}: ${tool.description} | ${JSON.stringify(tool.parameters)}`,
  );
  return `${PROTOCOL_HEADER}\n可用工具（名称：用途 | 参数）：\n${toolLines.join("\n")}\n${PROTOCOL_RULES}`;
}