/**
 * Presentation-only helpers for the client. Everything here is pure and
 * takes values straight from the wire protocol, so it is tested without a
 * browser and without a card.
 *
 * No function here logs, stores or transmits its input.
 */
import type { PersonName, ProgressStep, Sex } from "../shared/protocol.ts";

/** The card reports years in the Buddhist Era; the UI shows BE years too. */
const BUDDHIST_ERA_OFFSET = 543;

const THAI_MONTHS = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
] as const;

const THAI_MONTHS_SHORT = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
] as const;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** Parse strict `YYYY-MM-DD`, rejecting days the calendar does not have. */
function parseIsoDate(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Reject 2023-02-29 and friends: Date normalises them into March.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `1101700203456` → `1-1017-00203-45-6`; anything else is returned as-is. */
export function formatCitizenId(citizenId: string): string {
  if (!/^\d{13}$/.test(citizenId)) return citizenId;
  return [
    citizenId.slice(0, 1),
    citizenId.slice(1, 5),
    citizenId.slice(5, 10),
    citizenId.slice(10, 12),
    citizenId.slice(12),
  ].join("-");
}

/** Thai names attach the prefix to the first name: `นายสมชาย รักไทย`. */
export function formatThaiName(name: PersonName): string {
  return [name.prefix + name.firstName, name.middleName, name.lastName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

/** English names separate every part: `Mr. Somchai Rakthai`. */
export function formatEnglishName(name: PersonName): string {
  return [name.prefix, name.firstName, name.middleName, name.lastName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

/** `1987-01-15` → `15 มกราคม 2530`. Invalid input is echoed unchanged. */
export function formatThaiDate(isoDate: string): string {
  const parts = parseIsoDate(isoDate);
  if (!parts) return isoDate;

  const month = THAI_MONTHS[parts.month - 1]!;
  return `${parts.day} ${month} ${parts.year + BUDDHIST_ERA_OFFSET}`;
}

/** `2026-10-28` → `28 ต.ค. 2569`, for dense tables. */
export function formatThaiDateShort(isoDate: string): string {
  const parts = parseIsoDate(isoDate);
  if (!parts) return isoDate;

  const month = THAI_MONTHS_SHORT[parts.month - 1]!;
  return `${parts.day} ${month} ${parts.year + BUDDHIST_ERA_OFFSET}`;
}

/**
 * ISO timestamp → `28 ต.ค. 2569 15:41 น.` in the viewer's local time.
 * A missing or broken timestamp renders as an em dash, never `Invalid Date`.
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return `${date.getDate()} ${THAI_MONTHS_SHORT[date.getMonth()]} ${
    date.getFullYear() + BUDDHIST_ERA_OFFSET
  } ${pad2(date.getHours())}:${pad2(date.getMinutes())} น.`;
}

export function formatSex(sex: Sex): string {
  switch (sex) {
    case "male":
      return "ชาย";
    case "female":
      return "หญิง";
    default:
      return "ไม่ระบุ";
  }
}

/** `786` → `786 มิลลิวินาที`, `1543` → `1.5 วินาที`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} มิลลิวินาที`;
  if (ms < 60_000) {
    const seconds = Number((ms / 1000).toFixed(1));
    return `${seconds} วินาที`;
  }

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes} นาที` : `${minutes} นาที ${seconds} วินาที`;
}

/** The audit page only ever has a short hash; an empty one is not a value. */
export function formatHash(hash: string): string {
  return hash.length === 0 ? "—" : hash;
}

export interface ProgressStepInfo {
  step: ProgressStep;
  /** Shown next to the marker in the timeline. */
  label: string;
}

/** Reading order. The server reports these steps in exactly this sequence. */
export const PROGRESS_STEPS: readonly ProgressStepInfo[] = [
  { step: "select", label: "เลือกแอปพลิเคชันบนบัตร" },
  { step: "cid", label: "อ่านเลขประจำตัวประชาชน" },
  { step: "name", label: "อ่านชื่อและนามสกุล" },
  { step: "address", label: "อ่านที่อยู่" },
  { step: "photo", label: "อ่านรูปถ่าย" },
];

/** Index of a step in the timeline, or -1 for an unknown value. */
export function progressIndex(step: ProgressStep | null): number {
  if (step === null) return -1;
  return PROGRESS_STEPS.findIndex((info) => info.step === step);
}
