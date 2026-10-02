import { join } from "node:path";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { readOptional } from "./files.ts";

export interface SkillInfo {
  name: string;
  description?: string;
  path: string;
}

export interface ContextSources {
  globalAgents?: string;
  projectAgents?: string;
  skills: SkillInfo[];
}

/** The Pi context the first prompt of an ACP session carries. A text for the agent: it stays in English. */
export function buildContextBlock(sources: ContextSources): string {
  const sections = [
    section("Pi's global AGENTS.md", sources.globalAgents),
    section("Project AGENTS.md", sources.projectAgents),
    section("Pi skills (read the SKILL.md before you use one)", skillLines(sources.skills)),
  ].filter(Boolean);
  return ["<pi-context>", ...sections, "</pi-context>"].join("\n\n");
}

function section(title: string, body: string | undefined): string {
  return body?.trim() ? `## ${title}\n\n${body.trim()}` : "";
}

function skillLines(skills: SkillInfo[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description ?? ""} (${skill.path})`).join("\n");
}

/** Reads the Pi context files for a new ACP session. */
export async function loadContextSources(
  agentDir: string,
  cwd: string,
  skills: SkillInfo[],
): Promise<ContextSources> {
  return {
    globalAgents: await readOptional(join(agentDir, "AGENTS.md")),
    projectAgents: await readOptional(join(cwd, "AGENTS.md")),
    skills,
  };
}

export function skillsFromCommands(commands: SlashCommandInfo[]): SkillInfo[] {
  return commands
    .filter((command) => command.source === "skill")
    .map((command) => ({
      name: command.name.replace(/^skill:/, ""),
      description: command.description,
      path: command.sourceInfo.path,
    }));
}
