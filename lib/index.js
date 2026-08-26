/**
 * dsh-plugin-usage-meter — host half.
 *
 * Tracks provider-reported token usage across every live session (the same
 * last-sample-replacing fold the built-in `tokenUsage` projection uses), keeps
 * a persistent ledger under `$DSH_HOME/usage-meter/ledger.json` (per-day and
 * grand totals plus per-session model/usage), and serves a small JSON API to
 * the browser half:
 *
 *   GET  /usage-meter/state           -> { grand, days, hours, today, sessions, models, balance, serverNow }
 *   POST /usage-meter/balance/refresh -> force a fresh DeepSeek balance query
 *
 * `days` and `hours` (today only) carry a per-model split for the stacked
 * chart: `{ total: Buckets, models: { [model]: Buckets } }`.
 *
 * The browser half owns pricing, currency, and budget (see `./client`), so this
 * half stores raw token buckets and the per-session model only — no money math.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Stable Cordis plugin name. */
const name = "usage-meter";
/** Services required: the web server for routes and the session store for the ledger fold. */
const inject = ["webServer", "sessions"];

/** The DeepSeek credential reference (web Models page / env `DEEPSEEK_API_KEY`). */
const CREDENTIAL_REF = "DEEPSEEK_API_KEY";
/** DeepSeek public API base; overridable via `$DEEPSEEK_BASE_URL` (honoured by the provider too). */
const BALANCE_BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
/** Balance cache TTL (ms) — kept short so the chip balance stays fresh. */
const BALANCE_TTL_MS = 30_000;
/** Balance query timeout (ms) — a hung endpoint must not stall /state. */
const BALANCE_TIMEOUT_MS = 10_000;
/** Official pricing page: parsed at runtime so list-price changes are picked up automatically. */
const PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";
/** Pricing cache TTL (ms) — the page rarely changes; refresh once a day. */
const PRICING_TTL_MS = 24 * 3600e3;
/** Pricing fetch timeout (ms). */
const PRICING_TIMEOUT_MS = 15_000;
/** npm registry metadata for the self update check. */
const UPDATE_CHECK_URL = "https://registry.npmjs.org/dsh-plugin-usage-meter/latest";
/** Update-check cache TTL (ms). */
const UPDATE_CHECK_TTL_MS = 10 * 60_000;
/** `dsh plugin add` self-update timeout (ms). */
const UPDATE_TIMEOUT_MS = 180_000;
/** Persist debounce (ms). */
const PERSIST_DELAY_MS = 2_000;
/** Ledger retention: keep this many days of daily buckets. */
const PRUNE_DAYS = 180;
/** Drop zero-usage session entries older than this (ms). */
const PRUNE_SESSIONS_MS = 90 * 86_400_000;

/** 官方账单（平台 dashboard 用量接口）需要的平台 token 凭证名。 */
const PLATFORM_REF = "DEEPSEEK_PLATFORM_TOKEN";
/** DeepSeek 平台 dashboard 的按日费用接口（与网页控制台同源数据）。 */
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/api/v0/usage/cost";
/** 官方账单缓存 TTL（ms）。 */
const BILL_TTL_MS = 10 * 60_000;
/** 平台接口超时（ms）。 */
const BILL_TIMEOUT_MS = 15_000;

/** 定价历史种子：内置快照（2026-08-17 抓取）作为最早生效区间（USD/1M）。 */
const PRICING_HISTORY_SEED = {
  since: "2026-08-17",
  peakHours: [[1, 4], [6, 10], "weekdays"],
  models: {
    "deepseek-v4-flash": { peak: { miss: 0.44, hit: 0.014, out: 1.32 }, offPeak: { miss: 0.22, hit: 0.007, out: 0.66 } },
    "deepseek-v4-pro": { peak: { miss: 1.32, hit: 0.044, out: 3.96 }, offPeak: { miss: 0.66, hit: 0.022, out: 1.98 } },
  },
};

/** 本插件自身版本（随包 package.json）。 */
let PKG_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  if (typeof pkg?.version === "string") PKG_VERSION = pkg.version;
} catch {
  /* keep fallback */
}

/** 三段式 semver 比较：a > b 时返回正数。 */
function compareVersions(a, b) {
  const pa = String(a).split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** 定位 dsh CLI（lib/bin.js）：进程启动参数优先，其次 DSH_CLI 环境变量。 */
function findDshBin() {
  const argv1 = process.argv?.[1];
  if (typeof argv1 === "string" && argv1 && existsSync(argv1) && /[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(argv1.replaceAll("\\", "/"))) return argv1;
  const env = process.env.DSH_CLI;
  if (typeof env === "string" && env && existsSync(env)) return env;
  return null;
}

/** 浏览器 Local Storage leveldb 目录候选（Edge / Chrome / Chromium 的全部 Profile）。 */
function browserLocalStorageDirs() {
  const dirs = [];
  const local = process.env.LOCALAPPDATA ?? (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local") : "");
  if (!local) return dirs;
  for (const rel of ["Microsoft\\Edge\\User Data", "Google\\Chrome\\User Data", "Chromium\\User Data"]) {
    const base = join(local, rel);
    try {
      if (!statSync(base).isDirectory()) continue;
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const ls = join(base, e.name, "Local Storage", "leveldb");
        if (existsSync(ls)) dirs.push(ls);
      }
    } catch {
      /* skip unreadable profile */
    }
  }
  return dirs;
}

/**
 * 从本机浏览器 Local Storage 自动提取 platform.deepseek.com 的 `userToken`
 * （无需手动复制；用户保持浏览器登录即可）。返回 token 或 null。
 * 仅在未配置 DEEPSEEK_PLATFORM_TOKEN 凭据/环境变量时使用。
 *
 * 注意：leveldb 里 origin 与 userToken 可能落在**不同文件**（跨 .ldb 分片），
 * 所以 origin 标记按目录判断、token 候选按文件提取，最后由平台接口校验。
 */
function scanBrowserPlatformToken() {
  let best = null;
  for (const dir of browserLocalStorageDirs()) {
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".ldb") || f.endsWith(".log"));
    } catch {
      continue;
    }
    // 目录级 origin 标记：该目录确实存过 platform.deepseek.com 的数据
    let dirHasPlatform = false;
    const fileBodies = [];
    for (const f of files) {
      let buf = null;
      try {
        buf = readFileSync(join(dir, f));
      } catch {
        continue; // 被浏览器独占的文件跳过（新写入通常在 .log，Node 共享读一般可读）
      }
      fileBodies.push(buf);
      if (!dirHasPlatform) {
        if (buf.toString("latin1").includes("platform.deepseek.com") || buf.toString("utf16le").includes("platform.deepseek.com")) {
          dirHasPlatform = true;
        }
      }
    }
    if (!dirHasPlatform) continue;
    for (const buf of fileBodies) {
      // localStorage 字符串可能以 latin1 或 UTF-16LE 落盘，两种都扫
      const reps = [buf.toString("latin1"), buf.toString("utf16le")];
      for (const hay of reps) {
        if (!hay.includes("userToken")) continue;
        let idx = 0;
        while ((idx = hay.indexOf("userToken", idx)) >= 0) {
          const window = hay.slice(Math.max(0, idx - 80), idx + 240);
          const cands = window.match(/[A-Za-z0-9_+\-/=]{40,}/g) ?? [];
          for (const c of cands) {
            if (c.includes("://") || c.includes("platform.deepseek.com")) continue;
            const clean = c.replace(/^[/=+\-]+|[/=+\-]+$/g, "");
            if (clean.length < 40) continue;
            if (best === null || clean.length > best.length) best = clean;
          }
          idx += 9;
        }
      }
    }
  }
  return best;
}

/** Data directory under the Harness home. */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const LEDGER_PATH = join(DSH_HOME, "usage-meter", "ledger.json");

/** Token buckets: the four disjoint provider billing classes. */
const zeroBuckets = () => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
const bucketsFrom = (usage) => ({
  uncachedInputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
});
const addBuckets = (a, b) => ({
  uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
const subBuckets = (a, b) => ({
  uncachedInputTokens: a.uncachedInputTokens - b.uncachedInputTokens,
  outputTokens: a.outputTokens - b.outputTokens,
  cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
});
const isZeroBuckets = (b) =>
  b.uncachedInputTokens === 0 && b.outputTokens === 0 && b.cacheReadTokens === 0 && b.cacheWriteTokens === 0;
const bucketsEqual = (a, b) =>
  a.uncachedInputTokens === b.uncachedInputTokens &&
  a.outputTokens === b.outputTokens &&
  a.cacheReadTokens === b.cacheReadTokens &&
  a.cacheWriteTokens === b.cacheWriteTokens;

/** Extract one provider usage sample from a durable event, or undefined. */
function usageSampleOf(event) {
  if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.chunk.usage };
  }
  if (event.type === "assistant/message" && event.data?.usage !== undefined) {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.usage };
  }
  return undefined;
}

/** Local calendar day key for an epoch-ms timestamp (wall-clock bucketing). */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Fold one event into a session state (mutates `state`). Returns the usage delta. */
function foldSessionEvent(state, event) {
  const before = state.usage;
  if (event.type === "request/header") {
    const model = event.data?.header?.config?.model;
    if (typeof model === "string" && model.length > 0) state.model = model;
  }
  const sample = usageSampleOf(event);
  if (sample !== undefined) {
    const buckets = bucketsFrom(sample.usage);
    const previous =
      state.last !== null && state.last.turn === sample.turn && state.last.step === sample.step
        ? state.last.buckets
        : undefined;
    if (previous === undefined || !bucketsEqual(previous, buckets)) {
      state.usage = addBuckets(subBuckets(state.usage, previous ?? zeroBuckets()), buckets);
      state.last = { turn: sample.turn, step: sample.step, buckets };
    }
  }
  return subBuckets(state.usage, before);
}

/** Serialize the in-memory ledger for persistence (days/sessions are plain objects). */
function apply(ctx) {
  /** Live fold state per session id (seeded from the persisted ledger). */
  const states = new Map();

  /** The persisted ledger shape. */
  const ledger = {
    grand: zeroBuckets(),
    grandModels: {},
    days: {},
    hours: {},
    sessions: {},
    pricingHistory: [],
  };

  let loaded = false;
  let persistTimer = null;
  let seededPricingHistory = false;
  let repairedDays = false;

  async function load() {
    try {
      const raw = JSON.parse(await readFile(LEDGER_PATH, "utf8"));
      if (raw && typeof raw === "object") {
        if (raw.grand && typeof raw.grand === "object") ledger.grand = { ...zeroBuckets(), ...raw.grand };
        const hasGrandModels = raw.grandModels && typeof raw.grandModels === "object";
        if (raw.days && typeof raw.days === "object") {
          for (const [d, b] of Object.entries(raw.days)) {
            if (!b || typeof b !== "object") continue;
            if (typeof b.uncachedInputTokens === "number") {
              // v1 ledger: a plain bucket — wrap without model attribution.
              ledger.days[d] = { total: { ...zeroBuckets(), ...b }, models: {} };
            } else {
              const day = { total: { ...zeroBuckets(), ...(b.total ?? {}) }, models: {} };
              if (b.models && typeof b.models === "object") {
                for (const [m, mb] of Object.entries(b.models)) {
                  if (mb && typeof mb === "object") day.models[m] = { ...zeroBuckets(), ...mb };
                }
              }
              ledger.days[d] = day;
            }
          }
        }
        if (raw.hours && typeof raw.hours === "object") {
          for (const [d, hm] of Object.entries(raw.hours)) {
            if (!hm || typeof hm !== "object") continue;
            const day = {};
            for (const [h, he] of Object.entries(hm)) {
              if (!he || typeof he !== "object") continue;
              const hour = { total: { ...zeroBuckets(), ...(he.total ?? {}) }, models: {} };
              if (he.models && typeof he.models === "object") {
                for (const [m, mb] of Object.entries(he.models)) {
                  if (mb && typeof mb === "object") hour.models[m] = { ...zeroBuckets(), ...mb };
                }
              }
              day[h] = hour;
            }
            ledger.hours[d] = day;
          }
        }
        // 数据一致性修复：历史天的模型拆分可能不完整（v1→按模型记账迁移只归属了
        // 部分用量），把“日总量 − Σ模型桶”的残差挂到 unknown，保证按模型计价不漏算。
        for (const day of Object.values(ledger.days)) {
          const models = day?.models;
          if (!models || typeof models !== "object") continue;
          const residual = zeroBuckets();
          for (const key of ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
            let sum = 0;
            for (const mb of Object.values(models)) {
              if (mb && typeof mb === "object") sum += mb[key] ?? 0;
            }
            const r = (day.total?.[key] ?? 0) - sum;
            if (r > 0) residual[key] = r;
          }
          if (!isZeroBuckets(residual)) {
            models["unknown"] = addBuckets(models["unknown"] ?? zeroBuckets(), residual);
            repairedDays = true;
          }
        }
        if (raw.sessions && typeof raw.sessions === "object") {
          for (const [id, s] of Object.entries(raw.sessions)) {
            if (!s || typeof s !== "object") continue;
            const usage = { ...zeroBuckets(), ...(s.usage ?? {}) };
            const st = {
              model: typeof s.model === "string" ? s.model : undefined,
              usage,
              lastSeq: Number.isInteger(s.lastSeq) ? s.lastSeq : 0,
              last: s.last && Number.isInteger(s.last.turn) ? { turn: s.last.turn, step: s.last.step, buckets: { ...zeroBuckets(), ...s.last.buckets } } : null,
            };
            states.set(id, st);
            ledger.sessions[id] = { model: st.model, usage: { ...usage }, updatedAt: s.updatedAt ?? 0 };
            if (!hasGrandModels) {
              // Backfill the v1 approximation: attribute whole-session usage to its last model.
              const m = typeof st.model === "string" && st.model.length > 0 ? st.model : "unknown";
              ledger.grandModels[m] = addBuckets(ledger.grandModels[m] ?? zeroBuckets(), usage);
            }
          }
        }
        if (hasGrandModels) {
          for (const [m, b] of Object.entries(raw.grandModels)) {
            if (b && typeof b === "object") ledger.grandModels[m] = { ...zeroBuckets(), ...b };
          }
        }
        if (Array.isArray(raw.pricingHistory)) {
          ledger.pricingHistory = raw.pricingHistory.filter(
            (e) => e && typeof e === "object" && typeof e.since === "string" && e.models && typeof e.models === "object",
          );
        }
      }
    } catch {
      /* missing/corrupt ledger starts empty */
    }
    if (ledger.pricingHistory.length === 0) {
      ledger.pricingHistory = [JSON.parse(JSON.stringify(PRICING_HISTORY_SEED))];
      seededPricingHistory = true;
    }
    pruneLedger();
    loaded = true;
    if (seededPricingHistory || repairedDays) schedulePersist();
  }

  /** Drop daily buckets beyond retention, stale zero-usage sessions, and non-today hour maps. */
  function pruneLedger() {
    const now = Date.now();
    const oldestDay = dayKey(now - PRUNE_DAYS * 86_400_000);
    for (const d of Object.keys(ledger.days)) if (d < oldestDay) delete ledger.days[d];
    const today = dayKey(now);
    for (const d of Object.keys(ledger.hours)) if (d !== today) delete ledger.hours[d];
    for (const [id, s] of Object.entries(ledger.sessions)) {
      if (isZeroBuckets(s.usage) && typeof s.updatedAt === "number" && now - s.updatedAt > PRUNE_SESSIONS_MS) {
        delete ledger.sessions[id];
      }
    }
  }

  function schedulePersist() {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist().catch(() => {});
    }, PERSIST_DELAY_MS);
  }

  async function persist() {
    pruneLedger();
    await mkdir(dirname(LEDGER_PATH), { recursive: true });
    // Atomic replace: write a temp file then rename, so a crash mid-write
    // never leaves a truncated ledger behind. Compact JSON halves the bytes.
    const tmp = `${LEDGER_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(ledger), "utf8");
    await rename(tmp, LEDGER_PATH);
  }

  /** Fold a session up to its current tail, attributing marginal deltas per event day. */
  function syncSession(session) {
    const id = session.id;
    let st = states.get(id);
    if (st === undefined) {
      st = { model: undefined, usage: zeroBuckets(), lastSeq: 0, last: null };
      states.set(id, st);
    }
    const events = session.events ?? [];
    let changed = false;
    while (st.lastSeq < events.length) {
      const event = events[st.lastSeq];
      st.lastSeq += 1;
      if (event === undefined) continue;
      const delta = foldSessionEvent(st, event);
      if (!isZeroBuckets(delta)) {
        const at = typeof event.time === "number" ? event.time : Date.now();
        const day = dayKey(at);
        const model = typeof st.model === "string" && st.model.length > 0 ? st.model : "unknown";
        const dayEntry = ledger.days[day] ?? (ledger.days[day] = { total: zeroBuckets(), models: {} });
        dayEntry.total = addBuckets(dayEntry.total, delta);
        dayEntry.models[model] = addBuckets(dayEntry.models[model] ?? zeroBuckets(), delta);
        ledger.grand = addBuckets(ledger.grand, delta);
        ledger.grandModels[model] = addBuckets(ledger.grandModels[model] ?? zeroBuckets(), delta);
        const hour = String(new Date(at).getHours());
        const hourMap = ledger.hours[day] ?? (ledger.hours[day] = {});
        const hourEntry = hourMap[hour] ?? (hourMap[hour] = { total: zeroBuckets(), models: {} });
        hourEntry.total = addBuckets(hourEntry.total, delta);
        hourEntry.models[model] = addBuckets(hourEntry.models[model] ?? zeroBuckets(), delta);
        changed = true;
      }
      if (event.type === "request/header") changed = true;
    }
    if (changed) {
      ledger.sessions[id] = { model: st.model, usage: { ...st.usage }, updatedAt: Date.now() };
      schedulePersist();
    }
  }

  // Balance cache.
  let balanceCache = null; // { ok, data?, error?, at }
  let balanceInflight = null;

  // Official pricing cache: parsed from the docs page (USD per 1M tokens).
  let pricingCache = null; // { ok, models?, peakHours?, error?, at }
  let pricingInflight = null;

  /** Strip tags/scripts and normalize whitespace from the docs HTML. */
  function stripHtml(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Parse the three pricing rows and the peak-hours rule out of the pricing page. */
  function parsePricing(html) {
    const text = stripHtml(html);
    if (!text.includes("deepseek-v4-flash") || !text.includes("PRICING")) return null;
    const section = text.slice(text.indexOf("PRICING"));
    const readRow = (label) => {
      const i = section.indexOf(label);
      if (i < 0) return null;
      const nums = section
        .slice(i + label.length, i + label.length + 500)
        .match(/\d+\.\d+/g);
      if (!nums || nums.length < 6) return null;
      const v = nums.map((n) => Number.parseFloat(n));
      // OFF-PEAK 三个（flash/pro/vision-exp），PEAK 三个
      return { offPeak: v.slice(0, 3), peak: v.slice(3, 6) };
    };
    const hit = readRow("1M INPUT TOKENS (CACHE HIT)");
    const miss = readRow("1M INPUT TOKENS (CACHE MISS)");
    const out = readRow("1M OUTPUT TOKENS");
    if (!hit || !miss || !out) return null;
    const names = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"];
    const models = {};
    names.forEach((n, idx) => {
      models[n] = {
        peak: { miss: miss.peak[idx], hit: hit.peak[idx], out: out.peak[idx] },
        offPeak: { miss: miss.offPeak[idx], hit: hit.offPeak[idx], out: out.offPeak[idx] },
      };
    });
    // 高峰时段规则（UTC，仅工作日）
    const h = section.match(/Peak hours are (\d{1,2}:\d{2}) - (\d{1,2}:\d{2}) and (\d{1,2}:\d{2}) - (\d{1,2}:\d{2}) UTC, Monday through Friday/);
    let peakHours = null;
    if (h) {
      const toH = (t) => {
        const [hh, mm] = t.split(":").map((x) => Number.parseInt(x, 10));
        return hh + (mm || 0) / 60;
      };
      peakHours = [[toH(h[1]), toH(h[2])], [toH(h[3]), toH(h[4])], "weekdays"];
    }
    return { models, peakHours };
  }

  /** 官方价解析成功后：若与上一生效区间不同，追加一条定价历史快照（观测日 = 生效起点）。 */
  function recordPricingSnapshot(pricing) {
    if (!pricing?.ok || !pricing.models) return;
    const hist = Array.isArray(ledger.pricingHistory) ? ledger.pricingHistory : (ledger.pricingHistory = []);
    const last = hist[hist.length - 1];
    if (last && JSON.stringify(last.models) === JSON.stringify(pricing.models)) return;
    hist.push({ since: dayKey(Date.now()), models: pricing.models, peakHours: pricing.peakHours ?? null });
    if (hist.length > 24) hist.splice(0, hist.length - 24);
    schedulePersist();
  }

  /** Fetch + parse the official pricing page (daily cache, graceful fallback). */
  async function pricing() {
    const now = Date.now();
    if (pricingCache !== null && now - pricingCache.at < PRICING_TTL_MS) return pricingCache;
    if (pricingInflight !== null) return pricingInflight;
    pricingInflight = (async () => {
      let result = { ok: false, error: "transport" };
      try {
        const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(PRICING_TIMEOUT_MS) });
        if (res.ok) {
          const parsed = parsePricing(await res.text());
          if (parsed && parsed.models["deepseek-v4-flash"] && parsed.models["deepseek-v4-pro"]) {
            result = { ok: true, ...parsed, source: "official", at: Date.now() };
          } else {
            result = { ok: false, error: "parse_failed" };
          }
        } else {
          result = { ok: false, error: `http_${res.status}` };
        }
      } catch (error) {
        result = { ok: false, error: "transport", message: String(error?.message ?? error) };
      }
      pricingCache = result;
      pricingInflight = null;
      if (result.ok && loaded) recordPricingSnapshot(result);
      return pricingCache;
    })();
    return pricingInflight;
  }

  // Self-update check cache.
  let updateCheckCache = null; // { at, current, latest, newer, error? }

  // 官方账单缓存：{ ok, days, today, month, error?, at, source }
  let billCache = null;
  let billInflight = null;
  let scannedTokenInvalidUntil = 0;

  function localDayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** 平台 dashboard 按日费用接口（Bearer userToken 鉴权，与网页控制台同源）。 */
  async function fetchPlatformBilling(token) {
    const now = new Date();
    const url = `${PLATFORM_USAGE_URL}?month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "x-app-version": "1.0.0",
        Origin: "https://platform.deepseek.com",
        Referer: "https://platform.deepseek.com/usage",
      },
      signal: AbortSignal.timeout(BILL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`platform usage HTTP ${res.status}`);
    const body = await res.json();
    const biz = body && typeof body === "object" ? body.data : undefined;
    if (body?.code !== 0 || biz === undefined || biz.biz_code !== 0) {
      const code = body?.code ?? biz?.biz_code;
      if (code === 40002 || code === 40003) throw new Error("DEEPSEEK_PLATFORM_TOKEN 已过期：请重新登录 platform.deepseek.com 并更新 userToken");
      throw new Error(`platform usage error (code ${code ?? "unknown"})`);
    }
    const bizData = biz.biz_data;
    const container = Array.isArray(bizData) ? bizData[0] : bizData;
    const days = container && typeof container === "object" ? container.days : undefined;
    if (!Array.isArray(days)) return null;
    const byDay = {};
    for (const d of days) {
      if (!d || typeof d.date !== "string" || !Array.isArray(d.data)) continue;
      let total = 0;
      for (const modelEntry of d.data) {
        if (!modelEntry || typeof modelEntry !== "object" || !Array.isArray(modelEntry.usage)) continue;
        for (const u of modelEntry.usage) {
          if (!u || typeof u !== "object") continue;
          const v = u.cost ?? u.amount;
          const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
          if (Number.isFinite(n)) total += n;
        }
      }
      byDay[d.date] = Math.round(total * 100) / 100;
    }
    return byDay;
  }

  /** 官方账单（10 分钟缓存）：凭据/环境变量优先，其次自动读本机浏览器 token；失败优雅降级。 */
  async function bill() {
    const nowMs = Date.now();
    if (billCache !== null && nowMs - billCache.at < BILL_TTL_MS) return billCache;
    if (billInflight !== null) return billInflight;
    billInflight = (async () => {
      let result = { ok: false, error: "no_token", days: {}, today: null, month: null, at: nowMs, source: null };
      try {
        const credentials = ctx.get("credentials");
        let token;
        let source = null;
        if (credentials !== undefined) {
          const hit = await credentials.resolve(PLATFORM_REF);
          token = typeof hit === "string" ? hit : hit?.value;
          if (token) source = "credential";
        }
        if (!token && process.env.DEEPSEEK_PLATFORM_TOKEN) {
          token = process.env.DEEPSEEK_PLATFORM_TOKEN;
          source = "env";
        }
        // 自动导入：未配置时直接从本机浏览器 Local Storage 读取平台 userToken
        if (!token && process.env.USAGE_METER_AUTO_PLATFORM_TOKEN !== "0" && nowMs >= scannedTokenInvalidUntil) {
          token = scanBrowserPlatformToken();
          if (token) source = "browser";
        }
        // 诊断：自动扫描未命中时输出环境信息（仅 USAGE_METER_SCAN_DEBUG=1 时开启）
        if (!token && process.env.USAGE_METER_SCAN_DEBUG === "1") {
          const dirs = browserLocalStorageDirs();
          const diag = { localAppData: process.env.LOCALAPPDATA ?? null, dirCount: dirs.length, dirs: dirs.map((d) => { let n = 0; try { n = readdirSync(d).length; } catch { n = -1; } return `${d}#${n}`; }) };
          result.scanDiag = diag;
        }
        if (token) {
          const byDay = await fetchPlatformBilling(token);
          if (byDay && typeof byDay === "object") {
            const today = byDay[localDayKey()] ?? null;
            let month = 0;
            for (const v of Object.values(byDay)) if (typeof v === "number") month += v;
            month = Math.round(month * 100) / 100;
            result = { ok: true, days: byDay, today, month, at: nowMs, source };
          } else {
            result = { ok: false, error: "empty", days: {}, today: null, month: null, at: nowMs, source };
          }
        }
      } catch (error) {
        const message = String(error?.message ?? error);
        // token 过期（40002/40003）：冷却 30 分钟后再重新扫描，避免用坏 token 反复请求
        if (/40002|40003|过期/.test(message)) scannedTokenInvalidUntil = Date.now() + 30 * 60_000;
        result = { ok: false, error: message, days: {}, today: null, month: null, at: nowMs, source: null };
      }
      billCache = result;
      billInflight = null;
      return billCache;
    })();
    return billInflight;
  }

  /** npm registry 最新版查询（10 分钟缓存）。 */
  async function updateCheck() {
    const now = Date.now();
    if (updateCheckCache !== null && now - updateCheckCache.at < UPDATE_CHECK_TTL_MS) return updateCheckCache;
    let result = { at: now, current: PKG_VERSION, latest: null, newer: false };
    try {
      const res = await fetch(UPDATE_CHECK_URL, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const j = await res.json();
        const latest = typeof j?.version === "string" ? j.version : null;
        result.latest = latest;
        result.newer = latest !== null && compareVersions(latest, PKG_VERSION) > 0;
      } else {
        result.error = `http_${res.status}`;
      }
    } catch (error) {
      result.error = String(error?.message ?? error);
    }
    updateCheckCache = result;
    return updateCheckCache;
  }

  /** 一键更新：`dsh plugin --profile web add dsh-plugin-usage-meter`（pnpm add 即升级）。 */
  function runPluginUpdate() {
    const bin = findDshBin();
    if (!bin) return Promise.resolve({ ok: false, error: "dsh_cli_not_found" });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      let child;
      try {
        child = spawn(
          process.execPath,
          [bin, "plugin", "--profile", "web", "add", "dsh-plugin-usage-meter"],
          { windowsHide: true, stdio: "ignore" },
        );
      } catch (error) {
        return finish({ ok: false, error: String(error?.message ?? error) });
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: "timeout" });
      }, UPDATE_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        finish({ ok: false, error: String(error?.message ?? error) });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish({ ok: code === 0, code: code ?? null });
      });
    });
  }

  async function fetchBalance() {
    let key;
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const hit = await credentials.resolve(CREDENTIAL_REF);
      if (hit !== undefined && hit.value) key = hit.value;
    }
    if (!key) key = process.env[CREDENTIAL_REF];
    if (!key) return { ok: false, error: "no_api_key" };
    let res;
    try {
      res = await fetch(`${BALANCE_BASE}/user/balance`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, error: "transport", message: String(error?.message ?? error) };
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    try {
      const json = await res.json();
      return { ok: true, data: json };
    } catch {
      return { ok: false, error: "bad_json" };
    }
  }

  async function balance() {
    const now = Date.now();
    if (balanceCache !== null && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache;
    if (balanceInflight !== null) return balanceInflight;
    balanceInflight = (async () => {
      const result = await fetchBalance();
      balanceCache = { ...result, at: Date.now() };
      balanceInflight = null;
      return balanceCache;
    })();
    return balanceInflight;
  }

  function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }

  /** Aggregate usage per model across all recorded sessions (panel breakdown). */
  function modelsSummary() {
    return ledger.grandModels;
  }

  ctx.webServer.register({
    kind: "prefix",
    path: "/usage-meter",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const rawUrl = req.url ?? "/";
      if (rawUrl.includes("..")) {
        res.writeHead(403);
        res.end();
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(rawUrl, "http://x").pathname);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const rel = pathname.slice("/usage-meter".length).replace(/^\/+/, "");

      if (rel === "state") {
        const now = new Date();
        const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const sessions = {};
        for (const [id, s] of Object.entries(ledger.sessions)) sessions[id] = s;
        json(res, 200, {
          grand: ledger.grand,
          days: ledger.days,
          hours: ledger.hours[todayKey] ?? {},
          today: ledger.days[todayKey]?.total ?? zeroBuckets(),
          sessions,
          models: modelsSummary(),
          balance: await balance(),
          pricing: await pricing(),
          pricingHistory: ledger.pricingHistory,
          bill: await bill(),
          serverNow: Date.now(),
        });
        return;
      }

      if (rel === "balance/refresh") {
        balanceCache = null;
        billCache = null;
        json(res, 200, await balance());
        return;
      }

      if (rel === "update-check") {
        json(res, 200, await updateCheck());
        return;
      }

      if (rel === "update") {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        json(res, 200, await runPluginUpdate());
        return;
      }

      res.writeHead(404);
      res.end();
    },
  });

  // Fold live sessions and future events.
  ctx.on("session/event", (session) => {
    if (!loaded) return;
    try {
      syncSession(session);
    } catch (error) {
      ctx.logger?.warn?.("usage-meter: session fold failed: %s", String(error?.message ?? error));
    }
  });

  ctx.effect(() => {
    const ready = (async () => {
      await load();
      // Backfill every currently-live session (idempotent via lastSeq).
      const sessions = ctx.get("sessions");
      if (sessions !== undefined && typeof sessions.list === "function") {
        for (const session of sessions.list()) {
          try {
            syncSession(session);
          } catch {
            /* skip malformed session */
          }
        }
      }
    })();
    return () => {
      if (persistTimer !== null) clearTimeout(persistTimer);
    };
  }, "usage-meter: ledger lifecycle");
}

export { apply, inject, name };
