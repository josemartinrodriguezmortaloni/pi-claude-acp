import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CompactionUpdate,
  ContentBlock,
  McpServer,
  SessionConfigOption,
  SessionModeId,
} from "@agentclientprotocol/sdk";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
  configValue,
  EFFORT_CONFIG_ID,
  effortChange,
  MODEL_CONFIG_ID,
  modelOptions,
  type ProbeSession,
} from "./catalog.ts";
import type { AcpConnection } from "./connection.ts";
import { copy } from "./messages.ts";
import type { ModeId } from "./modes.ts";

export const PROVIDER_ID = "claude-acp";
export const SESSION_ENTRY = "claude-acp-session";
/**
 * The adapter reads `defaultMode` from ~/.claude even with `settingSources: []`
 * (claude-agent-acp/dist/settings.js:79-88), so every session is set to the Pi session's mode.
 * Internal calls always run in this one.
 */
const DEFAULT_MODE: SessionModeId = "default";
/**
 * Sends every tool call to session/request_permission, except in auto mode: there Claude Code's
 * classifier decides, and only what it escalates reaches Pi. The hook reads its JSON input on stdin;
 * grep keeps it fast, since it runs before every tool call.
 */
const ASK_HOOK_COMMAND = `grep -Eq '"permission_mode" *: *"auto"' || printf '%s' '${JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
})}'`;

/**
 * Links a Pi session to its ACP session. Persisted with `pi.appendEntry`.
 * A Pi fork copies the parent's entries, so `piSessionId` tells the fork the record is not its own.
 */
export interface SessionRecord {
  acpSessionId: string;
  leafId: string | null;
  piSessionId: string;
}

export interface AcpSession {
  readonly id: string;
  readonly conn: AcpConnection;
  configOptions: SessionConfigOption[];
  needsContext: boolean;
  /** Cumulative `usage_update.cost.amount` seen so far. */
  costTotal: number;
}

export interface OpenedSession {
  session: AcpSession;
  /** Lines shown to the user before the turn output. */
  notices: string[];
}

export interface TurnRequest {
  conn: AcpConnection;
  /** `ctx.sessionManager.getSessionId()`. */
  piSessionId: string;
  /** `options.sessionId` of the stream request. */
  requestSessionId: string | undefined;
  cwd: string;
  branchHas(leafId: string | null): boolean;
  modelId: string;
  level: ThinkingLevel | undefined;
  /** The last user message. */
  blocks: ContentBlock[];
}

export interface OpenTurn extends OpenedSession {
  prompt: ContentBlock[];
}

export interface SessionDeps {
  /** The MCP servers of a new session. A Pi session also gets its harness server; internal calls do not. */
  mcpServers(piSessionId?: string): Promise<McpServer[]>;
  contextBlock(cwd: string): Promise<string>;
  /** Receives every config response, so the catalog learns models and effort levels. */
  onConfig(configOptions: SessionConfigOption[]): void;
  /** The mode the user chose for a Pi session. */
  mode(piSessionId: string): ModeId;
}

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

export function sessionMeta(persist: boolean) {
  return {
    claudeCode: {
      options: {
        settingSources: [],
        // Recent models stream empty thinking unless a summary is requested (acp-agent.js:7751);
        // the `showThinkingSummaries` setting does not reach the SDK through the adapter.
        thinking: { type: "adaptive", display: "summarized" },
        settings: {
          hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: ASK_HOOK_COMMAND }] }] },
        },
        allowDangerouslySkipPermissions: false,
        ...(!persist && { persistSession: false }),
      },
    },
  };
}

/** Owns the Pi session ↔ ACP session mapping for one Pi runtime. */
export class SessionStore {
  readonly #live = new Map<string, AcpSession>();
  readonly #records = new Map<string, SessionRecord>();
  readonly #used = new Set<string>();
  /** Pi sessions whose latest record belongs to another Pi session: a fork. */
  readonly #forked = new Set<string>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SessionDeps) {}

  /** Reads the latest persisted record of a Pi session. */
  load(piSessionId: string, entries: SessionEntry[]): void {
    const data = latestRecordData(entries);
    if (isRecordOf(piSessionId, data)) this.#records.set(piSessionId, data);
    else if (data !== undefined) this.#forked.add(piSessionId);
  }

  async ensure(
    conn: AcpConnection,
    piSessionId: string,
    cwd: string,
    branchHas: (leafId: string | null) => boolean,
  ): Promise<OpenedSession> {
    this.#used.add(piSessionId);
    const record = this.#records.get(piSessionId);
    if (!this.#diverged(piSessionId, record, branchHas)) return this.#reuse(conn, piSessionId, cwd, record);
    await this.#closeLive(piSessionId);
    return this.#fresh(conn, piSessionId, cwd, [copy.branchDiverged]);
  }

  #diverged(
    piSessionId: string,
    record: SessionRecord | undefined,
    branchHas: (leafId: string | null) => boolean,
  ) {
    return this.#forked.delete(piSessionId) || diverged(record, branchHas);
  }

  async #closeLive(piSessionId: string): Promise<void> {
    const live = this.#live.get(piSessionId);
    this.#live.delete(piSessionId);
    await live?.conn.agent.closeSession({ sessionId: live.id }).catch(() => undefined);
  }

  /** Keeps the live session while its connection is the current one. */
  async #reuse(conn: AcpConnection, piSessionId: string, cwd: string, record: SessionRecord | undefined) {
    const live = this.#live.get(piSessionId);
    if (live?.conn === conn) return { session: live, notices: [] };
    return this.#reopen(conn, piSessionId, cwd, record);
  }

  /** Resumes the recorded session, or opens a new one when there is no record. */
  #reopen(conn: AcpConnection, piSessionId: string, cwd: string, record: SessionRecord | undefined) {
    return record
      ? this.#resume(conn, piSessionId, cwd, record.acpSessionId)
      : this.#fresh(conn, piSessionId, cwd, []);
  }

  /** A session for Pi's internal calls (compaction, summaries). The caller closes it. */
  async ephemeral(conn: AcpConnection, cwd: string): Promise<AcpSession> {
    const response = await conn.agent.newSession({
      cwd,
      mcpServers: await this.deps.mcpServers(),
      _meta: sessionMeta(false),
    });
    const session = newSession(conn, response.sessionId, response.configOptions, false);
    await conn.agent.setSessionMode({ sessionId: session.id, modeId: DEFAULT_MODE });
    return session;
  }

  /**
   * Opens and configures the ACP session of a request, then runs `task` with its prompt.
   * Requests whose session id is not the Pi session are internal calls (compaction, summaries,
   * pi-coding-agent/dist/core/sdk.js:257) and go to a disposable session.
   */
  withTurn<T>(request: TurnRequest, task: (turn: OpenTurn) => Promise<T>): Promise<T> {
    if (request.requestSessionId !== request.piSessionId) return this.#internalTurn(request, task);
    return this.serialize(request.piSessionId, async () => {
      const opened = await this.ensure(request.conn, request.piSessionId, request.cwd, request.branchHas);
      return task(await this.#prepare(opened, request));
    });
  }

  async #internalTurn<T>(request: TurnRequest, task: (turn: OpenTurn) => Promise<T>): Promise<T> {
    const session = await this.ephemeral(request.conn, request.cwd);
    try {
      return await task(await this.#prepare({ session, notices: [] }, request));
    } finally {
      await request.conn.agent.closeSession({ sessionId: session.id }).catch(() => undefined);
    }
  }

  async #prepare(opened: OpenedSession, request: TurnRequest): Promise<OpenTurn> {
    await applyConfig(opened.session, request.modelId, request.level);
    this.deps.onConfig(opened.session.configOptions);
    return { ...opened, prompt: await this.promptBlocks(opened.session, request.blocks, request.cwd) };
  }

  /** Runs tasks of one Pi session one after another. */
  serialize<T>(piSessionId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(piSessionId) ?? Promise.resolve()).then(task);
    this.#queues.set(
      piSessionId,
      run.catch(() => undefined),
    );
    return run;
  }

  /** The record to persist after a turn, or undefined when no turn ran since the last commit. */
  commit(piSessionId: string, leafId: string | null): SessionRecord | undefined {
    const live = this.#live.get(piSessionId);
    if (!live || !this.#used.delete(piSessionId)) return undefined;
    const record = { acpSessionId: live.id, leafId, piSessionId };
    this.#records.set(piSessionId, record);
    return record;
  }

  /** Prepends the Pi context block to the first prompt of a session. */
  async promptBlocks(session: AcpSession, blocks: ContentBlock[], cwd: string): Promise<ContentBlock[]> {
    if (!session.needsContext) return blocks;
    session.needsContext = false;
    return [{ type: "text", text: await this.deps.contextBlock(cwd) }, ...blocks];
  }

  /** Claude Code dropped its history, so the next prompt carries the context block again. */
  noteCompaction(session: AcpSession, update: CompactionUpdate): void {
    if (update.status === "completed") session.needsContext = true;
  }

  async #fresh(
    conn: AcpConnection,
    piSessionId: string,
    cwd: string,
    notices: string[],
  ): Promise<OpenedSession> {
    const response = await conn.agent.newSession({
      cwd,
      mcpServers: await this.deps.mcpServers(piSessionId),
      _meta: sessionMeta(true),
    });
    const session = await this.#adopt(
      piSessionId,
      newSession(conn, response.sessionId, response.configOptions, true),
    );
    this.#records.delete(piSessionId);
    return { session, notices };
  }

  async #resume(
    conn: AcpConnection,
    piSessionId: string,
    cwd: string,
    acpSessionId: string,
  ): Promise<OpenedSession> {
    const response = await conn.agent
      .resumeSession({
        sessionId: acpSessionId,
        cwd,
        mcpServers: await this.deps.mcpServers(piSessionId),
        _meta: sessionMeta(true),
      })
      .catch(() => undefined);
    if (!response) return this.#fresh(conn, piSessionId, cwd, [copy.resumeFailed]);
    const session = await this.#adopt(
      piSessionId,
      newSession(conn, acpSessionId, response.configOptions, true),
    );
    return { session, notices: [] };
  }

  /** Applies a mode change to the live ACP session, if there is one. The next one opens in it anyway. */
  async setMode(piSessionId: string, mode: ModeId): Promise<void> {
    const live = this.#live.get(piSessionId);
    await live?.conn.agent.setSessionMode({ sessionId: live.id, modeId: mode });
  }

  async #adopt(piSessionId: string, session: AcpSession): Promise<AcpSession> {
    await session.conn.agent.setSessionMode({ sessionId: session.id, modeId: this.deps.mode(piSessionId) });
    this.deps.onConfig(session.configOptions);
    this.#live.set(piSessionId, session);
    return session;
  }
}

/** A disposable session for reading the catalog. */
export async function openProbe(
  store: SessionStore,
  conn: AcpConnection,
  cwd: string,
): Promise<ProbeSession> {
  const session = await store.ephemeral(conn, cwd);
  return {
    configOptions: session.configOptions,
    close: async () => {
      await conn.agent.closeSession({ sessionId: session.id });
    },
  };
}

function latestRecordData(entries: SessionEntry[]): unknown {
  const entry = entries.findLast((e) => e.type === "custom" && e.customType === SESSION_ENTRY);
  return entry?.type === "custom" ? entry.data : undefined;
}

function isRecordOf(piSessionId: string, data: unknown): data is SessionRecord {
  const record = Object(data) as Partial<SessionRecord>;
  return typeof record.acpSessionId === "string" && record.piSessionId === piSessionId;
}

/** The saved leaf left the current branch (tree navigation), so Claude Code's history no longer matches. */
function diverged(record: SessionRecord | undefined, branchHas: (leafId: string | null) => boolean): boolean {
  return record !== undefined && !branchHas(record.leafId);
}

function newSession(
  conn: AcpConnection,
  id: string,
  configOptions: SessionConfigOption[] | null | undefined,
  needsContext: boolean,
): AcpSession {
  return { id, conn, configOptions: configOptions ?? [], needsContext, costTotal: 0 };
}

async function setOption(session: AcpSession, configId: string, value: string): Promise<void> {
  const response = await session.conn.agent.setSessionConfigOption({
    sessionId: session.id,
    configId,
    value,
  });
  session.configOptions = response.configOptions;
}

/** Selects the model, then the offered effort closest to the Pi thinking level. */
export async function applyConfig(session: AcpSession, modelId: string, level: ThinkingLevel | undefined) {
  if (configValue(session.configOptions, MODEL_CONFIG_ID) !== modelId) await switchModel(session, modelId);
  const effort = effortChange(session.configOptions, level);
  if (effort) await setOption(session, EFFORT_CONFIG_ID, effort);
}

/** Never continues with another model: an unoffered or unapplied model is an error. */
async function switchModel(session: AcpSession, modelId: string): Promise<void> {
  requireOffered(session, modelId);
  await setOption(session, MODEL_CONFIG_ID, modelId);
  if (configValue(session.configOptions, MODEL_CONFIG_ID) === modelId) return;
  throw new Error(copy.modelNotApplied(modelId));
}

function requireOffered(session: AcpSession, modelId: string): void {
  const offered = modelOptions(session.configOptions).map((option) => option.value);
  if (offered.includes(modelId)) return;
  const { claudeVersion, claudeExecutable } = session.conn;
  throw new Error(copy.modelNotOffered(modelId, `${claudeExecutable} ${claudeVersion}`, offered));
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

/** Whether a saved leaf is still on the current branch. A null leaf predates every entry. */
export function branchContains(manager: { getBranch(): SessionEntry[] }) {
  return (leafId: string | null) =>
    leafId === null || manager.getBranch().some((entry) => entry.id === leafId);
}

/** Whether the active Pi model runs through this extension. */
export function usesClaudeAcp(model: { provider: string } | undefined): boolean {
  return model?.provider === PROVIDER_ID;
}

/** Claude Code compacts its own history, so Pi's compaction would summarize a transcript it never sends. */
export function shouldCancelCompaction(model: { provider: string } | undefined): boolean {
  return usesClaudeAcp(model);
}

interface PiMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
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

/** The file content, or undefined when it does not exist. Other read errors propagate. */
async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

function toAcpServer(name: string, server: PiMcpServer): McpServer {
  if (server.url) return { type: "http", name, url: server.url, headers: pairs(server.headers) };
  return stdioServer(name, server);
}

function stdioServer(name: string, server: PiMcpServer): McpServer {
  if (!server.command) throw new Error(copy.mcpServerWithoutCommand(name));
  return { name, command: server.command, args: server.args ?? [], env: pairs(server.env) };
}

function pairs(record: Record<string, string> | undefined): { name: string; value: string }[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}

export function buildContextBlock(sources: ContextSources): string {
  const sections = [
    section("AGENTS.md global de Pi", sources.globalAgents),
    section("AGENTS.md del proyecto", sources.projectAgents),
    section("Skills de Pi (leé el SKILL.md antes de usar una)", skillLines(sources.skills)),
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
