#!/usr/bin/env node
import { Command } from "commander";
import { HumanAgent } from "../src/agent.js";
import { createBridge } from "../src/bridge/index.js";
import { InterruptController } from "../src/heart/interrupt.js";
import { TextInput } from "../src/ears/text-input.js";
import { permission } from "../src/permission/index.js";

const program = new Command();

program
  .name("human-agent")
  .description("A humanoid modular AI Agent CLI tool")
  .version("0.1.0")
  .option("--workspace <path>", "工作区目录（优先于 HUMAN_AGENT_WORKSPACE；缺省为启动目录）");

program.parse(process.argv);

// 工作区三级决议：--workspace > HUMAN_AGENT_WORKSPACE > 启动 CWD（realpath 规范化且必须为已存在目录）
const resolved = permission.workspace.resolve(
  program.opts().workspace as string | undefined,
  process.env.HUMAN_AGENT_WORKSPACE,
  process.cwd(),
);
if (resolved.status === "error") {
  console.error(`启动失败：${resolved.error.message}`);
  process.exit(1);
}
const workspace = resolved.workspace;

if (process.env.GEMINI_BRIDGE_PORT !== undefined) {
  // 桥模式：对话在网页（AI Studio），CLI 仅宿主 HTTP 服务
  const parsed = Number.parseInt(process.env.GEMINI_BRIDGE_PORT, 10);
  const port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 8765;
  const interrupt = new InterruptController();
  const service = createBridge({
    workspace,
    port,
    signal: interrupt.getSignal(),
    logger: (text) => console.log(`[gemini-bridge] ${text}`),
  });
  process.on("SIGINT", () => interrupt.abort());
  process.on("SIGTERM", () => interrupt.abort());
  try {
    const actual = await service.getPort();
    console.log(`工作区：${workspace}`);
    console.log(`Gemini 桥已监听 http://127.0.0.1:${actual}`);
    console.log("请在 AI Studio 页面与 Gemini 对话；插件会把 Gemini 的回复传给智能体执行工具，并把结果回填提交。");
  } catch (err) {
    console.error(`Gemini 桥无法监听端口：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  await new Promise<void>((resolve) => {
    if (interrupt.isAborted()) resolve();
    else interrupt.getSignal().addEventListener("abort", () => resolve(), { once: true });
  });
  service.close();
  process.exitCode = interrupt.isAborted() ? 130 : 0;
} else {
  const agent = new HumanAgent({ workspace });
  process.on("SIGINT", () => agent.interrupt.abort());
  process.on("SIGTERM", () => agent.interrupt.abort());
  console.log(`工作区：${workspace}`);
  const status = await agent.run();
  if (agent.ears instanceof TextInput) agent.ears.close();
  process.exitCode = status === "ERROR" ? 1 : status === "INTERRUPTED" ? 130 : 0;
}
