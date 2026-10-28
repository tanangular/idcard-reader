/**
 * Verifies the CDE offsets in src/server/cde.ts against the inserted card.
 * Prints structure and non-sensitive fields only: names are reduced to a
 * prefix plus a length, and the citizen id to its last two digits.
 */
import { CDE, parseCde } from "../src/server/cde.ts";
import { formatAtr, Pcsc } from "../src/server/pcsc.ts";

const SELECT = new Uint8Array([
  0x00, 0xa4, 0x04, 0x00, 0x08, 0xa0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01,
]);

const pcsc = new Pcsc();

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

  const mask = (s: string) =>
    s.length <= 2 ? "*".repeat(s.length) : "*".repeat(s.length - 2) + s.slice(-2);
  const shape = (s: string) => `${s.length} chars, all-thai-prefix=${/^[\u0e00-\u0e7f]/.test(s)}`;

  console.log(
    `\ncitizenId  : ${mask(card.citizenId)} (13 digits: ${/^\d{13}$/.test(card.citizenId)})`,
  );
  console.log(
    `nameTh     : prefix="${card.nameTh.prefix}" ${shape(card.nameTh.firstName)}, middle=${card.nameTh.middleName === null ? "none" : shape(card.nameTh.middleName)}, last=${shape(card.nameTh.lastName)}`,
  );
  console.log(
    `nameEn     : ${card.nameEn === null ? "absent" : `prefix="${card.nameEn.prefix}" first=${shape(card.nameEn.firstName)} last=${shape(card.nameEn.lastName)}`}`,
  );
  console.log(`dateOfBirth: ${card.dateOfBirth}`);
  console.log(`sex        : ${card.sex}`);
  console.log(`issuer     : ${card.issuer}`);
  console.log(`issueDate  : ${card.issueDate}`);
  console.log(`expireDate : ${card.expireDate}`);
  console.log(
    `address    : ${card.address.length} chars, starts with thai=${/^[\u0e00-\u0e7f0-9]/.test(card.address)}`,
  );

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
