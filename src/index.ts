import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Catalog } from "./catalog.ts";
import { adapterConnection, createLog, type Log, type SharedConnection } from "./connection.ts";
import { answerElicitation } from "./elicitation.ts";
import { attachToTerminal, LOGIN_COMMAND, type LoginDeps, login, warnIfLoggedOut } from "./login.ts";
import { decide } from "./permissions.ts";
import {
  branchContains,
  buildContextBlock,
  loadContextSources,
  loadMcpServers,
  openProbe,
  PROVIDER_ID,
  SESSION_ENTRY,
  SessionStore,
  shouldCancelCompaction,
  skillsFromCommands,
} from "./sessions.ts";
import { type StreamDeps, streamPrompt } from "./stream.ts";

const CATALOG_TIMEOUT_MS = 15_000;
const AUTH_STATUS_TIMEOUT_MS = 5_000;
const PLAN_WIDGET = "claude-acp-plan";
/** Pi requires an auth method; Claude Code uses its own login, so this constant is not a secret. */
const AUTH_PLACEHOLDER = "claude-code-login";

export interface ExtensionDeps {
  adapter: SharedConnection;
  agentDir: string;
  log: Log;
}

export default function claudeAcp(pi: ExtensionAPI): Promise<void> {
  const agentDir = getAgentDir();
  const log = createLog(join(agentDir, "claude-acp", "adapter.log"));
  return registerClaudeAcp(pi, { adapter: adapterConnection(log), agentDir, log });
}

export async function registerClaudeAcp(
  pi: ExtensionAPI,
  { adapter, agentDir, log }: ExtensionDeps,
): Promise<void> {
  let ctx: ExtensionContext | undefined;
  const requireCtx = () => {
    if (!ctx) throw new Error("claude-acp: no hay una sesión de Pi activa.");
    return ctx;
  };
  const catalog = new Catalog((models) => register(models));
  const store = new SessionStore({
    mcpServers: () => loadMcpServers(join(agentDir, "mcp.json")),
    contextBlock: async (cwd) =>
      buildContextBlock(await loadContextSources(agentDir, cwd, skillsFromCommands(pi.getCommands()))),
    onConfig: (configOptions) => catalog.observe(configOptions),
  });
  const deps: StreamDeps = {
    connect: () => adapter.get(),
    withTurn: (request, task) => {
      const current = requireCtx();
      const piSessionId = current.sessionManager.getSessionId();
      const branchHas = branchContains(current.sessionManager);
      return store.withTurn({ ...request, piSessionId, cwd: current.cwd, branchHas }, task);
    },
    decide: (request, signal) =>
      decide(request, { events: pi.events, ui: ctx?.hasUI ? ctx.ui : undefined, signal }),
    elicit: (request, signal) => answerElicitation(request, { ui: ctx?.hasUI ? ctx.ui : undefined, signal }),
    showPlan: (lines) => ctx?.ui.setWidget(PLAN_WIDGET, lines),
    onContextWindow: (modelId, size) => catalog.setContextWindow(modelId, size),
    noteCompaction: (session, update) => store.noteCompaction(session, update),
    log,
  };
  const loginDeps: LoginDeps = {
    executable: async () => (await adapter.get()).claudeExecutable,
    capture: (command, args) => pi.exec(command, args, { timeout: AUTH_STATUS_TIMEOUT_MS }),
    attach: attachToTerminal,
    restartAdapter: () => adapter.close(),
  };
  const openCatalogProbe = async () => openProbe(store, await adapter.get(), process.cwd());
  const loadCatalog = () => catalog.load(openCatalogProbe, CATALOG_TIMEOUT_MS);

  function register(models: ProviderModelConfig[]): void {
    pi.registerProvider(PROVIDER_ID, {
      name: "Claude Code (ACP)",
      api: PROVIDER_ID,
      baseUrl: "acp://claude-agent-acp",
      apiKey: AUTH_PLACEHOLDER,
      models,
      streamSimple: (model, context, options) => streamPrompt(model, context, options, deps),
      refreshModels: async () => {
        const error = await loadCatalog();
        if (error) throw new Error(error);
        return catalog.models;
      },
    });
  }

  const startupError = await loadCatalog();
  if (startupError) log(startupError);
  register(catalog.models);

  pi.registerCommand(LOGIN_COMMAND, {
    description: "Inicia sesión en Claude Code con su propio login",
    handler: (_args, current) => login(current, loginDeps),
  });

  pi.on("session_start", (_event, current) => {
    ctx = current;
    store.load(current.sessionManager.getSessionId(), current.sessionManager.getEntries());
    void catalog
      .ensureLoaded(openCatalogProbe, CATALOG_TIMEOUT_MS)
      .then((error) => error && current.ui.notify(error, "error"));
    // A failed adapter start is already reported by the catalog load above.
    void warnIfLoggedOut(current, loginDeps).catch(() => undefined);
  });
  pi.on("session_shutdown", (event, current) => {
    current.ui.setWidget(PLAN_WIDGET, undefined);
    ctx = undefined;
    if (event.reason === "quit" || event.reason === "reload") adapter.close();
  });
  pi.on("session_before_compact", (_event, current) =>
    shouldCancelCompaction(current.model) ? { cancel: true } : undefined,
  );
  pi.on("agent_end", (_event, current) => {
    const record = store.commit(current.sessionManager.getSessionId(), current.sessionManager.getLeafId());
    if (record) pi.appendEntry(SESSION_ENTRY, record);
  });
}
