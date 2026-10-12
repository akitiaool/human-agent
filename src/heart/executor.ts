import { fail, type ActionResult, type EyesContract, type HandsContract } from "../types/index.js";
import type { DiffHunk } from "../brain/llm.js";
import type { Permission } from "../permission/index.js";

export interface ToolOrgans {
  eyes: EyesContract;
  hands: HandsContract;
}

export interface ExecuteToolContext {
  /** 判定/执行基准：路径类参数经 permission.key.execPath 归实为绝对落点（执行落点 = 判定落点）。 */
  permission: Permission;
}

/** 工具执行路由：工具名 → 双手/眼睛方法（loop 与桥管道共用，保持单一映射）。 */
export async function executeTool(
  organs: ToolOrgans,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  context: ExecuteToolContext,
): Promise<ActionResult<unknown>> {
  switch (name) {
    case "file_read": {
      if (typeof args.path !== "string") return fail("invalid-args", "file_read 缺少必填参数 path");
      const startLine = typeof args.start_line === "number" ? args.start_line : undefined;
      const lineCount = typeof args.line_count === "number" ? args.line_count : undefined;
      const opts = {
        ...(startLine !== undefined ? { startLine } : {}),
        ...(lineCount !== undefined ? { lineCount } : {}),
      };
      return organs.eyes.readFile(
        context.permission.key.execPath(args.path),
        Object.keys(opts).length > 0 ? opts : undefined,
      );
    }
    case "dir_list": {
      if (typeof args.path !== "string") return fail("invalid-args", "dir_list 缺少必填参数 path");
      return organs.eyes.readDir(context.permission.key.execPath(args.path));
    }
    case "code_search": {
      if (typeof args.pattern !== "string") return fail("invalid-args", "code_search 缺少必填参数 pattern");
      const dir = typeof args.dir === "string" ? args.dir : ".";
      return organs.eyes.searchCode(args.pattern, context.permission.key.execPath(dir));
    }
    case "page_fetch": {
      if (typeof args.url !== "string") return fail("invalid-args", "page_fetch 缺少必填参数 url");
      return organs.eyes.fetchPageAsMarkdown(args.url);
    }
    case "file_write": {
      if (typeof args.path !== "string") return fail("invalid-args", "file_write 缺少必填参数 path");
      if (typeof args.content !== "string") return fail("invalid-args", "file_write 缺少必填参数 content");
      return organs.hands.writeFile(context.permission.key.execPath(args.path), args.content);
    }
    case "file_patch": {
      if (typeof args.path !== "string") return fail("invalid-args", "file_patch 缺少必填参数 path");
      if (typeof args.patch !== "string") return fail("invalid-args", "file_patch 缺少必填参数 patch");
      return organs.hands.applyPatch(context.permission.key.execPath(args.path), args.patch);
    }
    case "file_edit": {
      if (typeof args.path !== "string") return fail("invalid-args", "file_edit 缺少必填参数 path");
      return organs.hands.editFile(
        context.permission.key.execPath(args.path),
        (args.hunks as DiffHunk[] | undefined) ?? [],
        args.base_version as string | undefined,
      );
    }
    case "command_run": {
      if (typeof args.command !== "string") return fail("invalid-args", "command_run 缺少必填参数 command");
      return organs.hands.executeCommand(
        args.command,
        signal,
        args.timeoutMs as number | undefined,
      );
    }
    default:
      return fail("unknown-tool", `未知工具：${name}`);
  }
}
