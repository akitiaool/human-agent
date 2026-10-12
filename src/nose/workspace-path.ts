// 工作区路径管道：词法绝对化（工作区基准）→ realpath 深度归实 → win32 小写匹配键。
// 判定失败一律返回 null（调用方按未信任处置），绝不回退纯词法结果用于匹配。
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type RealpathFn = (path: string) => string;

export const defaultRealpath: RealpathFn = (path) => realpathSync.native(path);

export interface WorkspacePath {
  /** 执行用绝对路径（realpath 规范大小写；不存在的尾段拼回最深已存在祖先）。 */
  execPath: string;
  /** 匹配键：正斜杠 + win32 小写。 */
  matchKey: string;
}

/** 匹配键归一：反斜杠转正斜杠；win32 小写。 */
export function normalizeMatchKey(path: string): string {
  const forward = path.replace(/\\/g, "/");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

/**
 * 路径类参数的统一管道。相对值以 workspace 为基准（探针②）；.. 段有基准可正确消解（探针①）。
 * realpath 深度归实：全路径不存在时逐段上溯找最深已存在祖先，realpath 后拼回剩余尾段。
 */
export function resolveWorkspacePath(
  input: string,
  workspace: string,
  realpathFn: RealpathFn = defaultRealpath,
): WorkspacePath | null {
  const lexical = resolve(workspace, input);
  const tail: string[] = [];
  let current = lexical;
  for (;;) {
    try {
      const real = realpathFn(current);
      const execPath = tail.length === 0 ? real : join(real, ...tail);
      return { execPath, matchKey: normalizeMatchKey(execPath) };
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

export type StartupWorkspaceResult =
  | { ok: true; workspace: string }
  | { ok: false; error: string };

/** 启动工作区决议：--workspace > HUMAN_AGENT_WORKSPACE > 启动 CWD；realpath 规范化；必须为已存在目录。 */
export function resolveStartupWorkspace(
  cliValue: string | undefined,
  envValue: string | undefined,
  cwd: string,
  realpathFn: RealpathFn = defaultRealpath,
): StartupWorkspaceResult {
  const raw =
    cliValue !== undefined && cliValue.trim() !== ""
      ? cliValue
      : envValue !== undefined && envValue.trim() !== ""
        ? envValue
        : cwd;
  let real: string;
  try {
    real = realpathFn(resolve(cwd, raw));
  } catch {
    return { ok: false, error: `工作区不存在或不可访问：${raw}` };
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(real).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return { ok: false, error: `工作区不是目录：${raw}` };
  return { ok: true, workspace: real };
}
