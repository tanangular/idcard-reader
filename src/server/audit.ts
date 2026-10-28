/**
 * Append-only audit log in SQLite.
 *
 * The only thing that may identify a card is `cid_hash`: SHA-256 of
 * `AUDIT_SALT + citizenId`. Everything else the card carries — name,
 * address, birth date, photo — never reaches this module at all, because
 * `ReadOutcome` only carries the id and the error code.
 *
 * The salt is never written to the database. Without `AUDIT_SALT` the salt
 * is random per process, so hashes do not correlate across restarts — the
 * safer default, at the cost of continuity.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppErrorCode, AuditRow } from "#shared/protocol.ts";
import type { ReadOutcome } from "./state.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS read_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,
  reader      TEXT    NOT NULL,
  outcome     TEXT    NOT NULL,
  error_code  TEXT,
  duration_ms INTEGER NOT NULL,
  cid_hash    TEXT
);
CREATE INDEX IF NOT EXISTS idx_read_events_at ON read_events(at DESC);
`;

export interface AuditLogOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  /** Hashing salt. Defaults to AUDIT_SALT, then to a random per-process value. */
  salt?: string;
}

interface EventRow {
  id: number;
  at: string;
  reader: string;
  outcome: string;
  error_code: string | null;
  duration_ms: number;
  cid_hash: string | null;
}

type InsertParams = [string, string, string, string | null, number, string | null];

/** SHA-256 over `salt + citizenId`, lowercase hex. */
export function hashCitizenId(citizenId: string, salt: string): string {
  return createHash("sha256").update(salt).update(citizenId).digest("hex");
}

function toAuditRow(row: EventRow): AuditRow {
  return {
    id: row.id,
    at: row.at,
    reader: row.reader,
    outcome: row.outcome === "ok" ? "ok" : "error",
    errorCode: row.error_code as AppErrorCode | null,
    durationMs: row.duration_ms,
    // Only a short prefix is useful for spotting repeats; the full hash
    // stays server-side so the history page leaks as little as possible.
    cidHashShort: row.cid_hash === null ? "" : row.cid_hash.slice(0, 8),
  };
}

export class AuditLog {
  private readonly db: Database;
  private readonly salt: string;
  private readonly insert: ReturnType<Database["query"]>;
  private readonly page: ReturnType<Database["query"]>;
  private readonly count: ReturnType<Database["query"]>;

  constructor(options: AuditLogOptions) {
    const configured = options.salt ?? process.env["AUDIT_SALT"];
    // `??` alone treats an empty variable as a valid salt, hashing ids with
    // no salt at all. A blank value means "unset": randomise instead.
    this.salt =
      configured !== undefined && configured.trim().length > 0
        ? configured
        : randomBytes(32).toString("hex");

    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }

    this.db = new Database(options.path, { create: true });
    this.db.exec(SCHEMA);

    this.insert = this.db.query(
      "INSERT INTO read_events (at, reader, outcome, error_code, duration_ms, cid_hash) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.page = this.db.query(
      "SELECT id, at, reader, outcome, error_code, duration_ms, cid_hash FROM read_events ORDER BY at DESC, id DESC LIMIT ? OFFSET ?",
    );
    this.count = this.db.query("SELECT COUNT(*) AS n FROM read_events");
  }

  record(outcome: ReadOutcome): void {
    const params: InsertParams = [
      outcome.at.toISOString(),
      outcome.reader,
      outcome.errorCode === null ? "ok" : "error",
      outcome.errorCode,
      outcome.durationMs,
      outcome.citizenId === null ? null : hashCitizenId(outcome.citizenId, this.salt),
    ];
    this.insert.run(...params);
  }

  list(limit: number, offset: number): { rows: AuditRow[]; total: number } {
    const rows = this.page.all(limit, offset) as EventRow[];
    const counted = this.count.get() as { n: number } | null;
    return { rows: rows.map(toAuditRow), total: counted?.n ?? 0 };
  }

  close(): void {
    this.db.close();
  }
}
