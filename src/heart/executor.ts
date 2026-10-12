import { resolve as resolvePath } from "node:path";
import { fail, type ActionResult, type EyesContract, type HandsContract } from "../types/index.js";
import type { DiffHunk } from "../brain/llm.js";
import { resolveWorkspacePath, type RealpathFn } from "../nose/workspace-path.js";

export interface ToolOrgans {
  eyes: EyesContract;
  hands: HandsContract;
}

export interface ExecuteToolContext {
  /** 判定/执行基准工作区：路径类参数经管道归实为绝对 execPath；缺省时原样透传（兼容既有调用）。 */
  workspace?: string;
  /** realpath 注入（测试用）。 */
  realpathFn?: RealpathFn;
}

/** 执行落点：管道 execPath 优先；管道失败（realpath 不可用）回退词法绝对化——执行不因归实失败搁浅。 */
function execPathFor(target: string, context: ExecuteToolContext): string {
  if (context.workspace === undefined) return target;
  const resolved = resolveWorkspacePath(target, context.workspace, context.realpathFn);
  return resolved !== null ? resolved.execPath : resolvePath(context.workspace, target);
}

/** 工具执行路由：工具名 → 双手/眼睛方法（loop 与桥服务共用，保持单一映射）。 */
export async function executeTool(
  organs: ToolOrgans,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  context: ExecuteToolContext = {},
): Promise<ActionResult<unknown>> {
  switch (name) {
    case "read_file": {
      const startLine = typeof args.start_line === "number" ? args.start_line : undefined;
      const lineCount = typeof args.line_count === "number" ? args.line_count : undefined;
      const opts = {
        ...(startLine !== undefined ? { startLine } : {}),
        ...(lineCount !== undefined ? { lineCount } : {}),
      };
      return organs.eyes.readFile(
        execPathFor(args.path as string, context),
        Object.keys(opts).length > 0 ? opts : undefined,
      );
    }
    case "read_dir":
      return organs.eyes.readDir(execPathFor(args.path as string, context));
    case "search_code":
      return organs.eyes.searchCode(
        args.pattern as string,
        args.dir === undefined ? context.workspace : execPathFor(args.dir as string, context),
      );
    case "write_file":
      return organs.hands.writeFile(execPathFor(args.path as string, context), args.content as string);
    case "apply_patch":
      return organs.hands.applyPatch(execPathFor(args.path as string, context), args.patch as string);
    case "edit_file":
      return organs.hands.editFile(
        execPathFor(args.path as string, context),
        (args.hunks as DiffHunk[] | undefined) ?? [],
        args.base_version as string | undefined,
      );
    case "terminal":
      return organs.hands.executeCommand(
        args.command as string,
        signal,
        args.timeoutMs as number | undefined,
      );
    case "fetch_page":
      return organs.eyes.fetchPageAsMarkdown(args.url as string);
    default:
      return fail("UNKNOWN_TOOL", `未知工具: ${name}`);
  }
}
