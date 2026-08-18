import net from "node:net";
import os from "node:os";
import { execaSync } from "execa";
import type { EnvSnapshot, PortStatus } from "../types/index.js";

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

  /** 探测端口占用：能建立 TCP 连接即视为占用；ECONNREFUSED 视为空闲；其余异常保守视为占用。 */
  async checkPorts(ports: number[]): Promise<PortStatus[]> {
    return await Promise.all(ports.map((port) => this.#checkPort(port)));
  }

  #checkPort(port: number): Promise<PortStatus> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (occupied: boolean) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve({ port, occupied });
      };
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.setTimeout(1000);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(true));
      socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code !== "ECONNREFUSED"));
    });
  }
}
