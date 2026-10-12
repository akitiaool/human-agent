// 统一信封（传输层判定，每响应一封；spec §5.1）。
export type TransportCode = "invalid-body" | "unknown-endpoint" | "method-not-allowed" | "unknown-approval" | "internal";

export interface EnvelopeOk<T> {
  status: "ok";
  data?: T;
}

export interface EnvelopeError {
  status: "error";
  error: { code: TransportCode; message: string };
}

export type Envelope<T = unknown> = EnvelopeOk<T> | EnvelopeError;

export function okEnvelope<T>(data?: T): EnvelopeOk<T> {
  return data === undefined ? { status: "ok" } : { status: "ok", data };
}

export function errorEnvelope(code: TransportCode, message: string): EnvelopeError {
  return { status: "error", error: { code, message } };
}

export const TRANSPORT_STATUS: Record<TransportCode, number> = {
  "invalid-body": 400,
  "unknown-endpoint": 404,
  "method-not-allowed": 405,
  "unknown-approval": 404,
  internal: 500,
};
