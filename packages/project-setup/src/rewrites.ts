// Restoring a config without fighting over it: the VS Code extension and the sf plugin's watch restore the
// `lwc` folders' configs whenever something changes them (see planMaintenance), and stop restoring one that
// something keeps rewriting, rather than rewriting it back and forth.

/** How many times one config is restored within REWRITE_WINDOW before it's left alone. */
export const MAX_REWRITES = 5;
/** The window MAX_REWRITES counts restores in, in milliseconds. */
export const REWRITE_WINDOW = 60_000;

/** What to do about restoring a config: write it, or stop (`"stop"` the first time, to say so once). */
export type RewriteDecision = "write" | "stop" | "stopped";

/** Counts each config's restores, and stops restoring one once it's restored MAX_REWRITES times within REWRITE_WINDOW. */
export class RewriteLimiter {
  readonly #rewrites = new Map<string, number[]>();
  readonly #stopped = new Set<string>();
  readonly #now: () => number;

  /** @param now the time in milliseconds, `Date.now` by default; tests replace it */
  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.#now = now;
  }

  /**
   * Whether to restore `file` now. `"write"` counts the restore. `"stop"` is the first time it's been
   * restored too often, for the caller to say it stopped, and `"stopped"` every time after.
   */
  rewrite(file: string): RewriteDecision {
    if (this.#stopped.has(file)) {
      return "stopped";
    }
    const now = this.#now();
    const recent = (this.#rewrites.get(file) ?? []).filter((time) => now - time < REWRITE_WINDOW);
    if (recent.length >= MAX_REWRITES) {
      this.#stopped.add(file);
      this.#rewrites.delete(file);
      return "stop";
    }
    this.#rewrites.set(file, [...recent, now]);
    return "write";
  }
}
