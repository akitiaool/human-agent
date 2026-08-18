import type { RiskLevel } from "../types/index.js";

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[^\s]*r[^\s]*f[^\s]*\b/i, // rm -rf / -r -f
  /\bsudo\s+rm\b/i,
  /\bdrop\s+table\b/i,
  /\bgit\s+push\b[^\n|;]*\s(?:-f|--force)\b/i, // git push --force / -f
  /\bgit\s+reset\s+--hard\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/f(?:\s+\/s)?\b/i,
  /\bformat\s+[a-z]:\b/i,
  /\btaskkill\b[^\n|;]*\/f\b/i,
  /\bkill\s+-9\b/i,
];

export class RiskChecker {
  checkRisk(command: string): RiskLevel {
    return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))
      ? "DANGEROUS"
      : "SAFE";
  }
}
