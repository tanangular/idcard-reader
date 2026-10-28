import { describe, expect, test } from "bun:test";
import { MAX_HISTORY_LIMIT, parseClientMsg } from "#shared/protocol";

describe("parseClientMsg", () => {
  test("accepts readers.list", () => {
    const res = parseClientMsg(JSON.stringify({ id: "1", type: "readers.list" }));
    expect(res).toEqual({ ok: true, msg: { id: "1", type: "readers.list" } });
  });

  test("accepts card.read", () => {
    const res = parseClientMsg(JSON.stringify({ id: "2", type: "card.read" }));
    expect(res).toEqual({ ok: true, msg: { id: "2", type: "card.read" } });
  });

  test("accepts history.list with valid paging", () => {
    const res = parseClientMsg(
      JSON.stringify({ id: "3", type: "history.list", limit: 20, offset: 40 }),
    );
    expect(res).toEqual({
      ok: true,
      msg: { id: "3", type: "history.list", limit: 20, offset: 40 },
    });
  });

  test("rejects malformed JSON", () => {
    const res = parseClientMsg("{not json");
    expect(res.ok).toBe(false);
  });

  test("rejects JSON that is not an object", () => {
    for (const raw of ["42", "null", '"str"', "[]"]) {
      expect(parseClientMsg(raw).ok).toBe(false);
    }
  });

  test("rejects unknown message type", () => {
    const res = parseClientMsg(JSON.stringify({ id: "1", type: "card.delete" }));
    expect(res.ok).toBe(false);
  });

  test("rejects missing or empty id", () => {
    for (const msg of [
      { type: "readers.list" },
      { id: "", type: "readers.list" },
      { id: 5, type: "readers.list" },
    ]) {
      expect(parseClientMsg(JSON.stringify(msg)).ok).toBe(false);
    }
  });

  test("rejects history.list limit outside 1..MAX", () => {
    for (const limit of [0, -1, MAX_HISTORY_LIMIT + 1, 1.5]) {
      const res = parseClientMsg(
        JSON.stringify({ id: "1", type: "history.list", limit, offset: 0 }),
      );
      expect(res.ok).toBe(false);
    }
  });

  test("rejects negative or fractional offset", () => {
    for (const offset of [-1, 0.5]) {
      const res = parseClientMsg(
        JSON.stringify({ id: "1", type: "history.list", limit: 10, offset }),
      );
      expect(res.ok).toBe(false);
    }
  });

  test("rejects history.list with missing paging fields", () => {
    expect(parseClientMsg(JSON.stringify({ id: "1", type: "history.list" })).ok).toBe(false);
  });

  test("ignores unknown extra fields", () => {
    const res = parseClientMsg(JSON.stringify({ id: "1", type: "readers.list", extra: true }));
    expect(res).toEqual({ ok: true, msg: { id: "1", type: "readers.list" } });
  });
});

describe("MAX_HISTORY_LIMIT", () => {
  test("is a positive integer", () => {
    expect(Number.isInteger(MAX_HISTORY_LIMIT)).toBe(true);
    expect(MAX_HISTORY_LIMIT).toBeGreaterThan(0);
  });
});
