/**
 * CLI probe for step 2 of the plan.
 *
 *   bun run probe --list     list PC/SC readers
 *   bun run probe --status   list readers, then connect and report ATR/state
 *
 * Prints no card data — only reader names, PC/SC states and the ATR.
 */
import { PcscError } from "./errors.ts";
import { formatAtr, Pcsc, statusHasCard, type ReaderStatus } from "./pcsc.ts";

/** dwEventState bits (used after SCardGetStatusChange). */
const EVENT_STATE_NAMES: ReadonlyArray<readonly [number, string]> = [
  [0x0001, "IGNORE"],
  [0x0002, "CHANGED"],
  [0x0004, "UNKNOWN"],
  [0x0008, "UNAVAILABLE"],
  [0x0010, "EMPTY"],
  [0x0020, "PRESENT"],
  [0x0040, "ATRMATCH"],
  [0x0080, "EXCLUSIVE"],
  [0x0100, "INUSE"],
  [0x0200, "MUTE"],
];

/** SCardStatus.dwState bits — a separate enum from the one above. */
const STATUS_STATE_NAMES: ReadonlyArray<readonly [number, string]> = [
  [0x0001, "ABSENT"],
  [0x0002, "PRESENT"],
  [0x0004, "SWALLOWED"],
  [0x0008, "POWERED"],
  [0x0010, "NEGOTIABLE"],
  [0x0020, "SPECIFIC"],
];

function describe(state: number, names: ReadonlyArray<readonly [number, string]>): string {
  const bits = names.filter(([bit]) => (state & bit) !== 0).map(([, name]) => name);
  const hex = `0x${state.toString(16).toUpperCase().padStart(2, "0")}`;
  return bits.length > 0 ? `${hex} (${bits.join("|")})` : hex;
}

function reportStatus(pcsc: Pcsc, reader: string): void {
  let handle: bigint | undefined;
  try {
    handle = pcsc.connect(reader);
    const status: ReaderStatus = pcsc.status(handle);
    console.log(`  ATR        : ${formatAtr(status.atr)}`);
    console.log(`  protocol   : T=${status.protocol === 1 ? 0 : 1}`);
    console.log(`  dwState    : ${describe(status.state, STATUS_STATE_NAMES)}`);
    console.log(`  card       : ${statusHasCard(status) ? "present" : "absent"}`);
  } catch (error) {
    if (error instanceof PcscError) {
      console.log(`  error      : ${error.app.code} (${error.app.pcscCode ?? error.app.sw ?? "-"}) — ${error.app.message}`);
    } else {
      throw error;
    }
  } finally {
    if (handle !== undefined) pcsc.disconnect(handle);
  }
}

const mode = process.argv[2] ?? "--list";
const pcsc = new Pcsc();

try {
  const readers = pcsc.listReaders();
  console.log(`readers: ${readers.length}`);
  for (const reader of readers) console.log(`- ${reader}`);

  if (mode === "--status") {
    for (const reader of readers) {
      console.log(`\nstatus of "${reader}":`);
      reportStatus(pcsc, reader);
    }
  } else if (mode === "--events") {
    // Poll SCardGetStatusChange for 5 seconds so the state machine's
    // detection path can be exercised by hand (insert/remove the card).
    const reader = readers[0];
    if (!reader) throw new Error("no reader");
    console.log(`\npolling "${reader}" for 5s — insert or remove the card now:`);
    const deadline = Date.now() + 5000;
    let current = 0;
    while (Date.now() < deadline) {
      const change = pcsc.waitForChange(reader, current, 500);
      if (change.changed) {
        console.log(`  eventState: ${describe(change.status.state, EVENT_STATE_NAMES)}`);
        current = change.status.state;
      }
    }
  } else if (mode !== "--list") {
    console.error(`unknown mode: ${mode} (expected --list, --status or --events)`);
    process.exitCode = 2;
  }

  if (readers.length === 0) process.exitCode = 1;
} catch (error) {
  if (error instanceof PcscError) {
    console.error(`${error.app.code} (${error.app.pcscCode ?? "-"}): ${error.app.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  pcsc.release();
}
