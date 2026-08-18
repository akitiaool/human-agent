import { describe, expect, it } from "vitest";
import { RiskChecker } from "../src/nose/risk-checker.js";

describe("RiskChecker", () => {
  const checker = new RiskChecker();

  it("把 rm -rf 判定为 DANGEROUS", () => {
    expect(checker.checkRisk("rm -rf node_modules")).toBe("DANGEROUS");
  });

  it("把 sudo rm -rf 判定为 DANGEROUS", () => {
    expect(checker.checkRisk("sudo rm -rf /")).toBe("DANGEROUS");
  });

  it("把 DROP TABLE 判定为 DANGEROUS", () => {
    expect(checker.checkRisk("DROP TABLE users;")).toBe("DANGEROUS");
  });

  it("把 git push --force 判定为 DANGEROUS", () => {
    expect(checker.checkRisk("git push --force origin main")).toBe("DANGEROUS");
  });

  it("把 git push -f 判定为 DANGEROUS", () => {
    expect(checker.checkRisk("git push -f origin main")).toBe("DANGEROUS");
  });

  it("把 git reset --hard 判定为 DANGEROUS", () => {
    expect(checker.checkRisk("git reset --hard HEAD~1")).toBe("DANGEROUS");
  });

  it("把普通读取命令判定为 SAFE", () => {
    expect(checker.checkRisk("ls -la")).toBe("SAFE");
  });

  it("把只读 git 命令判定为 SAFE", () => {
    expect(checker.checkRisk("git status")).toBe("SAFE");
  });

  it("把包含 rm 字样但不构成删除的单词判定为 SAFE", () => {
    expect(checker.checkRisk("echo remove nothing")).toBe("SAFE");
  });

  it("大小写不敏感", () => {
    expect(checker.checkRisk("DROP TABLE users")).toBe("DANGEROUS");
  });
});
