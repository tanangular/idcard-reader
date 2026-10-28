/**
 * Drives the APDU conversation with a Thai national ID card.
 *
 * The card in hand is T=0 only, so every READ answers `61 XX` and needs a
 * `GET RESPONSE`; some cards answer `6C XX` when the requested length is too
 * large and need the shorter length re-sent. Reads are capped at 0xFF bytes
 * because a 0x0100 request comes back as SW 6986.
 */
import { PHOTO, parseCde, type CdeReader } from "./cde.ts";
import { appError, decodeStatusWord, PcscError } from "./errors.ts";
import type { ProgressStep, ThaiIdCard } from "../shared/protocol.ts";

/** SELECT the Thai ID applet. */
const SELECT_APPLET = new Uint8Array([
  0x00, 0xa4, 0x04, 0x00, 0x08, 0xa0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01,
]);

const MAX_READ = 0xff;
const MAX_APDU_ROUNDS = 16;
/**
 * The address CDE starts at 0x1579, right after the photo, so a photo longer
 * than this would read into unrelated data. Reject a bad length early
 * instead of issuing up to 64 pointless READs.
 */
const MAX_PHOTO_BYTES = 0x1579 - 0x017b;

const JPEG_SOI = 0xffd8;
const JPEG_EOI = 0xffd9;

export interface CardTransport {
  /** ATR rendered as uppercase hex pairs, e.g. "3B 79 ...". */
  readonly atrHex: string;
  transmit(apdu: Uint8Array): Uint8Array;
}

export type ProgressFn = (step: ProgressStep, pct: number) => void;

export interface ReadOptions {
  onProgress?: ProgressFn;
  now?: () => Date;
}

function statusWord(response: Uint8Array): number {
  if (response.length < 2) return -1;
  return ((response[response.length - 2]! << 8) | response[response.length - 1]!) & 0xffff;
}

function payload(response: Uint8Array): Uint8Array {
  return response.slice(0, Math.max(0, response.length - 2));
}

/** Re-send a command with the length the card asked for. */
function shrink(command: Uint8Array, length: number): Uint8Array {
  const out = command.slice();
  if (out[1] === 0xb0 && out.length >= 7) {
    out[5] = 0x00;
    out[6] = length & 0xff;
    return out;
  }
  // GET RESPONSE is a case-2 command: it already ends in Le, so replace it
  // rather than appending a second Le byte.
  if (out[1] === 0xc0) {
    const fixed = out.slice(0, 5);
    fixed[4] = length & 0xff;
    return fixed;
  }
  // Other case-3 commands get a trailing Le instead.
  const withLe = new Uint8Array(out.length + 1);
  withLe.set(out);
  withLe[out.length] = length & 0xff;
  return withLe;
}

function transceive(transport: CardTransport, command: Uint8Array): Uint8Array {
  // Track the command actually in flight: a GET RESPONSE can itself answer
  // `6C XX`, and the retry must shorten *that* command, not the READ before it.
  let current = command;
  let response = transport.transmit(current);

  for (let round = 0; round < MAX_APDU_ROUNDS; round++) {
    const sw = statusWord(response);

    if (sw === 0x9000) return payload(response);

    const hi = sw & 0xff00;
    if (hi === 0x6100) {
      const le = sw & 0xff; // 0x00 means 256
      current = new Uint8Array([0x00, 0xc0, 0x00, 0x00, le]);
      response = transport.transmit(current);
      continue;
    }
    if (hi === 0x6c00) {
      current = shrink(current, sw & 0xff);
      response = transport.transmit(current);
      continue;
    }

    throw new PcscError(decodeStatusWord(sw));
  }

  throw new PcscError(appError("TRANSMIT_FAILED"));
}

function readRange(transport: CardTransport, offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let done = 0;

  while (done < length) {
    const chunk = Math.min(MAX_READ, length - done);
    const at = offset + done;
    const command = new Uint8Array([
      0x80,
      0xb0,
      (at >> 8) & 0xff,
      at & 0xff,
      0x02,
      (chunk >> 8) & 0xff,
      chunk & 0xff,
    ]);

    const data = transceive(transport, command);
    const got = Math.min(data.length, chunk);
    if (got === 0) throw new PcscError(appError("TRANSMIT_FAILED"));

    out.set(data.subarray(0, got), done);
    done += got;
  }

  return out;
}

function isJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const soi = (bytes[0]! << 8) | bytes[1]!;
  const eoi = (bytes[bytes.length - 2]! << 8) | bytes[bytes.length - 1]!;
  return soi === JPEG_SOI && eoi === JPEG_EOI;
}

/** Which progress step a CDE offset belongs to. */
const STEPS: Readonly<Record<number, readonly [ProgressStep, number]>> = {
  0x0004: ["cid", 10],
  0x0011: ["name", 20],
  0x1579: ["address", 25],
};

const PHOTO_START_PCT = 30;
const PHOTO_END_PCT = 99;

export function readThaiIdCard(transport: CardTransport, options: ReadOptions = {}): ThaiIdCard {
  const progress = options.onProgress;
  const now = options.now ?? (() => new Date());

  progress?.("select", 5);
  transceive(transport, SELECT_APPLET);

  // parseCde pulls fields through this reader, so progress is tied to the
  // field being fetched without teaching the parser about the UI.
  const read: CdeReader = (offset, length) => {
    const step = STEPS[offset];
    if (step) progress?.(step[0], step[1]);
    return readRange(transport, offset, length);
  };

  const parsed = parseCde(read);

  const lengthBytes = readRange(transport, PHOTO.lengthOffset, 2);
  const photoLength = ((lengthBytes[0] ?? 0) << 8) | (lengthBytes[1] ?? 0);

  if (photoLength <= 4 || photoLength > MAX_PHOTO_BYTES) {
    throw new PcscError(appError("PARSE_FAILED"));
  }

  const photo = new Uint8Array(photoLength);
  let done = 0;
  while (done < photoLength) {
    const chunk = Math.min(MAX_READ, photoLength - done);
    const slice = readRange(transport, PHOTO.offset + done, chunk);
    photo.set(slice, done);
    done += slice.length;

    const span = PHOTO_END_PCT - PHOTO_START_PCT;
    const pct = PHOTO_START_PCT + Math.round((done / photoLength) * span);
    progress?.("photo", Math.min(PHOTO_END_PCT, pct));
  }

  if (!isJpeg(photo)) throw new PcscError(appError("PARSE_FAILED"));

  progress?.("photo", 100);

  return {
    citizenId: parsed.citizenId,
    nameTh: parsed.nameTh,
    nameEn: parsed.nameEn,
    dateOfBirth: parsed.dateOfBirth,
    sex: parsed.sex,
    address: parsed.address,
    issueDate: parsed.issueDate,
    expireDate: parsed.expireDate,
    issuer: parsed.issuer,
    photo: {
      mime: "image/jpeg",
      dataUrl: `data:image/jpeg;base64,${Buffer.from(photo).toString("base64")}`,
    },
    atr: transport.atrHex,
    readAt: now().toISOString(),
  };
}
