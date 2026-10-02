import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  ElicitationSchema,
  EnumOption,
} from "@agentclientprotocol/sdk";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { oneAtATime } from "./dialogs.ts";
import { copy } from "./messages.ts";
import { printable } from "./terminal-text.ts";

/** claude-agent-acp pairs each AskUserQuestion question with a free-text `<key>_custom` field (elicitation.js:131). */
const CUSTOM_SUFFIX = "_custom";

export interface ElicitContext {
  /** Undefined when Pi has no dialog UI. */
  ui: Pick<ExtensionUIContext, "select" | "input" | "confirm"> | undefined;
  /** Aborts when the turn is cancelled. */
  signal?: AbortSignal;
}

type Ui = NonNullable<ElicitContext["ui"]>;
type Content = Record<string, ElicitationContentValue>;
type Choice = { value: string; label: string };

interface Field {
  key: string;
  property: ElicitationPropertySchema;
  title: string;
  /** The adapter offers a free-text answer next to this question. */
  ownAnswer: boolean;
}

/**
 * Answers an ACP form elicitation (AskUserQuestion, MCP forms) with Pi dialogs, one field at a time.
 * Dismissing a dialog declines the form, which Claude Code reads as "the user skipped".
 */
export async function answerElicitation(
  request: CreateElicitationRequest,
  ctx: ElicitContext,
): Promise<CreateElicitationResponse> {
  const ui = ctx.ui;
  if (!ui || !("requestedSchema" in request)) return { action: "decline" };
  const { requestedSchema } = request as { requestedSchema: ElicitationSchema };
  const content = await oneAtATime(() => fillForm(fields(request.message, requestedSchema), ui, ctx.signal));
  return response(content, ctx.signal);
}

function response(content: Content | undefined, signal: AbortSignal | undefined): CreateElicitationResponse {
  if (signal?.aborted) return { action: "cancel" };
  return accepted(content);
}

function accepted(content: Content | undefined): CreateElicitationResponse {
  return content ? { action: "accept", content } : { action: "decline" };
}

/** The fields to ask, in order; `_custom` companions are offered inside their question. */
function fields(message: string, schema: ElicitationSchema): Field[] {
  const properties = schema.properties ?? {};
  const isCompanion = (key: string) =>
    key.endsWith(CUSTOM_SUFFIX) && key.slice(0, -CUSTOM_SUFFIX.length) in properties;
  return Object.entries(properties)
    .filter(([key]) => !isCompanion(key))
    .map(([key, property]) => ({
      key,
      property,
      title: fieldTitle(message, property),
      ownAnswer: `${key}${CUSTOM_SUFFIX}` in properties,
    }));
}

/** The agent or an MCP server writes every text of the form. */
function fieldTitle(message: string, property: ElicitationPropertySchema): string {
  const { title, description } = property as { title?: string | null; description?: string | null };
  return printable([title, description || message].filter(Boolean).join(" · "));
}

async function fillForm(
  fields: Field[],
  ui: Ui,
  signal: AbortSignal | undefined,
): Promise<Content | undefined> {
  const content: Content = {};
  for (const field of fields) {
    const answer = await ASK[fieldKind(field.property)](field, ui, signal);
    if (!answer) return undefined;
    Object.assign(content, answer);
  }
  return content;
}

type Kind = "select" | "multi" | "boolean" | "number" | "text";
type Ask = (field: Field, ui: Ui, signal: AbortSignal | undefined) => Promise<Content | undefined>;

const KIND_BY_TYPE: Record<string, Kind> = {
  array: "multi",
  boolean: "boolean",
  number: "number",
  integer: "number",
};

function fieldKind(property: ElicitationPropertySchema): Kind {
  return KIND_BY_TYPE[property.type] ?? (choices(property).length > 0 ? "select" : "text");
}

const ASK: Record<Kind, Ask> = {
  select: askSelect,
  multi: askMulti,
  boolean: async (field, ui, signal) => ({ [field.key]: await ui.confirm(field.title, "", { signal }) }),
  number: async (field, ui, signal) =>
    numberAnswer(field.key, await ui.input(field.title, undefined, { signal })),
  text: async (field, ui, signal) =>
    textAnswer(field.key, await ui.input(field.title, undefined, { signal })),
};

/** Options of a string `oneOf`/`enum` or of an array's `anyOf`/`enum` items. */
function choices(property: ElicitationPropertySchema): Choice[] {
  const source = (property as { items?: unknown }).items ?? property;
  const titled = enumOptions(source).map((option) => ({ value: option.const, label: optionLabel(option) }));
  return titled.length > 0
    ? titled
    : plainValues(source).map((value) => ({ value, label: printable(value) }));
}

function enumOptions(source: unknown): EnumOption[] {
  const { oneOf, anyOf } = source as { oneOf?: EnumOption[]; anyOf?: EnumOption[] };
  return oneOf ?? anyOf ?? [];
}

function plainValues(source: unknown): string[] {
  return (source as { enum?: string[] }).enum ?? [];
}

function optionLabel(option: EnumOption): string {
  return printable(option.description ? `${option.title} — ${option.description}` : option.title);
}

async function askSelect(
  field: Field,
  ui: Ui,
  signal: AbortSignal | undefined,
): Promise<Content | undefined> {
  const options = choices(field.property);
  const label = await ui.select(field.title, selectLabels(field, options), { signal });
  if (label !== copy.ownAnswer)
    return textAnswer(field.key, options.find((option) => option.label === label)?.value);
  return textAnswer(`${field.key}${CUSTOM_SUFFIX}`, await ui.input(field.title, undefined, { signal }));
}

function selectLabels(field: Field, options: Choice[]): string[] {
  const labels = options.map((option) => option.label);
  return field.ownAnswer ? [...labels, copy.ownAnswer] : labels;
}

async function askMulti(field: Field, ui: Ui, signal: AbortSignal | undefined): Promise<Content | undefined> {
  const picked = await pickMany(field.title, choices(field.property), new Set(), ui, signal);
  return picked && { [field.key]: [...picked] };
}

/** Pi has no multi-select dialog: each pick toggles one option until the user chooses "Listo". */
async function pickMany(
  title: string,
  options: Choice[],
  picked: Set<string>,
  ui: Ui,
  signal: AbortSignal | undefined,
): Promise<Set<string> | undefined> {
  const labels = options.map((option) => `${picked.has(option.value) ? "[x]" : "[ ]"} ${option.label}`);
  const label = await ui.select(title, [...labels, copy.done], { signal });
  if (label === copy.done) return picked;
  if (label === undefined) return undefined;
  return pickMany(title, options, toggle(picked, options[labels.indexOf(label)]), ui, signal);
}

function toggle(picked: Set<string>, option: Choice | undefined): Set<string> {
  const next = new Set(picked);
  if (option && !next.delete(option.value)) next.add(option.value);
  return next;
}

function textAnswer(key: string, text: string | undefined): Content | undefined {
  return text === undefined ? undefined : { [key]: text };
}

function numberAnswer(key: string, text: string | undefined): Content | undefined {
  const value = Number(text);
  return text === undefined || Number.isNaN(value) ? undefined : { [key]: value };
}
