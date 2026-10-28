import { describe, expect, test } from "bun:test";
import { createCardClient, type SocketLike, type Timer } from "../src/client/ws.ts";
import type { ServerMsg, ThaiIdCard } from "../src/shared/protocol.ts";

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

type Listener = (event: { data?: unknown }) => void;

/** Minimal stand-in for the browser WebSocket: the client sees no difference. */
class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;

  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list) list.push(listener);
    else this.listeners.set(type, [listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(msg: ServerMsg): void {
    this.raw(JSON.stringify(msg));
  }

  raw(data: string): void {
    this.emit("message", { data });
  }

  serverClose(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Records timers instead of waiting, so backoff is asserted in milliseconds. */
class FakeTimer implements Timer {
  private next = 1;
  private readonly scheduled = new Map<number, { fn: () => void; ms: number }>();

  set(fn: () => void, ms: number): number {
    const id = this.next++;
    this.scheduled.set(id, { fn, ms });
    return id;
  }

  clear(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  get size(): number {
    return this.scheduled.size;
  }

  runNext(): number {
    const first = this.scheduled.entries().next();
    if (first.done) throw new Error("no timer is scheduled");
    const [id, entry] = first.value;
    this.scheduled.delete(id);
    entry.fn();
    return entry.ms;
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timer = new FakeTimer();
  const client = createCardClient({
    url: "ws://127.0.0.1:3000/ws",
    makeSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    timer,
    retryBaseMs: 500,
    retryMaxMs: 10_000,
    requestTimeoutMs: 5000,
  });

  const current = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket has been opened");
    return socket;
  };

  return { client, sockets, timer, current };
}

describe("connection", () => {
  test("connects only when asked", () => {
    const { client, sockets } = harness();

    expect(client.connected()).toBe(false);
    expect(sockets).toHaveLength(0);

    client.connect();
    expect(sockets).toHaveLength(1);
    expect(client.connected()).toBe(false);
  });

  test("marks itself connected on open and applies reader.state", () => {
    const { client, sockets } = harness();
    client.connect();

    sockets[0]!.open();
    expect(client.connected()).toBe(true);

    sockets[0]!.message({
      type: "reader.state",
      state: "waiting-card",
      readers: ["Fake Reader"],
    });
    expect(client.phase()).toBe("waiting-card");
    expect(client.readers()).toEqual(["Fake Reader"]);
  });

  test("does not create a second socket when connect is called twice", () => {
    const { client, sockets } = harness();

    client.connect();
    client.connect();

    expect(sockets).toHaveLength(1);
  });
});

describe("server pushes", () => {
  test("stores a snapshot and clears it when the card leaves", () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();

    sockets[0]!.message({ type: "card.snapshot", card: CARD });
    expect(client.card()).toEqual(CARD);
    expect(client.phase()).toBe("ready");

    sockets[0]!.message({ type: "card.removed", reader: "Fake Reader" });
    expect(client.card()).toBeNull();
  });

  test("clears the snapshot when the reader leaves the ready phase", () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message({ type: "card.snapshot", card: CARD });

    sockets[0]!.message({ type: "reader.state", state: "reading", readers: ["Fake Reader"] });

    expect(client.card()).toBeNull();
    expect(client.progress()).toBeNull();
  });

  test("tracks progress and resets it when a new card is inserted", () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();

    sockets[0]!.message({ type: "card.progress", step: "photo", pct: 42 });
    expect(client.progress()).toEqual({ step: "photo", pct: 42 });

    sockets[0]!.message({ type: "card.inserted", reader: "Fake Reader" });
    expect(client.progress()).toBeNull();
    expect(client.card()).toBeNull();
    expect(client.error()).toBeNull();
  });

  test("stores and clears the last error", () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();

    sockets[0]!.message({
      type: "card.error",
      error: { code: "PARSE_FAILED", message: "อ่านข้อมูลบนบัตรไม่สำเร็จ" },
    });
    expect(client.error()?.code).toBe("PARSE_FAILED");

    sockets[0]!.message({ type: "card.inserted", reader: "Fake Reader" });
    expect(client.error()).toBeNull();
  });

  test("ignores a malformed frame", () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();

    sockets[0]!.raw("{not json");
    sockets[0]!.raw(JSON.stringify({ type: 42 }));

    expect(client.connected()).toBe(true);
    expect(client.phase()).toBe("no-reader");
  });

  test("clears the card and progress when the connection drops", () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.message({ type: "card.snapshot", card: CARD });
    sockets[0]!.message({ type: "card.progress", step: "photo", pct: 10 });

    sockets[0]!.serverClose();

    expect(client.connected()).toBe(false);
    expect(client.card()).toBeNull();
    expect(client.progress()).toBeNull();
  });
});

describe("requests", () => {
  test("sends an id and resolves with the matching reply", async () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();

    const pending = client.listReaders();
    expect(sockets[0]!.sent).toHaveLength(1);
    const frame = JSON.parse(sockets[0]!.sent[0]!) as { id: string; type: string };
    expect(frame.type).toBe("readers.list");
    expect(frame.id.length).toBeGreaterThan(0);

    sockets[0]!.message({ id: frame.id, type: "readers.list", ok: true, readers: ["A"] });

    await expect(pending).resolves.toEqual({
      id: frame.id,
      type: "readers.list",
      ok: true,
      readers: ["A"],
    });
  });

  test("correlates two requests even when replies arrive out of order", async () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();

    const readers = client.listReaders();
    const history = client.listHistory(10, 20);
    const [sentReaders, sentHistory] = sockets[0]!.sent.map(
      (frame) => JSON.parse(frame) as { id: string },
    );

    sockets[0]!.message({
      id: sentHistory!.id,
      type: "history.list",
      ok: true,
      rows: [],
      total: 0,
    });
    sockets[0]!.message({
      id: sentReaders!.id,
      type: "readers.list",
      ok: true,
      readers: ["A"],
    });

    await expect(history).resolves.toMatchObject({ type: "history.list", total: 0 });
    await expect(readers).resolves.toMatchObject({ type: "readers.list", readers: ["A"] });
  });

  test("rejects a request made before the socket is open", async () => {
    const { client } = harness();

    await expect(client.listReaders()).rejects.toMatchObject({ code: "OFFLINE" });
  });

  test("rejects a pending request when the socket closes", async () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();

    const pending = client.readCard();
    sockets[0]!.serverClose();

    await expect(pending).rejects.toMatchObject({ code: "OFFLINE" });
  });

  test("times a request out instead of hanging forever", async () => {
    const { client, sockets, timer } = harness();
    client.connect();
    sockets[0]!.open();

    const pending = client.listHistory(20, 0);
    expect(timer.size).toBe(1);
    expect(timer.runNext()).toBe(5000);

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("clears the request timer when the reply arrives", async () => {
    const { client, sockets, timer } = harness();
    client.connect();
    sockets[0]!.open();

    const pending = client.listHistory(20, 0);
    const frame = JSON.parse(sockets[0]!.sent[0]!) as { id: string };
    sockets[0]!.message({
      id: frame.id,
      type: "history.list",
      ok: true,
      rows: [],
      total: 0,
    });
    await pending;

    expect(timer.size).toBe(0);
  });
});

describe("reconnection", () => {
  test("backs off exponentially and caps at ten seconds", () => {
    const { client, timer, current } = harness();
    client.connect();
    current().open();

    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      current().serverClose();
      delays.push(timer.runNext());
    }

    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(client.connected()).toBe(false);
  });

  test("resets the backoff after a successful connection", () => {
    const { client, sockets, timer } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.serverClose();

    expect(timer.runNext()).toBe(500);
    sockets[1]!.open();
    expect(client.connected()).toBe(true);

    sockets[1]!.serverClose();
    expect(timer.runNext()).toBe(500);
  });

  test("stops reconnecting after dispose", () => {
    const { client, sockets, timer } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.serverClose();
    expect(timer.size).toBe(1);

    client.dispose();

    expect(timer.size).toBe(0);
    expect(client.connected()).toBe(false);
  });
});
