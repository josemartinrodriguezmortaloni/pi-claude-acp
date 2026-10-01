/**
 * Every text the extension shows to the user, in the user's language. Pi has no i18n of its own,
 * so the language comes from the system locale. Logs stay out of here: they are for debugging.
 */
export type Locale = "en" | "es";

/** What a tool of a burst does, as the summary line counts it. */
export type ToolCategory = "read" | "search" | "edit" | "create" | "command" | "fetch" | "subagent" | "plan";

/** The modes of src/modes.ts, as the footer names them. U+FE0E keeps ⏸ a text glyph, not an emoji. */
type ModeLabels = Record<"default" | "acceptEdits" | "plan", string>;

export interface Messages {
  providerName: string;
  loginCommandDescription: string;
  loginHint(command: string): string;
  loginOutsideTui(command: string): string;
  loggedIn: string;
  loginIncomplete(command: string): string;
  resumeFailed: string;
  branchDiverged: string;
  turnCancelled: string;
  turnEnded(reason: string): string;
  modelNotApplied(modelId: string): string;
  /** `binary` names the executable and its version: an old binary is the usual cause. */
  modelNotOffered(modelId: string, binary: string, offered: string[]): string;
  catalogFailed(detail: string): string;
  noResponseWithin(ms: number): string;
  noUserMessage: string;
  noImageSupport: string;
  permissionTitle(tool: string, detail: string): string;
  unknownTool: string;
  hiddenLines(count: number): string;
  planTitle: string;
  ownAnswer: string;
  done: string;
  noPiSession: string;
  mcpInvalidJson(file: string): string;
  mcpServerWithoutCommand(name: string): string;
  binaryNotFound: string;
  binaryNotExecutable(exe: string): string;
  notTheBinary(exe: string, output: string): string;
  adapterNoResponse(detail: string): string;
  adapterExited(code: number | null, signal: string | null): string;
  activityLabel: string;
  activityUnavailable: string;
  toolCount(count: number): string;
  categoryCount: Record<ToolCategory, (count: number) => string>;
  failedCount(count: number): string;
  lineCount(count: number): string;
  resultCount(count: number): string;
  inScope(scope: string): string;
  failedChip: string;
  awaitingApproval: string;
  rejected: string;
  interrupted: string;
  thinkingFor(seconds: number): string;
  thoughtFor(seconds: number): string;
  modeLabel: ModeLabels;
  modeCommandDescription: string;
  modeChoose: string;
  modeUnknown(value: string): string;
  planQuestion: string;
  planAcceptEdits: string;
  planManual: string;
  planKeep: string;
  planFeedback: string;
  planApproved: string;
  subagentsTitle: string;
  moreRows(count: number): string;
}

/** Locale variables in POSIX precedence order. */
const LOCALE_VARIABLES = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

const plural = (count: number, one: string, other: string) => (count === 1 ? one : other);

/** "Bash · rm -rf build", or the tool alone when it acts on nothing named. */
const permissionTitle = (tool: string, detail: string) => [tool, detail].filter(Boolean).join(" · ");

const EN: Messages = {
  providerName: "Claude (subscription)",
  loginCommandDescription: "Log in with your Claude account",
  loginHint: (command) => `You are not logged in to your Claude account. Run /${command} to log in.`,
  loginOutsideTui: (command) =>
    `/${command} needs Pi's TUI. Log in by running \`claude auth login\` in a terminal.`,
  loggedIn: "You are logged in. The next turn uses the new account.",
  loginIncomplete: (command) => `The login did not finish. Run /${command} again.`,
  resumeFailed: "The previous session could not be resumed. A new session started without its history.",
  branchDiverged: "The conversation changed (branch, fork or edit). The model context was reset.",
  turnCancelled: "Turn cancelled.",
  turnEnded: (reason) => `The turn ended: ${reason}`,
  modelNotApplied: (modelId) => `The model ${modelId} could not be selected.`,
  modelNotOffered: (modelId, binary, offered) =>
    `The model ${modelId} is not available with ${binary}. Available models: ${offered.join(", ")}.`,
  catalogFailed: (detail) => `Could not load the model list: ${detail}`,
  noResponseWithin: (ms) => `no response in ${ms} ms`,
  noUserMessage: "The conversation has no user message to send.",
  noImageSupport: "This model connection does not accept images.",
  permissionTitle,
  unknownTool: "a tool",
  hiddenLines: (count) => `… (+${count} ${plural(count, "line", "lines")})`,
  planTitle: "Plan",
  ownAnswer: "Other answer…",
  done: "Done",
  noPiSession: "claude-acp: there is no active Pi session.",
  mcpInvalidJson: (file) => `${file} is not valid JSON.`,
  mcpServerWithoutCommand: (name) => `The MCP server "${name}" has neither command nor url.`,
  binaryNotFound: "`claude` is not on the PATH. Set CLAUDE_CODE_EXECUTABLE to the Claude Code binary.",
  binaryNotExecutable: (exe) => `The Claude Code binary does not exist or is not executable: ${exe}`,
  notTheBinary: (exe, output) =>
    `${exe} is not the Claude Code binary: \`--version\` printed ${JSON.stringify(output)}. ` +
    "Point CLAUDE_CODE_EXECUTABLE to the real binary, not to a wrapper.",
  adapterNoResponse: (detail) => `The ACP adapter did not respond: ${detail}`,
  adapterExited: (code, signal) =>
    `The ACP adapter exited (${code === null ? `signal ${signal}` : `code ${code}`}).`,
  activityLabel: "Activity",
  activityUnavailable: "This activity is no longer available.",
  toolCount: (count) => `${count} ${plural(count, "tool", "tools")}`,
  categoryCount: {
    read: (count) => `${count} ${plural(count, "read", "reads")}`,
    search: (count) => `${count} ${plural(count, "search", "searches")}`,
    edit: (count) => `${count} ${plural(count, "edit", "edits")}`,
    create: (count) => `${count} ${plural(count, "new file", "new files")}`,
    command: (count) => `${count} ${plural(count, "command", "commands")}`,
    fetch: (count) => `${count} ${plural(count, "fetch", "fetches")}`,
    subagent: (count) => `${count} ${plural(count, "subagent", "subagents")}`,
    plan: (count) => `${count} ${plural(count, "plan", "plans")}`,
  },
  failedCount: (count) => `${count} failed`,
  lineCount: (count) => `${count} ${plural(count, "line", "lines")}`,
  resultCount: (count) => `${count} ${plural(count, "result", "results")}`,
  inScope: (scope) => `in ${scope}`,
  failedChip: "FAILED",
  awaitingApproval: "awaiting approval",
  rejected: "rejected",
  interrupted: "interrupted",
  thinkingFor: (seconds) => `Thinking ${seconds} s`,
  thoughtFor: (seconds) => `Thought for ${seconds} s`,
  modeLabel: { default: "⏸\uFE0E manual mode", acceptEdits: "⏵⏵ auto-accept edits", plan: "◇ plan mode" },
  modeCommandDescription: "Switch the permission mode: manual, edits or plan",
  modeChoose: "Permission mode",
  modeUnknown: (value) => `Unknown mode: ${value}. Use manual, edits or plan.`,
  planQuestion: "Would you like to proceed?",
  planAcceptEdits: "Yes, and auto-accept edits",
  planManual: "Yes, manually approve edits",
  planKeep: "No, keep planning",
  planFeedback: "What should change in the plan?",
  planApproved: "approved",
  subagentsTitle: "Subagents",
  moreRows: (count) => `… ${count} more, Ctrl+O to view all`,
};

const ES: Messages = {
  providerName: "Claude (suscripción)",
  loginCommandDescription: "Iniciá sesión con tu cuenta de Claude",
  loginHint: (command) =>
    `No hay una sesión iniciada con tu cuenta de Claude. Ejecutá /${command} para iniciarla.`,
  loginOutsideTui: (command) =>
    `/${command} necesita la TUI de Pi. Iniciá sesión ejecutando \`claude auth login\` en una terminal.`,
  loggedIn: "La sesión está iniciada. El próximo turno usa la cuenta nueva.",
  loginIncomplete: (command) => `El login no se completó. Volvé a ejecutar /${command}.`,
  resumeFailed: "No se pudo reanudar la sesión anterior. Se abrió una sesión nueva sin su historial.",
  branchDiverged: "La conversación cambió (rama, fork o edición). El contexto del modelo se reinició.",
  turnCancelled: "Turno cancelado.",
  turnEnded: (reason) => `El turno terminó: ${reason}`,
  modelNotApplied: (modelId) => `No se pudo seleccionar el modelo ${modelId}.`,
  modelNotOffered: (modelId, binary, offered) =>
    `El modelo ${modelId} no está disponible con ${binary}. Modelos disponibles: ${offered.join(", ")}.`,
  catalogFailed: (detail) => `No se pudo leer la lista de modelos: ${detail}`,
  noResponseWithin: (ms) => `sin respuesta en ${ms} ms`,
  noUserMessage: "La conversación no tiene un mensaje de usuario para enviar.",
  noImageSupport: "Esta conexión con el modelo no acepta imágenes.",
  permissionTitle,
  unknownTool: "una herramienta",
  hiddenLines: (count) => `… (+${count} ${plural(count, "línea", "líneas")})`,
  planTitle: "Plan",
  ownAnswer: "Otra respuesta…",
  done: "Listo",
  noPiSession: "claude-acp: no hay una sesión de Pi activa.",
  mcpInvalidJson: (file) => `${file} no es JSON válido.`,
  mcpServerWithoutCommand: (name) => `El servidor MCP "${name}" no tiene command ni url.`,
  binaryNotFound:
    "No se encontró `claude` en el PATH. Definí CLAUDE_CODE_EXECUTABLE con la ruta del binario de Claude Code.",
  binaryNotExecutable: (exe) => `El binario de Claude Code no existe o no es ejecutable: ${exe}`,
  notTheBinary: (exe, output) =>
    `${exe} no es el binario de Claude Code: \`--version\` devolvió ${JSON.stringify(output)}. ` +
    "Apuntá CLAUDE_CODE_EXECUTABLE al binario real, no a un wrapper.",
  adapterNoResponse: (detail) => `El adaptador ACP no respondió: ${detail}`,
  adapterExited: (code, signal) =>
    `El adaptador ACP terminó (${code === null ? `señal ${signal}` : `código ${code}`}).`,
  activityLabel: "Actividad",
  activityUnavailable: "Esta actividad ya no está disponible.",
  toolCount: (count) => `${count} ${plural(count, "herramienta", "herramientas")}`,
  categoryCount: {
    read: (count) => `${count} ${plural(count, "lectura", "lecturas")}`,
    search: (count) => `${count} ${plural(count, "búsqueda", "búsquedas")}`,
    edit: (count) => `${count} ${plural(count, "edición", "ediciones")}`,
    create: (count) => `${count} ${plural(count, "archivo nuevo", "archivos nuevos")}`,
    command: (count) => `${count} ${plural(count, "comando", "comandos")}`,
    fetch: (count) => `${count} ${plural(count, "consulta web", "consultas web")}`,
    subagent: (count) => `${count} ${plural(count, "subagente", "subagentes")}`,
    plan: (count) => `${count} ${plural(count, "plan", "planes")}`,
  },
  failedCount: (count) => `${count} ${plural(count, "falló", "fallaron")}`,
  lineCount: (count) => `${count} ${plural(count, "línea", "líneas")}`,
  resultCount: (count) => `${count} ${plural(count, "resultado", "resultados")}`,
  inScope: (scope) => `en ${scope}`,
  failedChip: "FALLÓ",
  awaitingApproval: "esperando aprobación",
  rejected: "rechazada",
  interrupted: "interrumpida",
  thinkingFor: (seconds) => `Pensando ${seconds} s`,
  thoughtFor: (seconds) => `Pensó ${seconds} s`,
  modeLabel: { default: "⏸\uFE0E modo manual", acceptEdits: "⏵⏵ ediciones automáticas", plan: "◇ modo plan" },
  modeCommandDescription: "Cambiá el modo de permisos: manual, edits o plan",
  modeChoose: "Modo de permisos",
  modeUnknown: (value) => `Modo desconocido: ${value}. Usá manual, edits o plan.`,
  planQuestion: "¿Ejecutar este plan?",
  planAcceptEdits: "Sí, y aceptar ediciones automáticas",
  planManual: "Sí, aprobar ediciones a mano",
  planKeep: "No, seguir planificando",
  planFeedback: "¿Qué cambio en el plan?",
  planApproved: "aprobado",
  subagentsTitle: "Subagentes",
  moreRows: (count) => `… ${count} más, Ctrl+O para ver todo`,
};

const CATALOGS: Record<string, Messages> = { en: EN, es: ES };

/** The language of the first locale variable set, else of `intlLocale`. Languages without a catalog read English. */
export function localeFrom(env: Partial<Record<string, string>>, intlLocale: string): Locale {
  const tag = LOCALE_VARIABLES.map((name) => env[name]).find(Boolean) ?? intlLocale;
  return catalogLocale(languageOf(tag));
}

/** "es_AR.UTF-8", "es-419" and "es@euro" all name the language "es". */
function languageOf(tag: string): string {
  return tag.split(/[_.@-]/)[0]?.toLowerCase() ?? "";
}

function catalogLocale(language: string): Locale {
  return Object.hasOwn(CATALOGS, language) ? (language as Locale) : "en";
}

export function messagesFor(locale: Locale): Messages {
  return CATALOGS[locale] ?? EN;
}

/** The catalog for this process's locale. */
export const copy: Messages = messagesFor(
  localeFrom(process.env, Intl.DateTimeFormat().resolvedOptions().locale),
);
