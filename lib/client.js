window.__ModuleLoader__.load({
	id: "dsh-plugin-usage-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region usage meter
		/** Locale namespace. */
		const NS = "usage-meter";

		/**
		 * DeepSeek 官方刊例价（每 1M tokens，2026-08-17 抓取，高峰/空闲双时段 × 双币种）。
		 * 高峰时段（北京时间）09:00–12:00、14:00–18:00，价格为空闲时段的 2 倍。
		 * 来源：官方定价页中/英文版；deepseek-chat → flash、deepseek-reasoner → pro 视为别名。
		 */
		const PRICING = {
			"deepseek-v4-flash": {
				peak: { cny: { miss: 3.0, hit: 0.10, out: 9.0 }, usd: { miss: 0.44, hit: 0.014, out: 1.32 } },
				offPeak: { cny: { miss: 1.5, hit: 0.05, out: 4.5 }, usd: { miss: 0.22, hit: 0.007, out: 0.66 } },
			},
			"deepseek-v4-pro": {
				peak: { cny: { miss: 9.0, hit: 0.30, out: 27.0 }, usd: { miss: 1.32, hit: 0.044, out: 3.96 } },
				offPeak: { cny: { miss: 4.5, hit: 0.15, out: 13.5 }, usd: { miss: 0.66, hit: 0.022, out: 1.98 } },
			},
		};
		const MODEL_ALIASES = { "deepseek-chat": "deepseek-v4-flash", "deepseek-reasoner": "deepseek-v4-pro" };
		const DEFAULT_MODEL = "deepseek-v4-flash";
		const VERIFIED_AT = "2026-08-17";
		/** 用户覆盖价只给人民币时，按官方双币种比例折算美元。 */
		const CNY_PER_USD = 6.82;

		function normalizeModel(model) {
			if (typeof model !== "string" || model.length === 0) return DEFAULT_MODEL;
			const m = model.trim().toLowerCase();
			return MODEL_ALIASES[m] ?? m;
		}

		/** UTC 时刻（小数小时）。 */
		function utcHourFloat(d) {
			return d.getUTCHours() + d.getUTCMinutes() / 60;
		}
		/**
		 * 当前是否高峰价。官方规则：UTC 01:00–04:00、06:00–10:00，仅周一至周五
		 * （等于北京时间 09:00–12:00、14:00–18:00 工作日）。
		 * `peakHours` 来自官方页面解析（[[start,end],[start,end],"weekdays"]），
		 * 解析不到时用内置同值规则兜底。
		 */
		function beijingPeakNow(peakHours) {
			const now = new Date();
			const weekday = now.getUTCDay(); // 0=周日
			const isWeekday = weekday >= 1 && weekday <= 5;
			let ranges = [[1, 4], [6, 10]];
			if (Array.isArray(peakHours) && Array.isArray(peakHours[0])) {
				const custom = peakHours.filter((r) => Array.isArray(r) && typeof r[0] === "number" && typeof r[1] === "number");
				if (custom.length > 0) ranges = custom;
			}
			const h = utcHourFloat(now);
			return isWeekday && ranges.some(([s, e]) => h >= s && h < e);
		}

		/** Resolve effective per-1M prices for a model（优先级：设置覆盖 > 官方实时 > 内置快照）。 */
		function pricesOf(model, currency, overrides, official) {
			const normalized = normalizeModel(model);
			const base = PRICING[normalized] ?? PRICING[DEFAULT_MODEL];
			const peak = beijingPeakNow(official?.peakHours);
			let tier = peak ? base.peak : base.offPeak;
			// 官方实时价（USD/1M，人民币按固定比例折算）
			const oModel = official?.models?.[normalized];
			if (oModel) {
				const ot = peak ? oModel.peak : oModel.offPeak;
				if (num(ot?.miss) !== undefined && num(ot?.hit) !== undefined && num(ot?.out) !== undefined) {
					tier = {
						cny: { miss: ot.miss * CNY_PER_USD, hit: ot.hit * CNY_PER_USD, out: ot.out * CNY_PER_USD },
						usd: { miss: ot.miss, hit: ot.hit, out: ot.out },
					};
				}
			}
			const ov = overrides?.[normalized] ?? overrides?.[model];
			if (ov) {
				const t = peak ? ov.peak : ov.offPeak;
				if (t) {
					const cny = { miss: num(t.cacheMissInput) ?? num(t.miss) ?? tier.cny.miss, hit: num(t.cacheHitInput) ?? num(t.hit) ?? tier.cny.hit, out: num(t.output) ?? num(t.out) ?? tier.cny.out };
					tier = { cny, usd: { miss: cny.miss / CNY_PER_USD, hit: cny.hit / CNY_PER_USD, out: cny.out / CNY_PER_USD } };
				}
			}
			const cur = currency === "USD" ? "usd" : "cny";
			return {
				model: normalized,
				peak,
				currency: currency === "USD" ? "USD" : "CNY",
				p: tier[cur],
				verifiedAt: official?.ok ? new Date(official.at).toLocaleDateString() : VERIFIED_AT,
				live: official?.ok === true,
			};
		}

		function num(v) {
			return typeof v === "number" && Number.isFinite(v) ? v : undefined;
		}

		function formatTokens(n) {
			if (!Number.isFinite(n)) return "0";
			if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
			if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
			return String(Math.round(n));
		}
		function formatMoney(n, currency) {
			const sym = currency === "USD" ? "$" : "¥";
			if (!Number.isFinite(n)) return sym + "0";
			if (n >= 1) return sym + n.toFixed(2);
			if (n >= 0.01) return sym + n.toFixed(4).replace(/0+$/, "");
			return sym + n.toFixed(6).replace(/0+$/, "");
		}
		function costOf(miss, hit, out, p) {
			return miss / 1e6 * p.miss + hit / 1e6 * p.hit + out / 1e6 * p.out;
		}
		function billedInput(u) {
			return (u.uncachedInputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
		}

		/** Last N local calendar days (oldest first); `today` marks the newest. */
		function lastNDays(n) {
			const out = [];
			const now = new Date();
			for (let i = n - 1; i >= 0; i--) {
				const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
				out.push({
					key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
					label: `${d.getMonth() + 1}/${d.getDate()}`,
					today: i === 0,
				});
			}
			return out;
		}
		function isZeroBucketish(b) {
			return (b?.uncachedInputTokens ?? 0) === 0 && (b?.outputTokens ?? 0) === 0 && (b?.cacheReadTokens ?? 0) === 0 && (b?.cacheWriteTokens ?? 0) === 0;
		}
		function shortModel(model) {
			return String(model ?? "").replace(/^deepseek-/, "") || "unknown";
		}
		/** Per-model ledger rows (cost + tokens), biggest spender first. */
		function modelBreakdown(models, p) {
			if (!models || typeof models !== "object") return [];
			return Object.entries(models)
				.filter(([, b]) => b && typeof b === "object" && !isZeroBucketish(b))
				.map(([model, b]) => {
					const miss = (b.uncachedInputTokens ?? 0) + (b.cacheWriteTokens ?? 0);
					const hit = b.cacheReadTokens ?? 0;
					const out = b.outputTokens ?? 0;
					return { model, cost: costOf(miss, hit, out, p), tokens: miss + hit + out, miss, hit, out };
				})
				.sort((a, b) => b.cost - a.cost);
		}

		/** Stable per-model palette (sorted model names map onto it in order). */
		const MODEL_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4", "#84cc16", "#ec4899"];
		function modelColors(models) {
			const map = {};
			Object.keys(models ?? {}).sort().forEach((m, i) => {
				map[m] = MODEL_COLORS[i % MODEL_COLORS.length];
			});
			return map;
		}
		/** Stack segments of one time bucket: [{ model, cost, tokens }], biggest first.
		 *  Falls back to a single `unknown` segment when the bucket only has totals
		 *  (pre-upgrade ledger days carry no model split). */
		function stackSegments(bucketModels, p, totalFallback) {
			const segs = [];
			for (const [model, b] of Object.entries(bucketModels ?? {})) {
				if (!b || typeof b !== "object") continue;
				const miss = (b.uncachedInputTokens ?? 0) + (b.cacheWriteTokens ?? 0);
				const hit = b.cacheReadTokens ?? 0;
				const out = b.outputTokens ?? 0;
				const cost = costOf(miss, hit, out, p);
				if (cost > 0) segs.push({ model, cost, tokens: miss + hit + out, miss, hit, out });
			}
			if (segs.length === 0 && totalFallback && !isZeroBucketish(totalFallback)) {
				const miss = (totalFallback.uncachedInputTokens ?? 0) + (totalFallback.cacheWriteTokens ?? 0);
				const hit = totalFallback.cacheReadTokens ?? 0;
				const out = totalFallback.outputTokens ?? 0;
				const cost = costOf(miss, hit, out, p);
				if (cost > 0) segs.push({ model: "unknown", cost, tokens: miss + hit + out, miss, hit, out });
			}
			segs.sort((a, b) => b.cost - a.cost);
			return segs;
		}
		/** Local calendar-day key, same wall-clock rule as the host ledger. */
		function todayKeyLocal() {
			const d = new Date();
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		}

		const zh = {
			"meter.chip": "API ↑{input} ↓{output} ≈{cost}",
			"meter.chipPrefix": "API ↑{input} ↓{output}",
			"meter.chipToday": "今日 {today}",
			"meter.title": "API 用量",
			"meter.model": "模型",
			"meter.miss": "输入（缓存未命中）",
			"meter.hit": "输入（缓存命中）",
			"meter.write": "缓存写入",
			"meter.output": "输出",
			"meter.occupancy": "上下文占用",
			"meter.sessionCost": "本次会话",
			"meter.today": "今日累计",
			"meter.grand": "累计",
			"meter.peak": "高峰价",
			"meter.offpeak": "空闲价",
			"meter.tier.peakShort": "峰",
			"meter.tier.valleyShort": "谷",
			"meter.tier.peakTitle": "高峰价（北京时间 09:00–12:00、14:00–18:00）",
			"meter.tier.valleyTitle": "空闲价（非高峰时段）",
			"meter.balance": "账户余额",
			"meter.budget": "预算",
			"meter.noData": "暂无用量数据",
			"meter.noKey": "未配置余额 API Key",
			"meter.refresh": "刷新",
			"meter.refreshing": "刷新中…",
			"meter.verified": "刊例价 {date} · 未定价模型按 flash 估算",
			"meter.verifiedLive": "官方实时刊例价（{date} 同步）· 未定价模型按 flash 估算",
			"meter.cacheHit": "缓存命中",
			"meter.chart": "用量分布",
			"meter.chartToday": "当日",
			"meter.chartWeek": "近 7 天",
			"meter.byModel": "模型分布",
			"meter.chartNote": "柱状图与模型分布按当前刊例价估算",
			"meter.unknownModel": "未识别模型",
		};
		const en = {
			"meter.chip": "API ↑{input} ↓{output} ≈{cost}",
			"meter.chipPrefix": "API ↑{input} ↓{output}",
			"meter.chipToday": "today {today}",
			"meter.title": "API usage",
			"meter.model": "Model",
			"meter.miss": "Input (cache miss)",
			"meter.hit": "Input (cache hit)",
			"meter.write": "Cache write",
			"meter.output": "Output",
			"meter.occupancy": "Context occupancy",
			"meter.sessionCost": "This session",
			"meter.today": "Today",
			"meter.grand": "Total",
			"meter.peak": "peak price",
			"meter.offpeak": "off-peak price",
			"meter.tier.peakShort": "Peak",
			"meter.tier.valleyShort": "Off-peak",
			"meter.tier.peakTitle": "Peak pricing (Beijing time 09:00–12:00, 14:00–18:00)",
			"meter.tier.valleyTitle": "Off-peak pricing",
			"meter.balance": "Balance",
			"meter.budget": "Budget",
			"meter.noData": "No usage data yet",
			"meter.noKey": "No balance API key configured",
			"meter.refresh": "Refresh",
			"meter.refreshing": "Refreshing…",
			"meter.verified": "list price {date} · unknown models priced as flash",
			"meter.verifiedLive": "live official list price (synced {date}) · unknown models priced as flash",
			"meter.cacheHit": "cache hit",
			"meter.chart": "Usage by time",
			"meter.chartToday": "Today",
			"meter.chartWeek": "7 days",
			"meter.byModel": "By model",
			"meter.chartNote": "chart & model shares estimated at current list prices",
			"meter.unknownModel": "unknown model",
		};

		const styles = {
			root: { display: "inline-flex", position: "relative", alignItems: "center", minWidth: 0 },
			trigger: {
				display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", lineHeight: "20px",
				color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-interactive-bg-default, transparent)",
				border: "1px solid var(--dsw-alias-border-l3)", borderRadius: "999px",
				cursor: "pointer", padding: "1px 10px", whiteSpace: "nowrap", transition: "background .15s",
			},
			triggerHover: { background: "var(--dsw-alias-interactive-bg-hover)" },
			chevron: { fontSize: "10px", lineHeight: "20px", color: "var(--dsw-alias-label-caption)" },
			chipTier: {
				fontSize: "10px", lineHeight: "15px", padding: "0 5px", borderRadius: "999px",
				fontWeight: 600, flex: "none", fontVariantNumeric: "tabular-nums",
			},
			chipTierPeak: { color: "var(--dsw-alias-state-warn-label)", background: "rgba(224, 163, 60, 0.16)" },
			chipTierValley: { color: "var(--dsw-alias-state-success-primary)", background: "rgba(45, 164, 78, 0.16)" },
			cost: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)", fontWeight: 500 },
			costWarn: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-state-warn-label)", fontWeight: 500 },
			costOver: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-state-error-primary)", fontWeight: 500 },
			dot: { color: "var(--dsw-alias-label-caption)" },
			panel: {
				position: "absolute", bottom: "calc(100% + 8px)", right: "0", zIndex: 100, width: "320px", maxWidth: "calc(100vw - 32px)",
				boxSizing: "border-box", background: "var(--dsw-specific-menu)", border: "1px solid var(--dsw-alias-border-inverted)",
				borderRadius: "12px", boxShadow: "var(--dsw-shadow-lv3)", color: "var(--dsw-alias-label-secondary)",
				fontSize: "12px", lineHeight: "20px", padding: "12px", cursor: "default",
			},
			header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" },
			title: { color: "var(--dsw-alias-label-primary)", fontWeight: 500, fontSize: "13px" },
			headerFigures: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)", fontWeight: 600, marginLeft: "auto" },
			tierTag: {
				fontSize: "11px", lineHeight: "16px", padding: "0 6px", borderRadius: "999px",
				background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-secondary)", flex: "none",
			},
			row: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "2px 0" },
			rowLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			figures: { fontVariantNumeric: "tabular-nums", flex: "none", textAlign: "right" },
			divider: { border: "none", borderTop: "1px solid var(--dsw-alias-border-l3)", margin: "8px 0" },
			total: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "2px 0", fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
			balanceRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "2px 0" },
			balanceValue: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)", fontWeight: 600 },
			refreshBtn: {
				font: "inherit", fontSize: "11px", color: "inherit", cursor: "pointer", background: "none",
				border: "1px solid var(--dsw-alias-border-l3)", borderRadius: "6px", padding: "0 6px", lineHeight: "18px",
			},
			budgetBar: { background: "var(--dsw-alias-interactive-bg-hover)", borderRadius: "999px", height: "4px", margin: "6px 0 2px", overflow: "hidden" },
			budgetFill: { background: "var(--dsw-alias-state-business-primary)", borderRadius: "999px", height: "100%", transition: "width .2s" },
			budgetFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
			budgetFillOver: { background: "var(--dsw-alias-state-error-primary)" },
			footer: { color: "var(--dsw-alias-label-caption)", fontSize: "11px", lineHeight: "16px", marginTop: "8px" },
			empty: { color: "var(--dsw-alias-label-tertiary)", padding: "4px 0" },
			sectionTitle: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)", margin: "8px 0 4px" },
			chartHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", margin: "8px 0 4px" },
			chartTitle: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
			chart: { display: "flex", alignItems: "flex-end", gap: "4px", height: "72px" },
			chartCol: { flex: "1 1 0%", minWidth: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: "1px" },
			chartBar: { width: "100%", borderRadius: "3px 3px 0 0", background: "var(--dsw-alias-interactive-bg-hover)", minHeight: "2px", transition: "height .25s" },
			chartSeg: { width: "100%", borderRadius: "2px", minHeight: "2px", flex: "none", transition: "height .25s" },
			chartLabel: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-caption)", whiteSpace: "nowrap", marginTop: "3px" },
			segBtn: {
				font: "inherit", fontSize: "11px", lineHeight: "18px", padding: "0 8px", borderRadius: "999px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l3)", background: "none", color: "var(--dsw-alias-label-secondary)",
			},
			segBtnActive: { background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)" },
			legend: { display: "flex", flexWrap: "wrap", gap: "4px 10px", margin: "6px 0 2px" },
			legendItem: { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-caption)" },
			legendDot: { width: "6px", height: "6px", borderRadius: "999px", flex: "none" },
			modelBar: { height: "4px", borderRadius: "999px", background: "var(--dsw-alias-interactive-bg-hover)", overflow: "hidden", margin: "2px 0 6px" },
			modelBarFill: { height: "100%", borderRadius: "999px", background: "var(--dsw-alias-state-business-primary)" },
		};

		function UsageMeter({ useProjection, useUsageSettings, t, usageSessionId }) {
			const usage = useProjection("tokenUsage");
			const pressure = useProjection("contextPressure");
			const scoped = useUsageSettings((value) => value);
			const settings = (scoped && typeof scoped === "object" && "value" in scoped ? scoped.value : scoped) ?? {};

			const currency = settings.currency === "USD" ? "USD" : "CNY";
			const budget = typeof settings.budget === "number" && Number.isFinite(settings.budget) && settings.budget > 0 ? settings.budget : 0;
			const pricingOverrides = settings.pricing && typeof settings.pricing === "object" ? settings.pricing : {};

			const [open, setOpen] = react.useState(false);
			const [hovered, setHovered] = react.useState(false);
			const [chartMode, setChartMode] = react.useState("today");
			const [snapshot, setSnapshot] = react.useState(null);
			const [refreshing, setRefreshing] = react.useState(false);
			const rootRef = react.useRef(null);

			const refreshState = react.useCallback(() => {
				fetch("/usage-meter/state")
					.then((r) => (r.ok ? r.json() : null))
					.then((data) => data && setSnapshot(data))
					.catch(() => {});
			}, []);

			react.useEffect(() => {
				refreshState();
				// Faster polling while the panel is open; relaxed when closed.
				const timer = setInterval(refreshState, open ? 5000 : 20000);
				return () => clearInterval(timer);
			}, [refreshState, open]);

			react.useEffect(() => {
				if (!open) return;
				const onPointerDown = (e) => {
					if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			const refreshBalance = () => {
				setRefreshing(true);
				fetch("/usage-meter/balance/refresh", { method: "POST" })
					.then((r) => r.json())
					.then((b) => {
						setSnapshot((s) => (s ? { ...s, balance: b } : s));
						setRefreshing(false);
					})
					.catch(() => setRefreshing(false));
			};

			const sid = typeof usageSessionId === "string" ? usageSessionId : undefined;
			const model = snapshot?.sessions?.[sid]?.model ?? DEFAULT_MODEL;
			const officialPricing = snapshot?.pricing?.ok ? snapshot.pricing : null;
			const prices = pricesOf(model, currency, pricingOverrides, officialPricing);

			if (usage === undefined) return null;
			const miss = (usage.uncachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			const hit = usage.cacheReadTokens ?? 0;
			const out = usage.outputTokens ?? 0;
			const input = billedInput(usage);
			if (input === 0 && out === 0 && hit === 0) return null;

			const liveCost = costOf(miss, hit, out, prices.p);
			const cacheHitPct = miss + hit > 0 ? Math.round(hit / (miss + hit) * 100) : null;
			const occupancy = pressure?.contextWindow !== undefined && (pressure.projectedTokens ?? pressure.pressureTokens) !== undefined
				? Math.min(100, Math.round((pressure.projectedTokens ?? pressure.pressureTokens) / pressure.contextWindow * 100))
				: null;

			const todayBuckets = snapshot?.today ?? null;
			const grandBuckets = snapshot?.grand ?? null;
			const todayCost = todayBuckets ? costOf(
				(todayBuckets.uncachedInputTokens ?? 0) + (todayBuckets.cacheWriteTokens ?? 0),
				todayBuckets.cacheReadTokens ?? 0,
				todayBuckets.outputTokens ?? 0,
				prices.p,
			) : null;
			const grandCost = grandBuckets ? costOf(
				(grandBuckets.uncachedInputTokens ?? 0) + (grandBuckets.cacheWriteTokens ?? 0),
				grandBuckets.cacheReadTokens ?? 0,
				grandBuckets.outputTokens ?? 0,
				prices.p,
			) : null;

			const budgetUsed = todayCost !== null ? todayCost : liveCost;
			const budgetPct = budget > 0 ? Math.min(100, Math.round(budgetUsed / budget * 100)) : 0;
			const budgetState = budget > 0 && budgetUsed >= budget ? "over" : budget > 0 && budgetUsed >= budget * 0.8 ? "warn" : "ok";
			const costClass = budgetState === "over" ? styles.costOver : budgetState === "warn" ? styles.costWarn : styles.cost;

			const balance = snapshot?.balance;
			const balanceAmount = balance?.ok ? normalizeBalance(balance.data, currency) : null;

			const tierLabel = prices.peak ? t("meter.peak") : t("meter.offpeak");

			const chipCost = formatMoney(liveCost, currency);
			const chipToday = todayCost !== null ? formatMoney(todayCost, currency) : null;

			// Stacked time buckets for the two chart views (today = hourly, week = daily).
			const hourBars = [];
			for (let h = 0; h < 24; h++) {
				const hourEntry = snapshot?.hours?.[String(h)];
				const segs = stackSegments(hourEntry?.models, prices.p, hourEntry?.total);
				const total = segs.reduce((s, x) => s + x.cost, 0);
				hourBars.push({ key: `h${h}`, label: h % 3 === 0 ? String(h) : "", title: `${String(h).padStart(2, "0")}:00`, segs, total });
			}
			const hourMax = hourBars.reduce((m, b) => Math.max(m, b.total), 0);

			const weekBars = lastNDays(7).map((d) => {
				const dayEntry = snapshot?.days?.[d.key];
				const segs = stackSegments(dayEntry?.models, prices.p, dayEntry?.total);
				const total = segs.reduce((s, x) => s + x.cost, 0);
				return { key: d.key, label: d.label, title: d.label, segs, total };
			});
			const weekMax = weekBars.reduce((m, b) => Math.max(m, b.total), 0);

			// Colors cover every model visible in either view (plus the ledger summary),
			// so the legend always matches the bars.
			const seenModels = {};
			for (const b of hourBars) for (const s of b.segs) seenModels[s.model] = true;
			for (const b of weekBars) for (const s of b.segs) seenModels[s.model] = true;
			const colorMap = modelColors({ ...snapshot?.models, ...seenModels });
			const bars = chartMode === "today" ? hourBars : weekBars;
			const barMax = chartMode === "today" ? hourMax : weekMax;
			const hasChartData = hourMax > 0 || weekMax > 0;

			// Shared chart pieces (reused by the small panel chart and the enlarged view).
			const chartToggles = react_jsx_runtime.jsxs("span", { style: { display: "inline-flex", gap: "4px" }, children: [
				react_jsx_runtime.jsx("button", {
					type: "button",
					style: chartMode === "today" ? { ...styles.segBtn, ...styles.segBtnActive } : styles.segBtn,
					onClick: () => setChartMode("today"),
					children: t("meter.chartToday"),
				}),
				react_jsx_runtime.jsx("button", {
					type: "button",
					style: chartMode === "week" ? { ...styles.segBtn, ...styles.segBtnActive } : styles.segBtn,
					onClick: () => setChartMode("week"),
					children: t("meter.chartWeek"),
				}),
			] });
			const chartLegend = react_jsx_runtime.jsx("div", { style: styles.legend, children: Object.keys(colorMap).map((m) =>
				react_jsx_runtime.jsxs("span", { key: m, style: styles.legendItem, children: [
					react_jsx_runtime.jsx("span", { style: { ...styles.legendDot, background: colorMap[m] } }),
					m === "unknown" ? t("meter.unknownModel") : shortModel(m),
				] })
			) });
			/** The stacked bar chart (today = hourly, week = daily). */
			const renderChart = () => react_jsx_runtime.jsx("div", { style: styles.chart, children: bars.map((b) =>
				react_jsx_runtime.jsxs("div", {
					key: b.key,
					style: styles.chartCol,
					"aria-label": `${b.title}: ${formatMoney(b.total, currency)}`,
					title: b.total > 0
						? `${b.title} · ${formatMoney(b.total, currency)}\n` + b.segs.map((s) => `${s.model === "unknown" ? t("meter.unknownModel") : shortModel(s.model)} ${formatMoney(s.cost, currency)} · ↑${formatTokens(s.miss + s.hit)} ↓${formatTokens(s.out)}`).join("\n")
						: `${b.title} · 0`,
					children: [
						b.total === 0
							? react_jsx_runtime.jsx("div", { style: { ...styles.chartBar, height: "2px" } })
							: b.segs.map((s) =>
								react_jsx_runtime.jsx("div", {
									key: s.model,
									style: {
										...styles.chartSeg,
										background: colorMap[s.model] ?? "#8b949e",
										height: barMax > 0 ? `${Math.max(3, Math.round(s.cost / barMax * 80))}%` : "2px",
									},
								})
							),
						react_jsx_runtime.jsx("span", { style: styles.chartLabel, children: b.label }),
					],
				})
			) });

			// Per-model breakdown from the host ledger summary.
			const modelRows = modelBreakdown(snapshot?.models, prices.p);
			const modelMax = modelRows.reduce((m, r) => Math.max(m, r.cost), 0);

			return react_jsx_runtime.jsx("span", {
				ref: rootRef,
				style: styles.root,
				children: [
					react_jsx_runtime.jsx("button", {
						type: "button",
						style: hovered ? { ...styles.trigger, ...styles.triggerHover } : styles.trigger,
						"aria-label": t("meter.title"),
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						onClick: () => setOpen(!open),
						onMouseEnter: () => setHovered(true),
						onMouseLeave: () => setHovered(false),
						children: [
							react_jsx_runtime.jsx("span", {
								style: { ...styles.chipTier, ...(prices.peak ? styles.chipTierPeak : styles.chipTierValley) },
								title: prices.peak ? t("meter.tier.peakTitle") : t("meter.tier.valleyTitle"),
								children: prices.peak ? t("meter.tier.peakShort") : t("meter.tier.valleyShort"),
							}),
							t("meter.chipPrefix", { input: formatTokens(input), output: formatTokens(out) }),
							react_jsx_runtime.jsx("span", { style: costClass, children: "≈" + chipCost }),
							chipToday !== null && react_jsx_runtime.jsxs(react.Fragment, {
								children: [
									react_jsx_runtime.jsx("span", { style: styles.dot, "aria-hidden": true, children: "·" }),
									react_jsx_runtime.jsx("span", { children: t("meter.chipToday", { today: chipToday }) }),
								],
							}),
							react_jsx_runtime.jsx("span", { style: styles.chevron, "aria-hidden": true, children: open ? "▴" : "▾" }),
						],
					}),
					open && react_jsx_runtime.jsx("div", {
						role: "dialog",
						style: styles.panel,
						children: [
							react_jsx_runtime.jsxs("div", { style: styles.header, children: [
								react_jsx_runtime.jsx("span", { style: styles.title, children: t("meter.title") }),
								react_jsx_runtime.jsx("span", { style: styles.tierTag, children: tierLabel }),
								react_jsx_runtime.jsx("span", { style: styles.headerFigures, children: formatMoney(liveCost, currency) }),
							] }),
							react_jsx_runtime.jsxs("div", { style: styles.row, children: [
								react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.miss") }),
								react_jsx_runtime.jsx("span", { style: styles.figures, children: `${formatTokens(miss)} · ${formatMoney(miss / 1e6 * prices.p.miss, currency)}` }),
							] }),
							react_jsx_runtime.jsxs("div", { style: styles.row, children: [
								react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.hit") + (cacheHitPct !== null ? ` (${cacheHitPct}%)` : "") }),
								react_jsx_runtime.jsx("span", { style: styles.figures, children: `${formatTokens(hit)} · ${formatMoney(hit / 1e6 * prices.p.hit, currency)}` }),
							] }),
							react_jsx_runtime.jsxs("div", { style: styles.row, children: [
								react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.output") }),
								react_jsx_runtime.jsx("span", { style: styles.figures, children: `${formatTokens(out)} · ${formatMoney(out / 1e6 * prices.p.out, currency)}` }),
							] }),
							occupancy !== null && react_jsx_runtime.jsxs("div", { style: styles.row, children: [
								react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.occupancy") }),
								react_jsx_runtime.jsx("span", { style: styles.figures, children: `${occupancy}%` }),
							] }),
							react_jsx_runtime.jsx("hr", { style: styles.divider }),
							react_jsx_runtime.jsxs("div", { style: styles.total, children: [
								react_jsx_runtime.jsx("span", { children: t("meter.sessionCost") }),
								react_jsx_runtime.jsx("span", { style: styles.figures, children: formatMoney(liveCost, currency) }),
							] }),
							todayCost !== null && react_jsx_runtime.jsxs("div", { style: styles.row, children: [
								react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.today") }),
								react_jsx_runtime.jsx("span", { style: styles.figures, children: formatMoney(todayCost, currency) }),
							] }),
							grandCost !== null && react_jsx_runtime.jsxs("div", { style: styles.row, children: [
								react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.grand") }),
								react_jsx_runtime.jsx("span", { style: styles.figures, children: formatMoney(grandCost, currency) }),
							] }),
							hasChartData && react_jsx_runtime.jsxs(react.Fragment, { children: [
								react_jsx_runtime.jsxs("div", { style: styles.chartHeader, children: [
									react_jsx_runtime.jsx("span", { style: styles.chartTitle, children: t("meter.chart") }),
									chartToggles,
								] }),
								renderChart(),
								chartLegend,
							] }),
							modelRows.length > 0 && react_jsx_runtime.jsxs(react.Fragment, { children: [
								react_jsx_runtime.jsx("div", { style: styles.sectionTitle, children: t("meter.byModel") }),
								modelRows.map((r) =>
									react_jsx_runtime.jsxs("div", { key: r.model, children: [
										react_jsx_runtime.jsxs("div", { style: styles.row, children: [
											react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: shortModel(r.model) }),
											react_jsx_runtime.jsx("span", { style: styles.figures, children: `${formatMoney(r.cost, currency)} · ${formatTokens(r.tokens)}` }),
										] }),
										react_jsx_runtime.jsx("div", { style: styles.modelBar, children: react_jsx_runtime.jsx("div", {
											style: { ...styles.modelBarFill, width: modelMax > 0 ? `${Math.max(2, Math.round(r.cost / modelMax * 100))}%` : "0%" },
										}) }),
									] })
								),
							] }),
							budget > 0 && react_jsx_runtime.jsxs(react.Fragment, { children: [
								react_jsx_runtime.jsxs("div", { style: styles.row, children: [
									react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.budget") }),
									react_jsx_runtime.jsx("span", { style: styles.figures, children: `${formatMoney(budgetUsed, currency)} / ${formatMoney(budget, currency)}` }),
								] }),
								react_jsx_runtime.jsx("div", { style: styles.budgetBar, children: react_jsx_runtime.jsx("div", {
									style: { ...styles.budgetFill, width: `${budgetPct}%`, ...(budgetState === "warn" ? styles.budgetFillWarn : budgetState === "over" ? styles.budgetFillOver : {}) },
								}) }),
							] }),
							react_jsx_runtime.jsx("hr", { style: styles.divider }),
							react_jsx_runtime.jsxs("div", { style: styles.balanceRow, children: [
								react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.balance") }),
								react_jsx_runtime.jsx("span", { style: styles.figures, children: [
									balanceAmount !== null
										? react_jsx_runtime.jsx("span", { style: styles.balanceValue, children: formatMoney(balanceAmount, currency) })
										: react_jsx_runtime.jsx("span", { style: styles.empty, children: balance?.ok === false && balance.error === "no_api_key" ? t("meter.noKey") : "—" }),
									react_jsx_runtime.jsx("button", {
										type: "button",
										style: styles.refreshBtn,
										onClick: refreshBalance,
										children: refreshing ? t("meter.refreshing") : t("meter.refresh"),
									}),
								] }),
							] }),
							react_jsx_runtime.jsx("div", { style: styles.footer, children: [
								prices.live
									? t("meter.verifiedLive", { date: prices.verifiedAt })
									: t("meter.verified", { date: VERIFIED_AT }),
								" · " + t("meter.model") + " " + normalizeModel(model),
								(hasChartData || modelRows.length > 0) ? " · " + t("meter.chartNote") : null,
							] }),
						],
					}),
				],
			});
		}

		/** DeepSeek balance payload -> a single number in the requested currency. */
		function normalizeBalance(data, currency) {
			const infos = data?.balance_infos;
			if (!Array.isArray(infos) || infos.length === 0) return null;
			const target = currency === "USD" ? "USD" : "CNY";
			const hit = infos.find((i) => i?.currency === target);
			if (hit) return num(parseFloat(hit.total_balance));
			const first = infos.find((i) => typeof i?.total_balance === "string" || typeof i?.total_balance === "number");
			return first ? num(parseFloat(first.total_balance)) : null;
		}

		//#endregion

		//#region apply
		/** Required client services. */
		const inject = ["slots", "locale", "settingsScope"];
		/**
		 * Register the usage chip into the composer dock (after the built-in stats
		 * line) and bind the durable settings scope (`usage-meter:` in settings.yaml).
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			const usageScope = ctx.settingsScope.bind({ namespace: "usage-meter" });
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "usage-meter: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "usage",
				order: 1,
				locale: NS,
				inject: (sessionId) => ({
					usageSessionId: sessionId,
					hooks: { usageSettings: usageScope },
				}),
			}, UsageMeter));
		}
		//#endregion

		exports.name = "usage-meter";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
