// 全局类型统一出口：全局状态、工具结果与事件类型（设计文档 §2）
export type {
  ActionResult,
  AgentOutput,
  AgentPhase,
  AgentStatus,
  EnvSnapshot,
  EarsContract,
  EyesContract,
  HandsContract,
  MouthContract,
  NoseContract,
  PortStatus,
  RiskLevel,
} from "./organ.js";

export { fail, ok } from "./organ.js";
