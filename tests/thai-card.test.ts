import { describe, expect, test } from "bun:test";
import { PcscError } from "../src/server/errors.ts";
import { readThaiIdCard, type CardTransport } from "../src/server/thai-card.ts";
import type { ProgressStep } from "../src/shared/protocol.ts";
import { FIXTURE_OFFSET, makeCardBuffer, makePhoto } from "./fixtures/card.ts";

const ATR = "3B 79 96 00 00 54 48 20 4E 49 44 20 31 37";

interface FakeOptions {
  selectSw?: number;
  /** Refuse READs longer than this with 6C XX, like a real card with a small Le. */
  chunkLimit?: number;
  /** Interrupt a READ with this status word. */
  failAtOffset?: number;
  failSw?: number;
  /** Return data directly from READ instead of a 61 XX handshake. */
  noGetResponse?: boolean;
  /** Answer the first GET RESPONSE with 6C XX before returning data. */
  getResponse6c?: number;
}

/** Emulates the parts of a Thai ID card that thai-card.ts drives. */
class FakeTransport implements CardTransport {
  readonly atrHex = ATR;
  private pending: { offset: number; length: number } | undefined;
  private answered6c = false;
  readonly apdus: Uint8Array[] = [];

  constructor(
    private readonly data: Uint8Array,
    private readonly options: FakeOptions = {},
  ) {}

  transmit(apdu: Uint8Array): Uint8Array {
    this.apdus.push(apdu.slice());
    const ins = apdu[1];

    if (ins === 0xa4) {
      const sw = this.options.selectSw ?? 0x9000;
      return sw === 0x9000
        ? this.options.noGetResponse
          ? new Uint8Array([0x90, 0x00])
          : new Uint8Array([0x61, 0x0a])
        : new Uint8Array([(sw >> 8) & 0xff, sw & 0xff]);
    }

    if (ins === 0xb0) {
      const offset = ((apdu[2] ?? 0) << 8) | (apdu[3] ?? 0);
      const length = ((apdu[5] ?? 0) << 8) | (apdu[6] ?? 0);
      const limit = this.options.chunkLimit ?? 0xff;

      if (length > limit) return new Uint8Array([0x6c, limit]);
      if (this.options.failAtOffset === offset && this.options.failSw !== undefined) {
        return new Uint8Array([(this.options.failSw >> 8) & 0xff, this.options.failSw & 0xff]);
      }

      this.pending = { offset, length };

      if (this.options.noGetResponse) {
        return this.payload(offset, length);
      }
      return new Uint8Array([0x61, length === 0 ? 0x00 : length]);
    }

    if (ins === 0xc0) {
      if (this.options.getResponse6c !== undefined && !this.answered6c) {
        this.answered6c = true;
        return new Uint8Array([0x6c, this.options.getResponse6c]);
      }
      const le = apdu[4] === 0 ? 0x100 : (apdu[4] ?? 0);
      const pending = this.pending ?? { offset: 0, length: 0 };
      this.pending = undefined;
      return this.payload(pending.offset, Math.min(le, pending.length));
    }

    return new Uint8Array([0x6d, 0x00]);
  }

  private payload(offset: number, length: number): Uint8Array {
    const slice = this.data.slice(offset, offset + length);
    const out = new Uint8Array(slice.length + 2);
    out.set(slice);
    out.set([0x90, 0x00], slice.length);
    return out;
  }
}

describe("readThaiIdCard", () => {
  test("reads every field and returns a JPEG data url", () => {
    const card = makeCardBuffer();
    const transport = new FakeTransport(card);

    const result = readThaiIdCard(transport, { now: () => new Date("2026-10-28T10:00:00.000Z") });

    expect(result.citizenId).toBe("1101700203456");
    expect(result.nameTh.prefix).toBe("นาย");
    expect(result.nameTh.firstName).toBe("สมชาย");
    expect(result.dateOfBirth).toBe("1987-01-15");
    expect(result.sex).toBe("male");
    expect(result.issuer).toBe("สำนักทะเบียนกลาง");
    expect(result.address).toBe("99 หมู่ 5 ตำบลในเมือง");
    expect(result.atr).toBe(ATR);
    expect(result.readAt).toBe("2026-10-28T10:00:00.000Z");
    expect(result.photo.mime).toBe("image/jpeg");
    expect(result.photo.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);

    const base64 = result.photo.dataUrl.slice("data:image/jpeg;base64,".length);
    expect(Buffer.from(base64, "base64").equals(Buffer.from(makePhoto()))).toBe(true);
  });

  test("re-reads after a 6C XX short-length response", () => {
    const transport = new FakeTransport(makeCardBuffer(), { chunkLimit: 32 });
    const result = readThaiIdCard(transport);
    expect(result.nameTh.lastName).toBe("รักไทย");
    expect(result.photo.dataUrl.length).toBeGreaterThan(300);
  });

  test("retries GET RESPONSE with 6C XX instead of resending the READ", () => {
    const transport = new FakeTransport(makeCardBuffer(), { getResponse6c: 3 });

    const result = readThaiIdCard(transport);

    expect(result.citizenId).toBe("1101700203456");
    expect(
      transport.apdus.some(
        (apdu) =>
          apdu.length === 5 &&
          apdu[0] === 0x00 &&
          apdu[1] === 0xc0 &&
          apdu[2] === 0x00 &&
          apdu[3] === 0x00 &&
          apdu[4] === 0x03,
      ),
    ).toBe(true);
    // The buggy path re-read the same offset with the shorter length.
    expect(
      transport.apdus.some(
        (apdu) => apdu[1] === 0xb0 && apdu[2] === 0x00 && apdu[3] === 0x00 && apdu[6] === 0x03,
      ),
    ).toBe(false);
  });

  test("rejects a photo length that would run into the address field", () => {
    const transport = new FakeTransport(makeCardBuffer({ photoLengthOverride: 0x13ff }));

    expect(() => readThaiIdCard(transport)).toThrow(PcscError);
    try {
      readThaiIdCard(transport);
    } catch (error) {
      expect((error as PcscError).app.code).toBe("PARSE_FAILED");
    }
    expect(
      transport.apdus.some(
        (apdu) => apdu[1] === 0xb0 && ((apdu[2]! << 8) | apdu[3]!) === FIXTURE_OFFSET.photo,
      ),
    ).toBe(false);
  });

  test("survives a card that answers READ directly instead of 61 XX", () => {
    const transport = new FakeTransport(makeCardBuffer(), { noGetResponse: true });
    const result = readThaiIdCard(transport);
    expect(result.citizenId).toBe("1101700203456");
  });

  test("rejects a card that is not a Thai ID", () => {
    const transport = new FakeTransport(makeCardBuffer(), { selectSw: 0x6a82 });
    expect(() => readThaiIdCard(transport)).toThrow(PcscError);
    try {
      readThaiIdCard(transport);
    } catch (error) {
      expect((error as PcscError).app.code).toBe("NOT_THAI_ID");
    }
  });

  test("maps a security-status failure", () => {
    const transport = new FakeTransport(makeCardBuffer(), {
      failAtOffset: FIXTURE_OFFSET.citizenId,
      failSw: 0x6982,
    });
    try {
      readThaiIdCard(transport);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as PcscError).app.code).toBe("SECURITY_STATUS");
    }
  });

  test("rejects a photo that is not JPEG", () => {
    const badPhoto = new Uint8Array(64).fill(0x41);
    const transport = new FakeTransport(makeCardBuffer({ photo: badPhoto }));
    try {
      readThaiIdCard(transport);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as PcscError).app.code).toBe("PARSE_FAILED");
    }
  });

  test("rejects an implausible photo length instead of reading forever", () => {
    const transport = new FakeTransport(makeCardBuffer({ photoLengthOverride: 0xffff }));
    try {
      readThaiIdCard(transport);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as PcscError).app.code).toBe("PARSE_FAILED");
    }
  });

  test("emits progress in order and ends at 100", () => {
    const events: Array<{ step: ProgressStep; pct: number }> = [];
    const transport = new FakeTransport(makeCardBuffer());

    readThaiIdCard(transport, { onProgress: (step, pct) => events.push({ step, pct }) });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.step).toBe("select");
    expect(events[0]!.pct).toBeLessThan(events[events.length - 1]!.pct);

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.pct).toBeGreaterThanOrEqual(events[i - 1]!.pct);
    }

    const steps = new Set(events.map((e) => e.step));
    expect(steps.has("cid")).toBe(true);
    expect(steps.has("name")).toBe(true);
    expect(steps.has("address")).toBe(true);
    expect(steps.has("photo")).toBe(true);
    expect(events[events.length - 1]!.pct).toBe(100);
  });

  test("never sends a READ longer than 255 bytes", () => {
    const transport = new FakeTransport(makeCardBuffer());
    readThaiIdCard(transport);

    for (const apdu of transport.apdus) {
      if (apdu[1] !== 0xb0) continue;
      const length = ((apdu[5] ?? 0) << 8) | (apdu[6] ?? 0);
      expect(length).toBeLessThanOrEqual(0xff);
    }
  });
});
