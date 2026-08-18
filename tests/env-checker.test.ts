import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvChecker } from "../src/nose/env-checker.js";

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
});
