/**
 * Pure parser for the pre-encoded CNP (card data elements) on a Thai
 * national ID card. No PC/SC, no I/O: hand it a `read` function and it
 * returns decoded values, so the whole file is testable from a hex fixture.
 *
 * Layout note: PLAN.md §7 lists the issuer at 0x00E2, the issue date at
 * 0x00DA, the expiry at 0x00E2 and the address at 0x00EF. Those overlap each
 * other and none of them match the card in hand. Dumping the card shows a
 * 2567-series layout instead, which is what the constants below encode:
 *
 *   0x0000   4   header ("0004")
 *   0x0004  13   citizen id (ASCII)
 *   0x0011 100   Thai name      (TIS-620, '#': prefix#first#middle#last#)
 *   0x0075 100   English name   (ASCII,    same '#' convention)
 *   0x00D9   8   date of birth (Buddhist Era, YYYYMMDD)
 *   0x00E1   1   sex           (ASCII '1'/'2')
 *   0x00E2  20   registration code (unused)
 *   0x00F6 100   issuer        (TIS-620)
 *   0x015A  13   card serial (unused)
 *   0x0167   8   issue date    (Buddhist Era)
 *   0x016F   8   expire date   (Buddhist Era)
 *   0x0177   2   version
 *   0x0179   2   photo length  (big-endian uint16)
 *   0x017B   n   photo bytes   (JPEG, starts FF D8)
 *   0x1579 160   address       (TIS-620, '#' marks a line break)
 */
import iconv from "iconv-lite";
import type { PersonName, Sex } from "#shared/protocol.ts";

export const CDE = {
  citizenId: { offset: 0x0004, length: 13 },
  nameTh: { offset: 0x0011, length: 100 },
  nameEn: { offset: 0x0075, length: 100 },
  dateOfBirth: { offset: 0x00d9, length: 8 },
  sex: { offset: 0x00e1, length: 1 },
  issuer: { offset: 0x00f6, length: 100 },
  issueDate: { offset: 0x0167, length: 8 },
  expireDate: { offset: 0x016f, length: 8 },
  address: { offset: 0x1579, length: 160 },
} as const;

/** Photo CDE: a 2-byte big-endian length immediately followed by the JPEG. */
export const PHOTO = { lengthOffset: 0x0179, offset: 0x017b } as const;

export type CdeField = keyof typeof CDE;

export interface ParsedCard {
  citizenId: string;
  nameTh: PersonName;
  nameEn: PersonName | null;
  dateOfBirth: string;
  sex: Sex;
  address: string;
  issueDate: string;
  expireDate: string;
  issuer: string;
}

/** Raised when the bytes on the card cannot be shaped into a valid value. */
export class CdeParseError extends Error {
  constructor(
    readonly field: CdeField | "photo",
    message: string,
  ) {
    super(message);
    this.name = "CdeParseError";
  }
}

/** The card reports years in the Buddhist Era; the UI wants Gregorian. */
const BUDDHIST_ERA_OFFSET = 543;

/** Two-digit zero padding for month/day. */
const pad2 = (n: number): string => String(n).padStart(2, "0");

const THAI_ENCODING = "windows-874";

/** Strip NUL/space padding and any trailing '#' separators. */
function clean(raw: string): string {
  return raw.replace(/\0/g, " ").replace(/#+$/, "").trim();
}

function decodeTh(buffer: Uint8Array, field: CdeField): string {
  try {
    return iconv.decode(Buffer.from(buffer), THAI_ENCODING);
  } catch {
    throw new CdeParseError(field, `decode failed: ${field}`);
  }
}

/**
 * The English name, dates and citizen id are ASCII on the card. A byte
 * above 0x7f is a wrong-card or wrong-offset signal, not text: reject it
 * rather than passing Latin-1 mojibake through to the UI.
 */
function decodeAscii(buffer: Uint8Array, field: CdeField): string {
  let out = "";
  for (const byte of buffer) {
    if (byte === 0) break;
    if (byte > 0x7f) throw new CdeParseError(field, `invalid ascii: ${field}`);
    out += String.fromCharCode(byte);
  }
  return out;
}

function splitName(raw: string, field: CdeField): PersonName {
  const parts = clean(raw)
    .split("#")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) throw new CdeParseError(field, `empty name: ${field}`);

  const [prefix = "", first = "", ...rest] = parts;

  if (rest.length === 0) {
    return { prefix, firstName: first, middleName: null, lastName: "" };
  }
  if (rest.length === 1) {
    return { prefix, firstName: first, middleName: null, lastName: rest[0]! };
  }

  return {
    prefix,
    firstName: first,
    middleName: rest.slice(0, -1).join(" "),
    lastName: rest[rest.length - 1]!,
  };
}

function parseDate(raw: string, field: CdeField): string {
  const digits = raw.replace(/\0/g, " ").trim();

  if (!/^\d{8}$/.test(digits)) {
    throw new CdeParseError(field, `invalid date format: ${field}`);
  }

  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));

  // The card writes Buddhist Era years (2400..2700). Anything in the
  // Gregorian range is accepted as-is so a re-issued card that switches
  // conventions does not silently become the year 1400.
  const gregorian = year >= 2400 ? year - BUDDHIST_ERA_OFFSET : year;

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new CdeParseError(field, `invalid date value: ${field}`);
  }

  const date = new Date(Date.UTC(gregorian, month - 1, day));
  if (
    date.getUTCFullYear() !== gregorian ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new CdeParseError(field, `impossible date: ${field}`);
  }

  return `${String(gregorian).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

function parseSex(raw: Uint8Array): Sex {
  const byte = raw[0];
  // Some cards store the ASCII digit, others the raw 1/2. Accept both.
  if (byte === 0x31 || byte === 0x01) return "male";
  if (byte === 0x32 || byte === 0x02) return "female";
  return "unknown";
}

function parseCitizenId(raw: string): string {
  const id = raw.replace(/\0/g, " ").trim();
  if (!/^\d{13}$/.test(id)) {
    throw new CdeParseError("citizenId", "invalid citizen id");
  }
  return id;
}

/** Read a CDE block from the card. Offsets/lengths come from `CDE`. */
export type CdeReader = (offset: number, length: number) => Uint8Array;

export function parseCde(read: CdeReader): ParsedCard {
  const field = (name: CdeField): Uint8Array => read(CDE[name].offset, CDE[name].length);

  const citizenId = parseCitizenId(decodeAscii(field("citizenId"), "citizenId"));

  const nameTh = splitName(decodeTh(field("nameTh"), "nameTh"), "nameTh");

  const nameEnRaw = decodeAscii(field("nameEn"), "nameEn");
  const nameEnParts = clean(nameEnRaw);
  const nameEn = nameEnParts.length === 0 ? null : splitName(nameEnRaw, "nameEn");

  const dateOfBirth = parseDate(decodeAscii(field("dateOfBirth"), "dateOfBirth"), "dateOfBirth");
  const issueDate = parseDate(decodeAscii(field("issueDate"), "issueDate"), "issueDate");
  const expireDate = parseDate(decodeAscii(field("expireDate"), "expireDate"), "expireDate");

  const sex = parseSex(field("sex"));

  const issuer = decodeTh(field("issuer"), "issuer").replace(/\0/g, " ").trim();

  const address = clean(decodeTh(field("address"), "address"))
    .replace(/#/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    citizenId,
    nameTh,
    nameEn,
    dateOfBirth,
    sex,
    address,
    issueDate,
    expireDate,
    issuer,
  };
}
