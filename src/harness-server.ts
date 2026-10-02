import { randomBytes } from "node:crypto";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type * as acp from "@agentclientprotocol/sdk";
import type { Tool } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** The MCP server name. The agent sees its tools as `mcp__pi__<name>`. */
export const HARNESS_SERVER = "pi";
const SERVER_INFO = { name: HARNESS_SERVER, version: "1.0.0" };
const SESSION_HEADER = "mcp-session-id";
/** A text for the agent: it stays in English. */
const NOT_OFFERED = (name: string) => `The tool ${name} is not offered in this Pi session.`;

/** How ACP describes an MCP server it reaches over HTTP. */
export type HttpMcpServer = Extract<acp.McpServer, { type: "http" }>;

/** Runs the harness tool `name` for the Pi session `key`. */
export type HarnessCaller = (
  key: string,
  name: string,
  args: Record<string, unknown>,
) => Promise<CallToolResult>;

/** One MCP session of the agent, bound to the Pi session whose token opened it. */
interface Connection {
  key: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
}

/**
 * The MCP server that offers the harness tools to the agent (docs/adr/0002). It listens on loopback
 * only, and each Pi session has its own bearer token: the token decides which tools a request sees
 * and calls. The token never goes on a command line (src/mcp-config.ts).
 */
export class HarnessServer {
  readonly #tools = new Map<string, Tool[]>();
  readonly #tokens = new Map<string, string>();
  readonly #keys = new Map<string, string>();
  readonly #connections = new Map<string, Connection>();
  #http: HttpServer | undefined;
  #url: Promise<string> | undefined;

  constructor(private readonly call: HarnessCaller) {}

  /** Sets the tools the agent of `key` sees. Connected agents hear about a change. */
  setTools(key: string, tools: Tool[]): void {
    const changed = declarations(this.#tools.get(key) ?? []) !== declarations(tools);
    this.#tools.set(key, tools);
    if (changed) this.#notify(key);
  }

  /** The ACP description of this server for the Pi session `key`. The server starts on first use. */
  async describe(key: string): Promise<HttpMcpServer> {
    const url = await this.#listen();
    const authorization = { name: "authorization", value: `Bearer ${this.#token(key)}` };
    return { type: "http", name: HARNESS_SERVER, url, headers: [authorization] };
  }

  /** Revokes every token, then stops listening. */
  async close(): Promise<void> {
    this.#keys.clear();
    this.#tokens.clear();
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map((connection) => connection.server.close()));
    this.#http?.closeAllConnections();
    this.#http?.close();
  }

  #listen(): Promise<string> {
    this.#url ??= new Promise((resolve) => {
      const http = createServer((req, res) => void this.#handle(req, res).catch(() => refuse(res, 500)));
      this.#http = http;
      http.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`),
      );
    });
    return this.#url;
  }

  #token(key: string): string {
    const token = this.#tokens.get(key) ?? randomBytes(32).toString("hex");
    this.#tokens.set(key, token);
    this.#keys.set(token, key);
    return token;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = this.#keys.get(bearer(req));
    if (key === undefined) return refuse(res, 401);
    return this.#serve(key, req, res);
  }

  /** A request that opens no MCP session, such as one that is not `initialize`, leaves nothing open. */
  async #serve(key: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const connection = this.#connectionFor(key, req.headers[SESSION_HEADER]);
    if (!connection) return refuse(res, 404);
    await connection.transport.handleRequest(req, res);
    if (connection.transport.sessionId === undefined) await connection.server.close();
  }

  /** The MCP session the request names, or a new one when it names none. */
  #connectionFor(key: string, sessionId: string | string[] | undefined): Connection | undefined {
    if (sessionId === undefined) return this.#open(key);
    return this.#connectionOf(key, String(sessionId));
  }

  /** Another Pi session's token never reaches this session's MCP session. */
  #connectionOf(key: string, sessionId: string): Connection | undefined {
    const connection = this.#connections.get(sessionId);
    return connection?.key === key ? connection : undefined;
  }

  #open(key: string): Connection {
    const server = new Server(SERVER_INFO, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: (this.#tools.get(key) ?? []).map(mcpTool),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.#call(key, request.params.name, request.params.arguments ?? {}),
    );
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString("hex"),
      onsessioninitialized: (sessionId) => {
        this.#connections.set(sessionId, { key, server, transport });
      },
      onsessionclosed: (sessionId) => {
        this.#connections.delete(sessionId);
      },
    });
    void server.connect(transport);
    return { key, server, transport };
  }

  /** Pi runs any of its active tools by name, so only a tool offered to this session gets to Pi. */
  #call(key: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const offered = (this.#tools.get(key) ?? []).some((tool) => tool.name === name);
    if (!offered)
      return Promise.resolve({ content: [{ type: "text", text: NOT_OFFERED(name) }], isError: true });
    return this.call(key, name, args);
  }

  #notify(key: string): void {
    for (const connection of this.#connections.values()) {
      if (connection.key === key) connection.server.sendToolListChanged().catch(() => undefined);
    }
  }
}

/** The JSON round trip drops TypeBox's symbol keys, as Pi does for its own declarations. */
function mcpTool(tool: Tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
  };
}

function declarations(tools: Tool[]): string {
  return JSON.stringify(tools.map(mcpTool));
}

function bearer(req: IncomingMessage): string {
  return (req.headers.authorization ?? "").replace(/^Bearer /, "");
}

function refuse(res: ServerResponse, status: number): void {
  if (!res.headersSent) res.writeHead(status);
  res.end();
}
