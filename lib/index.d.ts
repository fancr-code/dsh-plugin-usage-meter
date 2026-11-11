/**
 * dsh-plugin-usage-meter — host half type surface (Harness 0.2.x).
 *
 * Serves `GET /usage-meter/state` (`{ grand, days, hours, today, sessions,
 * models, balance, pricing, pricingHistory, settings, serverNow }` —
 * `days`/`hours` (today only) carry a per-model split
 * `{ total: Buckets, models: { [model]: Buckets } }` for the stacked chart),
 * `GET /usage-meter/update-check`, and `POST /usage-meter/balance/refresh`;
 * folds live `session/event` payloads into a pruned, atomically persisted
 * ledger under `$DSH_HOME/usage-meter/`.
 *
 * Settings live in the profile entry Config (`currency`, `budget`, `pricing`),
 * are rendered by Settings → Plugins, and are auto-imported once from the
 * legacy `$DSH_HOME/settings.yaml` by Harness 0.2.2.
 */

/** User-visible plugin settings (profile entry Config). */
export interface UsageMeterSettings {
  /** Display/estimate currency. */
  currency: "CNY" | "USD";
  /** Daily budget; 0 disables the budget bar. */
  budget: number;
  /** Per-model list-price overrides (CNY per 1M tokens). */
  pricing: Record<string, { peak?: Record<string, number>; offPeak?: Record<string, number> }>;
}

/** Stable Cordis plugin name. */
export declare const name: "usage-meter";

/** Services required: the web server for routes and the session store for the ledger fold. */
export declare const inject: ["webServer", "sessions"];

/**
 * Schemastery schema for the profile entry config. Fields are `volatile`, so
 * Settings → Plugins can rewrite them without remounting the plugin.
 */
export declare const Config: unknown;

/** Host context surface this plugin uses. */
export interface UsageMeterContext {
  webServer: {
    register(route: {
      kind: "prefix" | "exact";
      path: string;
      handler: (req: unknown, res: unknown) => unknown;
    }): unknown;
  };
  sessions: unknown;
  fiber?: { config?: unknown; effectiveConfig?: unknown };
  get(service: string): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  effect(callback: () => unknown | (() => void), label?: string): unknown;
  logger?: { warn(message: string, ...args: unknown[]): void };
}

/**
 * Mount the host half.
 * @param ctx - host context (also exposes the running fiber for live Config reads).
 * @param config - resolved Config snapshot (volatile values are wrappers with `.get()`).
 */
export declare function apply(ctx: UsageMeterContext, config?: unknown): void;

/** Normalize a (possibly volatile-wrapped) Config snapshot for the browser half. */
export declare function normalizeConfig(config: unknown): UsageMeterSettings;

/** Parse the legacy `usage-meter:` section of a `settings.yaml` document. */
export declare function parseUsageMeterSettings(text: string): UsageMeterSettings | null;

/** Fold one session event into the per-session fold state (exported for regression tests). */
export declare function foldSessionEvent(
  state: { model?: string; usage: Record<string, number>; last: unknown },
  event: { type?: string; data?: Record<string, unknown>; time?: number; seq?: number },
): Record<string, number>;

/** Parse the official pricing page (exported for regression tests). */
export declare function parsePricing(html: string): {
  models: Record<string, { peak: Record<string, number>; offPeak: Record<string, number> }>;
  peakHours?: unknown;
} | null;
