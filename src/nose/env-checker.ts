import os from "node:os";
import { execaSync } from "execa";
import type { EnvSnapshot } from "../types/index.js";

export class EnvChecker {
  getEnvSnapshot(options?: { cwd?: string }): EnvSnapshot {
    const cwd = options?.cwd ?? process.cwd();
    const snapshot: EnvSnapshot = { os: os.platform(), cwd };
    try {
      const { stdout } = execaSync("git", ["branch", "--show-current"], { cwd });
      const branch = stdout.trim();
      if (branch) snapshot.gitBranch = branch;
    } catch {
      // 非 git 仓库或 git 不可用：无分支信息
    }
    return snapshot;
  }
}
