/**
 * HTTP + WebSocket surface. Kept separate from `main.ts` so tests can start
 * a real server on port 0 with stubbed card/audit sources.
 *
 * Two security rules live here:
 *  - a WebSocket upgrade from a browser origin that is not allowlisted is
 *    refused before the socket is created;
 *  - a static request can never resolve outside `distDir`.
 */
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { appError, PcscError } from "./errors.ts";
import { parseClientMsg } from "../shared/protocol.ts";
import type { AppError, AuditRow, ServerMsg } from "../shared/protocol.ts";
import type { CardState, ReadResult } from "./state.ts";

/** Where the browser client is served from in dev. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
];

/**
 * True when the handshake may proceed.
 *
 * Browsers always send `Origin` on a WebSocket handshake, so a page from
 * another origin is refused. A missing Origin can only come from a
 * non-browser client (wscat, a test), which already has local access — it is
 * allowed so the documented `wscat` check keeps working.
 */
export function isOriginAllowed(origin: string | null, allowed: readonly string[]): boolean {
  if (origin === null) return true;
  return allowed.includes(origin);
}

/**
 * Resolve a URL path against `root`, refusing anything that escapes it.
 *
 * Percent-decoding happens first, so `%2e%2e` cannot sneak past the check,
 * and a NUL byte or a broken escape is rejected outright.
 */
export function safeJoin(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) return null;

  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, "." + decoded);

  if (candidate === resolvedRoot) return candidate;
  if (!candidate.startsWith(resolvedRoot + sep)) return null;
  return candidate;
}

export interface ClientHub {
  add(socket: Bun.ServerWebSocket<undefined>): void;
  remove(socket: Bun.ServerWebSocket<undefined>): void;
  send(socket: Bun.ServerWebSocket<undefined>, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  size(): number;
}

/**
 * Fan-out to every connected client. A socket that throws on `send` is
 * dropped instead of failing the caller — a read must not fail because one
 * browser tab went away.
 */
export function createHub(): ClientHub {
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();

  function send(socket: Bun.ServerWebSocket<undefined>, msg: ServerMsg): void {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      sockets.delete(socket);
    }
  }

  return {
    add(socket) {
      sockets.add(socket);
    },
    remove(socket) {
      sockets.delete(socket);
    },
    send,
    broadcast(msg) {
      const text = JSON.stringify(msg);
      for (const socket of sockets) {
        try {
          socket.send(text);
        } catch {
          sockets.delete(socket);
        }
      }
    },
    size() {
      return sockets.size;
    },
  };
}

export interface CardSource {
  getState(): CardState;
  readNow(): Promise<ReadResult>;
}

export interface HistorySource {
  list(limit: number, offset: number): { rows: AuditRow[]; total: number };
}

/** The bit of Bun's server object `fetch` needs. */
export interface UpgradeServer {
  upgrade(request: Request): boolean;
}

export interface AppOptions {
  hub: ClientHub;
  service: CardSource;
  audit: HistorySource;
  listReaders: () => string[];
  distDir: string;
  allowedOrigins: readonly string[];
}

function toAppError(error: unknown): AppError {
  return error instanceof PcscError ? error.app : appError("UNKNOWN");
}

const DEV_HINT = `<!doctype html>
<html lang="th"><meta charset="utf-8"><title>ยังไม่มี build</title>
<body style="font-family:system-ui;padding:2rem;line-height:1.6">
<h1>ยังไม่มี <code>dist/</code></h1>
<p>โหมด dev: เปิด <a href="http://localhost:5173">http://localhost:5173</a></p>
<p>โหมด production: รัน <code>bun run build</code> แล้วเริ่มเซิร์ฟเวอร์ใหม่</p>
</body></html>`;

function cacheHeaders(pathname: string): Record<string, string> {
  return pathname.startsWith("/assets/")
    ? { "cache-control": "public, max-age=31536000, immutable" }
    : { "cache-control": "no-cache" };
}

async function serveFile(path: string, pathname: string): Promise<Response | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
  } catch {
    return null;
  }
  return new Response(Bun.file(path), { headers: cacheHeaders(pathname) });
}

async function serveIndex(distDir: string): Promise<Response> {
  const index = join(distDir, "index.html");
  try {
    if ((await stat(index)).isFile()) {
      return new Response(Bun.file(index), {
        headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
      });
    }
  } catch {
    // No build yet: fall through to the hint.
  }
  return new Response(DEV_HINT, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function createApp(options: AppOptions) {
  const { hub, service, audit, listReaders, distDir, allowedOrigins } = options;

  async function fetch(request: Request, server: UpgradeServer): Promise<Response | undefined> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (!isOriginAllowed(request.headers.get("origin"), allowedOrigins)) {
        return new Response("forbidden origin", { status: 403 });
      }
      if (server.upgrade(request)) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const filePath = safeJoin(distDir, url.pathname);
    if (filePath !== null) {
      const served = await serveFile(filePath, url.pathname);
      if (served !== null) return served;
    }

    return serveIndex(distDir);
  }

  const websocket: Bun.WebSocketHandler<undefined> = {
    open(socket) {
      hub.add(socket);
      const state = service.getState();
      hub.send(socket, { type: "reader.state", state: state.phase, readers: state.readers });
      if (state.card !== null) {
        hub.send(socket, { type: "card.snapshot", card: state.card });
      }
    },

    async message(socket, raw) {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed = parseClientMsg(text);
      if (!parsed.ok) {
        // Reason only: the payload is untrusted and never worth echoing.
        console.warn(`ws: dropped frame (${parsed.reason})`);
        return;
      }

      const msg = parsed.msg;

      switch (msg.type) {
        case "readers.list": {
          try {
            hub.send(socket, {
              id: msg.id,
              type: "readers.list",
              ok: true,
              readers: listReaders(),
            });
          } catch (error) {
            hub.send(socket, {
              id: msg.id,
              type: "readers.list",
              ok: false,
              error: toAppError(error),
            });
          }
          return;
        }

        case "card.read": {
          const result = await service.readNow();
          hub.send(
            socket,
            result.ok
              ? { id: msg.id, type: "card.read", ok: true, card: result.card }
              : { id: msg.id, type: "card.read", ok: false, error: result.error },
          );
          return;
        }

        case "history.list": {
          try {
            const page = audit.list(msg.limit, msg.offset);
            hub.send(socket, {
              id: msg.id,
              type: "history.list",
              ok: true,
              rows: page.rows,
              total: page.total,
            });
          } catch {
            hub.send(socket, {
              id: msg.id,
              type: "history.list",
              ok: false,
              error: appError("UNKNOWN"),
            });
          }
        }
      }
    },

    close(socket) {
      hub.remove(socket);
    },
  };

  return { fetch, websocket };
}
