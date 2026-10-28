/**
 * Verifies the CDE offsets in src/server/cde.ts against the inserted card.
 *
 * Structural output only: lengths, format validity and script checks. The
 * script never prints a field value — no citizen id, name, date, issuer or
 * address. If you extend it, keep it that way: this file runs against a real
 * card and its output can end up in a terminal log or a bug report.
 */
import { CDE, parseCde } from "#server/cde.ts";
import { formatAtr, Pcsc } from "#server/pcsc.ts";

const SELECT = new Uint8Array([
  0x00, 0xa4, 0x04, 0x00, 0x08, 0xa0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01,
]);

const pcsc = new Pcsc();

const ok = (value: boolean) => (value ? "yes" : "no");

function apdu(handle: bigint, bytes: Uint8Array): Uint8Array {
  let res = pcsc.transmit(handle, bytes);
  let guard = 0;
  while (res.length >= 2 && res[res.length - 2] === 0x61 && guard++ < 8) {
    const le = res[res.length - 1]!;
    const body = res.subarray(0, res.length - 2);
    const more = pcsc.transmit(handle, new Uint8Array([0x00, 0xc0, 0x00, 0x00, le]));
    const merged = new Uint8Array(body.length + more.length);
    merged.set(body);
    merged.set(more, body.length);
    res = merged;
  }
  return res;
}

function read(handle: bigint, offset: number, length: number): Uint8Array {
  const apduBytes = new Uint8Array([
    0x80,
    0xb0,
    (offset >> 8) & 0xff,
    offset & 0xff,
    0x02,
    (length >> 8) & 0xff,
    length & 0xff,
  ]);
  const res = apdu(handle, apduBytes);
  if (res.length < 2) throw new Error("short response");
  const sw = (res[res.length - 2]! << 8) | res[res.length - 1]!;
  if (sw !== 0x9000) throw new Error(`SW=${sw.toString(16)} at offset ${offset}`);
  return res.slice(0, res.length - 2);
}

const readers = pcsc.listReaders();
const reader = readers[0];
if (!reader) throw new Error("no reader");

const handle = pcsc.connect(reader);
console.log(`reader: ${reader}`);
console.log(`ATR   : ${formatAtr(pcsc.status(handle).atr)}`);

try {
  apdu(handle, SELECT);

  const card = parseCde((offset, length) => read(handle, offset, length));

  const THAI = /^[\u0e00-\u0e7f]/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const KNOWN_PREFIXES = new Set(["นาย", "นาง", "นางสาว", "Mr.", "Mrs.", "Miss"]);
  const shape = (s: string) => `${s.length} chars, thai=${ok(THAI.test(s))}`;

  // Every value printed below is a length or a boolean: the console line
  // never interpolates a field. tests/privacy.test.ts enforces that shape.
  const cidLength = card.citizenId.length;
  const cidIsDigits = /^\d{13}$/.test(card.citizenId);
  const thPrefixKnown = KNOWN_PREFIXES.has(card.nameTh.prefix);
  const thFirst = shape(card.nameTh.firstName);
  const thMiddle = card.nameTh.middleName === null ? "none" : shape(card.nameTh.middleName);
  const thLast = shape(card.nameTh.lastName);
  const en = card.nameEn;
  const enSummary =
    en === null
      ? "absent"
      : `prefixKnown=${ok(KNOWN_PREFIXES.has(en.prefix))} first=${shape(en.firstName)} last=${shape(en.lastName)}`;
  const dobValid = DATE.test(card.dateOfBirth);
  const sexKnown = card.sex !== "unknown";
  const issuerLength = card.issuer.length;
  const issuerIsThai = THAI.test(card.issuer);
  const issueValid = DATE.test(card.issueDate);
  const expireValid = DATE.test(card.expireDate);
  const addressLength = card.address.length;
  const addressIsThai = THAI.test(card.address);

  console.log(`\ncitizenId  : length=${cidLength}, digits13=${ok(cidIsDigits)}`);
  console.log(
    `nameTh     : prefixKnown=${ok(thPrefixKnown)} first=${thFirst} middle=${thMiddle} last=${thLast}`,
  );
  console.log(`nameEn     : ${enSummary}`);
  console.log(`dateOfBirth: formatValid=${ok(dobValid)}`);
  console.log(`sex        : known=${ok(sexKnown)}`);
  console.log(`issuer     : length=${issuerLength}, thai=${ok(issuerIsThai)}`);
  console.log(`issueDate  : formatValid=${ok(issueValid)}`);
  console.log(`expireDate : formatValid=${ok(expireValid)}`);
  console.log(`address    : ${addressLength} chars, thai=${ok(addressIsThai)}`);

  // Raw field sizing: how many bytes are actually used before padding.
  const used = (offset: number, length: number) => {
    const bytes = read(handle, offset, length);
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20 || bytes[end - 1] === 0x23))
      end--;
    return end;
  };

  console.log("\nraw field usage:");
  for (const [name, cde] of Object.entries(CDE)) {
    console.log(
      `  ${name.padEnd(12)} @0x${cde.offset.toString(16).padStart(4, "0")} len=${cde.length} used=${used(cde.offset, cde.length)}`,
    );
  }
} finally {
  pcsc.disconnect(handle);
  pcsc.release();
}
