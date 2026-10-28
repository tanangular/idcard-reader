import { describe, expect, test } from "bun:test";
import { decodePcscError, formatPcscCode } from "../src/server/errors.ts";
import { formatAtr, parseReaderList } from "../src/server/pcsc.ts";

describe("parseReaderList", () => {
  test("returns an empty array for an empty block", () => {
    expect(parseReaderList(new Uint8Array([]), 0)).toEqual([]);
    expect(parseReaderList(new Uint8Array([0, 0]), 2)).toEqual([]);
  });

  test("parses a single reader", () => {
    const block = new TextEncoder().encode("Generic EMV Smartcard Reader\0\0");
    expect(parseReaderList(block, block.length)).toEqual(["Generic EMV Smartcard Reader"]);
  });

  test("parses multiple readers in order", () => {
    const block = new TextEncoder().encode("Reader A\0Reader B\0\0");
    expect(parseReaderList(block, block.length)).toEqual(["Reader A", "Reader B"]);
  });

  test("honours the reported length and ignores trailing garbage", () => {
    const block = new TextEncoder().encode("Reader A\0\0trailing");
    expect(parseReaderList(block, 10)).toEqual(["Reader A"]);
  });

  test("drops empty names", () => {
    const block = new TextEncoder().encode("Reader A\0\0Reader B\0\0");
    expect(parseReaderList(block, block.length)).toEqual(["Reader A"]);
  });
});

describe("formatAtr", () => {
  test("formats bytes as uppercase hex pairs", () => {
    const atr = new Uint8Array([0x3b, 0x79, 0x96, 0x00, 0x0a]);
    expect(formatAtr(atr)).toBe("3B 79 96 00 0A");
  });

  test("returns an empty string for an empty ATR", () => {
    expect(formatAtr(new Uint8Array([]))).toBe("");
  });
});

describe("formatPcscCode", () => {
  test("renders the unsigned 32-bit value", () => {
    expect(formatPcscCode(0x8010002e)).toBe("0x8010002E");
  });

  test("normalises a negative int32 LONG", () => {
    expect(formatPcscCode(-2146435026)).toBe("0x8010002E");
  });
});

describe("decodePcscError", () => {
  test("maps no readers", () => {
    const err = decodePcscError(0x8010002e);
    expect(err.code).toBe("NO_READER");
    expect(err.pcscCode).toBe("0x8010002E");
    expect(err.message.length).toBeGreaterThan(0);
  });

  test("maps no smartcard", () => {
    expect(decodePcscError(0x8010000c).code).toBe("NO_CARD");
  });

  test("maps removed card", () => {
    expect(decodePcscError(0x80100069).code).toBe("CARD_REMOVED");
  });

  test("maps sharing violation", () => {
    expect(decodePcscError(0x8010000b).code).toBe("SHARING_VIOLATION");
  });

  test("maps an unknown code to UNKNOWN but keeps the hex", () => {
    const err = decodePcscError(0x12345678);
    expect(err.code).toBe("UNKNOWN");
    expect(err.pcscCode).toBe("0x12345678");
  });

  test("never leaks card data in messages", () => {
    for (const code of [0x8010002e, 0x8010000c, 0x80100069, 0x8010000b, 0x12345678]) {
      const err = decodePcscError(code);
      expect(err.message).not.toMatch(/\d{13}/);
    }
  });
});
