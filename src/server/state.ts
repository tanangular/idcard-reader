/**
 * The server-owned card state machine.
 *
 * Everything the UI shows is derived from `CardState`; the client only
 * renders. The loop is intentionally boring: ask PC/SC what is in the
 * reader, and if a card is sitting there and we have not read it yet, read
 * it. Reads are serialised through `inFlight` so a manual `card.read` never
 * races an automatic one.
 *
 * The PC/SC port and the reader are injected, so the whole machine is
 * exercised from a fake port in tests without hardware.
 */
import { appError, PcscError } from "./errors";
import {
  eventStateHasCard,
  formatAtr,
  type PcscHandle,
  type PcscPort,
  type ReaderChange,
} from "./pcsc";
import { readThaiIdCard } from "./thai-card";
import type { AppError, AppErrorCode, ReaderState, ServerMsg, ThaiIdCard } from "#shared/protocol";

/** The reader is a function so tests can supply a card without bytes. */
export type CardReader = typeof readThaiIdCard;

export interface CardState {
  phase: ReaderState;
  /** Reader currently being watched, when there is one. */
  reader: string | null;
  /** Every reader PC/SC reports. */
  readers: string[];
  /** In-memory snapshot. Cleared the moment the card leaves the reader. */
  card: ThaiIdCard | null;
  error: AppError | null;
}

/** What the audit log needs. `citizenId` must be hashed before it is stored. */
export interface ReadOutcome {
  reader: string;
  at: Date;
  durationMs: number;
  /** Present only on success. Never log or persist this. */
  citizenId: string | null;
  errorCode: AppErrorCode | null;
}

export type ReadResult = { ok: true; card: ThaiIdCard } | { ok: false; error: AppError };

export interface CardServiceOptions {
  pcsc: PcscPort;
  /** Defaults to the real APDU reader. */
  readCard?: CardReader;
  emit?: (msg: ServerMsg) => void;
  onOutcome?: (outcome: ReadOutcome) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

const DEFAULT_POLL_MS = 500;

/**
 * Map anything thrown by the card layer onto a UI-safe error.
 *
 * Never use `error.message`: a parser message could echo card bytes, and a
 * Thai name or citizen id must not reach a log through an error path.
 */
function toAppError(error: unknown): AppError {
  if (error instanceof PcscError) return error.app;
  if (error instanceof Error && error.name === "CdeParseError") {
    return appError("PARSE_FAILED");
  }
  return appError("UNKNOWN");
}

export class CardService {
  private readonly pcsc: PcscPort;
  private readonly readCard: CardReader;
  private readonly emitMsg: ((msg: ServerMsg) => void) | undefined;
  private readonly onOutcome: ((outcome: ReadOutcome) => void) | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;

  private state: CardState = {
    phase: "no-reader",
    reader: null,
    readers: [],
    card: null,
    error: null,
  };

  /** ATR of the card the current snapshot or error belongs to. */
  private lastAtrHex: string | null = null;
  private inFlight: Promise<ReadResult> | null = null;
  private running = false;

  constructor(options: CardServiceOptions) {
    this.pcsc = options.pcsc;
    this.readCard = options.readCard ?? readThaiIdCard;
    this.emitMsg = options.emit;
    this.onOutcome = options.onOutcome;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  getState(): CardState {
    return { ...this.state, readers: [...this.state.readers] };
  }

  /** Poll until `stop()`. Safe to call once; resolves when stopped. */
  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch {
        // A single bad poll must not kill the loop; the next one retries.
      }
      if (!this.running) break;
      await this.sleep(this.pollMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  /** One polling iteration. Exposed so tests can drive it deterministically. */
  async tick(): Promise<void> {
    if (this.inFlight) return;

    const readers = this.listReaders();
    const reader = readers[0];

    if (!reader) {
      this.announceRemoval();
      this.lastAtrHex = null;
      this.update({ phase: "no-reader", reader: null, readers, card: null, error: null });
      return;
    }

    let change: ReaderChange;
    try {
      // Ask for the *current* state every tick; a zero timeout with an
      // unchanged `dwCurrentState` reports SCARD_E_TIMEOUT and leaves the
      // ATR empty, which is exactly how a swap between two polls hides.
      change = this.pcsc.waitForChange(reader, 0, 0);
    } catch {
      // The reader vanished between listing and polling.
      this.announceRemoval();
      this.lastAtrHex = null;
      this.update({ phase: "no-reader", reader: null, readers, card: null, error: null });
      return;
    }

    if (!eventStateHasCard(change.status.state)) {
      this.announceRemoval();
      this.lastAtrHex = null;
      this.update({ phase: "waiting-card", reader, readers, card: null, error: null });
      return;
    }

    const atrHex = change.status.atr.length > 0 ? formatAtr(change.status.atr) : null;

    if (this.state.phase === "ready" || this.state.phase === "error") {
      // A different ATR without an observed removal means the card was
      // swapped between polls; the old snapshot (or old error) must not stay
      // on screen. A failed card stays failed while its ATR is unchanged,
      // otherwise a broken card would be re-read every 500 ms.
      if (atrHex !== null && atrHex !== this.lastAtrHex) {
        this.announceRemoval();
        await this.read(reader, readers);
        return;
      }
      this.update({ readers });
      return;
    }

    await this.read(reader, readers);
  }

  /**
   * Client-requested read. Returns the in-flight attempt when one is already
   * running so two reads never talk to the card at once.
   */
  async readNow(): Promise<ReadResult> {
    if (this.inFlight) return this.inFlight;

    const readers = this.listReaders();
    const reader = readers[0];

    if (!reader) {
      const error = appError("NO_READER");
      this.lastAtrHex = null;
      this.update({ phase: "no-reader", reader: null, readers, card: null, error });
      return { ok: false, error };
    }

    try {
      const change = this.pcsc.waitForChange(reader, 0, 0);

      if (!eventStateHasCard(change.status.state)) {
        const error = appError("NO_CARD");
        this.lastAtrHex = null;
        this.update({ phase: "waiting-card", reader, readers, card: null, error });
        this.emit({ type: "card.error", error });
        return { ok: false, error };
      }
    } catch (error) {
      const app = toAppError(error);
      this.update({ phase: "no-reader", reader: null, readers, card: null, error: app });
      return { ok: false, error: app };
    }

    return this.read(reader, readers);
  }

  private read(reader: string, readers: string[]): Promise<ReadResult> {
    if (this.inFlight) return this.inFlight;
    const attempt = this.doRead(reader, readers).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = attempt;
    return attempt;
  }

  private async doRead(reader: string, readers: string[]): Promise<ReadResult> {
    this.lastAtrHex = null;
    this.update({ phase: "reading", reader, readers, card: null, error: null });
    this.emit({ type: "card.inserted", reader });

    const startedAt = this.now().getTime();
    const at = this.now();
    let handle: PcscHandle | undefined;

    try {
      handle = this.pcsc.connect(reader);
      const status = this.pcsc.status(handle);
      if (status.atr.length === 0) throw new PcscError(appError("NO_CARD"));

      const atrHex = formatAtr(status.atr);
      // Remember the ATR before the conversation: a parse failure still
      // identifies which card is in the reader, so a replacement can be
      // detected without observing the removal.
      this.lastAtrHex = atrHex;
      const card = this.readCard(
        { atrHex, transmit: (apdu) => this.pcsc.transmit(handle!, apdu) },
        {
          now: this.now,
          onProgress: (step, pct) => this.emit({ type: "card.progress", step, pct }),
        },
      );

      this.update({ phase: "ready", reader, readers, card, error: null });
      this.emit({ type: "card.snapshot", card });
      this.reportOutcome({
        reader,
        at,
        durationMs: this.now().getTime() - startedAt,
        citizenId: card.citizenId,
        errorCode: null,
      });
      return { ok: true, card };
    } catch (error) {
      const app = toAppError(error);
      const cardIsGone = app.code === "CARD_REMOVED" || app.code === "NO_CARD";

      if (cardIsGone) {
        this.lastAtrHex = null;
      }

      this.update({
        phase: cardIsGone ? "waiting-card" : "error",
        reader,
        readers,
        card: null,
        error: app,
      });
      this.emit({ type: "card.error", error: app });
      this.reportOutcome({
        reader,
        at,
        durationMs: this.now().getTime() - startedAt,
        citizenId: null,
        errorCode: app.code,
      });
      return { ok: false, error: app };
    } finally {
      if (handle !== undefined) this.pcsc.disconnect(handle);
    }
  }

  private listReaders(): string[] {
    try {
      return this.pcsc.listReaders();
    } catch {
      return [];
    }
  }

  private announceRemoval(): void {
    const { card, reader } = this.state;
    if (card !== null && reader !== null) {
      this.emit({ type: "card.removed", reader });
    }
  }

  private update(patch: Partial<CardState>): void {
    const prev = this.state;
    const next: CardState = { ...prev, ...patch };
    const changed =
      next.phase !== prev.phase ||
      next.reader !== prev.reader ||
      next.readers.length !== prev.readers.length ||
      next.readers.some((name, i) => name !== prev.readers[i]);

    this.state = next;
    if (changed) {
      this.emit({ type: "reader.state", state: next.phase, readers: [...next.readers] });
    }
  }

  private emit(msg: ServerMsg): void {
    try {
      this.emitMsg?.(msg);
    } catch {
      // A closed socket must not stop the poll loop.
    }
  }

  private reportOutcome(outcome: ReadOutcome): void {
    try {
      this.onOutcome?.(outcome);
    } catch {
      // Auditing is best effort; a full disk must not fail a good read.
    }
  }
}
