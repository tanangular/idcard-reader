import { describe, expect, test } from "bun:test";
import { appError, PcscError } from "../src/server/errors.ts";
import type { PcscHandle, PcscPort, ReaderChange, ReaderStatus } from "../src/server/pcsc.ts";
import { CardService, type CardReader, type ReadOutcome } from "../src/server/state.ts";
import type { ServerMsg, ThaiIdCard } from "../src/shared/protocol.ts";

const ATR = "3B 79 96 00 00 54 48 20 4E 49 44 20 31 37";
const OTHER_ATR = "3B 79 96 00 00 54 48 20 4E 49 44 20 32 30";

const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from(hex.split(" "), (pair) => Number.parseInt(pair, 16));

/** Deliberately fake card: every field is synthetic, nothing here is real. */
const CARD: ThaiIdCard = {
  citizenId: "1101700203456",
  nameTh: { prefix: "นาย", firstName: "สมชาย", middleName: "ใจดี", lastName: "รักไทย" },
  nameEn: { prefix: "Mr.", firstName: "Somchai", middleName: "JaiDee", lastName: "Rakthai" },
  dateOfBirth: "1987-01-15",
  sex: "male",
  address: "99 หมู่ 5 ตำบลในเมือง",
  issueDate: "2017-01-01",
  expireDate: "2027-01-01",
  issuer: "สำนักทะเบียนกลาง",
  photo: { mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA==" },
  atr: ATR,
  readAt: "2026-10-28T10:00:00.000Z",
};

/**
 * Models just enough of PC/SC for the state machine: one reader, a card that
 * can be inserted or removed, and an ATR that changes when the card does.
 *
 * `waitForChange` reports the current state, exactly as SCardGetStatusChange
 * does with a zero timeout, and sets `changed` when it differs from the
 * caller's `dwCurrentState`.
 */
class FakePort implements PcscPort {
  readers: string[] = ["Fake Reader"];
  present = false;
  atr = ATR;
  failList: PcscError | undefined;
  failConnect: PcscError | undefined;

  readonly calls = { connect: 0, disconnect: 0, transmit: 0 };

  listReaders(): string[] {
    if (this.failList) throw this.failList;
    return [...this.readers];
  }

  connect(): PcscHandle {
    this.calls.connect++;
    if (this.failConnect) throw this.failConnect;
    if (!this.present) throw new PcscError(appError("NO_CARD"));
    return 1n;
  }

  status(): ReaderStatus {
    if (!this.present) throw new PcscError(appError("NO_CARD"));
    return { state: 0x54, atr: bytesOf(this.atr), reader: this.readers[0] ?? "", protocol: 1 };
  }

  transmit(): Uint8Array {
    this.calls.transmit++;
    return new Uint8Array([0x90, 0x00]);
  }

  disconnect(): void {
    this.calls.disconnect++;
  }

  waitForChange(reader: string, currentState: number): ReaderChange {
    if (!this.readers.includes(reader)) throw new PcscError(appError("NO_READER"));
    const state = this.present ? 0x22 : 0x12;
    return {
      changed: state !== currentState,
      status: {
        state,
        atr: this.present ? bytesOf(this.atr) : new Uint8Array(),
        reader,
        protocol: 0,
      },
    };
  }

  release(): void {}
}

/** A reader that succeeds and reports both ends of the progress range. */
const fakeReader: CardReader = (_transport, options) => {
  options?.onProgress?.("select", 5);
  options?.onProgress?.("photo", 100);
  return CARD;
};

interface HarnessOptions {
  readCard?: CardReader;
  emit?: (msg: ServerMsg) => void;
  onOutcome?: (outcome: ReadOutcome) => void;
}

function harness(options: HarnessOptions = {}) {
  const port = new FakePort();
  const messages: ServerMsg[] = [];
  const service = new CardService({
    pcsc: port,
    readCard: options.readCard ?? fakeReader,
    emit: options.emit ?? ((msg) => messages.push(msg)),
    ...(options.onOutcome ? { onOutcome: options.onOutcome } : {}),
  });
  return { port, messages, service };
}

describe("CardService", () => {
  test("waits for a card when a reader is idle", async () => {
    const { port, messages, service } = harness();

    await service.tick();

    expect(service.getState()).toMatchObject({
      phase: "waiting-card",
      reader: "Fake Reader",
      card: null,
      error: null,
    });
    expect(messages).toEqual([
      { type: "reader.state", state: "waiting-card", readers: ["Fake Reader"] },
    ]);
    expect(port.calls.connect).toBe(0);
  });

  test("reads automatically when a card appears", async () => {
    const { port, messages, service } = harness();
    await service.tick();

    port.present = true;
    await service.tick();

    expect(service.getState().phase).toBe("ready");
    expect(service.getState().card).toEqual(CARD);
    expect(port.calls.connect).toBe(1);
    expect(port.calls.disconnect).toBe(1);
    expect(messages).toContainEqual({ type: "card.inserted", reader: "Fake Reader" });
    expect(messages).toContainEqual({ type: "card.snapshot", card: CARD });
    expect(messages).toContainEqual({ type: "card.progress", step: "select", pct: 5 });
    expect(messages).toContainEqual({ type: "card.progress", step: "photo", pct: 100 });
  });

  test("does not re-read a card that is already ready", async () => {
    const { port, service } = harness();
    await service.tick();
    port.present = true;
    await service.tick();

    await service.tick();
    await service.tick();

    expect(port.calls.connect).toBe(1);
  });

  test("clears the snapshot when the card is removed", async () => {
    const { port, messages, service } = harness();
    await service.tick();
    port.present = true;
    await service.tick();

    messages.length = 0;
    port.present = false;
    await service.tick();

    expect(service.getState()).toMatchObject({ phase: "waiting-card", card: null, error: null });
    expect(messages).toContainEqual({ type: "card.removed", reader: "Fake Reader" });
    expect(messages).toContainEqual({ type: "reader.state", state: "waiting-card", readers: ["Fake Reader"] });
  });

  test("drops the snapshot when the reader is unplugged", async () => {
    const { port, messages, service } = harness();
    await service.tick();
    port.present = true;
    await service.tick();

    messages.length = 0;
    port.readers = [];
    await service.tick();

    expect(service.getState()).toMatchObject({
      phase: "no-reader",
      reader: null,
      readers: [],
      card: null,
    });
    expect(messages).toContainEqual({ type: "card.removed", reader: "Fake Reader" });
    expect(messages).toContainEqual({ type: "reader.state", state: "no-reader", readers: [] });
  });

  test("moves back to no-reader when the last reader disappears", async () => {
    const { port, messages, service } = harness();
    await service.tick();

    port.readers = [];
    await service.tick();

    expect(service.getState().phase).toBe("no-reader");
    expect(messages.at(-1)).toEqual({ type: "reader.state", state: "no-reader", readers: [] });
  });

  test("treats a card removed mid-read as removal, not as an error state", async () => {
    const port = new FakePort();
    const messages: ServerMsg[] = [];
    const service = new CardService({
      pcsc: port,
      readCard: () => {
        port.present = false; // the card physically left the reader
        throw new PcscError(appError("CARD_REMOVED"));
      },
      emit: (msg) => messages.push(msg),
    });

    await service.tick();
    port.present = true;
    await service.tick();

    expect(service.getState()).toMatchObject({ phase: "waiting-card", card: null });
    expect(service.getState().error?.code).toBe("CARD_REMOVED");
    expect(messages).toContainEqual({ type: "card.error", error: appError("CARD_REMOVED") });
    expect(port.calls.disconnect).toBe(1);
  });

  test("stays in error while the card is present and does not auto-retry", async () => {
    let attempts = 0;
    const { port, service } = harness({
      readCard: () => {
        attempts++;
        throw new PcscError(appError("PARSE_FAILED"));
      },
    });

    await service.tick();
    port.present = true;
    await service.tick();

    expect(service.getState().phase).toBe("error");
    expect(service.getState().error?.code).toBe("PARSE_FAILED");

    await service.tick();
    await service.tick();
    expect(attempts).toBe(1);
  });

  test("recovers from error after the card is removed and reinserted", async () => {
    let fail = true;
    const { port, service } = harness({
      readCard: () => {
        if (fail) throw new PcscError(appError("PARSE_FAILED"));
        return CARD;
      },
    });

    await service.tick();
    port.present = true;
    await service.tick();
    expect(service.getState().phase).toBe("error");

    port.present = false;
    await service.tick();
    expect(service.getState().phase).toBe("waiting-card");

    fail = false;
    port.present = true;
    await service.tick();
    expect(service.getState().phase).toBe("ready");
  });

  test("retries on demand from the error state", async () => {
    let fail = true;
    const { port, service } = harness({
      readCard: () => {
        if (fail) throw new PcscError(appError("PARSE_FAILED"));
        return CARD;
      },
    });

    await service.tick();
    port.present = true;
    await service.tick();
    expect(service.getState().phase).toBe("error");

    fail = false;
    const result = await service.readNow();

    expect(result.ok).toBe(true);
    expect(service.getState().phase).toBe("ready");
    expect(service.getState().card).toEqual(CARD);
  });

  test("rejects an on-demand read when no card is inserted", async () => {
    const { service } = harness();

    const result = await service.readNow();

    expect(result).toEqual({ ok: false, error: appError("NO_CARD") });
    expect(service.getState().phase).toBe("waiting-card");
  });

  test("rejects an on-demand read when no reader is attached", async () => {
    const { port, service } = harness();
    port.readers = [];

    const result = await service.readNow();

    expect(result).toEqual({ ok: false, error: appError("NO_READER") });
    expect(service.getState().phase).toBe("no-reader");
  });

  test("surfaces a reader that disappears between list and poll", async () => {
    const { port, service } = harness();
    await service.tick();
    port.present = true;
    await service.tick();

    // The reader is still listed but SCardGetStatusChange already lost it.
    port.waitForChange = () => {
      throw new PcscError(appError("NO_READER"));
    };
    await service.tick();

    expect(service.getState()).toMatchObject({ phase: "no-reader", card: null });
  });

  test("re-reads when a different card appears without an observed removal", async () => {
    let reads = 0;
    const { port, service } = harness({
      readCard: () => {
        reads++;
        return CARD;
      },
    });
    await service.tick();
    port.present = true;
    await service.tick();
    expect(reads).toBe(1);

    port.atr = OTHER_ATR;
    await service.tick();

    expect(reads).toBe(2);
    expect(service.getState().phase).toBe("ready");
  });

  test("survives a failing listReaders call", async () => {
    const { port, service } = harness();
    port.failList = new PcscError(appError("NO_READER"));

    await service.tick();

    expect(service.getState().phase).toBe("no-reader");
  });

  test("survives a connect failure and keeps the reader", async () => {
    const { port, messages, service } = harness();
    port.failConnect = new PcscError(appError("SHARING_VIOLATION"));
    await service.tick();
    port.present = true;
    port.failConnect = new PcscError(appError("SHARING_VIOLATION"));

    await service.tick();

    expect(service.getState().phase).toBe("error");
    expect(service.getState().error?.code).toBe("SHARING_VIOLATION");
    expect(messages).toContainEqual({
      type: "card.error",
      error: appError("SHARING_VIOLATION"),
    });
  });

  test("polls every 500 ms until stopped", async () => {
    const port = new FakePort();
    const sleeps: number[] = [];
    let slept = 0;

    const service = new CardService({
      pcsc: port,
      readCard: fakeReader,
      sleep: async (ms) => {
        sleeps.push(ms);
        slept++;
        if (slept === 3) service.stop();
      },
    });

    await service.start();

    expect(sleeps).toEqual([500, 500, 500]);
    expect(service.getState().phase).toBe("waiting-card");
  });

  test("a throwing subscriber does not stop polling", async () => {
    const port = new FakePort();
    const service = new CardService({
      pcsc: port,
      readCard: fakeReader,
      emit: () => {
        throw new Error("socket closed");
      },
    });

    await expect(service.tick()).resolves.toBeUndefined();
    expect(service.getState().phase).toBe("waiting-card");
  });

  test("reports one outcome per read for the audit log", async () => {
    const outcomes: ReadOutcome[] = [];
    const { port, service } = harness({ onOutcome: (outcome) => outcomes.push(outcome) });

    await service.tick();
    port.present = true;
    await service.tick();

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    expect(outcome.reader).toBe("Fake Reader");
    expect(outcome.citizenId).toBe(CARD.citizenId);
    expect(outcome.errorCode).toBeNull();
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.at).toBeInstanceOf(Date);
  });

  test("reports an outcome with the error code when the read fails", async () => {
    const outcomes: ReadOutcome[] = [];
    const { port, service } = harness({
      readCard: () => {
        throw new PcscError(appError("NOT_THAI_ID"));
      },
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    await service.tick();
    port.present = true;
    await service.tick();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.errorCode).toBe("NOT_THAI_ID");
    expect(outcomes[0]!.citizenId).toBeNull();
  });
});
