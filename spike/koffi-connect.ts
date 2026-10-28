/**
 * Spike 2: connect to the card, read the ATR, SELECT the Thai ID applet,
 * and read the 13-byte citizen ID. Proves the whole FFI chain before we
 * build the real pcsc.ts / thai-card.ts.
 */
import koffi from "koffi";

const pcsc = koffi.load("/System/Library/Frameworks/PCSC.framework/PCSC");

const SCardEstablishContext = pcsc.func(
  "long SCardEstablishContext(uint32_t dwScope, void *pvReserved1, void *pvReserved2, _Out_ intptr_t *phContext)",
);
const SCardReleaseContext = pcsc.func("long SCardReleaseContext(intptr_t hContext)");
const SCardListReaders = pcsc.func(
  "long SCardListReaders(intptr_t hContext, const char *mszGroups, _Out_ uint8_t *mszReaders, _Inout_ uint32_t *pcchReaders)",
);
const SCardConnect = pcsc.func(
  "long SCardConnect(intptr_t hContext, const char *szReader, uint32_t dwShareMode, uint32_t dwPreferredProtocols, _Out_ intptr_t *phCard, _Out_ uint32_t *pdwActiveProtocol)",
);
const SCardDisconnect = pcsc.func("long SCardDisconnect(intptr_t hCard, uint32_t dwDisposition)");
const SCardStatus = pcsc.func(
  "long SCardStatus(intptr_t hCard, _Out_ uint8_t *szReaderName, _Inout_ uint32_t *pcchReaderLen, _Out_ uint32_t *pdwState, _Out_ uint32_t *pdwProtocol, _Out_ uint8_t *pbAtr, _Inout_ uint32_t *pcbAtrLen)",
);
const SCardTransmit = pcsc.func(
  "long SCardTransmit(intptr_t hCard, SCARD_IO_REQUEST *pioSendPci, uint8_t *pbSendBuffer, uint32_t cbSendLength, SCARD_IO_REQUEST *pioRecvPci, _Out_ uint8_t *pbRecvBuffer, _Inout_ uint32_t *pcbRecvLength)",
);

const hex = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
const bhex = (b: Buffer | Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");

const SCARD_SHARE_SHARED = 2;
const SCARD_PROTOCOL_T0 = 1;
const SCARD_LEAVE_CARD = 0;

const ctx: [bigint] = [0n];
SCardEstablishContext(0, null, null, ctx);
const hContext = ctx[0];
console.log(`hContext = ${hContext}`);

const needed: [number] = [0];
SCardListReaders(hContext, null, null, needed);
const rbuf = Buffer.alloc(needed[0]);
const rlen: [number] = [needed[0]];
SCardListReaders(hContext, null, rbuf, rlen);
const reader = rbuf.subarray(0, rlen[0]).toString("utf8").split("\0")[0]!;
console.log(`reader    = ${reader}`);

const card: [bigint] = [0n];
const proto: [number] = [0];
const rcConnect = SCardConnect(
  hContext,
  reader,
  SCARD_SHARE_SHARED,
  SCARD_PROTOCOL_T0,
  card,
  proto,
);
console.log(`SCardConnect -> ${hex(rcConnect)} (hCard=${card[0]}, proto=${proto[0]})`);
if (rcConnect !== 0) process.exit(1);
const hCard = card[0];

// ATR via SCardStatus
const nameBuf = Buffer.alloc(256);
const nameLen: [number] = [256];
const state: [number] = [0];
const activeProto: [number] = [0];
const atrBuf = Buffer.alloc(64);
const atrLen: [number] = [64];
const rcStatus = SCardStatus(hCard, nameBuf, nameLen, state, activeProto, atrBuf, atrLen);
console.log(`SCardStatus  -> ${hex(rcStatus)}`);
console.log(`  state      = ${state[0]}`);
console.log(`  protocol   = ${activeProto[0]}`);
console.log(`  ATR        = ${bhex(atrBuf.subarray(0, atrLen[0]))}`);

const sendPci = { dwProtocol: SCARD_PROTOCOL_T0, cbPciLength: 8 };

function transmit(apdu: Uint8Array): Buffer {
  const recv = Buffer.alloc(512);
  const recvLen: [number] = [512];
  const rc = SCardTransmit(hCard, sendPci, apdu, apdu.length, null, recv, recvLen);
  if (rc !== 0) throw new Error(`SCardTransmit failed: ${hex(rc)}`);
  return recv.subarray(0, recvLen[0]);
}

function sw(buf: Buffer): number {
  if (buf.length < 2) return -1;
  return (buf[buf.length - 2]! << 8) | buf[buf.length - 1]!;
}

// SELECT Thai ID applet: 00 A4 04 00 08 A0 00 00 00 54 48 00 01
const SELECT = new Uint8Array([
  0x00, 0xa4, 0x04, 0x00, 0x08, 0xa0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01,
]);
let res = transmit(SELECT);
console.log(
  `\nSELECT applet -> SW=${sw(res).toString(16).toUpperCase().padStart(4, "0")} (${res.length} bytes)`,
);

// If 61 XX, GET RESPONSE
if ((sw(res) & 0xff00) === 0x6100) {
  const le = sw(res) & 0xff;
  res = transmit(new Uint8Array([0x00, 0xc0, 0x00, 0x00, le]));
  console.log(
    `GET RESPONSE  -> SW=${sw(res).toString(16).toUpperCase().padStart(4, "0")} (${res.length} bytes)`,
  );
}

// READ citizen id: 80 B0 00 04 02 00 0D
res = transmit(new Uint8Array([0x80, 0xb0, 0x00, 0x04, 0x02, 0x00, 0x0d]));
console.log(`READ CID      -> SW=${sw(res).toString(16).toUpperCase().padStart(4, "0")}`);
if ((sw(res) & 0xff00) === 0x6100) {
  const le = sw(res) & 0xff;
  res = transmit(new Uint8Array([0x00, 0xc0, 0x00, 0x00, le]));
  console.log(`  GET RESPONSE -> SW=${sw(res).toString(16).toUpperCase().padStart(4, "0")}`);
}
const cidLen = res.length - 2;
const cidIsDigits = /^\d{13}$/.test(res.subarray(0, cidLen).toString("ascii"));
console.log(`  CID length  = ${cidLen}`);
console.log(`  CID digits  = ${cidIsDigits}`);

SCardDisconnect(hCard, SCARD_LEAVE_CARD);
SCardReleaseContext(hContext);
