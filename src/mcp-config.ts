import type { McpServer } from "@agentclientprotocol/sdk";
import { readOptional } from "./files.ts";
import { copy } from "./messages.ts";

/** Prefix of the variables that carry header and env values (`PI_MCP_0`, `PI_MCP_1`, ...). */
const ENV_PREFIX = "PI_MCP_";

/** A header or an environment variable of an MCP server, as ACP describes it. */
interface NameValue {
  name: string;
  value: string;
}

/** The MCP servers of an ACP session, and the environment of the Claude Code process they read. */
export interface McpConfig {
  servers: McpServer[];
  env: Record<string, string>;
}

interface PiMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/**
 * The Agent SDK passes the MCP servers to Claude Code on its command line (`--mcp-config`), and every
 * local user can read a command line in /proc/<pid>/cmdline. So each header and env value moves to
 * the environment of the Claude Code process, which only its owner reads, and the server names it
 * as `${PI_MCP_<n>}`: Claude Code expands it. A value that already names a variable stays.
 */
export function moveValuesToEnv(servers: McpServer[]): McpConfig {
  const env: Record<string, string> = {};
  const hide = (pair: NameValue): NameValue => {
    if (pair.value.includes("${")) return pair;
    const variable = `${ENV_PREFIX}${Object.keys(env).length}`;
    env[variable] = pair.value;
    return { name: pair.name, value: `\${${variable}}` };
  };
  return { servers: servers.map((server) => hideValues(server, hide)), env };
}

function hideValues(server: McpServer, hide: (pair: NameValue) => NameValue): McpServer {
  if ("headers" in server) return { ...server, headers: server.headers.map(hide) };
  if ("env" in server) return { ...server, env: server.env.map(hide) };
  return server;
}

/** Reads the MCP servers of `~/.pi/agent/mcp.json` as ACP server descriptions. */
export async function loadMcpServers(file: string): Promise<McpServer[]> {
  const text = await readOptional(file);
  if (text === undefined) return [];
  const servers = parseJson(file, text).mcpServers ?? {};
  return Object.entries(servers)
    .filter(([, server]) => server.enabled !== false)
    .map(([name, server]) => toAcpServer(name, server));
}

/** The parse error is not quoted: it can echo file content, such as tokens in headers. */
function parseJson(file: string, text: string): { mcpServers?: Record<string, PiMcpServer> } {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(copy.mcpInvalidJson(file));
  }
}

function toAcpServer(name: string, server: PiMcpServer): McpServer {
  if (server.url) return { type: "http", name, url: server.url, headers: pairs(server.headers) };
  return stdioServer(name, server);
}

function stdioServer(name: string, server: PiMcpServer): McpServer {
  if (!server.command) throw new Error(copy.mcpServerWithoutCommand(name));
  return { name, command: server.command, args: server.args ?? [], env: pairs(server.env) };
}

function pairs(record: Record<string, string> | undefined): NameValue[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}
