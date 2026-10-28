/**
 * Spike: prove koffi can talk to PCSC.framework from Bun.
 *
 * Step 0 of PLAN.md. Success = prints the reader name(s) reported by PC/SC,
 * and (if a card is present) the ATR, matching `system_profiler SPSmartCardsDataType`.
 */
import koffi from "koffi";

const PCSC_PATH = "/System/Library/Frameworks/PCSC.framework/PCSC";
const SCARD_SCOPE_USER = 0;

const pcsc = koffi.load(PCSC_PATH);

const SCardEstablishContext = pcsc.func(
  "long SCardEstablishContext(uint32_t dwScope, void *pvReserved1, void *pvReserved2, _Out_ intptr_t *phContext)",
);
const SCardReleaseContext = pcsc.func("long SCardReleaseContext(intptr_t hContext)");
const SCardListReaders = pcsc.func(
  "long SCardListReaders(intptr_t hContext, const char *mszGroups, _Out_ uint8_t *mszReaders, _Inout_ uint32_t *pcchReaders)",
);

function hex(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

const ctx: [bigint] = [0n];
const rcEstablish = SCardEstablishContext(SCARD_SCOPE_USER, null, null, ctx);
console.log(`SCardEstablishContext -> ${hex(rcEstablish)} (hContext=${ctx[0]})`);
if (rcEstablish !== 0) {
  console.error("FAILED: cannot establish PC/SC context");
  process.exit(1);
}

const hContext = ctx[0];

// First call: null buffer to learn the required size (multi-string block).
const needed: [number] = [0];
const rcSize = SCardListReaders(hContext, null, null, needed);
console.log(`SCardListReaders(size) -> ${hex(rcSize)}, bytes needed = ${needed[0]}`);
if (rcSize !== 0) {
  console.error("FAILED: cannot list readers");
  SCardReleaseContext(hContext);
  process.exit(1);
}

const buf = Buffer.alloc(needed[0]);
const len: [number] = [needed[0]];
const rcList = SCardListReaders(hContext, null, buf, len);
console.log(`SCardListReaders(data) -> ${hex(rcList)}`);

const block = buf.subarray(0, len[0]);
const readers: string[] = [];
let start = 0;
for (let i = 0; i < block.length; i++) {
  if (block[i] === 0) {
    if (i === start) break; // double NUL = end of multi-string
    readers.push(block.subarray(start, i).toString("utf8"));
    start = i + 1;
  }
}

console.log("\nReaders:");
for (const r of readers) console.log(`  - ${r}`);

SCardReleaseContext(hContext);

if (readers.length === 0) {
  console.error("\nFAILED: no readers reported");
  process.exit(1);
}
console.log("\nOK: koffi + PCSC.framework works from Bun.");
