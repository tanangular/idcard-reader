import { describe, expect, test } from "bun:test";
import { CDE, CdeParseError, parseCde } from "../src/server/cde.ts";

/**
 * Offsets are written out literally here on purpose: the plan's §7 table
 * disagrees with the card's real layout, so the test pins what the card in
 * hand actually reports instead of trusting a shared constant.
 *
 * Observed on a 2567-series card:
 *   0x0000  4  header ("0004")          0x00E1  1  sex (ASCII)
 *   0x0004 13  citizen id               0x00E2 20  registration code (unused)
 *   0x0011 100 Thai name                0x00F6 100 issuer
 *   0x0075 100 English name             0x015A 13  card serial (unused)
 *   0x00D9  8  date of birth            0x0167  8  issue date
 *                                       0x016F  8  expire date
 *                                       0x0179  2  photo length (BE u16)
 *                                       0x017B     photo (JPEG)
 *                                       0x1579 160 address
 */
const OFFSET = {
  citizenId: 0x0004,
  nameTh: 0x0011,
  nameEn: 0x0075,
  dateOfBirth: 0x00d9,
  sex: 0x00e1,
  issuer: 0x00f6,
  issueDate: 0x0167,
  expireDate: 0x016f,
  address: 0x1579,
} as const;

const CARD_BYTES = 0x1700;

/**
 * Encode a string the way TIS-620 defines it: ASCII passes through, and the
 * Thai block U+0E01..U+0E5B maps to 0xA1..0xFB. Written independently of
 * iconv-lite so a wrong codepage in production shows up as a test failure.
 */
function tis620(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x80) out.push(cp);
    else if (cp >= 0x0e01 && cp <= 0x0e5b) out.push(cp - 0x0e00 + 0xa0);
    else throw new Error(`unmappable character: ${ch}`);
  }
  return Uint8Array.from(out);
}

function put(buf: Uint8Array, offset: number, data: Uint8Array | number[]): void {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  buf.set(bytes, offset);
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

function makeCard(overrides: Partial<Record<keyof typeof OFFSET, Uint8Array | number[]>> = {}): Uint8Array {
  const buf = new Uint8Array(CARD_BYTES);
  buf.fill(0x20);
  const fields: Record<keyof typeof OFFSET, Uint8Array | number[]> = {
    citizenId: ascii("1101700203456"),
    nameTh: tis620("นาย#สมชาย#ใจดี#รักไทย#"),
    nameEn: ascii("Mr.#Somchai#JaiDee#Rakthai#"),
    dateOfBirth: ascii("25300115"),
    sex: [1],
    issuer: tis620("สำนักทะเบียนกลาง"),
    issueDate: ascii("25600101"),
    expireDate: ascii("25700101"),
    address: tis620("99 หมู่ 5 ตำบลในเมือง"),
    ...overrides,
  };
  for (const [field, value] of Object.entries(fields) as Array<[keyof typeof OFFSET, Uint8Array | number[]]>) {
    put(buf, OFFSET[field], value);
  }
  return buf;
}

function readerFor(buf: Uint8Array) {
  return (offset: number, length: number): Uint8Array => {
    if (offset < 0 || offset + length > buf.length) {
      throw new Error(`read out of bounds: ${offset}+${length}`);
    }
    return buf.slice(offset, offset + length);
  };
}

describe("CDE layout", () => {
  test("matches the offsets observed on the real card", () => {
    expect(CARD_BYTES).toBe(0x1700);
    expect(CDE.citizenId).toEqual({ offset: 0x0004, length: 13 });
    expect(CDE.nameTh).toEqual({ offset: 0x0011, length: 100 });
    expect(CDE.nameEn).toEqual({ offset: 0x0075, length: 100 });
    expect(CDE.dateOfBirth).toEqual({ offset: 0x00d9, length: 8 });
    expect(CDE.sex).toEqual({ offset: 0x00e1, length: 1 });
    expect(CDE.issuer).toEqual({ offset: 0x00f6, length: 100 });
    expect(CDE.issueDate).toEqual({ offset: 0x0167, length: 8 });
    expect(CDE.expireDate).toEqual({ offset: 0x016f, length: 8 });
    expect(CDE.address).toEqual({ offset: 0x1579, length: 160 });
  });

  test("the identity block is contiguous up to sex", () => {
    const chain = ["citizenId", "nameTh", "nameEn", "dateOfBirth", "sex"] as const;
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1]!;
      const curr = chain[i]!;
      expect(CDE[curr].offset).toBe(CDE[prev].offset + CDE[prev].length);
    }
  });

  test("a 20-byte registration code sits between sex and the issuer", () => {
    expect(CDE.issuer.offset - (CDE.sex.offset + CDE.sex.length)).toBe(20);
    expect(CDE.issuer.offset + CDE.issuer.length).toBe(0x015a);
  });

  test("the address block sits between the photo and the signature block", () => {
    expect(CDE.address.offset + CDE.address.length).toBe(0x1619);
    expect(CARD_BYTES).toBe(0x1700);
  });
});

describe("parseCde", () => {
  test("reads every field of a well-formed card", () => {
    const card = parseCde(readerFor(makeCard()));

    expect(card.citizenId).toBe("1101700203456");
    expect(card.nameTh).toEqual({
      prefix: "นาย",
      firstName: "สมชาย",
      middleName: "ใจดี",
      lastName: "รักไทย",
    });
    expect(card.nameEn).toEqual({
      prefix: "Mr.",
      firstName: "Somchai",
      middleName: "JaiDee",
      lastName: "Rakthai",
    });
    expect(card.dateOfBirth).toBe("1987-01-15");
    expect(card.sex).toBe("male");
    expect(card.issuer).toBe("สำนักทะเบียนกลาง");
    expect(card.issueDate).toBe("2017-01-01");
    expect(card.expireDate).toBe("2027-01-01");
    expect(card.address).toBe("99 หมู่ 5 ตำบลในเมือง");
  });

  test("lays out a three-part Thai name without a middle name", () => {
    const card = parseCde(readerFor(makeCard({ nameTh: tis620("นาง#สมหญิง#รักไทย#") })));
    expect(card.nameTh).toEqual({
      prefix: "นาง",
      firstName: "สมหญิง",
      middleName: null,
      lastName: "รักไทย",
    });
  });

  test("treats a blank English name as absent", () => {
    const card = parseCde(readerFor(makeCard({ nameEn: [] })));
    expect(card.nameEn).toBeNull();
  });

  test("trims NUL and space padding", () => {
    const padded = new Uint8Array(CDE.nameTh.length);
    padded.set(tis620("นาย#สมชาย#ใจดี#รักไทย#"));
    padded.fill(0x00, 30);
    const card = parseCde(readerFor(makeCard({ nameTh: padded })));
    expect(card.nameTh.lastName).toBe("รักไทย");
  });

  test("maps sex byte 2 to female and anything else to unknown", () => {
    expect(parseCde(readerFor(makeCard({ sex: [2] }))).sex).toBe("female");
    expect(parseCde(readerFor(makeCard({ sex: [0] }))).sex).toBe("unknown");
    expect(parseCde(readerFor(makeCard({ sex: [9] }))).sex).toBe("unknown");
  });

  test("converts Buddhist Era years to Gregorian", () => {
    const card = parseCde(readerFor(makeCard({ dateOfBirth: ascii("25000101") })));
    expect(card.dateOfBirth).toBe("1957-01-01");
  });

  test("replaces address line separators with spaces", () => {
    const card = parseCde(readerFor(makeCard({ address: tis620("99 หมู่ 5#ตำบลในเมือง#") })));
    expect(card.address).toBe("99 หมู่ 5 ตำบลในเมือง");
  });

  test("rejects a malformed citizen id", () => {
    expect(() => parseCde(readerFor(makeCard({ citizenId: ascii("11017002034X6") })))).toThrow(CdeParseError);
    expect(() => parseCde(readerFor(makeCard({ citizenId: ascii("12345") })))).toThrow(CdeParseError);
  });

  test("rejects an impossible date and names the field", () => {
    try {
      parseCde(readerFor(makeCard({ dateOfBirth: ascii("25301301") })));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CdeParseError);
      expect((error as CdeParseError).field).toBe("dateOfBirth");
    }
  });

  test("rejects a non-numeric date", () => {
    expect(() => parseCde(readerFor(makeCard({ issueDate: ascii("2560-1-1") })))).toThrow(CdeParseError);
  });

  test("throws a CdeParseError whose message carries no card data", () => {
    try {
      parseCde(readerFor(makeCard({ dateOfBirth: ascii("00000000") })));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CdeParseError);
      expect((error as CdeParseError).message).not.toContain("1101700203456");
    }
  });
});
