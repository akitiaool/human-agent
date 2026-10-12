// 反思层（确定性代码）：裁决顺序 = 黑名单 → 未知工具 → 非法参数 → 白名单放行 → pending（spec §3.2）。
import type { BlockedCall, ReflectionVerdict, ToolCall } from "./llm.js";
import { fail } from "../types/index.js";
import { isToolName, tool } from "../tool/index.js";
import type { Permission } from "../permission/index.js";

export function createReflection(options: { permission: Permission }): {
  reflect(calls: readonly ToolCall[]): ReflectionVerdict;
} {
  const { permission } = options;
  return {
    reflect(calls) {
      const allowed: ToolCall[] = [];
      const pending: ToolCall[] = [];
      const blocked: BlockedCall[] = [];
      for (const call of calls) {
        const verdict = permission.verdict.decide(call);
        if (verdict.status === "blacklist") {
          blocked.push({ call, result: fail("blacklist", `黑名单命中：${verdict.key ?? call.name}`) });
          continue;
        }
        if (!isToolName(call.name)) {
          blocked.push({ call, result: fail("unknown-tool", `未知工具：${call.name}`) });
          continue;
        }
        const parsed = tool.schemas[call.name].safeParse(call.arguments ?? {});
        if (!parsed.success) {
          blocked.push({
            call,
            result: fail("invalid-args", `参数校验失败：${parsed.error.issues.map((i) => i.message).join("；")}`),
          });
          continue;
        }
        if (verdict.status === "allowed") {
          allowed.push(call);
          continue;
        }
        pending.push(call);
      }
      return { allowed, pending, blocked };
    },
  };
}
