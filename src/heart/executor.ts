import { fail, type ActionResult, type EyesContract, type HandsContract } from "../types/index.js";

export interface ToolOrgans {
  eyes: EyesContract;
  hands: HandsContract;
}

/** 工具执行路由：工具名 → 双手/眼睛方法（loop 与桥服务共用，保持单一映射）。 */
export async function executeTool(
  organs: ToolOrgans,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ActionResult<unknown>> {
  switch (name) {
    case "read_file":
      return organs.eyes.readFile(args.path as string);
    case "read_dir":
      return organs.eyes.readDir(args.path as string);
    case "search_code":
      return organs.eyes.searchCode(args.pattern as string, args.dir as string | undefined);
    case "write_file":
      return organs.hands.writeFile(args.path as string, args.content as string);
    case "apply_patch":
      return organs.hands.applyPatch(args.path as string, args.patch as string);
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
