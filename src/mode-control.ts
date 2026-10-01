import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { copy } from "./messages.ts";
import { isModeId, MODES, type ModeId, nextMode, savedMode } from "./modes.ts";
import { usesClaudeAcp } from "./sessions.ts";

/** Footer key of the mode indicator. */
const STATUS_KEY = "claude-acp-mode";
export const MODE_SHORTCUT = "alt+m";
/** The names `/mode` accepts. */
const MODE_NAMES = new Map<string, ModeId>([
  ["manual", "default"],
  ["edits", "acceptEdits"],
  ["plan", "plan"],
]);
const MODE_COLORS: Record<ModeId, "muted" | "warning" | "accent"> = {
  default: "muted",
  acceptEdits: "warning",
  plan: "accent",
};

type Context = Pick<ExtensionContext, "sessionManager" | "ui" | "model">;

export interface ModeControlDeps {
  /** Applies the mode to the live ACP session of a Pi session. */
  applyMode(piSessionId: string, mode: ModeId): Promise<void>;
  /** Records the mode in the current Pi session. */
  persist(mode: ModeId): void;
}

/** The mode of each Pi session: what the user picks, what the agent switches to, and the footer. */
export class ModeControl {
  readonly #modes = new Map<string, ModeId>();
  /** Pi sessions whose approved plan continues in auto-accept edits (plan-approval.ts). */
  readonly #editsAfterPlan = new Set<string>();

  constructor(private readonly deps: ModeControlDeps) {}

  load(piSessionId: string, entries: SessionEntry[]): void {
    this.#modes.set(piSessionId, savedMode(entries));
  }

  get(piSessionId: string): ModeId {
    return this.#modes.get(piSessionId) ?? "default";
  }

  /** The user picked `mode`. */
  async choose(ctx: Context, mode: ModeId): Promise<void> {
    this.#record(ctx, mode);
    await this.deps.applyMode(ctx.sessionManager.getSessionId(), mode);
  }

  /** `alt+m`: the next mode, while a claude-acp model is active. */
  cycle(ctx: Context): Promise<void> {
    if (!usesClaudeAcp(ctx.model)) return Promise.resolve();
    return this.choose(ctx, nextMode(this.get(ctx.sessionManager.getSessionId())));
  }

  /** `/mode [manual|edits|plan]`; without a name, a dialog lists the modes. */
  command(args: string, ctx: Context): Promise<void> {
    const name = args.trim();
    return name ? this.#chooseNamed(name, ctx) : this.#chooseFromDialog(ctx);
  }

  /** The agent changed its own mode. A plan approved with auto-accept edits lands in Manual first. */
  async agentChanged(ctx: Context, modeId: string): Promise<void> {
    if (!isModeId(modeId)) return;
    if (this.#editsFollow(ctx.sessionManager.getSessionId(), modeId)) return this.choose(ctx, "acceptEdits");
    this.#record(ctx, modeId);
  }

  acceptEditsAfterPlan(piSessionId: string): void {
    this.#editsAfterPlan.add(piSessionId);
  }

  /** The indicator shows only while a claude-acp model is active. */
  showStatus(ctx: Context): void {
    const mode = this.get(ctx.sessionManager.getSessionId());
    const text = `${ctx.ui.theme.fg(MODE_COLORS[mode], copy.modeLabel[mode])} ${ctx.ui.theme.fg("dim", `(${MODE_SHORTCUT})`)}`;
    ctx.ui.setStatus(STATUS_KEY, usesClaudeAcp(ctx.model) ? text : undefined);
  }

  #editsFollow(piSessionId: string, modeId: ModeId): boolean {
    return modeId === "default" && this.#editsAfterPlan.delete(piSessionId);
  }

  #record(ctx: Context, mode: ModeId): void {
    this.#modes.set(ctx.sessionManager.getSessionId(), mode);
    this.deps.persist(mode);
    this.showStatus(ctx);
  }

  async #chooseNamed(name: string, ctx: Context): Promise<void> {
    const mode = MODE_NAMES.get(name);
    if (mode) return this.choose(ctx, mode);
    ctx.ui.notify(copy.modeUnknown(name), "error");
  }

  async #chooseFromDialog(ctx: Context): Promise<void> {
    const mode = await this.#ask(ctx);
    if (mode) await this.choose(ctx, mode);
  }

  async #ask(ctx: Context): Promise<ModeId | undefined> {
    const label = await ctx.ui.select(
      copy.modeChoose,
      MODES.map((mode) => copy.modeLabel[mode]),
    );
    return MODES.find((mode) => copy.modeLabel[mode] === label);
  }
}
