#!/usr/bin/env node
import { Command } from "commander";
import { buildBridgeService, HumanAgent } from "../src/agent.js";
import { InterruptController } from "../src/heart/interrupt.js";
import { TextInput } from "../src/ears/text-input.js";
import { resolveStartupWorkspace } from "../src/nose/workspace-path.js";

const program = new Command();

program
  .name("human-agent")
  .description("A humanoid modular AI Agent CLI tool")
  .version("0.1.0")
  .option("--workspace <path>", "工作区目录（优先于 HUMAN_AGENT_WORKSPACE；缺省为启动目录）");

program.parse(process.argv);

const startup = resolveStartupWorkspace(
  program.opts().workspace as string | undefined,
  process.env.HUMAN_AGENT_WORKSPACE,
  process.cwd(),
);
if (!startup.ok) {
  console.error(`启动失败：${startup.error}`);
  process.exit(1);
}
const workspace = startup.workspace;

if (process.env.GEMINI_BRIDGE_PORT !== undefined) {
  // 桥模式：对话在网页（AI Studio），CLI 仅宿主 HTTP 服务
  const interrupt = new InterruptController();
  const service = buildBridgeService({
    workspace,
    signal: interrupt.getSignal(),
    logger: (text) => console.log(`[gemini-bridge] ${text}`),
  });
  process.on("SIGINT", () => interrupt.abort());
  process.on("SIGTERM", () => interrupt.abort());
  try {
    const port = await service.getPort();
    console.log(`工作区：${workspace}`);
    console.log(`Gemini 桥已监听 http://127.0.0.1:${port}`);
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
