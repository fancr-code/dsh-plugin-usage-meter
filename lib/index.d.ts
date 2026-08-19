/**
 * dsh-plugin-usage-meter — host half type surface.
 *
 * Serves `GET /usage-meter/state` (`{ grand, days, hours, today, sessions,
 * models, balance, serverNow }` — `days`/`hours` (today only) carry a
 * per-model split `{ total, models: { [model]: Buckets } }` for the stacked
 * chart; `models` aggregates usage per model) and `POST /usage-meter/balance/refresh`;
 * folds live `session/event` usage into a pruned, atomically persisted ledger
 * under `$DSH_HOME/usage-meter/`.
 */
export declare const name: "usage-meter";
export declare const inject: ["webServer", "sessions"];
export declare function apply(ctx: {
  webServer: unknown;
  sessions: unknown;
  get(service: string): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  effect(callback: () => unknown | (() => void), label?: string): unknown;
  logger?: { warn(message: string, ...args: unknown[]): void };
}): void;
