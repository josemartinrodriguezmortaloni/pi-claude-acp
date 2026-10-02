import { type Tool, Type } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessServer, type HttpMcpServer } from "../src/harness-server.ts";

const EVAL: Tool = {
  name: "eval",
  description: "Runs a cell in a persistent kernel.",
  parameters: Type.Object({ code: Type.String() }),
};
const CODEMODE: Tool = {
  name: "codemode",
  description: "Runs a script that calls tools.",
  parameters: Type.Object({ script: Type.String() }),
};

const servers: HarnessServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function harnessServer(calls: [string, string, Record<string, unknown>][] = []) {
  const server = new HarnessServer(async (key, name, args) => {
    calls.push([key, name, args]);
    return { content: [{ type: "text", text: `ran ${name}` }] };
  });
  servers.push(server);
  return server;
}

/**
 * A real MCP client, connected as Claude Code connects to an ACP `http` server. `listening` resolves
 * once the client opened its stream for server notifications, which it does after initializing.
 */
async function connect(description: HttpMcpServer): Promise<{ client: Client; listening: Promise<void> }> {
  const headers = Object.fromEntries(description.headers.map((header) => [header.name, header.value]));
  let opened: () => void = () => {};
  const listening = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const watched: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method === "GET" && response.ok) opened();
    return response;
  };
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(description.url), {
    requestInit: { headers },
    fetch: watched,
  });
  await client.connect(transport);
  clients.push(client);
  return { client, listening };
}

describe("HarnessServer", () => {
  it("offers the tools of its Pi session with their JSON schema", async () => {
    const server = harnessServer();
    server.setTools("pi-1", [EVAL]);
    const { client } = await connect(await server.describe("pi-1"));
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      {
        name: "eval",
        description: "Runs a cell in a persistent kernel.",
        inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
      },
    ]);
  });

  it("names itself pi and listens on loopback only", async () => {
    const description = await harnessServer().describe("pi-1");
    expect(description).toMatchObject({ type: "http", name: "pi" });
    expect(new URL(description.url).hostname).toBe("127.0.0.1");
  });

  it("sends a tool call to the caller with its Pi session and returns the result", async () => {
    const calls: [string, string, Record<string, unknown>][] = [];
    const server = harnessServer(calls);
    server.setTools("pi-1", [EVAL]);
    const { client } = await connect(await server.describe("pi-1"));
    const result = await client.callTool({ name: "eval", arguments: { code: "1 + 1" } });
    expect(calls).toEqual([["pi-1", "eval", { code: "1 + 1" }]]);
    expect(result).toEqual({ content: [{ type: "text", text: "ran eval" }] });
  });

  it("refuses a tool its Pi session was not offered, such as Pi's own bash, without calling Pi", async () => {
    const calls: [string, string, Record<string, unknown>][] = [];
    const server = harnessServer(calls);
    server.setTools("pi-1", [EVAL]);
    const { client } = await connect(await server.describe("pi-1"));
    const result = await client.callTool({ name: "bash", arguments: { command: "id" } });
    expect(result).toEqual({
      content: [{ type: "text", text: "The tool bash is not offered in this Pi session." }],
      isError: true,
    });
    expect(calls).toEqual([]);
  });

  it("revokes every token when it closes", async () => {
    const server = harnessServer();
    server.setTools("pi-1", [EVAL]);
    const description = await server.describe("pi-1");
    await server.close();
    await expect(connect(description)).rejects.toThrow();
  });

  it("gives each Pi session only its own tools", async () => {
    const server = harnessServer();
    server.setTools("pi-1", [EVAL]);
    server.setTools("pi-2", [CODEMODE]);
    const { client } = await connect(await server.describe("pi-2"));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["codemode"]);
  });

  it("rejects a request without the session token", async () => {
    const server = harnessServer();
    const description = await server.describe("pi-1");
    const response = await fetch(description.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("tells a connected agent when the tools of its session change", async () => {
    const server = harnessServer();
    server.setTools("pi-1", [EVAL]);
    const { client, listening } = await connect(await server.describe("pi-1"));
    await listening;
    const changed = new Promise<void>((resolve) =>
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
    );
    server.setTools("pi-1", [EVAL, CODEMODE]);
    await changed;
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["eval", "codemode"]);
  });
});
