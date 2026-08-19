// 反思层（潜意识）：决策后再想"可行吗"。确定性代码，不经过模型，
// 所有大脑共享同一套实现：存在性 → 结构 → 危险嗅探，逐条裁决。
import { schemas } from "./knowledge.js";
import type { ReflectionVerdict, ToolCall } from "./llm.js";
import { fail, type MouthContract, type NoseContract } from "../types/index.js";

export class Reflection {
  readonly #nose: NoseContract;
  readonly #mouth: MouthContract;

  constructor(nose: NoseContract, mouth: MouthContract) {
    this.#nose = nose;
    this.#mouth = mouth;
  }

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    const allowed: ToolCall[] = [];
    const blocked: ReflectionVerdict["blocked"] = [];
    for (const call of calls) {
      const schema = schemas[call.name as keyof typeof schemas];
      if (schema === undefined) {
        blocked.push({ call, result: fail("UNKNOWN_TOOL", `未知工具: ${call.name}`) });
        continue;
      }
      const parsed = schema.safeParse(call.arguments);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        blocked.push({
          call,
          result: fail("INVALID_ARGS", `工具 ${call.name} 参数不合法: ${issues}`),
        });
        continue;
      }
      if (call.name === "terminal") {
        const { command } = parsed.data as { command: string };
        if (this.#nose.checkRisk(command) === "DANGEROUS") {
          const approved = await this.#mouth.confirm(`命令存在风险，是否执行？\n  ${command}`);
          if (!approved) {
            blocked.push({ call, result: fail("USER_DENIED", `用户拒绝了命令: ${command}`) });
            continue;
          }
        }
      }
      allowed.push(call);
    }
    return { allowed, blocked };
  }
}
