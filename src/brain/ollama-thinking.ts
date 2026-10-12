import type { ConversationContext, Message } from "./context.js";
import type {
  BrainInference,
  BrainInferenceResult,
  ReflectionVerdict,
  ToolCall,
  ToolInfo,
} from "./llm.js";
import { createReflection } from "./reflection.js";
import { createPermission, type Permission } from "../permission/index.js";

export interface OllamaThinkingOptions {
  /** 权限域实例（与 loop 共持同一实例）；缺省按 workspace/whitelistFile 新建。 */
  permission?: Permission;
  /** 工作区（缺省 process.cwd()）；仅在未注入 permission 时生效。 */
  workspace?: string;
  /** 白名单文件；缺省 ~/.human-agent/whitelist.json（仅在未注入 permission 时生效）。 */
  whitelistFile?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

/** 思考层的 Ollama 实现：走本机 /api/chat 协议，支持工具调用；确定性裁决委托反思层。 */
export class OllamaThinking implements BrainInference {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetchImpl: typeof fetch;
  readonly #permission: Permission;
  readonly #reflection: ReturnType<typeof createReflection>;

  constructor(options: OllamaThinkingOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "http://localhost:11434";
    this.#model = options.model ?? "qwen3:4b";
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#permission =
      options.permission ??
      createPermission({
        workspace: options.workspace ?? process.cwd(),
        ...(options.whitelistFile !== undefined ? { whitelistFile: options.whitelistFile } : {}),
      });
    this.#reflection = createReflection({ permission: this.#permission });
  }

  async infer(
    context: ConversationContext,
    tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult> {
    const body: Record<string, unknown> = {
      model: this.#model,
      stream: false,
      messages: context.getAll().map(toOllamaMessage),
    };
    if (tools.length > 0) {
      body.tools = tools.map(toOllamaTool);
    }
    const response = await this.#fetchImpl(`${this.#baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Ollama API ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { message: OllamaMessage };
    return {
      text: data.message.content ?? "",
      ...(data.message.tool_calls ? { toolCalls: data.message.tool_calls.map(toToolCall) } : {}),
    };
  }

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    return this.#reflection.reflect(calls);
  }
}

function toOllamaMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls
          ? { tool_calls: message.toolCalls.map((call) => ({ function: call })) }
          : {}),
      };
    case "tool":
      return { role: "tool", content: message.content };
  }
}

function toOllamaTool(tool: ToolInfo): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toToolCall(call: OllamaToolCall): ToolCall {
  return { name: call.function.name, arguments: call.function.arguments };
}
