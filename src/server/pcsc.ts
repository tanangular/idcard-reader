import koffi from "koffi";
import { decodePcscError, PcscError, PCSC } from "./errors";

const PCSC_PATH = "/System/Library/Frameworks/PCSC.framework/PCSC";

/** SCardConnect share modes. */
export const SCARD_SHARE_SHARED = 2;
export const SCARD_SHARE_EXCLUSIVE = 1;

/** SCardConnect protocols. */
export const SCARD_PROTOCOL_T0 = 1;
export const SCARD_PROTOCOL_T1 = 2;

/** SCardDisconnect dispositions. */
export const SCARD_LEAVE_CARD = 0;

/** SCardReaderState.dwEventState bits we care about. */
export const SCARD_STATE_EMPTY = 0x0010;
export const SCARD_STATE_PRESENT = 0x0020;
export const SCARD_STATE_INUSE = 0x0100;
export const SCARD_STATE_MUTE = 0x0200;

/**
 * SCardStatus.dwState uses a *different* enum from dwEventState above.
 * Mixing them makes a connected card look absent, so keep them apart.
 */
export const SCARD_STATUS_ABSENT = 0x0001;
export const SCARD_STATUS_PRESENT = 0x0002;
export const SCARD_STATUS_SWALLOWED = 0x0004;
export const SCARD_STATUS_POWERED = 0x0008;
export const SCARD_STATUS_NEGOTIABLE = 0x0010;
export const SCARD_STATUS_SPECIFIC = 0x0020;

const MAX_ATR_SIZE = 33;

export type PcscHandle = bigint;

export interface ReaderStatus {
  /** Raw dwState from SCardStatus, or dwEventState from SCardGetStatusChange. */
  state: number;
  /** ATR, empty when no card is present. */
  atr: Uint8Array;
  /** Reader name as reported by the framework. */
  reader: string;
  /** Active protocol (1 = T=0, 2 = T=1). */
  protocol: number;
}

export interface ReaderChange {
  /** False when the wait timed out without any change. */
  changed: boolean;
  /** On timeout this is the state passed in, not the untouched struct. */
  status: ReaderStatus;
}

/**
 * The slice of PC/SC the application depends on. Injecting this keeps the
 * state machine testable without hardware.
 */
export interface PcscPort {
  listReaders(): string[];
  connect(reader: string): PcscHandle;
  status(handle: PcscHandle): ReaderStatus;
  transmit(handle: PcscHandle, apdu: Uint8Array): Uint8Array;
  disconnect(handle: PcscHandle): void;
  /** Poll for a change, waiting at most `timeoutMs`. */
  waitForChange(reader: string, currentState: number, timeoutMs: number): ReaderChange;
  release(): void;
}

/**
 * Parse the double-NUL-terminated multi-string returned by SCardListReaders.
 *
 * The block is `name\0name\0\0`, and `length` is the byte count PC/SC reported
 * (it includes both terminators).
 */
export function parseReaderList(bytes: Uint8Array, length: number): string[] {
  const view = bytes.subarray(0, Math.max(0, length));
  const decoder = new TextDecoder("utf-8");
  const readers: string[] = [];
  let start = 0;

  for (let i = 0; i < view.length; i++) {
    if (view[i] !== 0) continue;
    if (i === start) break; // empty segment terminates the multi-string
    const name = decoder.decode(view.subarray(start, i)).trim();
    if (name.length > 0) readers.push(name);
    start = i + 1;
  }

  return readers;
}

export function formatAtr(atr: Uint8Array): string {
  return Array.from(atr, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

// ---------------------------------------------------------------------------
// FFI bindings, loaded lazily so pure helpers stay importable off-hardware.
// ---------------------------------------------------------------------------

type EstablishContext = (scope: number, r1: null, r2: null, out: [bigint]) => number;
type ReleaseContext = (hContext: bigint) => number;
type ListReaders = (
  hContext: bigint,
  groups: string | null,
  outBuf: Uint8Array | null,
  inoutLen: [number],
) => number;
type Connect = (
  hContext: bigint,
  reader: string,
  shareMode: number,
  preferredProtocols: number,
  outCard: [bigint],
  outProtocol: [number],
) => number;
type Disconnect = (hCard: bigint, disposition: number) => number;
type Status = (
  hCard: bigint,
  outName: Uint8Array,
  inoutNameLen: [number],
  outState: [number],
  outProtocol: [number],
  outAtr: Uint8Array,
  inoutAtrLen: [number],
) => number;
type Transmit = (
  hCard: bigint,
  sendPci: { dwProtocol: number; cbPciLength: number },
  send: Uint8Array,
  sendLen: number,
  recvPci: null,
  outRecv: Uint8Array,
  inoutRecvLen: [number],
) => number;
type GetStatusChange = (
  hContext: bigint,
  timeout: number,
  inoutStates: Array<{
    szReader: string;
    pvUserData: null;
    dwCurrentState: number;
    dwEventState: number;
    cbAtr: number;
    rgbAtr: number[];
  }>,
  count: number,
) => number;

interface PcscApi {
  establishContext: EstablishContext;
  releaseContext: ReleaseContext;
  listReaders: ListReaders;
  connect: Connect;
  disconnect: Disconnect;
  status: Status;
  transmit: Transmit;
  getStatusChange: GetStatusChange;
  ioRequest: { dwProtocol: number; cbPciLength: number };
}

let cachedApi: PcscApi | undefined;

function loadApi(): PcscApi {
  if (cachedApi) return cachedApi;

  const lib = koffi.load(PCSC_PATH);

  koffi.struct("SCARD_IO_REQUEST", {
    dwProtocol: "uint32_t",
    cbPciLength: "uint32_t",
  });

  koffi.struct("SCARD_READERSTATE", {
    szReader: "str",
    pvUserData: "void *",
    dwCurrentState: "uint32_t",
    dwEventState: "uint32_t",
    cbAtr: "uint32_t",
    rgbAtr: koffi.array("uint8_t", MAX_ATR_SIZE),
  });

  cachedApi = {
    establishContext: lib.func(
      "long SCardEstablishContext(uint32_t dwScope, void *pvReserved1, void *pvReserved2, _Out_ intptr_t *phContext)",
    ) as unknown as EstablishContext,
    releaseContext: lib.func(
      "long SCardReleaseContext(intptr_t hContext)",
    ) as unknown as ReleaseContext,
    listReaders: lib.func(
      "long SCardListReaders(intptr_t hContext, const char *mszGroups, _Out_ uint8_t *mszReaders, _Inout_ uint32_t *pcchReaders)",
    ) as unknown as ListReaders,
    connect: lib.func(
      "long SCardConnect(intptr_t hContext, const char *szReader, uint32_t dwShareMode, uint32_t dwPreferredProtocols, _Out_ intptr_t *phCard, _Out_ uint32_t *pdwActiveProtocol)",
    ) as unknown as Connect,
    disconnect: lib.func(
      "long SCardDisconnect(intptr_t hCard, uint32_t dwDisposition)",
    ) as unknown as Disconnect,
    status: lib.func(
      "long SCardStatus(intptr_t hCard, _Out_ uint8_t *szReaderName, _Inout_ uint32_t *pcchReaderLen, _Out_ uint32_t *pdwState, _Out_ uint32_t *pdwProtocol, _Out_ uint8_t *pbAtr, _Inout_ uint32_t *pcbAtrLen)",
    ) as unknown as Status,
    transmit: lib.func(
      "long SCardTransmit(intptr_t hCard, SCARD_IO_REQUEST *pioSendPci, uint8_t *pbSendBuffer, uint32_t cbSendLength, SCARD_IO_REQUEST *pioRecvPci, _Out_ uint8_t *pbRecvBuffer, _Inout_ uint32_t *pcbRecvLength)",
    ) as unknown as Transmit,
    getStatusChange: lib.func(
      "long SCardGetStatusChange(intptr_t hContext, uint32_t dwTimeout, _Inout_ SCARD_READERSTATE *rgReaderStates, uint32_t cReaders)",
    ) as unknown as GetStatusChange,
    ioRequest: { dwProtocol: SCARD_PROTOCOL_T0, cbPciLength: 8 },
  };

  return cachedApi;
}

function check(rc: number): void {
  if (rc >>> 0 !== PCSC.SCARD_S_SUCCESS) {
    throw new PcscError(decodePcscError(rc));
  }
}

export class Pcsc implements PcscPort {
  private readonly api: PcscApi;
  private context: bigint | undefined;

  constructor() {
    this.api = loadApi();
  }

  private hContext(): bigint {
    if (this.context !== undefined) return this.context;

    const ctx: [bigint] = [0n];
    check(this.api.establishContext(0, null, null, ctx));
    this.context = ctx[0];
    return this.context;
  }

  listReaders(): string[] {
    const hContext = this.hContext();
    const needed: [number] = [0];

    const rc = this.api.listReaders(hContext, null, null, needed);
    // SCARD_E_NO_READERS_AVAILABLE is a normal state, not a failure.
    if (rc >>> 0 === PCSC.SCARD_E_NO_READERS_AVAILABLE) return [];
    check(rc);

    if (needed[0] === 0) return [];

    const buf = new Uint8Array(needed[0]);
    const len: [number] = [needed[0]];
    check(this.api.listReaders(hContext, null, buf, len));
    return parseReaderList(buf, len[0]);
  }

  connect(reader: string): PcscHandle {
    const hContext = this.hContext();
    const card: [bigint] = [0n];
    const protocol: [number] = [0];

    let rc = this.api.connect(
      hContext,
      reader,
      SCARD_SHARE_SHARED,
      SCARD_PROTOCOL_T0,
      card,
      protocol,
    );

    // Another process may be holding the card for a moment (CryptoTokenKit).
    if (rc >>> 0 === PCSC.SCARD_E_SHARING_VIOLATION) {
      rc = this.api.connect(
        hContext,
        reader,
        SCARD_SHARE_SHARED,
        SCARD_PROTOCOL_T0,
        card,
        protocol,
      );
    }

    check(rc);
    return card[0];
  }

  status(handle: PcscHandle): ReaderStatus {
    const nameBuf = new Uint8Array(256);
    const nameLen: [number] = [nameBuf.length];
    const state: [number] = [0];
    const protocol: [number] = [0];
    const atrBuf = new Uint8Array(MAX_ATR_SIZE);
    const atrLen: [number] = [MAX_ATR_SIZE];

    check(this.api.status(handle, nameBuf, nameLen, state, protocol, atrBuf, atrLen));

    const reader = new TextDecoder("utf-8")
      .decode(nameBuf.subarray(0, nameLen[0]))
      .replace(/\0+$/, "");

    return {
      state: state[0],
      atr: atrBuf.slice(0, atrLen[0]),
      reader,
      protocol: protocol[0],
    };
  }

  transmit(handle: PcscHandle, apdu: Uint8Array): Uint8Array {
    const recv = new Uint8Array(512);
    const recvLen: [number] = [recv.length];

    check(this.api.transmit(handle, this.api.ioRequest, apdu, apdu.length, null, recv, recvLen));
    return recv.slice(0, recvLen[0]);
  }

  disconnect(handle: PcscHandle): void {
    // Best effort: a card that vanished must not mask the caller's own error.
    try {
      this.api.disconnect(handle, SCARD_LEAVE_CARD);
    } catch {
      // ignore
    }
  }

  waitForChange(reader: string, currentState: number, timeoutMs: number): ReaderChange {
    const hContext = this.hContext();
    const states = [
      {
        szReader: reader,
        pvUserData: null,
        dwCurrentState: currentState,
        dwEventState: 0,
        cbAtr: 0,
        rgbAtr: Array.from<number>({ length: MAX_ATR_SIZE }).fill(0),
      },
    ];

    const rc = this.api.getStatusChange(hContext, timeoutMs, states, states.length);
    const timedOut = rc >>> 0 === PCSC.SCARD_E_TIMEOUT;
    if (!timedOut && rc >>> 0 !== PCSC.SCARD_S_SUCCESS) {
      throw new PcscError(decodePcscError(rc));
    }

    const s = states[0];
    if (!s) throw new PcscError(decodePcscError(PCSC.SCARD_E_INVALID_HANDLE));

    // On timeout the framework does not write dwEventState, so keep the
    // caller's state instead of reporting a bogus 0x00.
    if (timedOut) {
      return {
        changed: false,
        status: { state: currentState, atr: new Uint8Array(), reader, protocol: 0 },
      };
    }

    return {
      changed: (s.dwEventState & 0x0002) !== 0, // SCARD_STATE_CHANGED
      status: {
        state: s.dwEventState,
        atr: Uint8Array.from(s.rgbAtr.slice(0, s.cbAtr)),
        reader,
        protocol: 0,
      },
    };
  }

  release(): void {
    if (this.context === undefined) return;
    try {
      this.api.releaseContext(this.context);
    } catch {
      // ignore
    }
    this.context = undefined;
  }
}

export function eventStateHasCard(eventState: number): boolean {
  return (eventState & SCARD_STATE_PRESENT) !== 0;
}

/** A successful SCardStatus with a non-empty ATR is the reliable presence signal. */
export function statusHasCard(status: ReaderStatus): boolean {
  return status.atr.length > 0;
}
