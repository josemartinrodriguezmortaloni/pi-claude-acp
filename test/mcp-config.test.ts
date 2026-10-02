import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpServers, moveValuesToEnv } from "../src/mcp-config.ts";

describe("moveValuesToEnv", () => {
  it("replaces every header and env value with a variable that holds it", () => {
    const { servers, env } = moveValuesToEnv([
      { name: "engram", command: "engram", args: ["--port", "1"], env: [{ name: "TOKEN", value: "s3cret" }] },
      {
        type: "http",
        name: "docs",
        url: "https://x.test/mcp",
        headers: [{ name: "Authorization", value: "k" }],
      },
    ]);
    expect(servers).toEqual([
      {
        name: "engram",
        command: "engram",
        args: ["--port", "1"],
        env: [{ name: "TOKEN", value: `\${PI_MCP_0}` }],
      },
      {
        type: "http",
        name: "docs",
        url: "https://x.test/mcp",
        headers: [{ name: "Authorization", value: `\${PI_MCP_1}` }],
      },
    ]);
    expect(env).toEqual({ PI_MCP_0: "s3cret", PI_MCP_1: "k" });
  });

  it("keeps a value that already names a variable, which Claude Code expands itself", () => {
    const header = { name: "Authorization", value: `Bearer \${DOCS_TOKEN}` };
    const { servers, env } = moveValuesToEnv([
      { type: "http", name: "docs", url: "https://x.test/mcp", headers: [header] },
    ]);
    expect(servers).toEqual([{ type: "http", name: "docs", url: "https://x.test/mcp", headers: [header] }]);
    expect(env).toEqual({});
  });
});

describe("loadMcpServers", () => {
  async function file(content: string): Promise<string> {
    const path = join(await mkdtemp(join(tmpdir(), "claude-acp-")), "mcp.json");
    await writeFile(path, content);
    return path;
  }

  it("maps stdio and http servers from the Pi mcp.json and skips disabled ones", async () => {
    const path = await file(
      JSON.stringify({
        mcpServers: {
          engram: { command: "engram", args: ["mcp"], env: { A: "1" } },
          docs: { url: "https://x.test/mcp", headers: { Authorization: "k" } },
          off: { command: "off", enabled: false },
        },
      }),
    );
    expect(await loadMcpServers(path)).toEqual([
      { name: "engram", command: "engram", args: ["mcp"], env: [{ name: "A", value: "1" }] },
      {
        type: "http",
        name: "docs",
        url: "https://x.test/mcp",
        headers: [{ name: "Authorization", value: "k" }],
      },
    ]);
  });

  it("fails naming a server that has neither command nor url", async () => {
    const path = await file(JSON.stringify({ mcpServers: { broken: { args: [] } } }));
    await expect(loadMcpServers(path)).rejects.toThrow("broken");
  });

  it("returns no servers when the file does not exist", async () => {
    await expect(loadMcpServers("/nonexistent/mcp.json")).resolves.toEqual([]);
  });

  it("fails with the path, never the file content, when the file is not valid JSON", async () => {
    const path = await file('{"headers": {"Authorization": "secret-token"');
    const error = (await loadMcpServers(path).catch((e: unknown) => e)) as Error;
    expect(error?.message).toContain(path);
    expect(error?.message).not.toContain("secret-token");
  });
});
