#!/usr/bin/env node
import { Command } from "commander";
import { HumanAgent } from "../src/agent.js";
import { GeminiBridgeThinking } from "../src/brain/thinking/gemini-bridge-thinking.js";
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
const status = await agent.run();
if (agent.ears instanceof TextInput) agent.ears.close();
if (agent.brain instanceof GeminiBridgeThinking) agent.brain.close();
process.exitCode = status === "ERROR" ? 1 : status === "INTERRUPTED" ? 130 : 0;
