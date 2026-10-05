import type {
  CompactionUpdate,
  ContentBlock,
  McpServer,
  SessionConfigOption,
  SessionModeId,
} from "@agentclientprotocol/sdk";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  configValue,
  EFFORT_CONFIG_ID,
  effortChange,
  MODEL_CONFIG_ID,
  modelOptions,
  type ProbeSession,
} from "./catalog.ts";
import type { AcpConnection } from "./connection.ts";
import { type McpConfig, moveValuesToEnv } from "./mcp-config.ts";
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
 * grep keeps it fast, since it runs before every tool call. Only the fields before `tool_input` are
 * read: the agent writes the tool input, and a key `permission_mode` inside it must not skip the dialog.
 * Should the order change, the cut drops `permission_mode` too and every call asks.
 */
const ASK_HOOK_COMMAND = `tr -d '\\n' | sed 's/"tool_input".*//' | grep -Eq '"permission_mode" *: *"auto"' || printf '%s' '${JSON.stringify(
  {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
  },
)}'`;

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
  /** The last `usage_update.used`: the tokens in the context window after the latest request. */
  contextUsed: number;
}

export interface OpenedSession {
  session: AcpSession;
  /** Warnings about the session shown to the user before the turn output. */
  warnings: string[];
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

/** `env` reaches the Claude Code process of the session: it carries the MCP header and env values. */
export function sessionMeta(persist: boolean, env: Record<string, string>) {
  return {
    claudeCode: {
      options: {
        settingSources: [],
        env,
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

  /** Closes every live ACP session: their Pi runtime ends, and each one keeps a Claude Code process. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#live.keys()].map((piSessionId) => this.#closeLive(piSessionId)));
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
    if (live?.conn === conn) return { session: live, warnings: [] };
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
    const response = await conn.agent.newSession({ cwd, ...(await this.#sessionParams(false)) });
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
      return await task(await this.#prepare({ session, warnings: [] }, request));
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

  /**
   * Prepends the Pi context block to the first prompt of a session. A slash command goes alone:
   * Claude Code runs it only when the prompt starts with it, and the block waits for the next prompt.
   */
  async promptBlocks(session: AcpSession, blocks: ContentBlock[], cwd: string): Promise<ContentBlock[]> {
    if (!session.needsContext || isSlashCommand(blocks)) return blocks;
    session.needsContext = false;
    return [{ type: "text", text: await this.deps.contextBlock(cwd) }, ...blocks];
  }

  /** Claude Code dropped its history, so the next prompt carries the context block again. */
  noteCompaction(session: AcpSession, update: CompactionUpdate): void {
    if (update.status === "completed") session.needsContext = true;
  }

  /** The MCP servers and options of a new or resumed session. Only a Pi session gets the harness server. */
  async #sessionParams(persist: boolean, piSessionId?: string) {
    const mcp: McpConfig = moveValuesToEnv(await this.deps.mcpServers(piSessionId));
    return { mcpServers: mcp.servers, _meta: sessionMeta(persist, mcp.env) };
  }

  async #fresh(
    conn: AcpConnection,
    piSessionId: string,
    cwd: string,
    warnings: string[],
  ): Promise<OpenedSession> {
    const response = await conn.agent.newSession({ cwd, ...(await this.#sessionParams(true, piSessionId)) });
    const session = await this.#adopt(
      piSessionId,
      newSession(conn, response.sessionId, response.configOptions, true),
    );
    this.#records.delete(piSessionId);
    return { session, warnings };
  }

  async #resume(
    conn: AcpConnection,
    piSessionId: string,
    cwd: string,
    acpSessionId: string,
  ): Promise<OpenedSession> {
    const response = await conn.agent
      .resumeSession({ sessionId: acpSessionId, cwd, ...(await this.#sessionParams(true, piSessionId)) })
      .catch(() => undefined);
    if (!response) return this.#fresh(conn, piSessionId, cwd, [copy.resumeFailed]);
    const session = await this.#adopt(
      piSessionId,
      newSession(conn, acpSessionId, response.configOptions, true),
    );
    return { session, warnings: [] };
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
  return { id, conn, configOptions: configOptions ?? [], needsContext, costTotal: 0, contextUsed: 0 };
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

/** Whether a saved leaf is still on the current branch. A null leaf predates every entry. */
export function branchContains(manager: { getBranch(): SessionEntry[] }) {
  return (leafId: string | null) =>
    leafId === null || manager.getBranch().some((entry) => entry.id === leafId);
}

/** Whether the active Pi model runs through this extension. */
function isSlashCommand(blocks: ContentBlock[]): boolean {
  const first = blocks[0];
  return first?.type === "text" && first.text.startsWith("/");
}

export function usesClaudeAcp(model: { provider: string } | undefined): boolean {
  return model?.provider === PROVIDER_ID;
}
