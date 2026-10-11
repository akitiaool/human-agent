import type { BrainInferenceResult, CompositeToolCall, DiffHunk, ToolCall, ToolCallNode } from "./llm.js";

export enum NodeType {
  ROOT = "ROOT",
  PIPELINE = "PIPELINE",
  BATCH = "BATCH",
  TOOL_CALL = "TOOL_CALL",
  CONTENT = "CONTENT",
  COMMAND = "COMMAND",
  BEFORE = "BEFORE",
  AFTER = "AFTER",
}

export interface ASTNode {
  type: NodeType;
  id?: string | undefined;
  metadata: Record<string, string>;
  rawText: string;
  children: ASTNode[];
}

/** 嵌套白名单矩阵：只有在此集合内的子节点才允许入栈，其余一律作为纯文本累加 */
export const ALLOWED_CHILDREN_MAP: Readonly<Record<NodeType, ReadonlySet<NodeType>>> = {
  [NodeType.ROOT]: new Set([NodeType.PIPELINE, NodeType.BATCH, NodeType.TOOL_CALL]),
  [NodeType.PIPELINE]: new Set([NodeType.PIPELINE, NodeType.BATCH, NodeType.TOOL_CALL]),
  [NodeType.BATCH]: new Set([NodeType.PIPELINE, NodeType.BATCH, NodeType.TOOL_CALL]),
  [NodeType.TOOL_CALL]: new Set([NodeType.CONTENT, NodeType.COMMAND, NodeType.BEFORE]),
  [NodeType.CONTENT]: new Set(), // 终结符
  [NodeType.COMMAND]: new Set(), // 终结符
  [NodeType.BEFORE]: new Set(),  // 终结符
  [NodeType.AFTER]: new Set(),   // 终结符
};

export class ASTParser {
  private stack: ASTNode[] = [];

  parse(rawText: string): ASTNode | null {
    const unwrap = this.unwrapRoot(rawText);
    if (unwrap === null) return null; // 零歧义校验：外层必须且只能是 { ... }

    const root: ASTNode = {
      type: NodeType.ROOT,
      metadata: {},
      rawText: "",
      children: [],
    };
    this.stack = [root];

    const lines = unwrap.split(/\r?\n/);
    for (const line of lines) {
      this.consumeLine(line);
    }

    // 校验栈是否平衡回到根节点
    const stackBottom = this.stack[0];
    if (this.stack.length !== 1 || !stackBottom || stackBottom.type !== NodeType.ROOT) {
      return null;
    }

    return root;
  }

  /** 将语法树直接转换为系统执行器所需的 BrainInferenceResult */
  parseToInference(rawText: string): BrainInferenceResult | null {
    const root = this.parse(rawText);
    if (root === null || root.children.length === 0) {
      return null;
    }

    const treeNodes: ToolCallNode[] = [];
    for (const child of root.children) {
      const converted = this.convertASTToToolNode(child);
      if (converted !== null) {
        treeNodes.push(converted);
      }
    }

    if (treeNodes.length === 0) return null;
    const flatCalls = flattenToolCalls(treeNodes);
    return {
      text: "",
      toolCalls: flatCalls,
      toolTree: treeNodes,
    };
  }

  private consumeLine(line: string): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) return;

    const token = this.lexLine(line);

    // 1. 普通文本行：追加到栈顶节点
    if (token === null) {
      if (top.type === NodeType.TOOL_CALL) {
        const kv = this.parseKeyValue(line);
        if (kv !== null) {
          top.metadata[kv.key] = kv.value;
          return;
        }
      }
      top.rawText += (top.rawText.length > 0 ? "\n" : "") + line;
      return;
    }

    // 2. <::: 开启符 (OPEN)：白名单校验后入栈
    if (token.kind === "OPEN") {
      const allowed = ALLOWED_CHILDREN_MAP[top.type];
      if (allowed && allowed.has(token.type)) {
        const newNode: ASTNode = {
          type: token.type,
          id: token.id,
          metadata: {},
          rawText: "",
          children: [],
        };
        top.children.push(newNode);
        this.stack.push(newNode);
      } else {
        top.rawText += (top.rawText.length > 0 ? "\n" : "") + line;
      }
      return;
    }

    // 3. <::> 连续过渡符 (TRANSITION)：前一阶段出栈，同级新阶段入栈
    if (token.kind === "TRANSITION") {
      const parent = this.stack[this.stack.length - 2];
      if (parent && top.type === NodeType.BEFORE && token.type === NodeType.AFTER) {
        this.stack.pop(); // 弹出 BEFORE
        const afterNode: ASTNode = {
          type: NodeType.AFTER,
          id: token.id,
          metadata: {},
          rawText: "",
          children: [],
        };
        parent.children.push(afterNode);
        this.stack.push(afterNode); // 压入 AFTER
      } else if (parent && top.type === NodeType.AFTER && token.type === NodeType.BEFORE) {
        this.stack.pop(); // 弹出上一轮 AFTER
        const beforeNode: ASTNode = {
          type: NodeType.BEFORE,
          id: token.id,
          metadata: {},
          rawText: "",
          children: [],
        };
        parent.children.push(beforeNode);
        this.stack.push(beforeNode); // 压入新一轮 BEFORE
      } else {
        top.rawText += (top.rawText.length > 0 ? "\n" : "") + line;
      }
      return;
    }

    // 4. :::> 终结符 (CLOSE)：匹配出栈
    if (token.kind === "CLOSE") {
      if (top.type === token.type && (!token.id || top.id === token.id)) {
        this.stack.pop();
      } else {
        top.rawText += (top.rawText.length > 0 ? "\n" : "") + line;
      }
      return;
    }
  }

  private unwrapRoot(text: string): string | null {
    let t = text.trim();
    if (t.startsWith("```") && t.endsWith("```")) {
      t = t.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "").trim();
    }
    if (!t.startsWith("{") || !t.endsWith("}")) return null;
    return t.slice(1, -1).trim();
  }

  private parseKeyValue(line: string): { key: string; value: string } | null {
    const match = /^([a-zA-Z0-9_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match && match[1] !== undefined && match[2] !== undefined) {
      return { key: match[1], value: match[2].trim() };
    }
    return null;
  }

  private lexLine(line: string): { kind: "OPEN" | "TRANSITION" | "CLOSE"; type: NodeType; id?: string | undefined } | null {
    const trimmed = line.trim();
    const openMatch = /^<:::\s*([A-Z_]+)(?:\[([a-zA-Z0-9_-]+)\])?$/.exec(trimmed);
    if (openMatch && openMatch[1] !== undefined && openMatch[1] in NodeType) {
      return { kind: "OPEN", type: openMatch[1] as NodeType, id: openMatch[2] };
    }

    const transMatch = /^<::>\s*([A-Z_]+)(?:\[([a-zA-Z0-9_-]+)\])?$/.exec(trimmed);
    if (transMatch && transMatch[1] !== undefined && transMatch[1] in NodeType) {
      return { kind: "TRANSITION", type: transMatch[1] as NodeType, id: transMatch[2] };
    }

    const closeMatch = /^:::>\s*([A-Z_]+)(?:\[([a-zA-Z0-9_-]+)\])?$/.exec(trimmed);
    if (closeMatch && closeMatch[1] !== undefined && closeMatch[1] in NodeType) {
      return { kind: "CLOSE", type: closeMatch[1] as NodeType, id: closeMatch[2] };
    }

    return null;
  }

  private convertASTToToolNode(node: ASTNode): ToolCallNode | null {
    if (node.type === NodeType.PIPELINE || node.type === NodeType.BATCH) {
      const children: ToolCallNode[] = [];
      for (const child of node.children) {
        const sub = this.convertASTToToolNode(child);
        if (sub !== null) children.push(sub);
      }
      return {
        mode: node.type === NodeType.PIPELINE ? "pipeline" : "batch",
        calls: children,
      } as CompositeToolCall;
    }

    if (node.type === NodeType.TOOL_CALL) {
      const toolName = node.metadata.tool;
      if (!toolName) return null;

      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.metadata)) {
        if (k === "tool") continue;
        if (k === "start_line" || k === "line_count" || k === "timeout_ms" || k === "timeoutMs") {
          const num = Number(v);
          args[k === "timeout_ms" ? "timeoutMs" : k] = isNaN(num) ? v : num;
        } else {
          args[k] = v;
        }
      }

      // 提取原生数据块
      const hunks: DiffHunk[] = [];
      let currentBefore: ASTNode | null = null;

      for (const child of node.children) {
        if (child.type === NodeType.CONTENT) {
          args.content = child.rawText;
        } else if (child.type === NodeType.COMMAND) {
          args.command = child.rawText;
        } else if (child.type === NodeType.BEFORE) {
          currentBefore = child;
        } else if (child.type === NodeType.AFTER && currentBefore !== null) {
          hunks.push({
            search: currentBefore.rawText,
            replace: child.rawText,
          });
          currentBefore = null;
        }
      }

      if (hunks.length > 0) {
        args.hunks = hunks;
      }

      return {
        name: toolName,
        arguments: args,
      } as ToolCall;
    }

    return null;
  }
}

export function flattenToolCalls(nodes: readonly ToolCallNode[]): ToolCall[] {
  const result: ToolCall[] = [];
  for (const node of nodes) {
    if ("name" in node && typeof (node as ToolCall).name === "string") {
      result.push(node as ToolCall);
    } else if ("calls" in node && Array.isArray((node as CompositeToolCall).calls)) {
      result.push(...flattenToolCalls((node as CompositeToolCall).calls));
    }
  }
  return result;
}