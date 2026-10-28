/**
 * Composition root. Everything with a side effect is wired here; the
 * modules it wires are testable on their own.
 *
 * Binds to loopback only, and only answers WebSocket handshakes from the
 * dev/prod origins (or whatever ALLOWED_ORIGINS lists).
 */
import { join } from "node:path";
import { AuditLog } from "./audit";
import { Pcsc } from "./pcsc";
import { createApp, createHub, defaultAllowedOrigins } from "./server";
import { CardService } from "./state";

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3000);

const ROOT = join(import.meta.dir, "../..");
const DIST_DIR = join(ROOT, "dist");
const AUDIT_DB = process.env["AUDIT_DB"] ?? join(ROOT, "data", "audit.db");

const ALLOWED_ORIGINS = process.env["ALLOWED_ORIGINS"]
  ? process.env["ALLOWED_ORIGINS"]
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  : defaultAllowedOrigins(PORT, HOST);

const pcsc = new Pcsc();
const audit = new AuditLog({ path: AUDIT_DB });
const hub = createHub();

const service = new CardService({
  pcsc,
  emit: hub.broadcast,
  onOutcome: (outcome) => audit.record(outcome),
});

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  ...createApp({
    hub,
    service,
    audit,
    listReaders: () => pcsc.listReaders(),
    distDir: DIST_DIR,
    allowedOrigins: ALLOWED_ORIGINS,
  }),
});

console.log(`idcard-reader  http://${HOST}:${server.port}`);
console.log(`audit log      ${AUDIT_DB}`);
console.log(`origins        ${ALLOWED_ORIGINS.join(", ")}`);

void service.start();

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down`);
  service.stop();
  server.stop(true);
  audit.close();
  pcsc.release();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
