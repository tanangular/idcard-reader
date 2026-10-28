/**
 * The browser's single WebSocket to the card service.
 *
 * The server owns the state; this module mirrors the pushes it receives into
 * Solid signals and correlates request/response pairs by id. If the socket
 * drops it reconnects with exponential backoff (500 ms → 10 s) and clears
 * the in-memory card, because the card may have left the reader while the
 * browser was offline.
 *
 * The transport is injected so the whole thing is testable with a fake
 * socket and a fake clock — no server, no timers, no hardware.
 */
import { createSignal, type Accessor } from "solid-js";
import type {
  AppError,
  ProgressStep,
  ReaderState,
  ServerMsg,
  ThaiIdCard,
} from "../shared/protocol.ts";

/** The slice of the browser WebSocket this client uses. */
export interface SocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

/** Injectable clock, so backoff and request timeouts are testable. */
export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export type ClientErrorCode = "OFFLINE" | "TIMEOUT" | "DISPOSED";

/** A failure that happened in the browser, not on the card. */
export class ClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

export interface Progress {
  step: ProgressStep;
  pct: number;
}

type RequestPayload =
  | { type: "readers.list" }
  | { type: "card.read" }
  | { type: "history.list"; limit: number; offset: number };

type ReplyFor<T extends ServerMsg["type"]> = Extract<ServerMsg, { type: T }>;

type ReplyOf<M extends RequestPayload> = ReplyFor<M["type"]>;

export interface CardClient {
  connected: Accessor<boolean>;
  phase: Accessor<ReaderState>;
  readers: Accessor<string[]>;
  card: Accessor<ThaiIdCard | null>;
  progress: Accessor<Progress | null>;
  error: Accessor<AppError | null>;

  connect(): void;
  dispose(): void;

  request<M extends RequestPayload>(msg: M): Promise<ReplyOf<M>>;
  listReaders(): Promise<ReplyFor<"readers.list">>;
  readCard(): Promise<ReplyFor<"card.read">>;
  listHistory(limit: number, offset: number): Promise<ReplyFor<"history.list">>;
}

export interface CardClientOptions {
  url: string;
  makeSocket?: (url: string) => SocketLike;
  timer?: Timer;
  retryBaseMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve(msg: ServerMsg): void;
  reject(error: ClientError): void;
  handle: unknown;
}

const defaultMakeSocket = (url: string): SocketLike => new WebSocket(url);

const defaultTimer: Timer = {
  set(fn, ms) {
    return setTimeout(fn, ms);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const OFFLINE_MESSAGE = "ยังไม่ได้เชื่อมต่อกับเซิร์ฟเวอร์";
const DISPOSED_MESSAGE = "ไคลเอนต์ถูกปิดแล้ว";
const TIMEOUT_MESSAGE = "เซิร์ฟเวอร์ไม่ตอบสนองภายในเวลาที่กำหนด";

export function createCardClient(options: CardClientOptions): CardClient {
  const {
    url,
    makeSocket = defaultMakeSocket,
    timer = defaultTimer,
    retryBaseMs = 500,
    retryMaxMs = 10_000,
    requestTimeoutMs = 10_000,
  } = options;

  const [connected, setConnected] = createSignal(false);
  const [phase, setPhase] = createSignal<ReaderState>("no-reader");
  const [readers, setReaders] = createSignal<string[]>([]);
  const [card, setCard] = createSignal<ThaiIdCard | null>(null);
  const [progress, setProgress] = createSignal<Progress | null>(null);
  const [error, setError] = createSignal<AppError | null>(null);

  const pending = new Map<string, Pending>();

  let socket: SocketLike | null = null;
  let retryTimer: unknown = null;
  let attempt = 0;
  let started = false;
  let open = false;
  let disposed = false;
  let nextId = 0;

  function rejectPending(code: ClientErrorCode, message: string): void {
    for (const entry of pending.values()) {
      timer.clear(entry.handle);
      entry.reject(new ClientError(code, message));
    }
    pending.clear();
  }

  function applyPush(msg: ServerMsg): void {
    switch (msg.type) {
      case "reader.state":
        setPhase(msg.state);
        setReaders(msg.readers);
        if (msg.state !== "ready") setCard(null);
        if (msg.state !== "reading") setProgress(null);
        if (msg.state === "reading" || msg.state === "waiting-card" || msg.state === "no-reader") {
          setError(null);
        }
        return;

      case "card.snapshot":
        setCard(msg.card);
        setPhase("ready");
        setProgress(null);
        setError(null);
        return;

      case "card.inserted":
        setCard(null);
        setProgress(null);
        setError(null);
        return;

      case "card.removed":
        setCard(null);
        setProgress(null);
        return;

      case "card.progress":
        setProgress({ step: msg.step, pct: msg.pct });
        return;

      case "card.error":
        setError(msg.error);
        setProgress(null);
        return;

      default:
        // RPC replies are handled by id before this point.
        return;
    }
  }

  function onFrame(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;
    if (typeof (parsed as { type?: unknown }).type !== "string") return;

    const msg = parsed as ServerMsg;
    if ("id" in msg && typeof msg.id === "string") {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      timer.clear(entry.handle);
      entry.resolve(msg);
      return;
    }

    applyPush(msg);
  }

  function onDisconnected(): void {
    open = false;
    setConnected(false);
    setCard(null);
    setProgress(null);
    rejectPending("OFFLINE", "การเชื่อมต่อกับเซิร์ฟเวอร์ขาดหาย");
  }

  function scheduleReconnect(): void {
    if (disposed || !started || retryTimer !== null) return;

    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt);
    attempt += 1;
    retryTimer = timer.set(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (disposed || socket !== null) return;
    started = true;

    let next: SocketLike;
    try {
      next = makeSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;

    next.addEventListener("open", () => {
      if (socket !== next) return;
      attempt = 0;
      open = true;
      setConnected(true);
    });

    next.addEventListener("message", (event) => {
      if (socket !== next) return;
      onFrame(event.data);
    });

    next.addEventListener("close", () => {
      if (socket !== next) return;
      socket = null;
      onDisconnected();
      scheduleReconnect();
    });

    // A browser fires close after error; closing here makes that explicit and
    // covers runtimes that only report the error.
    next.addEventListener("error", () => {
      if (socket !== next) return;
      try {
        next.close();
      } catch {
        // Already closed: the close handler owns the reconnect.
      }
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    started = false;

    if (retryTimer !== null) {
      timer.clear(retryTimer);
      retryTimer = null;
    }

    rejectPending("DISPOSED", DISPOSED_MESSAGE);

    const current = socket;
    socket = null;
    open = false;
    if (current !== null) {
      try {
        current.close();
      } catch {
        // Closing twice is harmless.
      }
    }
    setConnected(false);
  }

  function request<M extends RequestPayload>(msg: M): Promise<ReplyOf<M>> {
    if (disposed) return Promise.reject(new ClientError("DISPOSED", DISPOSED_MESSAGE));

    const current = socket;
    if (!open || current === null) {
      return Promise.reject(new ClientError("OFFLINE", OFFLINE_MESSAGE));
    }

    const id = `c${++nextId}`;
    const frame = JSON.stringify({ ...msg, id });

    return new Promise<ServerMsg>((resolve, reject) => {
      const handle = timer.set(() => {
        pending.delete(id);
        reject(new ClientError("TIMEOUT", TIMEOUT_MESSAGE));
      }, requestTimeoutMs);

      pending.set(id, { resolve, reject, handle });

      try {
        current.send(frame);
      } catch {
        pending.delete(id);
        timer.clear(handle);
        reject(new ClientError("OFFLINE", "ส่งคำขอไปยังเซิร์ฟเวอร์ไม่สำเร็จ"));
      }
    }) as Promise<ReplyOf<M>>;
  }

  return {
    connected,
    phase,
    readers,
    card,
    progress,
    error,
    connect,
    dispose,
    request,
    listReaders: () => request({ type: "readers.list" }),
    readCard: () => request({ type: "card.read" }),
    listHistory: (limit, offset) => request({ type: "history.list", limit, offset }),
  };
}

/** Same-origin socket, so it works behind the Vite proxy and in production. */
function defaultSocketUrl(): string {
  const secure = typeof location !== "undefined" && location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${location.host}/ws`;
}

let shared: CardClient | undefined;

/** The app-wide client. Components must not create their own sockets. */
export function getClient(): CardClient {
  shared ??= createCardClient({ url: defaultSocketUrl() });
  return shared;
}
