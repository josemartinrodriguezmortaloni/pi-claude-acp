import { describe, expect, it } from "vitest";
import { localeFrom, type Messages, messagesFor } from "../src/messages.ts";

describe("localeFrom", () => {
  it("reads the language of LANG", () => {
    expect(localeFrom({ LANG: "es_AR.UTF-8" }, "en-US")).toBe("es");
  });

  it("prefers LC_ALL, then LC_MESSAGES, over LANG", () => {
    expect(localeFrom({ LC_ALL: "es_ES.UTF-8", LANG: "en_US.UTF-8" }, "en-US")).toBe("es");
    expect(localeFrom({ LC_MESSAGES: "en_GB", LANG: "es_AR" }, "es-AR")).toBe("en");
  });

  it("skips empty variables", () => {
    expect(localeFrom({ LC_ALL: "", LANG: "es_MX" }, "en-US")).toBe("es");
  });

  it("falls back to the Intl locale when no variable is set", () => {
    expect(localeFrom({}, "es-419")).toBe("es");
  });

  it("uses English for C, POSIX and languages without a catalog", () => {
    expect(localeFrom({ LANG: "C.UTF-8" }, "es-AR")).toBe("en");
    expect(localeFrom({ LANG: "POSIX" }, "es-AR")).toBe("en");
    expect(localeFrom({ LANG: "fr_FR.UTF-8" }, "es-AR")).toBe("en");
  });
});

/** Every message rendered with sample arguments. */
function rendered(messages: Messages): [string, string][] {
  return Object.entries(messages).map(([key, value]) => [
    key,
    typeof value === "function" ? String(value("X", "Y", ["a", "b"])) : String(value),
  ]);
}

/** Setup errors must name the binary the user has to install or point to. */
const NAMES_THE_BINARY = new Set(["binaryNotFound", "binaryNotExecutable", "notTheBinary"]);

describe.each(["en", "es"] as const)("messagesFor(%s)", (locale) => {
  const messages = messagesFor(locale);

  it("never names the agent outside setup errors", () => {
    const leaks = rendered(messages).filter(
      ([key, text]) => !NAMES_THE_BINARY.has(key) && text.includes("Claude Code"),
    );
    expect(leaks).toEqual([]);
  });

  it("titles a permission dialog with the tool and what it acts on", () => {
    expect(messages.permissionTitle("Bash", "rm -rf build")).toBe("Bash · rm -rf build");
    expect(messages.permissionTitle("Read", "")).toBe("Read");
  });
});

describe("hiddenLines", () => {
  it.each([
    ["en", 1, "… (+1 line)"],
    ["en", 7, "… (+7 lines)"],
    ["es", 1, "… (+1 línea)"],
    ["es", 7, "… (+7 líneas)"],
  ] as const)("%s counts %i hidden lines", (locale, count, expected) => {
    expect(messagesFor(locale).hiddenLines(count)).toBe(expected);
  });
});
