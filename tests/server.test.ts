import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appError } from "#server/errors";
import {
  createApp,
  createHub,
  DEFAULT_ALLOWED_ORIGINS,
  defaultAllowedOrigins,
  isOriginAllowed,
  safeJoin,
  type AppOptions,
  type CardSource,
  type HistorySource,
} from "#server/server";
import type { CardState, ReadResult } from "#server/state";
import type { AuditRow, ServerMsg, ThaiIdCard } from "#shared/protocol";

const CARD: ThaiIdCard = {
  citizenId: "1101700203456",
  nameTh: { prefix: "นาย", firstName: "สมชาย", middleName: null, lastName: "รักไทย" },
  nameEn: null,
  dateOfBirth: "1987-01-15",
  sex: "male",
  address: "99 หมู่ 5 ตำบลในเมือง",
  issueDate: "2017-01-01",
  expireDate: "2027-01-01",
  issuer: "สำนักทะเบียนกลาง",
  photo: { mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA==" },
  atr: "3B 79",
  readAt: "2026-10-28T10:00:00.000Z",
};

const AUDIT_ROW: AuditRow = {
  id: 1,
  at: "2026-10-28T10:00:00.000Z",
  reader: "Fake Reader",
  outcome: "ok",
  errorCode: null,
  durationMs: 640,
  cidHashShort: "a1b2c3d4",
};

describe("isOriginAllowed", () => {
  test("allows a request with no Origin at all", () => {
    expect(isOriginAllowed(null, DEFAULT_ALLOWED_ORIGINS)).toBe(true);
  });

  test("allows each configured origin exactly", () => {
    for (const origin of DEFAULT_ALLOWED_ORIGINS) {
      expect(isOriginAllowed(origin, DEFAULT_ALLOWED_ORIGINS)).toBe(true);
    }
  });

  test("rejects a foreign origin", () => {
    expect(isOriginAllowed("http://evil.example", DEFAULT_ALLOWED_ORIGINS)).toBe(false);
    expect(isOriginAllowed("http://127.0.0.1:9999", DEFAULT_ALLOWED_ORIGINS)).toBe(false);
    expect(isOriginAllowed("https://127.0.0.1:3000", DEFAULT_ALLOWED_ORIGINS)).toBe(false);
  });

  test("rejects the literal null origin sent by sandboxed pages", () => {
    expect(isOriginAllowed("null", DEFAULT_ALLOWED_ORIGINS)).toBe(false);
  });
});

describe("defaultAllowedOrigins", () => {
  test("covers the configured port and the Vite dev port", () => {
    const origins = defaultAllowedOrigins(4000);

    expect(origins).toContain("http://127.0.0.1:4000");
    expect(origins).toContain("http://localhost:4000");
    expect(origins).toContain("http://127.0.0.1:5173");
    expect(origins).not.toContain("http://127.0.0.1:3000");
  });

  test("covers a non-default host without duplicates", () => {
    const origins = defaultAllowedOrigins(4000, "localhost");
    expect(origins.filter((origin) => origin === "http://localhost:4000")).toHaveLength(1);
  });

  test("does not repeat an origin when the port is the Vite port", () => {
    const origins = defaultAllowedOrigins(5173);
    expect(new Set(origins).size).toBe(origins.length);
  });
});

describe("safeJoin", () => {
  const root = "/srv/dist";

  test("resolves a normal asset inside the root", () => {
    expect(safeJoin(root, "/assets/app.js")).toBe("/srv/dist/assets/app.js");
    expect(safeJoin(root, "/")).toBe("/srv/dist");
  });

  test("refuses traversal outside the root", () => {
    expect(safeJoin(root, "/../../etc/passwd")).toBeNull();
    expect(safeJoin(root, "/assets/../../../etc/passwd")).toBeNull();
  });

  test("refuses percent-encoded traversal", () => {
    expect(safeJoin(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(safeJoin(root, "/..%2f..%2fetc%2fpasswd")).toBeNull();
  });

  test("refuses NUL bytes and broken escapes", () => {
    expect(safeJoin(root, "/a%00b")).toBeNull();
    expect(safeJoin(root, "/%zz")).toBeNull();
  });
});

async function startServer(overrides: Partial<AppOptions> = {}) {
  const distDir = mkdtempSync(join(tmpdir(), "idcard-dist-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>spa</title>");
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "assets", "app.js"), "console.log('app')");
  writeFileSync(join(distDir, "secret.txt"), "not for you");

  const state: CardState = {
    phase: "waiting-card",
    reader: "Fake Reader",
    readers: ["Fake Reader"],
    card: null,
    error: null,
  };

  const service: CardSource = {
    getState: () => state,
    readNow: async (): Promise<ReadResult> => ({ ok: true, card: CARD }),
  };

  const auditCalls: Array<{ limit: number; offset: number }> = [];
  const audit: HistorySource = {
    list(limit, offset) {
      auditCalls.push({ limit, offset });
      return { rows: [AUDIT_ROW], total: 42 };
    },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    ...createApp({
      hub: createHub(),
      service,
      audit,
      listReaders: () => ["Fake Reader"],
      distDir,
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      ...overrides,
    }),
  });

  const base = `http://127.0.0.1:${server.port}`;
  return { server, base, state, distDir, auditCalls, service };
}

type Harness = Awaited<ReturnType<typeof startServer>>;

const running: Harness[] = [];

afterEach(() => {
  for (const harness of running.splice(0)) {
    harness.server.stop(true);
    rmSync(harness.distDir, { recursive: true, force: true });
  }
});

async function startWith(overrides: Partial<AppOptions> = {}): Promise<Harness> {
  const started = await startServer(overrides);
  running.push(started);
  return started;
}

/**
 * The DOM lib also declares `WebSocket`, and its constructor has no option
 * bag. Bun's runtime does accept `{ headers }`, which is how the tests send
 * a specific Origin.
 */
type BunWebSocketCtor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

const BunWebSocket = WebSocket as unknown as BunWebSocketCtor;

/** Queues server messages so nothing is lost between assertions. */
class TestClient {
  private readonly queue: ServerMsg[] = [];
  private readonly waiters: Array<(msg: ServerMsg) => void> = [];
  private readonly socket: WebSocket;

  constructor(url: string, origin?: string) {
    this.socket = origin ? new BunWebSocket(url, { headers: { origin } }) : new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMsg;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("websocket failed")), {
        once: true,
      });
    });
  }

  next(): Promise<ServerMsg> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  close(): void {
    this.socket.close();
  }
}

describe("Bun.serve app", () => {
  test("rejects a WebSocket upgrade from a foreign origin", async () => {
    const { base } = await startWith();

    const res = await fetch(`${base}/ws`, { headers: { origin: "http://evil.example" } });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain("origin");
  });

  test("accepts a WebSocket from an allowlisted origin", async () => {
    const { base } = await startWith();
    const client = new TestClient(`${base.replace("http", "ws")}/ws`, "http://127.0.0.1:5173");

    await client.open();
    expect(await client.next()).toEqual({
      type: "reader.state",
      state: "waiting-card",
      readers: ["Fake Reader"],
    });
    client.close();
  });

  test("sends the current snapshot to a client that connects late", async () => {
    const started = await startWith();
    started.state.phase = "ready";
    started.state.card = CARD;

    const client = new TestClient(`${started.base.replace("http", "ws")}/ws`);
    await client.open();

    expect(await client.next()).toEqual({
      type: "reader.state",
      state: "ready",
      readers: ["Fake Reader"],
    });
    expect(await client.next()).toEqual({ type: "card.snapshot", card: CARD });
    client.close();
  });

  test("sends the current error to a client that connects late", async () => {
    const started = await startWith();
    started.state.phase = "error";
    started.state.error = appError("PARSE_FAILED");

    const client = new TestClient(`${started.base.replace("http", "ws")}/ws`);
    await client.open();

    expect(await client.next()).toEqual({
      type: "reader.state",
      state: "error",
      readers: ["Fake Reader"],
    });
    expect(await client.next()).toEqual({
      type: "card.error",
      error: appError("PARSE_FAILED"),
    });
    client.close();
  });

  test("answers readers.list with the echoed id", async () => {
    const { base } = await startWith();
    const client = new TestClient(`${base.replace("http", "ws")}/ws`);
    await client.open();
    await client.next(); // reader.state

    client.send({ id: "r1", type: "readers.list" });

    expect(await client.next()).toEqual({
      id: "r1",
      type: "readers.list",
      ok: true,
      readers: ["Fake Reader"],
    });
    client.close();
  });

  test("reports a reader failure instead of dropping the request", async () => {
    const { base } = await startWith({
      listReaders: () => {
        throw new Error("framework exploded");
      },
    });
    const client = new TestClient(`${base.replace("http", "ws")}/ws`);
    await client.open();
    await client.next();

    client.send({ id: "r2", type: "readers.list" });

    const reply = await client.next();
    expect(reply).toMatchObject({ id: "r2", type: "readers.list", ok: false });
    if (reply.type === "readers.list" && reply.ok === false) {
      expect(reply.error.code).toBe("UNKNOWN");
    }
    client.close();
  });

  test("answers card.read with the read result", async () => {
    const { base } = await startWith();
    const client = new TestClient(`${base.replace("http", "ws")}/ws`);
    await client.open();
    await client.next();

    client.send({ id: "c1", type: "card.read" });

    expect(await client.next()).toEqual({ id: "c1", type: "card.read", ok: true, card: CARD });
    client.close();
  });

  test("answers card.read with the failure arm", async () => {
    const { base } = await startWith({
      service: {
        getState: () => ({
          phase: "error",
          reader: "Fake Reader",
          readers: ["Fake Reader"],
          card: null,
          error: appError("PARSE_FAILED"),
        }),
        readNow: async () => ({ ok: false, error: appError("PARSE_FAILED") }),
      },
    });
    const client = new TestClient(`${base.replace("http", "ws")}/ws`);
    await client.open();
    await client.next(); // reader.state
    await client.next(); // card.error from the open snapshot

    client.send({ id: "c2", type: "card.read" });

    expect(await client.next()).toEqual({
      id: "c2",
      type: "card.read",
      ok: false,
      error: appError("PARSE_FAILED"),
    });
    client.close();
  });

  test("answers history.list with the requested page", async () => {
    const { base, auditCalls } = await startWith();
    const client = new TestClient(`${base.replace("http", "ws")}/ws`);
    await client.open();
    await client.next();

    client.send({ id: "h1", type: "history.list", limit: 10, offset: 20 });

    expect(await client.next()).toEqual({
      id: "h1",
      type: "history.list",
      ok: true,
      rows: [AUDIT_ROW],
      total: 42,
    });
    expect(auditCalls).toEqual([{ limit: 10, offset: 20 }]);
    client.close();
  });

  test("ignores a malformed frame and keeps the connection alive", async () => {
    const { base } = await startWith();
    const client = new TestClient(`${base.replace("http", "ws")}/ws`);
    await client.open();
    await client.next();

    client.sendRaw("{not json");
    client.send({ id: "r3", type: "readers.list" });

    const reply = await client.next();
    expect(reply).toMatchObject({ id: "r3", ok: true });
    client.close();
  });

  test("serves the SPA shell for a client route", async () => {
    const { base } = await startWith();

    const res = await fetch(`${base}/history`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
  });

  test("serves a static asset with its content type", async () => {
    const { base } = await startWith();

    const res = await fetch(`${base}/assets/app.js`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe("console.log('app')");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  test("returns 404 for a missing asset instead of the SPA shell", async () => {
    const { base } = await startWith();

    const res = await fetch(`${base}/assets/missing.js`);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  test("never serves a file outside dist", async () => {
    const { base } = await startWith();

    const res = await fetch(`${base}/secret.txt`);

    // Inside dist, so it is served — the guard is about escaping it.
    expect(await res.text()).toBe("not for you");

    const escaped = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect(await escaped.text()).toContain("spa");
  });

  test("marks the SPA shell as uncacheable", async () => {
    const { base } = await startWith();

    const res = await fetch(`${base}/`);

    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
