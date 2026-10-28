import { describe, expect, test } from "bun:test";
import { CDE, CdeParseError, parseCde } from "#server/cde.ts";
import { CARD_BYTES, FIXTURE_OFFSET, makeCardBuffer, put, tis620 } from "./fixtures/card.ts";

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
    expect(CDE.citizenId).toEqual({ offset: FIXTURE_OFFSET.citizenId, length: 13 });
    expect(CDE.nameTh).toEqual({ offset: FIXTURE_OFFSET.nameTh, length: 100 });
    expect(CDE.nameEn).toEqual({ offset: FIXTURE_OFFSET.nameEn, length: 100 });
    expect(CDE.dateOfBirth).toEqual({ offset: FIXTURE_OFFSET.dateOfBirth, length: 8 });
    expect(CDE.sex).toEqual({ offset: FIXTURE_OFFSET.sex, length: 1 });
    expect(CDE.issuer).toEqual({ offset: FIXTURE_OFFSET.issuer, length: 100 });
    expect(CDE.issueDate).toEqual({ offset: FIXTURE_OFFSET.issueDate, length: 8 });
    expect(CDE.expireDate).toEqual({ offset: FIXTURE_OFFSET.expireDate, length: 8 });
    expect(CDE.address).toEqual({ offset: FIXTURE_OFFSET.address, length: 160 });
  });

  test("the identity block is contiguous up to sex", () => {
    const chain = ["citizenId", "nameTh", "nameEn", "dateOfBirth", "sex"] as const;
    // Widened to `number`: the CDE offsets are literal types, and `toBe`
    // would then demand the expected value be one of those literals.
    const offsetOf = (field: (typeof chain)[number]): number => CDE[field].offset;
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1]!;
      const curr = chain[i]!;
      expect(offsetOf(curr)).toBe(offsetOf(prev) + CDE[prev].length);
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
    const card = parseCde(readerFor(makeCardBuffer()));

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
    const card = parseCde(
      readerFor(makeCardBuffer({ fields: { nameTh: tis620("นาง#สมหญิง#รักไทย#") } })),
    );
    expect(card.nameTh).toEqual({
      prefix: "นาง",
      firstName: "สมหญิง",
      middleName: null,
      lastName: "รักไทย",
    });
  });

  test("treats a blank English name as absent", () => {
    const card = parseCde(readerFor(makeCardBuffer({ fields: { nameEn: [] } })));
    expect(card.nameEn).toBeNull();
  });

  test("rejects non-ASCII bytes in an ASCII field", () => {
    try {
      parseCde(
        readerFor(
          makeCardBuffer({ fields: { nameEn: Uint8Array.from([0x4d, 0x72, 0x2e, 0xe9]) } }),
        ),
      );
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CdeParseError);
      expect((error as CdeParseError).field).toBe("nameEn");
    }
  });

  test("trims NUL and space padding", () => {
    const padded = new Uint8Array(CDE.nameTh.length);
    padded.set(tis620("นาย#สมชาย#ใจดี#รักไทย#"));
    padded.fill(0x00, 30);
    const card = parseCde(readerFor(makeCardBuffer({ fields: { nameTh: padded } })));
    expect(card.nameTh.lastName).toBe("รักไทย");
  });

  test("maps sex byte 2 to female and anything else to unknown", () => {
    expect(parseCde(readerFor(makeCardBuffer({ fields: { sex: [2] } }))).sex).toBe("female");
    expect(parseCde(readerFor(makeCardBuffer({ fields: { sex: [0] } }))).sex).toBe("unknown");
    expect(parseCde(readerFor(makeCardBuffer({ fields: { sex: [9] } }))).sex).toBe("unknown");
  });

  test("accepts both the ASCII and the raw sex digit", () => {
    expect(parseCde(readerFor(makeCardBuffer({ fields: { sex: [0x31] } }))).sex).toBe("male");
    expect(parseCde(readerFor(makeCardBuffer({ fields: { sex: [0x32] } }))).sex).toBe("female");
  });

  test("converts Buddhist Era years to Gregorian", () => {
    const card = parseCde(
      readerFor(makeCardBuffer({ fields: { dateOfBirth: new TextEncoder().encode("25000101") } })),
    );
    expect(card.dateOfBirth).toBe("1957-01-01");
  });

  test("replaces address line separators with spaces", () => {
    const card = parseCde(
      readerFor(makeCardBuffer({ fields: { address: tis620("99 หมู่ 5#ตำบลในเมือง#") } })),
    );
    expect(card.address).toBe("99 หมู่ 5 ตำบลในเมือง");
  });

  test("rejects a malformed citizen id", () => {
    const bad = new Uint8Array(CARD_BYTES).fill(0x20);
    put(bad, FIXTURE_OFFSET.citizenId, new TextEncoder().encode("11017002034X6"));
    expect(() => parseCde(readerFor(bad))).toThrow(CdeParseError);
  });

  test("rejects an impossible date and names the field", () => {
    try {
      parseCde(
        readerFor(
          makeCardBuffer({ fields: { dateOfBirth: new TextEncoder().encode("25301301") } }),
        ),
      );
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CdeParseError);
      expect((error as CdeParseError).field).toBe("dateOfBirth");
    }
  });

  test("rejects a non-numeric date", () => {
    expect(() =>
      parseCde(
        readerFor(makeCardBuffer({ fields: { issueDate: new TextEncoder().encode("2560-1-1") } })),
      ),
    ).toThrow(CdeParseError);
  });

  test("throws a CdeParseError whose message carries no card data", () => {
    try {
      parseCde(
        readerFor(
          makeCardBuffer({ fields: { dateOfBirth: new TextEncoder().encode("00000000") } }),
        ),
      );
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CdeParseError);
      expect((error as CdeParseError).message).not.toContain("1101700203456");
    }
  });
});
