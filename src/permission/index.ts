// permission 域门面：构造时绑定工作区与文件；成员不再收 workspace 参数。
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { createKey, normalizeMatchKey, defaultRealpath, type RealpathFn, type KeyService } from "./key.js";
import { createCandidates, type CandidatesService, type CandidateRecord } from "./candidates.js";
import { createWhitelist, type WhitelistService, type GrantResult } from "./whitelist.js";
import { createVerdict, type PermissionVerdict } from "./verdict.js";
import { commandPatterns, writePathPatterns } from "./blacklist.js";

export type { CandidateRecord, GrantResult, KeyService, PermissionVerdict };
export { createKey, normalizeMatchKey, defaultRealpath };

export interface Permission {
  workspace: { constraint(): string };
  key: KeyService;
  verdict: { decide(call: import("../brain/llm.js").ToolCall): PermissionVerdict };
  whitelist: WhitelistService;
  blacklist: { list(): { command: string[]; "write-path": string[] } };
  candidates: CandidatesService;
}

export function createPermission(options: {
  workspace: string;
  whitelistFile?: string;
  candidatesFile?: string;
  realpathFn?: RealpathFn;
  logger?: (message: string) => void;
}): Permission {
  const logger = options.logger ?? ((message: string) => console.error(message));
  const workspaceKey = normalizeMatchKey(options.workspace);
  const whitelistFile = options.whitelistFile ?? join(homedir(), ".human-agent", "whitelist.json");
  const candidatesFile = options.candidatesFile ?? join(homedir(), ".human-agent", "candidates.json");
  const key = createKey({
    workspace: options.workspace, // realpath 原大小写（裁定 5）；匹配键输出仍在管道末端小写化
    ...(options.realpathFn !== undefined ? { realpathFn: options.realpathFn } : {}),
  });
  const candidates = createCandidates({ workspaceKey, file: candidatesFile, logger });
  const whitelist = createWhitelist({
    workspaceKey,
    file: whitelistFile,
    key,
    retire: (entry) => candidates.dropCoveredBy(entry),
    logger,
  });
  const verdict = createVerdict({ key, entries: () => whitelist.list() });
  whitelist.grant({ tool: "file_write", key: `${workspaceKey}/`, scope: "subtree" }); // 构造即注册（幂等）
  return {
    workspace: {
      constraint: () => `你的工作区是 ${options.workspace}，工具调用请保持在界内；界外操作需要用户授权。`,
    },
    key,
    verdict,
    whitelist,
    blacklist: {
      list: () => ({
        command: commandPatterns.map(String),
        "write-path": writePathPatterns.map(String),
      }),
    },
    candidates,
  };
}

/** 模块级成员（构造前使用；鸡生蛋：实例需要先有 workspace）。 */
function resolveWorkspace(
  cliValue: string | undefined,
  envValue: string | undefined,
  cwd: string,
  realpathFn: RealpathFn = defaultRealpath,
): { status: "ok"; workspace: string } | { status: "error"; error: { code: "workspace-invalid"; message: string } } {
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
    return { status: "error", error: { code: "workspace-invalid", message: `工作区不存在或不可访问：${raw}` } };
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { status: "error", error: { code: "workspace-invalid", message: `工作区不是目录：${raw}` } };
    }
  } catch {
    return { status: "error", error: { code: "workspace-invalid", message: `工作区不存在或不可访问：${raw}` } };
  }
  return { status: "ok", workspace: real };
}

export const permission = { workspace: { resolve: resolveWorkspace } };
