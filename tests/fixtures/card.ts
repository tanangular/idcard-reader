/**
 * Test-only card fixture. Builds a byte buffer that mirrors the layout of
 * the physical 2567-series card this project was built against.
 *
 * Offsets are literal here on purpose so a change in `CDE` fails a test
 * instead of silently following the production constant.
 */
export const FIXTURE_OFFSET = {
  header: 0x0000,
  citizenId: 0x0004,
  nameTh: 0x0011,
  nameEn: 0x0075,
  dateOfBirth: 0x00d9,
  sex: 0x00e1,
  registrationCode: 0x00e2,
  issuer: 0x00f6,
  serial: 0x015a,
  issueDate: 0x0167,
  expireDate: 0x016f,
  version: 0x0177,
  photoLength: 0x0179,
  photo: 0x017b,
  address: 0x1579,
} as const;

export const CARD_BYTES = 0x1700;

/**
 * Encode a string the way TIS-620 defines it: ASCII passes through, and the
 * Thai block U+0E01..U+0E5B maps to 0xA1..0xFB. Written independently of
 * iconv-lite so a wrong codepage in production shows up as a test failure.
 */
export function tis620(text: string): Uint8Array {
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

export const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

export function put(buf: Uint8Array, offset: number, data: Uint8Array | number[]): void {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  buf.set(bytes, offset);
}

/** A small but structurally valid JPEG: SOI, APP0/JFIF, EOI. */
export function makePhoto(length = 300): Uint8Array {
  const photo = new Uint8Array(length);
  photo.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  photo.set([0xff, 0xd9], length - 2);
  return photo;
}

export interface FixtureOptions {
  photo?: Uint8Array;
  /** Value written to the photo-length field; defaults to the real photo size. */
  photoLengthOverride?: number;
  fields?: Partial<Record<keyof typeof FIXTURE_OFFSET, Uint8Array | number[]>>;
}

export function makeCardBuffer(options: FixtureOptions = {}): Uint8Array {
  const buf = new Uint8Array(CARD_BYTES);
  buf.fill(0x20);

  const photo = options.photo ?? makePhoto();
  const photoLength = options.photoLengthOverride ?? photo.length;

  const fields: Record<keyof typeof FIXTURE_OFFSET, Uint8Array | number[]> = {
    header: ascii("0004"),
    citizenId: ascii("1101700203456"),
    nameTh: tis620("นาย#สมชาย#ใจดี#รักไทย#"),
    nameEn: ascii("Mr.#Somchai#JaiDee#Rakthai#"),
    dateOfBirth: ascii("25300115"),
    sex: ascii("1"),
    registrationCode: ascii("10164317598/04181430"),
    issuer: tis620("สำนักทะเบียนกลาง"),
    serial: ascii("3101600319614"),
    issueDate: ascii("25600101"),
    expireDate: ascii("25700101"),
    version: ascii("01"),
    photoLength: [(photoLength >> 8) & 0xff, photoLength & 0xff],
    photo,
    address: tis620("99 หมู่ 5#ตำบลในเมือง#"),
    ...options.fields,
  };

  for (const key of Object.keys(fields) as Array<keyof typeof FIXTURE_OFFSET>) {
    if (key === "photo") continue;
    put(buf, FIXTURE_OFFSET[key], fields[key]);
  }

  put(buf, FIXTURE_OFFSET.photo, photo);
  return buf;
}
