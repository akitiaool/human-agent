// 工具知识唯一来源：schema + 描述 + 元数据（协议展示顺序 = names 顺序；硬规 1：编译期穷尽）。
import { z } from "zod";
import type { ToolInfo } from "../brain/llm.js";

export const schemas = {
  file_read: z.object({
    path: z.string().describe("文件路径"),
    start_line: z.number().int().positive().optional().describe("起始行号（从 1 开始，可选切片读取）"),
    line_count: z.number().int().positive().optional().describe("读取行数（可选切片读取）"),
  }),
  file_write: z.object({
    path: z.string().describe("文件路径"),
    content: z.string().describe("完整写入内容"),
  }),
  file_edit: z.object({
    path: z.string().describe("文件路径"),
    base_version: z.string().optional().describe("基准快照版本号（例如 v-a1b2c3d4，用于乐观锁校验）"),
  }),
  file_patch: z.object({
    path: z.string().describe("文件路径"),
    patch: z.string().describe("行级 patch 内容"),
  }),
  dir_list: z.object({ path: z.string().describe("目录路径") }),
  code_search: z.object({
    pattern: z.string().describe("检索正则表达式"),
    dir: z.string().optional().describe("检索目录（默认工作区）"),
  }),
  command_run: z.object({
    command: z.string().describe("待执行命令"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe("命令超时毫秒数（可选，默认由任务超时控制）")
      .optional(),
  }),
  page_fetch: z.object({ url: z.string().describe("网页 URL") }),
} as const;

export type ToolName = keyof typeof schemas;

export interface ToolMeta {
  target: "path" | "command" | "url";
  access: "read" | "write";
}

export type Scope = "self" | "subtree";
export interface TrustEntry {
  tool: string;
  key: string;
  scope: Scope;
}

/** 有序数组 = 协议展示顺序（spec §2）。 */
export const names = [
  "file_read",
  "file_write",
  "file_edit",
  "file_patch",
  "dir_list",
  "code_search",
  "command_run",
  "page_fetch",
] as const satisfies readonly ToolName[];

export const meta: Record<ToolName, ToolMeta> = {
  file_read: { target: "path", access: "read" },
  file_write: { target: "path", access: "write" },
  file_edit: { target: "path", access: "write" },
  file_patch: { target: "path", access: "write" },
  dir_list: { target: "path", access: "read" },
  code_search: { target: "path", access: "read" },
  command_run: { target: "command", access: "write" },
  page_fetch: { target: "url", access: "read" },
};

export const descriptions: Record<ToolName, string> = {
  file_read: "读取指定文件的内容（支持 start_line 与 line_count 切片读取，返回带行号与 version_id 的快照）",
  file_write: "全量写入文件内容（自动创建父目录）",
  file_edit: "局部精确代码替换（配合 <::: BEFORE ... <::> AFTER 语法，支持 base_version 快照锁）",
  file_patch: "对文件应用行级补丁",
  dir_list: "列出指定目录的条目",
  code_search: "在目录中检索匹配正则表达式的文件内容",
  command_run: "执行 shell 命令（可指定 timeoutMs 毫秒超时，超时自动终止）",
  page_fetch: "抓取网页并转换为 Markdown",
};

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name);
}

export type { ToolInfo };
