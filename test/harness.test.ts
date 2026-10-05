import { describe, expect, it } from "vitest";
import { hiddenTools } from "../src/harness.ts";

describe("hiddenTools", () => {
  it("C41: reads the patterns of claudeAcp.hiddenTools", () => {
    expect(hiddenTools({ claudeAcp: { hiddenTools: ["mem_*", "query-docs"] } })).toEqual([
      "mem_*",
      "query-docs",
    ]);
  });

  it("C41: hides nothing without the key, or with a value that is not a list of names", () => {
    expect(hiddenTools({})).toEqual([]);
    expect(hiddenTools({ claudeAcp: { hiddenTools: "mem_*" } })).toEqual([]);
    expect(hiddenTools({ claudeAcp: { hiddenTools: ["mem_*", 3] } })).toEqual(["mem_*"]);
  });
});
