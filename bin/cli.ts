#!/usr/bin/env node
import { Command } from "commander";
import { HumanAgent } from "../src/agent.js";
import { GeminiBridgeThinking } from "../src/brain/gemini-bridge-thinking.js";
import { TextInput } from "../src/ears/text-input.js";

const program = new Command();

program
  .name("human-agent")
  .description("A humanoid modular AI Agent CLI tool")
  .version("0.1.0");

program.parse(process.argv);

const agent = new HumanAgent();
process.on("SIGINT", () => agent.interrupt.abort());
process.on("SIGTERM", () => agent.interrupt.abort());
if (agent.brain instanceof GeminiBridgeThinking) {
  // 桥服务构造时即绑定端口；端口被占用（EADDRINUSE）会异步拒绝，
  // 必须先消费该拒绝再进入会话，否则 Node ≥20 以未处理拒绝崩溃。
  try {
    await agent.brain.getPort();
  } catch (err) {
    console.error(`Gemini 桥无法监听端口：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
const status = await agent.run();
if (agent.ears instanceof TextInput) agent.ears.close();
if (agent.brain instanceof GeminiBridgeThinking) agent.brain.close();
process.exitCode = status === "ERROR" ? 1 : status === "INTERRUPTED" ? 130 : 0;
