// 通用 Thinking 基类：确定性层（权限 + 反思 + 工作区）单一实现，
// OllamaThinking / GeminiBridgeThinking 继承升级，桥与 CLI 裁决行为必然一致。
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "./llm.js";
import { Reflection } from "./reflection.js";
import { serializeToolProtocol } from "./knowledge.js";
import { PermissionPolicy, type Classification } from "../nose/policy.js";
import type { WhitelistEntry } from "../types/index.js";

export interface BaseThinkingOptions {
  /** 工作区（CWD）；缺省 process.cwd()，启动后不可被智能体更改。 */
  workspace?: string;
  /** 白名单文件；缺省 ~/.human-agent/whitelist.json */
  whitelistFile?: string;
}

export abstract class BaseThinking {
  readonly #workspace: string;
  readonly #reflection: Reflection;
  readonly #permission: PermissionPolicy;

  constructor(options: BaseThinkingOptions = {}) {
    this.#workspace = options.workspace ?? process.cwd();
    this.#permission = new PermissionPolicy({
      workspace: this.#workspace,
      ...(options.whitelistFile !== undefined ? { file: options.whitelistFile } : {}),
    });
    this.#permission.ensureWorkspace();
    this.#reflection = new Reflection(this.#permission);
  }

  /** 统一裁决入口：黑名单 → 未知/非法 → 白名单 → 需授权。 */
  reflect(calls: readonly ToolCall[]): ReturnType<Reflection["reflect"]> {
    return this.#reflection.reflect(calls);
  }

  classify(call: ToolCall): Classification {
    return this.#permission.classify(call);
  }

  /** 白名单落盘（用户经弹窗/嘴巴批准后由宿主调用）；同步内部实现，返回 Promise 兼容接口。 */
  addWhitelistEntry(entry: WhitelistEntry): Promise<void> {
    this.#permission.addEntry(entry);
    return Promise.resolve();
  }

  /** 工作区声明（软约束）：协议文本 / system prompt 共用。 */
  workspaceConstraint(): string {
    return `你的工作区是 ${this.#workspace}，工具调用请保持在界内；界外操作需要用户授权。`;
  }

  /** 工具协议文本：工作区声明 + 工具清单与调用规则。 */
  toolProtocol(): string {
    return `${this.workspaceConstraint()}\n\n${serializeToolProtocol()}`;
  }

  static defaultWhitelistFile(): string {
    return join(homedir(), ".human-agent", "whitelist.json");
  }
}
