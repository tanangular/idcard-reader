import type { AppError, AppErrorCode } from "#shared/protocol";

/**
 * PC/SC return codes. Values are unsigned 32-bit; the framework hands them
 * back as a signed LONG, so always normalise with `>>> 0` before comparing.
 */
export const PCSC = {
  SCARD_S_SUCCESS: 0x00000000,
  SCARD_E_INVALID_HANDLE: 0x80100003,
  SCARD_E_TIMEOUT: 0x8010000a,
  SCARD_E_SHARING_VIOLATION: 0x8010000b,
  SCARD_E_NO_SMARTCARD: 0x8010000c,
  SCARD_E_READER_UNAVAILABLE: 0x80100017,
  SCARD_E_NO_READERS_AVAILABLE: 0x8010002e,
  SCARD_W_UNRESPONSIVE_CARD: 0x80100066,
  SCARD_W_UNPOWERED_CARD: 0x80100067,
  SCARD_W_RESET_CARD: 0x80100068,
  SCARD_W_REMOVED_CARD: 0x80100069,
} as const;

/** Thai UI messages. Never include card data here. */
const MESSAGES: Record<AppErrorCode, string> = {
  NO_READER: "ไม่พบเครื่องอ่านบัตร",
  NO_CARD: "ยังไม่ได้เสียบบัตรประชาชน",
  CARD_REMOVED: "บัตรถูกถอดออกระหว่างอ่าน",
  SHARING_VIOLATION: "มีโปรแกรมอื่นกำลังใช้งานบัตรอยู่",
  NOT_THAI_ID: "บัตรนี้ไม่ใช่บัตรประชาชนไทย",
  SECURITY_STATUS: "สถานะความปลอดภัยของบัตรไม่ถูกต้อง",
  TRANSMIT_FAILED: "สื่อสารกับบัตรไม่สำเร็จ",
  PARSE_FAILED: "อ่านข้อมูลบนบัตรไม่สำเร็จ",
  UNKNOWN: "เกิดข้อผิดพลาดที่ไม่รู้จัก",
};

export function formatPcscCode(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

export function appError(code: AppErrorCode, extra?: { sw?: string; pcscCode?: string }): AppError {
  const error: AppError = { code, message: MESSAGES[code] };
  if (extra?.sw !== undefined) error.sw = extra.sw;
  if (extra?.pcscCode !== undefined) error.pcscCode = extra.pcscCode;
  return error;
}

export function decodePcscError(raw: number): AppError {
  const code = raw >>> 0;
  const pcscCode = formatPcscCode(code);

  switch (code) {
    case PCSC.SCARD_E_NO_READERS_AVAILABLE:
    case PCSC.SCARD_E_READER_UNAVAILABLE:
      return appError("NO_READER", { pcscCode });

    case PCSC.SCARD_E_NO_SMARTCARD:
      return appError("NO_CARD", { pcscCode });

    case PCSC.SCARD_W_REMOVED_CARD:
    case PCSC.SCARD_W_UNRESPONSIVE_CARD:
    case PCSC.SCARD_W_UNPOWERED_CARD:
    case PCSC.SCARD_W_RESET_CARD:
      return appError("CARD_REMOVED", { pcscCode });

    case PCSC.SCARD_E_SHARING_VIOLATION:
      return appError("SHARING_VIOLATION", { pcscCode });

    case PCSC.SCARD_E_TIMEOUT:
      return appError("TRANSMIT_FAILED", { pcscCode });

    default:
      return appError("UNKNOWN", { pcscCode });
  }
}

export function decodeStatusWord(sw: number): AppError {
  const hex = sw.toString(16).toUpperCase().padStart(4, "0");
  switch (sw) {
    case 0x6a82:
      return appError("NOT_THAI_ID", { sw: hex });
    case 0x6982:
    case 0x6985:
      return appError("SECURITY_STATUS", { sw: hex });
    default:
      return appError("TRANSMIT_FAILED", { sw: hex });
  }
}

/** Thrown by the PC/SC layer so callers can forward a clean AppError. */
export class PcscError extends Error {
  constructor(readonly app: AppError) {
    super(app.message);
    this.name = "PcscError";
  }
}
