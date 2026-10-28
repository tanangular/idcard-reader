import { describe, expect, test } from "bun:test";
import {
  formatCitizenId,
  formatDateTime,
  formatDuration,
  formatEnglishName,
  formatHash,
  formatSex,
  formatThaiDate,
  formatThaiDateShort,
  formatThaiName,
  PROGRESS_STEPS,
} from "#client/format.ts";

/** A local Date, so the expected string is the same in every time zone. */
const localIso = (y: number, m: number, d: number, h: number, min: number): string =>
  new Date(y, m - 1, d, h, min).toISOString();

describe("formatCitizenId", () => {
  test("groups 13 digits as 1-4-5-2-1", () => {
    expect(formatCitizenId("1101700203456")).toBe("1-1017-00203-45-6");
  });

  test("leaves an already formatted id alone", () => {
    expect(formatCitizenId("1-1017-00203-45-6")).toBe("1-1017-00203-45-6");
  });

  test("leaves anything that is not exactly 13 digits alone", () => {
    expect(formatCitizenId("12345")).toBe("12345");
    expect(formatCitizenId("110170020345X")).toBe("110170020345X");
    expect(formatCitizenId("")).toBe("");
  });
});

describe("formatThaiDate", () => {
  test("renders a Gregorian ISO date as a Buddhist Era Thai date", () => {
    expect(formatThaiDate("1987-01-15")).toBe("15 มกราคม 2530");
    expect(formatThaiDate("2024-04-18")).toBe("18 เมษายน 2567");
    expect(formatThaiDate("2033-02-14")).toBe("14 กุมภาพันธ์ 2576");
  });

  test("accepts a leap day", () => {
    expect(formatThaiDate("2024-02-29")).toBe("29 กุมภาพันธ์ 2567");
  });

  test("returns the input when the date is not a real ISO date", () => {
    expect(formatThaiDate("2023-02-29")).toBe("2023-02-29");
    expect(formatThaiDate("1987-13-01")).toBe("1987-13-01");
    expect(formatThaiDate("15/01/1987")).toBe("15/01/1987");
    expect(formatThaiDate("")).toBe("");
  });

  test("renders the short month form for tables", () => {
    expect(formatThaiDateShort("2026-10-28")).toBe("28 ต.ค. 2569");
    expect(formatThaiDateShort("1987-01-05")).toBe("5 ม.ค. 2530");
  });
});

describe("formatDateTime", () => {
  test("renders the viewer's local time with a Buddhist Era year", () => {
    expect(formatDateTime(localIso(2026, 10, 28, 15, 41))).toBe("28 ต.ค. 2569 15:41 น.");
  });

  test("pads single-digit hours and minutes", () => {
    expect(formatDateTime(localIso(2026, 1, 2, 9, 5))).toBe("2 ม.ค. 2569 09:05 น.");
  });

  test("returns a dash for an unparseable timestamp", () => {
    expect(formatDateTime("not a date")).toBe("—");
    expect(formatDateTime("")).toBe("—");
  });
});

describe("names", () => {
  test("joins a Thai name without a space after the prefix", () => {
    expect(
      formatThaiName({
        prefix: "นาย",
        firstName: "สมชาย",
        middleName: "ใจดี",
        lastName: "รักไทย",
      }),
    ).toBe("นายสมชาย ใจดี รักไทย");
  });

  test("omits a missing middle name", () => {
    expect(
      formatThaiName({ prefix: "นาง", firstName: "มาลี", middleName: null, lastName: "ดีใจ" }),
    ).toBe("นางมาลี ดีใจ");
  });

  test("joins an English name with spaces", () => {
    expect(
      formatEnglishName({
        prefix: "Mr.",
        firstName: "Somchai",
        middleName: "JaiDee",
        lastName: "Rakthai",
      }),
    ).toBe("Mr. Somchai JaiDee Rakthai");
  });
});

describe("formatSex", () => {
  test("maps the three states to Thai", () => {
    expect(formatSex("male")).toBe("ชาย");
    expect(formatSex("female")).toBe("หญิง");
    expect(formatSex("unknown")).toBe("ไม่ระบุ");
  });
});

describe("formatDuration", () => {
  test("keeps sub-second reads in milliseconds", () => {
    expect(formatDuration(0)).toBe("0 มิลลิวินาที");
    expect(formatDuration(786)).toBe("786 มิลลิวินาที");
  });

  test("switches to seconds at one second and trims a trailing .0", () => {
    expect(formatDuration(1000)).toBe("1 วินาที");
    expect(formatDuration(1543)).toBe("1.5 วินาที");
  });

  test("uses minutes for longer reads", () => {
    expect(formatDuration(60_000)).toBe("1 นาที");
    expect(formatDuration(65_000)).toBe("1 นาที 5 วินาที");
  });

  test("returns a dash for a value that cannot be a duration", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatHash", () => {
  test("shows a dash when there is no hash", () => {
    expect(formatHash("")).toBe("—");
  });

  test("shows the short hash unchanged", () => {
    expect(formatHash("a1b2c3d4")).toBe("a1b2c3d4");
  });
});

describe("PROGRESS_STEPS", () => {
  test("covers every progress step in reading order", () => {
    expect(PROGRESS_STEPS.map((s) => s.step)).toEqual([
      "select",
      "cid",
      "name",
      "address",
      "photo",
    ]);
    for (const step of PROGRESS_STEPS) {
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});
