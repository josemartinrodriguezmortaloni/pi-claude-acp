import { describe, expect, it } from "vitest";
import { buildContextBlock, skillsFromCommands } from "../src/context-block.ts";

describe("buildContextBlock", () => {
  it("joins the global and project AGENTS.md with the Pi skills list", () => {
    const block = buildContextBlock({
      globalAgents: "reglas globales",
      projectAgents: "reglas del proyecto",
      skills: [{ name: "tdd", description: "Test first", path: "/skills/tdd/SKILL.md" }],
    });
    expect(block).toContain("reglas globales");
    expect(block).toContain("reglas del proyecto");
    expect(block).toContain("tdd: Test first (/skills/tdd/SKILL.md)");
  });

  it("omits the sections that have no content", () => {
    const block = buildContextBlock({ skills: [] });
    expect(block).not.toContain("AGENTS.md");
    expect(block).not.toContain("Skills");
  });
});

describe("skillsFromCommands", () => {
  it("lists the Pi skills with their SKILL.md path", () => {
    const source = { source: "local", scope: "user", origin: "top-level" } as const;
    expect(
      skillsFromCommands([
        {
          name: "skill:tdd",
          description: "Test first",
          source: "skill",
          sourceInfo: { ...source, path: "/s/SKILL.md" },
        },
        { name: "review", source: "prompt", sourceInfo: { ...source, path: "/p.md" } },
      ]),
    ).toEqual([{ name: "tdd", description: "Test first", path: "/s/SKILL.md" }]);
  });
});
