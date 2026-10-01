import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { copy } from "./messages.ts";

const VERSION_LINE = /^(\d+\.\d+\.\d+) \(Claude Code\)$/;
const ADAPTER_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
);
const STDERR_TAIL_BYTES = 8192;
const STDERR_TAIL_LINES = 10;

export type Log = (line: string) => void;

export interface ConnectionEnv {
  CLAUDE_CODE_EXECUTABLE?: string;
  PATH?: string;
}

/** Receives the traffic of one ACP session. */
export interface SessionListener {
  update(update: acp.SessionUpdate): void;
  permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  elicit(request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse>;
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
  readonly claudeExecutable: string;
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

  /** Only session-scoped elicitations reach a turn; request-scoped ones have no listener. */
  elicitation(request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    const listener = this.#listeners.get(String((request as { sessionId?: string }).sessionId));
    if (!listener) return Promise.resolve({ action: "cancel" });
    return listener.elicit(request);
  }
}

export async function resolveExecutable(env: ConnectionEnv): Promise<string> {
  if (env.CLAUDE_CODE_EXECUTABLE) return env.CLAUDE_CODE_EXECUTABLE;
  const found = await findOnPath(env.PATH);
  if (!found) {
    throw new Error(copy.binaryNotFound);
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
    throw new Error(copy.binaryNotExecutable(exe));
  }
  const output = await versionOutput(exe);
  const version = parseVersion(output);
  if (!version) {
    throw new Error(copy.notTheBinary(exe, output));
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
export async function openConnection(
  env: ConnectionEnv,
  log: Log,
  adapterEntry = ADAPTER_ENTRY,
): Promise<AcpConnection> {
  const exe = await resolveExecutable(env);
  const claudeVersion = await validateExecutable(exe);
  const child = spawn("node", [adapterEntry], {
    env: { ...process.env, CLAUDE_CODE_EXECUTABLE: exe },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = captureStderr(child, log);
  const exited = exitError(child, stderr);
  const router = new SessionRouter(log);
  const connection = client({ name: "pi-claude-acp" })
    .onRequest("session/request_permission", ({ params }) => router.permission(params))
    .onRequest("elicitation/create", ({ params }) => router.elicitation(params))
    .onNotification("session/update", ({ params }) => router.update(params))
    .connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
  const kill = () => child.kill();
  process.once("exit", kill);
  child.on("error", (error) => connection.close(error));
  void exited.then((error) => {
    process.off("exit", kill);
    connection.close(error);
  });
  /** A request that fails because the adapter died reports how it died. */
  const explain = async (error: unknown): Promise<never> => {
    throw connection.signal.aborted ? await exited : error;
  };
  const initialized = await connection.agent
    .request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { session: { compaction: {} }, elicitation: { form: {} } },
    })
    .catch(async (error: unknown) => {
      kill();
      throw new Error(`${copy.adapterNoResponse(errorText(error))}\n${stderr()}`);
    });
  log(`adaptador iniciado: claude ${claudeVersion} (${exe})`);
  return {
    agent: agentRequests(connection.agent, explain),
    claudeVersion,
    claudeExecutable: exe,
    supportsImages: announcesImages(initialized),
    get closed() {
      return connection.signal.aborted;
    },
    listen: (sessionId, listener) => router.listen(sessionId, listener),
    close: () => {
      connection.close();
      kill();
    },
  };
}

function announcesImages(initialized: acp.InitializeResponse): boolean {
  return initialized.agentCapabilities?.promptCapabilities?.image === true;
}

function agentRequests(agent: acp.ClientContext, explain: (error: unknown) => Promise<never>): AgentRequests {
  return {
    newSession: (params) => agent.request("session/new", params).catch(explain),
    resumeSession: (params) => agent.request("session/resume", params).catch(explain),
    closeSession: (params) => agent.request("session/close", params).catch(explain),
    setSessionMode: (params) => agent.request("session/set_mode", params).catch(explain),
    setSessionConfigOption: (params) => agent.request("session/set_config_option", params).catch(explain),
    prompt: (params) => agent.request("session/prompt", params).catch(explain),
    cancel: (params) => agent.notify("session/cancel", params).catch(explain),
  };
}

/** Resolves when the adapter process ends, with its exit code or signal and the last stderr lines. */
function exitError(child: ChildProcessWithoutNullStreams, stderr: () => string): Promise<Error> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => {
      resolve(new Error(`${copy.adapterExited(code, signal)}\n${lastLines(stderr(), STDERR_TAIL_LINES)}`));
    });
  });
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split("\n").slice(-count).join("\n");
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
