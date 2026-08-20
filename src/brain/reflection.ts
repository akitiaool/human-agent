// 反思层（潜意识）：决策后再想"可行吗"。确定性代码，不经过模型。
// 裁决顺序：权限黑名单 → 存在性 → 结构 → 白名单放行 → 其余需授权。
// 权限层注入 PermissionPolicy；"需授权"仅作标记，审批通道由宿主（桥/loop）负责。
import { schemas } from "./knowledge.js";
import { matchKeyFor, type PermissionPolicy } from "../nose/policy.js";
import type { ReflectionVerdict, ToolCall } from "./llm.js";
import { fail } from "../types/index.js";

export class Reflection {
  readonly #policy: PermissionPolicy;

  constructor(policy: PermissionPolicy) {
    this.#policy = policy;
  }

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    const allowed: ToolCall[] = [];
    const pending: ToolCall[] = [];
    const blocked: ReflectionVerdict["blocked"] = [];
    for (const call of calls) {
      if (this.#policy.classify(call) === "blacklist") {
        blocked.push({
          call,
          result: fail("BLACKLIST", `系统破坏操作，禁止执行：${matchKeyFor(call) ?? call.name}`),
        });
        continue;
      }
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
      if (this.#policy.classify(call) === "whitelist") allowed.push(call);
      else pending.push(call);
    }
    return { allowed, pending, blocked };
  }
}
