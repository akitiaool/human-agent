import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvChecker } from "../src/nose/env-checker.js";

/** 在随机空闲端口上起一个真实监听，拿到一个"占用中"端口。 */
function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("无法获取监听端口"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

describe("EnvChecker", () => {
  const checker = new EnvChecker();
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "env-checker-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("返回当前平台与工作目录", () => {
    const snapshot = checker.getEnvSnapshot();
    expect(snapshot.os).toBe(process.platform);
    expect(snapshot.cwd).toBe(process.cwd());
  });

  it("在 git 仓库内能探测到当前分支", () => {
    const snapshot = checker.getEnvSnapshot();
    expect(snapshot.gitBranch).toBeTypeOf("string");
    expect(snapshot.gitBranch!.length).toBeGreaterThan(0);
  });

  it("在非 git 目录中不抛错且 gitBranch 为 undefined", () => {
    const snapshot = checker.getEnvSnapshot({ cwd: tmpDir });
    expect(snapshot.gitBranch).toBeUndefined();
  });

  it("已监听端口标记为占用，空闲端口标记为空闲", async () => {
    const { server, port } = await listenOnFreePort();
    try {
      const free = await new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          if (address === null || typeof address === "string") {
            reject(new Error("无法获取监听端口"));
            return;
          }
          probe.close(() => resolve(address.port));
        });
      });
      const statuses = await checker.checkPorts([port, free]);
      expect(statuses).toEqual([
        { port, occupied: true },
        { port: free, occupied: false },
      ]);
    } finally {
      server.close();
    }
  });
});
