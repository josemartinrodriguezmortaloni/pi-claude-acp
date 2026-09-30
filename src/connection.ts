import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const VERSION_LINE = /^(\d+\.\d+\.\d+) \(Claude Code\)$/;
const ADAPTER_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
);
const STDERR_TAIL_BYTES = 8192;

export type Log = (line: string) => void;

export interface ConnectionEnv {
  CLAUDE_CODE_EXECUTABLE?: string;
  PATH?: string;
}

/** Receives the traffic of one ACP session. */
export interface SessionListener {
  update(update: acp.SessionUpdate): void;
  permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
}

/** The agent-side ACP methods the extension calls. */
export interface AgentRequests {
  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
  resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse>;
  closeSession(params: acp.CloseSessionRequest): Promise<unknown>;
  setSessionMode(params: acp.SetSessionModeRequest): Promise<unknown>;
  setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse>;
  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse>;
  cancel(params: acp.CancelNotification): Promise<void>;
}

export interface AcpConnection {
  readonly agent: AgentRequests;
  readonly claudeVersion: string;
  readonly supportsImages: boolean;
  readonly closed: boolean;
  listen(sessionId: string, listener: SessionListener): () => void;
  close(): void;
}

/** Routes inbound ACP traffic to the listener of its session. */
export class SessionRouter {
  readonly #listeners = new Map<string, SessionListener>();

  constructor(private readonly log: Log) {}

  listen(sessionId: string, listener: SessionListener): () => void {
    this.#listeners.set(sessionId, listener);
    return () => {
      if (this.#listeners.get(sessionId) === listener) this.#listeners.delete(sessionId);
    };
  }

  update(notification: acp.SessionNotification): void {
    const listener = this.#listeners.get(notification.sessionId);
    if (!listener) {
      this.log(`update descartado: ${notification.update.sessionUpdate} (${notification.sessionId})`);
      return;
    }
    listener.update(notification.update);
  }

  permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const listener = this.#listeners.get(request.sessionId);
    if (!listener) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    return listener.permission(request);
  }
}

export async function resolveExecutable(env: ConnectionEnv): Promise<string> {
  if (env.CLAUDE_CODE_EXECUTABLE) return env.CLAUDE_CODE_EXECUTABLE;
  const found = await findOnPath(env.PATH);
  if (!found) {
    throw new Error(
      "No se encontró `claude` en el PATH. Definí CLAUDE_CODE_EXECUTABLE con la ruta del binario.",
    );
  }
  return found;
}

async function findOnPath(pathVariable = ""): Promise<string | undefined> {
  const candidates = pathVariable
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "claude"));
  const executable = await Promise.all(candidates.map(isExecutable));
  return candidates[executable.indexOf(true)];
}

/** Checks that `exe` is the real Claude Code binary and returns its version. */
export async function validateExecutable(exe: string): Promise<string> {
  if (!(await isExecutable(exe))) {
    throw new Error(`El binario de Claude Code no existe o no es ejecutable: ${exe}`);
  }
  const output = await versionOutput(exe);
  const version = parseVersion(output);
  if (!version) {
    throw new Error(
      `${exe} no es el binario de Claude Code: \`--version\` devolvió ${JSON.stringify(output)}. ` +
        "Apuntá CLAUDE_CODE_EXECUTABLE al binario real, no a un wrapper.",
    );
  }
  return version;
}

/** The version in the first output line, which must be exactly `<x.y.z> (Claude Code)`. */
function parseVersion(output: string): string | undefined {
  return VERSION_LINE.exec(output.split("\n")[0] ?? "")?.[1];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionOutput(exe: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(exe, ["--version"], { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve(error ? `${stdout}${stderr}${error.message}`.trim() : stdout.trim());
    });
  });
}

/** Appends lines to `file`, in order, without ever writing to the Pi process streams. */
export function createLog(file: string): Log {
  let chain: Promise<unknown> = mkdir(dirname(file), { recursive: true }).catch(() => undefined);
  return (line) => {
    const stamped = `${new Date().toISOString()} ${line.endsWith("\n") ? line : `${line}\n`}`;
    chain = chain.then(() => appendFile(file, stamped)).catch(() => undefined);
  };
}

/** Launches the adapter and completes the ACP handshake. */
export async function openConnection(env: ConnectionEnv, log: Log): Promise<AcpConnection> {
  const exe = await resolveExecutable(env);
  const claudeVersion = await validateExecutable(exe);
  const child = spawn("node", [ADAPTER_ENTRY], {
    env: { ...process.env, CLAUDE_CODE_EXECUTABLE: exe },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = captureStderr(child, log);
  const router = new SessionRouter(log);
  const connection = client({ name: "pi-claude-acp" })
    .onRequest("session/request_permission", ({ params }) => router.permission(params))
    .onNotification("session/update", ({ params }) => router.update(params))
    .connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
  child.on("error", (error) => connection.close(error));
  child.on("exit", () => connection.close());
  const initialized = await connection.agent
    .request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { session: { compaction: {} } },
    })
    .catch((error: unknown) => {
      child.kill();
      throw new Error(`El adaptador ACP no respondió: ${errorText(error)}\n${stderr()}`);
    });
  log(`adaptador iniciado: claude ${claudeVersion} (${exe})`);
  return {
    agent: agentRequests(connection.agent),
    claudeVersion,
    supportsImages: initialized.agentCapabilities?.promptCapabilities?.image === true,
    get closed() {
      return connection.signal.aborted;
    },
    listen: (sessionId, listener) => router.listen(sessionId, listener),
    close: () => {
      connection.close();
      child.kill();
    },
  };
}

function agentRequests(agent: acp.ClientContext): AgentRequests {
  return {
    newSession: (params) => agent.request("session/new", params),
    resumeSession: (params) => agent.request("session/resume", params),
    closeSession: (params) => agent.request("session/close", params),
    setSessionMode: (params) => agent.request("session/set_mode", params),
    setSessionConfigOption: (params) => agent.request("session/set_config_option", params),
    prompt: (params) => agent.request("session/prompt", params),
    cancel: (params) => agent.notify("session/cancel", params),
  };
}

/** Keeps the last bytes of the adapter stderr in memory and copies all of it to the log. */
function captureStderr(child: ChildProcessWithoutNullStreams, log: Log): () => string {
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
    log(`[adaptador] ${chunk}`);
  });
  return () => tail;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SharedConnection {
  get(): Promise<AcpConnection>;
  close(): void;
}

/** Memoizes one live connection; opens a new one after the previous one closes or fails. */
export function sharedConnection(open: () => Promise<AcpConnection>): SharedConnection {
  let current: Promise<AcpConnection> | undefined;
  let stale = () => false;
  const opened = (connection: AcpConnection) => {
    stale = () => connection.closed;
    return connection;
  };
  const failed = (error: unknown): never => {
    current = undefined;
    throw error;
  };
  return {
    get: () => {
      if (stale()) current = undefined;
      current ??= open().then(opened, failed);
      return current;
    },
    /** Also closes a connection that is still opening, so its adapter process never outlives Pi. */
    close: () => {
      void current?.then(
        (connection) => connection.close(),
        () => undefined,
      );
      current = undefined;
    },
  };
}

let adapter: SharedConnection | undefined;

/** The adapter process shared by every Pi runtime of this Pi process. */
export function adapterConnection(log: Log): SharedConnection {
  adapter ??= sharedConnection(() => openConnection(process.env, log));
  return adapter;
}
