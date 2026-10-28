/**
 * The single source of truth for the wire protocol and the data shapes
 * shared by server and client.
 *
 * Rules encoded here:
 *  - every request carries an `id`; responses echo it back
 *  - push events carry no `id`
 *  - nothing in this file may be persisted, except `AuditRow` (which has no PII)
 */

export type Sex = "male" | "female" | "unknown";

export interface PersonName {
  prefix: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
}

/** In-memory only. Never written to disk, logs, error messages or URLs. */
export interface ThaiIdCard {
  citizenId: string;
  nameTh: PersonName;
  nameEn: PersonName | null;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  sex: Sex;
  address: string;
  /** YYYY-MM-DD */
  issueDate: string;
  /** YYYY-MM-DD */
  expireDate: string;
  issuer: string;
  photo: { mime: "image/jpeg"; dataUrl: string };
  /** ATR as uppercase hex pairs separated by spaces. */
  atr: string;
  /** ISO8601 */
  readAt: string;
}

export type AppErrorCode =
  | "NO_READER"
  | "NO_CARD"
  | "CARD_REMOVED"
  | "SHARING_VIOLATION"
  | "NOT_THAI_ID"
  | "SECURITY_STATUS"
  | "TRANSMIT_FAILED"
  | "PARSE_FAILED"
  | "UNKNOWN";

export interface AppError {
  code: AppErrorCode;
  /** Thai message safe to show in the UI. Must never contain card data. */
  message: string;
  /** EMV status word, e.g. "6A82". */
  sw?: string;
  /** PC/SC error code, e.g. "0x80100069". */
  pcscCode?: string;
}

/** Persisted audit record. Must never contain PII. */
export interface AuditRow {
  id: number;
  /** ISO8601 */
  at: string;
  reader: string;
  outcome: "ok" | "error";
  errorCode: AppErrorCode | null;
  durationMs: number;
  /** First 8 hex chars of SHA-256(salt + citizenId). Empty string when unavailable. */
  cidHashShort: string;
}

export type ProgressStep = "select" | "cid" | "name" | "address" | "photo";

export type ClientMsg =
  | { id: string; type: "readers.list" }
  | { id: string; type: "card.read" }
  | { id: string; type: "history.list"; limit: number; offset: number };

export type ReaderState = "no-reader" | "waiting-card" | "reading" | "ready" | "error";

export type ServerMsg =
  | { id: string; type: "readers.list"; ok: true; readers: string[] }
  | { id: string; type: "readers.list"; ok: false; error: AppError }
  | { id: string; type: "card.read"; ok: true; card: ThaiIdCard }
  | { id: string; type: "card.read"; ok: false; error: AppError }
  | { id: string; type: "history.list"; ok: true; rows: AuditRow[]; total: number }
  | { id: string; type: "history.list"; ok: false; error: AppError }
  | { type: "reader.state"; state: ReaderState; readers: string[] }
  | { type: "card.snapshot"; card: ThaiIdCard }
  | { type: "card.inserted"; reader: string }
  | { type: "card.removed"; reader: string }
  | { type: "card.progress"; step: ProgressStep; pct: number }
  | { type: "card.error"; error: AppError };

/** Upper bound on a single history page. */
export const MAX_HISTORY_LIMIT = 100;

export type ParseResult = { ok: true; msg: ClientMsg } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parse one WebSocket frame into a ClientMsg.
 *
 * The socket is reachable by anything that can open a connection to
 * localhost, so every field is treated as untrusted: unknown types,
 * missing ids, and out-of-range paging are all rejected rather than
 * coerced into something valid.
 */
export function parseClientMsg(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }

  if (!isRecord(value)) return { ok: false, reason: "message must be an object" };
  if (!isNonEmptyString(value["id"])) return { ok: false, reason: "missing id" };

  const id = value["id"];
  const type = value["type"];

  switch (type) {
    case "readers.list":
      return { ok: true, msg: { id, type } };

    case "card.read":
      return { ok: true, msg: { id, type } };

    case "history.list": {
      const limit = value["limit"];
      const offset = value["offset"];
      if (typeof limit !== "number" || !Number.isInteger(limit)) {
        return { ok: false, reason: "limit must be an integer" };
      }
      if (limit < 1 || limit > MAX_HISTORY_LIMIT) {
        return { ok: false, reason: `limit must be between 1 and ${MAX_HISTORY_LIMIT}` };
      }
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
        return { ok: false, reason: "offset must be a non-negative integer" };
      }
      return { ok: true, msg: { id, type, limit, offset } };
    }

    default:
      return { ok: false, reason: "unknown message type" };
  }
}
