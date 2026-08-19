// 大脑知识库（认知层）："工具如何使用"的知识——7 个工具的 schema + description。
// 当前是唯一知识来源；未来 RAG 系统将作为新的知识来源在此聚合。
import { z } from "zod";
import type { ToolInfo } from "./llm.js";

export const schemas = {
  read_file: z.object({ path: z.string() }),
  read_dir: z.object({ path: z.string() }),
  search_code: z.object({ pattern: z.string(), dir: z.string().optional() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  apply_patch: z.object({ path: z.string(), patch: z.string() }),
  terminal: z.object({
    command: z.string(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe("命令超时毫秒数（可选，默认由任务超时控制）")
      .optional(),
  }),
  fetch_page: z.object({ url: z.string() }),
} as const;

const descriptions = {
  read_file: "读取指定文件的内容",
  read_dir: "列出指定目录的条目",
  search_code: "在目录中检索匹配正则表达式的文件内容",
  write_file: "写入文件内容（自动创建父目录）",
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
  "- 一次只调用一个工具，等待工具结果后再决定下一步",
  "- 需要调用工具时，输出且只输出一个 JSON 代码块，不要附带其他文字：",
  "```tool_call",
  '{"name": "工具名", "arguments": {参数对象}}',
  "```",
  "- 工具结果将以「工具返回：{结果 JSON}」的形式出现在下一条消息",
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
