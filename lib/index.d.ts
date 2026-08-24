/**
 * dsh-plugin-usage-meter — host half type surface.
 *
 * Serves `GET /usage-meter/state` (`{ grand, days, hours, today, sessions,
 * models, balance, pricing, pricingHistory, serverNow }` — `days`/`hours`
 * (today only) carry a per-model split `{ total, models: { [model]: Buckets } }`
 * for the stacked chart; `models` aggregates usage per model; `pricingHistory`
 * lists effective-interval list-price snapshots), `POST /usage-meter/balance/refresh`,
 * `GET /usage-meter/update-check` and `POST /usage-meter/update` (npm latest +
 * one-click `dsh plugin add`); folds live `session/event` usage into a pruned,
 * atomically persisted ledger under `$DSH_HOME/usage-meter/`.
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
