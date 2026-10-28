/**
 * Privacy guardrail for code that runs against the physical card.
 *
 * A console call must never print a card field. The dev scripts in `spike/`
 * (and anything under `src/`) run against a real card, and terminal output
 * tends to end up in shell logs, CI logs and bug reports. The rule is blunt:
 * compute the structural fact first (length, boolean, known prefix) and
 * print that, never `card.<field>`.
 *
 * This is a grep-level check, not a type-system guarantee: someone can
 * launder a value through a local. Its job is to stop the accidental
 * regression the review found, in the same file the regression happened.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIRS = ["src", "spike"] as const;

/** Walks `console.x(...)` with a bracket counter that ignores quoted text. */
function consoleCalls(source: string): { text: string; line: number }[] {
  const calls: { text: string; line: number }[] = [];
  const marker = /console\s*\.\s*(?:log|warn|error|info|debug|trace)\s*\(/g;

  for (const match of source.matchAll(marker)) {
    const start = match.index ?? 0;
    let i = start + match[0].length;
    let depth = 1;
    let quote: string | null = null;

    while (i < source.length && depth > 0) {
      const ch = source[i]!;

      if (quote !== null) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === "/" && source[i + 1] === "/") {
        const newline = source.indexOf("\n", i);
        i = newline === -1 ? source.length : newline;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }

    calls.push({
      text: source.slice(start, i),
      line: source.slice(0, start).split("\n").length,
    });
  }

  return calls;
}

const PROPERTY_ACCESS = /\bcard\s*\./;
const BARE_ARGUMENT = /[(,]\s*card\s*[,)]/;
const BARE_INTERPOLATION = /\$\{\s*card\s*\}/;
const CITIZEN_ID_RUN = /\d{13}/;

function violationsIn(source: string): string[] {
  const found: string[] = [];
  for (const call of consoleCalls(source)) {
    if (PROPERTY_ACCESS.test(call.text)) {
      found.push(`line ${call.line}: prints a card field: ${call.text.slice(0, 120)}`);
    }
    if (BARE_ARGUMENT.test(call.text) || BARE_INTERPOLATION.test(call.text)) {
      found.push(`line ${call.line}: prints the whole card: ${call.text.slice(0, 120)}`);
    }
    if (CITIZEN_ID_RUN.test(call.text)) {
      found.push(`line ${call.line}: contains a 13-digit run: ${call.text.slice(0, 120)}`);
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function allViolations(): { file: string; problems: string[] }[] {
  const results: { file: string; problems: string[] }[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const problems = violationsIn(readFileSync(file, "utf8"));
      if (problems.length > 0) {
        results.push({ file: relative(ROOT, file), problems });
      }
    }
  }
  return results;
}

describe("console output", () => {
  test("never prints a card field or a citizen id", () => {
    expect(allViolations()).toEqual([]);
  });
});

describe("the guardrail itself", () => {
  test("finds card-field prints", () => {
    expect(violationsIn("console.log(card.firstName);")).toHaveLength(1);
    expect(violationsIn("console.log(`name: ${card.nameTh.firstName}`);")).toHaveLength(1);
  });

  test("finds the whole card", () => {
    expect(violationsIn("console.log(card);")).toHaveLength(1);
    expect(violationsIn("console.log('card', card);")).toHaveLength(1);
    expect(violationsIn("console.log(`card ${card}`);")).toHaveLength(1);
  });

  test("finds a hard-coded citizen id", () => {
    expect(violationsIn("console.log('1101700203456');")).toHaveLength(1);
  });

  test("allows structural facts and labels", () => {
    const ok = `
      console.log(\`  card       : \${present ? "present" : "absent"}\`);
      console.log(\`citizenId  : length=\${cidLength}, digits13=\${ok(cidIsDigits)}\`);
      console.log(\`photo      : \${photoBytes} bytes\`);
    `;
    expect(violationsIn(ok)).toEqual([]);
  });

  test("is not vacuous: it sees the real console calls", () => {
    const calls = consoleCalls(readFileSync(join(ROOT, "src/server/pcsc-cli.ts"), "utf8"));
    expect(calls.length).toBeGreaterThan(0);
  });
});
