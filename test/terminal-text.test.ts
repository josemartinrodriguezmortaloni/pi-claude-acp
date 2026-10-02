import { describe, expect, it } from "vitest";
import { printable, printableJson } from "../src/terminal-text.ts";

describe("printable", () => {
  it("drops escape sequences and control characters, and keeps tabs, newlines and text", () => {
    const text =
      "a\tb\n\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\r\u0000\u009bz";
    expect(printable(text)).toBe("a\tb\nredlinkz");
  });
});

describe("printableJson", () => {
  it("cleans every string inside nested objects and arrays, and keeps the rest", () => {
    const value = { tools: [{ name: "Bash", output: "x\u001b[2Jy", outputLines: 1 }], ok: true };
    expect(printableJson(value)).toEqual({
      tools: [{ name: "Bash", output: "xy", outputLines: 1 }],
      ok: true,
    });
  });
});
