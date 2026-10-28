import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, hashCitizenId } from "#server/audit.ts";
import type { ReadOutcome } from "#server/state.ts";

/** Synthetic 13-digit id; it appears nowhere on disk after a read. */
const CID = "1101700203456";
const SALT = "unit-test-salt";

function outcome(overrides: Partial<ReadOutcome> = {}): ReadOutcome {
  return {
    reader: "Fake Reader",
    at: new Date("2026-10-28T10:00:00.000Z"),
    durationMs: 640,
    citizenId: CID,
    errorCode: null,
    ...overrides,
  };
}

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "idcard-audit-"));
  tempDirs.push(dir);
  return join(dir, "audit.db");
}

/** Byte search that does not depend on the file being valid text. */
function containsBytes(haystack: Uint8Array, needle: string): boolean {
  const bytes = new TextEncoder().encode(needle);
  if (bytes.length === 0) return true;
  outer: for (let i = 0; i + bytes.length <= haystack.length; i++) {
    for (let j = 0; j < bytes.length; j++) {
      if (haystack[i + j] !== bytes[j]) continue outer;
    }
    return true;
  }
  return false;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hashCitizenId", () => {
  test("is a 64-char lowercase hex SHA-256", () => {
    expect(hashCitizenId(CID, SALT)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable for the same salt and different for another", () => {
    expect(hashCitizenId(CID, SALT)).toBe(hashCitizenId(CID, SALT));
    expect(hashCitizenId(CID, SALT)).not.toBe(hashCitizenId(CID, "other-salt"));
  });

  test("changes with the input", () => {
    expect(hashCitizenId(CID, SALT)).not.toBe(hashCitizenId("1101700203457", SALT));
  });
});

describe("AuditLog", () => {
  test("treats an empty or whitespace salt as unset", () => {
    for (const salt of ["", "   "]) {
      const log = new AuditLog({ path: ":memory:", salt });
      log.record(outcome());

      const row = log.list(1, 0).rows[0]!;
      expect(row.cidHashShort).not.toBe(hashCitizenId(CID, "").slice(0, 8));
      expect(row.cidHashShort).not.toBe(hashCitizenId(CID, salt).slice(0, 8));
      log.close();
    }
  });

  test("records a successful read and lists it newest first", () => {
    const log = new AuditLog({ path: ":memory:", salt: SALT });

    log.record(outcome());

    const { rows, total } = log.list(10, 0);
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      reader: "Fake Reader",
      outcome: "ok",
      errorCode: null,
      durationMs: 640,
      at: "2026-10-28T10:00:00.000Z",
    });
    expect(rows[0]!.cidHashShort).toBe(hashCitizenId(CID, SALT).slice(0, 8));
    log.close();
  });

  test("records a failed read with the error code and no hash", () => {
    const log = new AuditLog({ path: ":memory:", salt: SALT });

    log.record(outcome({ citizenId: null, errorCode: "PARSE_FAILED" }));

    const row = log.list(10, 0).rows[0]!;
    expect(row.outcome).toBe("error");
    expect(row.errorCode).toBe("PARSE_FAILED");
    expect(row.cidHashShort).toBe("");
    log.close();
  });

  test("never exposes more than 8 hex chars of the hash over the wire", () => {
    const log = new AuditLog({ path: ":memory:", salt: SALT });
    log.record(outcome());

    const row = log.list(10, 0).rows[0]!;
    expect(row.cidHashShort).toHaveLength(8);
    expect(JSON.stringify(row)).not.toContain(hashCitizenId(CID, SALT));
    log.close();
  });

  test("paginates with a total count", () => {
    const log = new AuditLog({ path: ":memory:", salt: SALT });
    for (const second of [0, 1, 2]) {
      log.record(outcome({ at: new Date(Date.UTC(2026, 9, 28, 10, 0, second)) }));
    }

    const first = log.list(2, 0);
    expect(first.total).toBe(3);
    expect(first.rows.map((r) => r.at)).toEqual([
      "2026-10-28T10:00:02.000Z",
      "2026-10-28T10:00:01.000Z",
    ]);

    const second = log.list(2, 2);
    expect(second.total).toBe(3);
    expect(second.rows.map((r) => r.at)).toEqual(["2026-10-28T10:00:00.000Z"]);
    log.close();
  });

  test("stores the full hash in the database", () => {
    const file = tempDbPath();
    const log = new AuditLog({ path: file, salt: SALT });
    log.record(outcome());
    log.close();

    const db = new Database(file, { readonly: true });
    const row = db.query("SELECT cid_hash FROM read_events").get() as { cid_hash: string };
    db.close();

    expect(row.cid_hash).toBe(hashCitizenId(CID, SALT));
  });

  test("the database file contains no PII", async () => {
    const file = tempDbPath();
    const log = new AuditLog({ path: file, salt: SALT });
    log.record(outcome());
    log.close();

    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());

    const forbidden = [
      CID,
      "1101700203", // any long prefix of the id
      "สมชาย",
      "ใจดี",
      "รักไทย",
      "99 หมู่ 5",
      "1987-01-15",
      "Somchai",
      "JaiDee",
      "Rakthai",
      "สำนักทะเบียนกลาง",
      "data:image/jpeg",
    ];

    for (const needle of forbidden) {
      expect({ needle, found: containsBytes(bytes, needle) }).toEqual({ needle, found: false });
    }

    // The hash itself must be there, otherwise the test proves nothing.
    expect(containsBytes(bytes, hashCitizenId(CID, SALT))).toBe(true);
  });

  test("creates missing parent directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "idcard-audit-"));
    tempDirs.push(dir);
    const file = join(dir, "nested", "deep", "audit.db");

    const log = new AuditLog({ path: file, salt: SALT });
    log.record(outcome());
    log.close();

    expect(existsSync(file)).toBe(true);
  });

  test("uses AUDIT_SALT when no salt is passed", () => {
    const previous = process.env["AUDIT_SALT"];
    process.env["AUDIT_SALT"] = "from-env";
    try {
      const log = new AuditLog({ path: ":memory:" });
      log.record(outcome());
      expect(log.list(1, 0).rows[0]!.cidHashShort).toBe(hashCitizenId(CID, "from-env").slice(0, 8));
      log.close();
    } finally {
      if (previous === undefined) delete process.env["AUDIT_SALT"];
      else process.env["AUDIT_SALT"] = previous;
    }
  });

  test("falls back to a random per-process salt", () => {
    const previous = process.env["AUDIT_SALT"];
    delete process.env["AUDIT_SALT"];
    try {
      const a = new AuditLog({ path: ":memory:" });
      const b = new AuditLog({ path: ":memory:" });
      a.record(outcome());
      b.record(outcome());

      expect(a.list(1, 0).rows[0]!.cidHashShort).not.toBe(b.list(1, 0).rows[0]!.cidHashShort);
      a.close();
      b.close();
    } finally {
      if (previous !== undefined) process.env["AUDIT_SALT"] = previous;
    }
  });
});
