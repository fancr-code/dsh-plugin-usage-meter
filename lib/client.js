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

		/** Resolve effective per-1M prices for a model（优先级：设置覆盖 > 官方实时/历史生效区间 > 内置快照）。
		 *  `history` 为 [{ since: "YYYY-MM-DD", models, peakHours }, ...]（时间升序），
		 *  `dayKey` 给定时按“生效区间”取对应日期的刊例价表；否则用当前官方实时价。 */
		function pricesOf(model, currency, overrides, official, history, dayKey) {
			const normalized = normalizeModel(model);
			const base = PRICING[normalized] ?? PRICING[DEFAULT_MODEL];
			const peak = beijingPeakNow(official?.peakHours);
			let tier = peak ? base.peak : base.offPeak;
			// 官方价（USD/1M，人民币按固定比例折算）：历史区间价优先于当前实时价
			let officialModels = official?.models;
			if (Array.isArray(history) && history.length > 0 && typeof dayKey === "string" && dayKey.length > 0) {
				let entry = null;
				for (const e of history) {
					if (e && typeof e.since === "string" && e.models && typeof e.models === "object" && e.since <= dayKey) entry = e;
				}
				if (!entry) entry = history[0];
				if (entry?.models) officialModels = entry.models;
			}
			const oModel = officialModels?.[normalized];
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
		/** Per-model ledger rows (cost + tokens), biggest spender first.
		 *  `priceOf(model)` 提供各模型自己的单价——不再套用当前会话模型的价。 */
		function modelBreakdown(models, priceOf) {
			if (!models || typeof models !== "object") return [];
			return Object.entries(models)
				.filter(([, b]) => b && typeof b === "object" && !isZeroBucketish(b))
				.map(([model, b]) => {
					const miss = (b.uncachedInputTokens ?? 0) + (b.cacheWriteTokens ?? 0);
					const hit = b.cacheReadTokens ?? 0;
					const out = b.outputTokens ?? 0;
					return { model, cost: costOf(miss, hit, out, priceOf(model)), tokens: miss + hit + out, miss, hit, out };
				})
				.sort((a, b) => b.cost - a.cost);
		}

		/** Stable per-model palette (sorted model names map onto it in order). */
		const MODEL_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4", "#84cc16", "#ec4899"];
		/** 梁祖吉祥物（分享卡片用，180×180 PNG）。 */
		const LIANGZU_MASCOT = "data:image/png;base64,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";
		function modelColors(models) {
			const map = {};
			Object.keys(models ?? {}).sort().forEach((m, i) => {
				map[m] = MODEL_COLORS[i % MODEL_COLORS.length];
			});
			return map;
		}
		/** Stack segments of one time bucket: [{ model, cost, tokens }], biggest first.
		 *  `priceOf(model)` 返回该桶生效刊例价的 p（{miss,hit,out}），支持按天生效区间计价。
		 *  Falls back to a single `unknown` segment when the bucket only has totals
		 *  (pre-upgrade ledger days carry no model split). */
		function stackSegments(bucketModels, priceOf, totalFallback) {
			const segs = [];
			for (const [model, b] of Object.entries(bucketModels ?? {})) {
				if (!b || typeof b !== "object") continue;
				const miss = (b.uncachedInputTokens ?? 0) + (b.cacheWriteTokens ?? 0);
				const hit = b.cacheReadTokens ?? 0;
				const out = b.outputTokens ?? 0;
				const cost = costOf(miss, hit, out, priceOf(model));
				if (cost > 0) segs.push({ model, cost, tokens: miss + hit + out, miss, hit, out });
			}
			if (segs.length === 0 && totalFallback && !isZeroBucketish(totalFallback)) {
				const miss = (totalFallback.uncachedInputTokens ?? 0) + (totalFallback.cacheWriteTokens ?? 0);
				const hit = totalFallback.cacheReadTokens ?? 0;
				const out = totalFallback.outputTokens ?? 0;
				const cost = costOf(miss, hit, out, priceOf(DEFAULT_MODEL));
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

		/** 本月（自然月）tokens 合计，来自日账本。 */
		function monthTokens(days) {
			const now = new Date();
			const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-`;
			let t = 0;
			for (const [k, v] of Object.entries(days ?? {})) {
				if (!k.startsWith(prefix)) continue;
				const b = v?.total;
				if (!b || typeof b !== "object") continue;
				t += (b.uncachedInputTokens ?? 0) + (b.cacheReadTokens ?? 0) + (b.cacheWriteTokens ?? 0) + (b.outputTokens ?? 0);
			}
			return t;
		}

		/** 消耗段位：按本月 tokens 分五档，最高档为梁祖。 */
		const TIERS = [
			{ key: "shrimp", zh: "虾米", en: "Shrimp", emoji: "🦐", min: 0 },
			{ key: "fish", zh: "小鱼", en: "Small Fish", emoji: "🐟", min: 1e6 },
			{ key: "dolphin", zh: "海豚", en: "Dolphin", emoji: "🐬", min: 10e6 },
			{ key: "whale", zh: "鲸鱼", en: "Whale", emoji: "🐳", min: 50e6 },
			{ key: "liangzu", zh: "梁祖", en: "Liangzu", emoji: "🐋", min: 200e6 },
		];
		function tierOf(tokens) {
			let idx = 0;
			for (let i = 0; i < TIERS.length; i++) if (tokens >= TIERS[i].min) idx = i;
			return TIERS[idx];
		}
		/** 段位显示名（随界面语言）。 */
		function tierName(tier, lang) {
			return lang === "en" ? tier.en : tier.zh;
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
			"meter.chartNote": "柱状图与模型分布按各时段生效刊例价估算",
			"meter.historyNote": "历史用量按生效区间刊例价计价（{n} 段）",
			"meter.unknownModel": "未识别模型",
			"meter.monthTier": "本月段位",
			"meter.monthTokens": "本月 {tokens}",
			"meter.toNext": "距 {next} 还需 {left}",
			"meter.maxTier": "已达最高段位",
			"meter.shareCard": "分享卡片",
			"meter.saveCard": "保存图片",
			"meter.close": "关闭",
			"meter.card.title": "DeepSeek Harness · API 用量",
			"meter.card.tier": "段位",
			"meter.card.month": "本月",
			"meter.card.today": "今日费用",
			"meter.card.grand": "累计费用",
			"meter.card.cacheHit": "缓存命中率",
			"meter.card.generated": "生成于 {date}",
			"meter.compact": "压缩",
			"meter.compactHint": "已把 /compact 放进输入框，回车发送即可压缩上下文",
			"meter.compactCopied": "已复制 /compact 到剪贴板，粘贴到输入框回车即可",
			"meter.occupancy.ok": "宽裕",
			"meter.occupancy.warn": "偏高",
			"meter.occupancy.high": "紧张",
			"meter.occupancy.critical": "危险",
			"meter.chipBalance": "余额 {balance}",
			"meter.updateCheck": "检查更新",
			"meter.updating": "更新中…",
			"meter.updateBtn": "更新",
			"meter.updateLatest": "已是最新 v{version}",
			"meter.updateNew": "新版本 v{version}",
			"meter.updateDone": "已更新，请重启 Harness 生效（托盘菜单 → 重启 Harness）",
			"meter.updateFailed": "更新失败：{error}",
			"meter.updateFailGeneric": "更新失败，详见 Harness 日志",
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
			"meter.chartNote": "chart & model shares estimated at each interval's effective list prices",
			"meter.historyNote": "history priced per effective list-price interval ({n} intervals)",
			"meter.unknownModel": "unknown model",
			"meter.monthTier": "Month tier",
			"meter.monthTokens": "this month {tokens}",
			"meter.toNext": "{left} to {next}",
			"meter.maxTier": "top tier reached",
			"meter.shareCard": "Share card",
			"meter.saveCard": "Save image",
			"meter.close": "Close",
			"meter.card.title": "DeepSeek Harness · API usage",
			"meter.card.tier": "Tier",
			"meter.card.month": "This month",
			"meter.card.today": "Today",
			"meter.card.grand": "Total",
			"meter.card.cacheHit": "Cache hit rate",
			"meter.card.generated": "generated {date}",
			"meter.compact": "Compact",
			"meter.compactHint": "/compact was placed into the composer — press Enter to compact the context",
			"meter.compactCopied": "/compact copied to clipboard — paste it into the composer and send",
			"meter.occupancy.ok": "comfortable",
			"meter.occupancy.warn": "elevated",
			"meter.occupancy.high": "tight",
			"meter.occupancy.critical": "critical",
			"meter.chipBalance": "balance {balance}",
			"meter.updateCheck": "Check update",
			"meter.updating": "Updating…",
			"meter.updateBtn": "Update",
			"meter.updateLatest": "up to date v{version}",
			"meter.updateNew": "new version v{version}",
			"meter.updateDone": "Updated — restart Harness to apply (tray menu → Restart Harness)",
			"meter.updateFailed": "update failed: {error}",
			"meter.updateFailGeneric": "update failed, see Harness logs",
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
			chartCol: { flex: "1 1 0%", minWidth: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "flex-end" },
			chartStack: { width: "100%", flex: "1 1 0%", minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "stretch", gap: "1px" },
			chartBar: { width: "100%", borderRadius: "3px 3px 0 0", background: "var(--dsw-alias-interactive-bg-hover)", minHeight: "2px", transition: "height .25s" },
			chartSeg: { width: "100%", borderRadius: "2px", minHeight: "2px", flex: "none", transition: "height .25s" },
			chartLabel: { fontSize: "9px", lineHeight: "12px", color: "var(--dsw-alias-label-caption)", whiteSpace: "nowrap", marginTop: "3px", alignSelf: "center", maxWidth: "100%", overflow: "hidden" },
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
			occupancyOk: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-secondary)" },
			occupancyWarn: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-state-warn-label)" },
			occupancyHigh: { fontVariantNumeric: "tabular-nums", color: "#f97316", fontWeight: 500 },
			occupancyCritical: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 },
			tierBadge: {
				display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", lineHeight: "18px",
				padding: "0 8px", borderRadius: "999px", border: "1px solid var(--dsw-alias-border-l3)",
				background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)", fontWeight: 500, flex: "none",
			},
			tierBar: { background: "var(--dsw-alias-interactive-bg-hover)", borderRadius: "999px", height: "4px", margin: "4px 0 2px", overflow: "hidden" },
			tierFill: { background: "linear-gradient(90deg, #3b82f6, #8b5cf6)", borderRadius: "999px", height: "100%", transition: "width .2s" },
			updateRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginTop: "8px", fontSize: "11px", lineHeight: "18px", color: "var(--dsw-alias-label-caption)" },
			updateBtns: { display: "inline-flex", gap: "6px", alignItems: "center", flex: "none" },
			updateMsg: { color: "var(--dsw-alias-label-caption)", fontSize: "11px", lineHeight: "16px", marginTop: "4px" },
			updateMsgOk: { color: "var(--dsw-alias-state-success-primary)", fontSize: "11px", lineHeight: "16px", marginTop: "4px" },
			updateMsgErr: { color: "var(--dsw-alias-state-error-primary)", fontSize: "11px", lineHeight: "16px", marginTop: "4px" },
			compactMsg: { color: "var(--dsw-alias-label-caption)", fontSize: "11px", lineHeight: "16px", marginTop: "4px" },
		};

		function UsageMeter({ useProjection, useUsageSettings, t, usageSessionId }) {
			const usage = useProjection("tokenUsage");
			const pressure = useProjection("contextPressure");
			const scoped = useUsageSettings((value) => value);
			const settings = (scoped && typeof scoped === "object" && "value" in scoped ? scoped.value : scoped) ?? {};

			const currency = settings.currency === "USD" ? "USD" : "CNY";
			const lang = /[\u4e00-\u9fa5]/.test(t("meter.title")) ? "zh" : "en";
			const budget = typeof settings.budget === "number" && Number.isFinite(settings.budget) && settings.budget > 0 ? settings.budget : 0;
			const pricingOverrides = settings.pricing && typeof settings.pricing === "object" ? settings.pricing : {};

			const [open, setOpen] = react.useState(false);
			const [hovered, setHovered] = react.useState(false);
			const [chartMode, setChartMode] = react.useState("today");
			const [snapshot, setSnapshot] = react.useState(null);
			const [refreshing, setRefreshing] = react.useState(false);
			const [upd, setUpd] = react.useState(null);
			const [updating, setUpdating] = react.useState(false);
			const [updMsg, setUpdMsg] = react.useState(null);
			const [compactMsg, setCompactMsg] = react.useState(null);
			const rootRef = react.useRef(null);

			/** 把 /compact 放进输入框（textarea / contenteditable 兜底，再不行复制剪贴板）。 */
			const triggerCompact = () => {
				try {
					const areas = document.querySelectorAll("textarea");
					for (const ta of areas) {
						if (!(ta instanceof HTMLTextAreaElement)) continue;
						if (!ta.offsetParent && ta.getBoundingClientRect().height === 0) continue;
						const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
						if (setter) setter.call(ta, "/compact");
						else ta.value = "/compact";
						ta.dispatchEvent(new Event("input", { bubbles: true }));
						ta.focus();
						setCompactMsg(t("meter.compactHint"));
						return;
					}
					const ce = document.querySelector('[contenteditable="true"]');
					if (ce instanceof HTMLElement && ce.offsetParent) {
						ce.focus();
						ce.textContent = "/compact";
						ce.dispatchEvent(new Event("input", { bubbles: true }));
						const sel = window.getSelection();
						if (sel) { sel.selectAllChildren(ce); sel.collapseToEnd(); }
						setCompactMsg(t("meter.compactHint"));
						return;
					}
				} catch { /* fall through to clipboard */ }
				try {
					navigator.clipboard?.writeText("/compact");
					setCompactMsg(t("meter.compactCopied"));
				} catch {
					setCompactMsg(null);
				}
			};

			const checkUpdate = () => {
				fetch("/usage-meter/update-check")
					.then((r) => (r.ok ? r.json() : null))
					.then((d) => d && setUpd(d))
					.catch(() => setUpd({ current: null, latest: null, newer: false, error: "transport" }));
			};

			const runUpdate = () => {
				setUpdating(true);
				setUpdMsg(null);
				fetch("/usage-meter/update", { method: "POST" })
					.then((r) => r.json())
					.then((d) => {
						setUpdating(false);
						setUpdMsg(d?.ok === true ? t("meter.updateDone") : t("meter.updateFailed", { error: d?.error ?? "?" }));
						if (d?.ok === true) setUpd((u) => (u ? { ...u, newer: false } : u));
					})
					.catch(() => { setUpdating(false); setUpdMsg(t("meter.updateFailGeneric")); });
			};

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
			const pricingHistory = Array.isArray(snapshot?.pricingHistory) ? snapshot.pricingHistory : [];
			const prices = pricesOf(model, currency, pricingOverrides, officialPricing);
			/** 某模型在当前时刻的 p（今日与实时用量）。 */
			const priceNow = (m) => pricesOf(m, currency, pricingOverrides, officialPricing).p;
			/** 某模型在某日生效区间刊例价下的 p。 */
			const priceOn = (dayKeyStr) => (m) => pricesOf(m, currency, pricingOverrides, officialPricing, pricingHistory, dayKeyStr).p;

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
			const bucketsCost = (b, p) => costOf(
				(b.uncachedInputTokens ?? 0) + (b.cacheWriteTokens ?? 0),
				b.cacheReadTokens ?? 0,
				b.outputTokens ?? 0,
				p,
			);
			// 今日累计：按“今日各模型桶 × 各自当前单价”求和（与累计/模型分布口径一致），
			// 无模型拆分的老账本日退化为总量 × 当前会话模型单价。
			const todayDayEntry = snapshot?.days?.[todayKeyLocal()];
			let todayCost = null;
			const todayModels = todayDayEntry?.models;
			if (todayModels && typeof todayModels === "object" && Object.keys(todayModels).length > 0) {
				let sum = 0;
				for (const [m, mb] of Object.entries(todayModels)) {
					if (!mb || typeof mb !== "object" || isZeroBucketish(mb)) continue;
					sum += bucketsCost(mb, priceNow(m));
				}
				todayCost = sum;
			} else if (todayBuckets) {
				todayCost = bucketsCost(todayBuckets, prices.p);
			}
			// 累计费用：优先“日账本 × 各日生效区间价 × 各模型单价”逐日求和；
			// 无日明细时退化为“各模型桶 × 当前单价”；再退化为总量 × 当前会话模型单价。
			let grandCost = null;
			if (pricingHistory.length > 0 && snapshot?.days && Object.keys(snapshot.days).length > 0) {
				let sum = 0;
				for (const [dk, dv] of Object.entries(snapshot.days)) {
					const dayPrice = priceOn(dk);
					const models = dv?.models;
					if (models && typeof models === "object" && Object.keys(models).length > 0) {
						for (const [m, mb] of Object.entries(models)) {
							if (!mb || typeof mb !== "object" || isZeroBucketish(mb)) continue;
							sum += bucketsCost(mb, dayPrice(m));
						}
					} else if (dv?.total && !isZeroBucketish(dv.total)) {
						sum += bucketsCost(dv.total, dayPrice(DEFAULT_MODEL));
					}
				}
				grandCost = sum;
			} else if (snapshot?.models && typeof snapshot.models === "object" && Object.keys(snapshot.models).length > 0) {
				let sum = 0;
				for (const [m, mb] of Object.entries(snapshot.models)) {
					if (!mb || typeof mb !== "object" || isZeroBucketish(mb)) continue;
					sum += bucketsCost(mb, priceNow(m));
				}
				grandCost = sum;
			} else if (grandBuckets) {
				grandCost = bucketsCost(grandBuckets, prices.p);
			}

			const budgetUsed = todayCost !== null ? todayCost : liveCost;
			const budgetPct = budget > 0 ? Math.min(100, Math.round(budgetUsed / budget * 100)) : 0;
			const budgetState = budget > 0 && budgetUsed >= budget ? "over" : budget > 0 && budgetUsed >= budget * 0.8 ? "warn" : "ok";
			const costClass = budgetState === "over" ? styles.costOver : budgetState === "warn" ? styles.costWarn : styles.cost;

			const balance = snapshot?.balance;
			const balanceAmount = balance?.ok ? normalizeBalance(balance.data, currency) : null;

			const tierLabel = prices.peak ? t("meter.peak") : t("meter.offpeak");

			const chipCost = formatMoney(liveCost, currency);
			const chipToday = todayCost !== null ? formatMoney(todayCost, currency) : null;
			const chipBalance = balanceAmount !== null ? formatMoney(balanceAmount, currency) : null;

			// 上下文压力三档预警：30% / 50% / 85%
			const occTier = occupancy === null ? null : occupancy >= 85 ? "critical" : occupancy >= 50 ? "high" : occupancy >= 30 ? "warn" : "ok";
			const occStyle = occTier === "critical" ? styles.occupancyCritical : occTier === "high" ? styles.occupancyHigh : occTier === "warn" ? styles.occupancyWarn : styles.occupancyOk;
			const occLabel = occTier === "critical" ? t("meter.occupancy.critical") : occTier === "high" ? t("meter.occupancy.high") : occTier === "warn" ? t("meter.occupancy.warn") : t("meter.occupancy.ok");

			// 消耗段位（本月 tokens）
			const monthTok = monthTokens(snapshot?.days);
			const tier = tierOf(monthTok);
			const tierIdx = TIERS.indexOf(tier);
			const nextTier = tierIdx + 1 < TIERS.length ? TIERS[tierIdx + 1] : null;
			const tierPct = nextTier ? Math.min(100, Math.round((monthTok - tier.min) / (nextTier.min - tier.min) * 100)) : 100;

			// 本月费用（按各日生效区间价逐日求和，分享卡片用）
			let monthCost = null;
			{
				const nowD = new Date();
				const mp = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, "0")}-`;
				if (snapshot?.days) {
					let sum = 0;
					let any = false;
					for (const [dk, dv] of Object.entries(snapshot.days)) {
						if (!dk.startsWith(mp)) continue;
						const dayPrice = pricingHistory.length > 0 ? priceOn(dk) : priceNow;
						const models = dv?.models;
						if (models && typeof models === "object" && Object.keys(models).length > 0) {
							for (const [m, mb] of Object.entries(models)) {
								if (!mb || typeof mb !== "object" || isZeroBucketish(mb)) continue;
								sum += bucketsCost(mb, dayPrice(m));
								any = true;
							}
						} else if (dv?.total && !isZeroBucketish(dv.total)) {
							sum += bucketsCost(dv.total, dayPrice(DEFAULT_MODEL));
							any = true;
						}
					}
					monthCost = any ? sum : null;
				}
			}

			// 分享卡片浮层：命令式 DOM 挂到 document.body —— 面板/输入框区域可能带
			// transform 祖先，会劫持 position:fixed 的包含块，导致浮层被压到底部。
			let cardOverlayEl = null;
			const onCardKey = (e) => {
				if (e.key === "Escape") closeCard();
			};
			const closeCard = () => {
				if (cardOverlayEl !== null) {
					try {
						cardOverlayEl.remove();
					} catch {
						/* ignore */
					}
					cardOverlayEl = null;
					document.removeEventListener("keydown", onCardKey);
				}
			};
			/** 全屏居中展示卡片浮层（点击遮罩或 Esc 关闭）。 */
			const openCardOverlay = (url) => {
				closeCard();
				const ov = document.createElement("div");
				Object.assign(ov.style, {
					position: "fixed",
					top: "0",
					left: "0",
					right: "0",
					bottom: "0",
					zIndex: "99999",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					background: "rgba(0,0,0,.55)",
					padding: "16px",
					boxSizing: "border-box",
				});
				const box = document.createElement("div");
				Object.assign(box.style, { display: "flex", flexDirection: "column", gap: "10px", alignItems: "center", maxWidth: "100%" });
				if (url) {
					const img = document.createElement("img");
					img.src = url;
					img.alt = "share card";
					Object.assign(img.style, { maxWidth: "100%", maxHeight: "72vh", borderRadius: "12px", boxShadow: "0 16px 48px rgba(0,0,0,.5)", display: "block" });
					box.appendChild(img);
				} else {
					const ph = document.createElement("span");
					ph.textContent = "…";
					ph.style.color = "#e8ecf4";
					box.appendChild(ph);
				}
				const btns = document.createElement("div");
				Object.assign(btns.style, { display: "flex", gap: "8px" });
				const mkBtn = (label, onClick) => {
					const b = document.createElement("button");
					b.type = "button";
					b.textContent = label;
					Object.assign(b.style, {
						font: "inherit",
						fontSize: "12px",
						lineHeight: "20px",
						color: "#e8ecf4",
						cursor: "pointer",
						background: "rgba(20,26,38,.92)",
						border: "1px solid #333d4f",
						borderRadius: "8px",
						padding: "2px 12px",
					});
					b.addEventListener("click", onClick);
					return b;
				};
				if (url) {
					btns.appendChild(mkBtn(t("meter.saveCard"), () => {
						const a = document.createElement("a");
						a.href = url;
						a.download = "dsh-usage-card.png";
						document.body.appendChild(a);
						a.click();
						a.remove();
					}));
				}
				btns.appendChild(mkBtn(t("meter.close"), closeCard));
				box.appendChild(btns);
				ov.appendChild(box);
				ov.addEventListener("click", (e) => {
					if (e.target === ov) closeCard();
				});
				document.body.appendChild(ov);
				cardOverlayEl = ov;
				document.addEventListener("keydown", onCardKey);
			};

			/** 用 canvas 画梁祖分享卡片（640×360），完成后居中弹层展示。 */
			const drawShareCard = () => {
				const W = 640;
				const H = 360;
				const cv = document.createElement("canvas");
				cv.width = W;
				cv.height = H;
				const g = cv.getContext("2d");
				if (!g) return;
				const roundRect = (x, y, w, h, r) => {
					g.beginPath();
					g.moveTo(x + r, y);
					g.arcTo(x + w, y, x + w, y + h, r);
					g.arcTo(x + w, y + h, x, y + h, r);
					g.arcTo(x, y + h, x, y, r);
					g.arcTo(x, y, x + w, y, r);
					g.closePath();
				};
				const draw = () => {
					// 底色 + 描边
					g.fillStyle = "#0b0e14";
					roundRect(0, 0, W, H, 20);
					g.fill();
					g.strokeStyle = "#333d4f";
					g.lineWidth = 2;
					roundRect(1, 1, W - 2, H - 2, 20);
					g.stroke();
					// 左侧梁祖吉祥物
					const img = new Image();
					img.onload = () => {
						g.drawImage(img, 30, 110, 170, 170);
						finish();
					};
					img.onerror = () => finish();
					img.src = LIANGZU_MASCOT;
					// 右侧信息
					g.fillStyle = "#9aa4b5";
					g.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
					g.fillText(t("meter.card.title"), 236, 64);
					g.fillStyle = "#e8ecf4";
					g.font = '600 42px "Segoe UI", "Microsoft YaHei", sans-serif';
					g.fillText(`${tier.emoji} ${tierName(tier, lang)}`, 236, 122);
					g.fillStyle = "#667082";
					g.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
					g.fillText(`${t("meter.card.tier")} · ${t("meter.monthTokens", { tokens: formatTokens(monthTok) })}`, 236, 148);
					const lines = [
						[t("meter.card.month"), `${formatTokens(monthTok)} · ${monthCost !== null ? formatMoney(monthCost, currency) : "—"}`],
						[t("meter.card.today"), todayCost !== null ? formatMoney(todayCost, currency) : "—"],
						[t("meter.card.grand"), grandCost !== null ? formatMoney(grandCost, currency) : "—"],
						[t("meter.card.cacheHit"), cacheHitPct !== null ? `${cacheHitPct}%` : "—"],
					];
					let y = 196;
					for (const [k, v] of lines) {
						g.fillStyle = "#9aa4b5";
						g.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
						g.fillText(k, 236, y);
						g.fillStyle = "#e8ecf4";
						g.font = '600 13px "Segoe UI", "Microsoft YaHei", sans-serif';
						g.textAlign = "right";
						g.fillText(v, 606, y);
						g.textAlign = "left";
						y += 34;
					}
					g.fillStyle = "#3b4859";
					g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
					g.fillText(`dsh-plugin-usage-meter · ${t("meter.card.generated", { date: new Date().toLocaleDateString() })}`, 24, H - 18);
				};
				const finish = () => {
					let url = null;
					try {
						url = cv.toDataURL("image/png");
					} catch {
						url = null;
					}
					openCardOverlay(url);
				};
				draw();
			};

			// Stacked time buckets for the two chart views (today = hourly, week = daily).
			const hourBars = [];
			for (let h = 0; h < 24; h++) {
				const hourEntry = snapshot?.hours?.[String(h)];
				const segs = stackSegments(hourEntry?.models, priceNow, hourEntry?.total);
				const total = segs.reduce((s, x) => s + x.cost, 0);
				hourBars.push({ key: `h${h}`, label: h % 3 === 0 ? String(h) : "", title: `${String(h).padStart(2, "0")}:00`, segs, total });
			}
			const hourMax = hourBars.reduce((m, b) => Math.max(m, b.total), 0);

			const weekBars = lastNDays(7).map((d) => {
				const dayEntry = snapshot?.days?.[d.key];
				const segs = stackSegments(dayEntry?.models, priceOn(d.key), dayEntry?.total);
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
						react_jsx_runtime.jsx("div", { style: styles.chartStack, children:
							b.total === 0
								? react_jsx_runtime.jsx("div", { style: { ...styles.chartBar, height: "2px" } })
								: b.segs.map((s) =>
									react_jsx_runtime.jsx("div", {
										key: s.model,
										style: {
											...styles.chartSeg,
											background: colorMap[s.model] ?? "#8b949e",
											height: barMax > 0 ? `${Math.max(2, Math.round(s.cost / barMax * 100))}%` : "2px",
										},
									})
								)
						}),
						react_jsx_runtime.jsx("span", { style: styles.chartLabel, children: b.label }),
					],
				})
			) });

			// 模型分布：与“累计”同口径——按“日账本 × 各日生效区间价 × 各模型单价”
			// 汇总（两行合计必然等于累计）；无日明细时退化为 grandModels × 当前单价。
			const modelRows = (() => {
				if (snapshot?.days && Object.keys(snapshot.days).length > 0) {
					const agg = new Map();
					const addRow = (model, mb, p) => {
						const miss = (mb.uncachedInputTokens ?? 0) + (mb.cacheWriteTokens ?? 0);
						const hit = mb.cacheReadTokens ?? 0;
						const out = mb.outputTokens ?? 0;
						let r = agg.get(model);
						if (r === undefined) {
							r = { model, cost: 0, tokens: 0, miss: 0, hit: 0, out: 0 };
							agg.set(model, r);
						}
						r.cost += costOf(miss, hit, out, p);
						r.tokens += miss + hit + out;
						r.miss += miss;
						r.hit += hit;
						r.out += out;
					};
					for (const [dk, dv] of Object.entries(snapshot.days)) {
						const dayPrice = priceOn(dk);
						const models = dv?.models;
						if (models && typeof models === "object" && Object.keys(models).length > 0) {
							for (const [m, mb] of Object.entries(models)) {
								if (!mb || typeof mb !== "object" || isZeroBucketish(mb)) continue;
								addRow(m, mb, dayPrice(m));
							}
						} else if (dv?.total && !isZeroBucketish(dv.total)) {
							addRow("unknown", dv.total, dayPrice(DEFAULT_MODEL));
						}
					}
					return [...agg.values()].sort((a, b) => b.cost - a.cost);
				}
				return modelBreakdown(snapshot?.models, priceNow);
			})();
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
							chipBalance !== null && react_jsx_runtime.jsxs(react.Fragment, {
								children: [
									react_jsx_runtime.jsx("span", { style: styles.dot, "aria-hidden": true, children: "·" }),
									react_jsx_runtime.jsx("span", { children: t("meter.chipBalance", { balance: chipBalance }) }),
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
								react_jsx_runtime.jsx("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px", flex: "none" }, children: [
									react_jsx_runtime.jsxs("span", { style: occStyle, title: occLabel, children: [
										`${occupancy}%`,
										" · " + occLabel,
									] }),
									occupancy >= 30 && react_jsx_runtime.jsx("button", {
										type: "button",
										style: styles.refreshBtn,
										onClick: triggerCompact,
										title: "/compact",
										children: t("meter.compact"),
									}),
								] }),
							] }),
							compactMsg !== null && react_jsx_runtime.jsx("div", { style: styles.compactMsg, children: compactMsg }),
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
							react_jsx_runtime.jsxs("div", { style: styles.row, children: [
								react_jsx_runtime.jsx("span", { style: styles.rowLabel, children: t("meter.monthTier") }),
								react_jsx_runtime.jsx("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px", flex: "none" }, children: [
									react_jsx_runtime.jsxs("span", { style: styles.tierBadge, children: [tier.emoji, " ", tierName(tier, lang)] }),
									react_jsx_runtime.jsx("button", {
										type: "button",
										style: styles.refreshBtn,
										onClick: () => drawShareCard(),
										children: t("meter.shareCard"),
									}),
								] }),
							] }),
							react_jsx_runtime.jsxs("div", { style: styles.row, children: [
								react_jsx_runtime.jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-caption)" }, children: t("meter.monthTokens", { tokens: formatTokens(monthTok) }) }),
								nextTier
									? react_jsx_runtime.jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-caption)" }, children: t("meter.toNext", { next: tierName(nextTier, lang), left: formatTokens(nextTier.min - monthTok) }) })
									: react_jsx_runtime.jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-caption)" }, children: t("meter.maxTier") }),
							] }),
							react_jsx_runtime.jsx("div", { style: styles.tierBar, children: react_jsx_runtime.jsx("div", { style: { ...styles.tierFill, width: `${tierPct}%` } }) }),
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
							react_jsx_runtime.jsxs("div", { style: styles.updateRow, children: [
								react_jsx_runtime.jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: upd === null
									? "dsh-plugin-usage-meter"
									: upd.newer
										? t("meter.updateNew", { version: upd.latest })
										: upd.latest
											? t("meter.updateLatest", { version: upd.latest })
											: t("meter.updateFailGeneric") }),
								react_jsx_runtime.jsxs("span", { style: styles.updateBtns, children: [
									react_jsx_runtime.jsx("button", {
										type: "button",
										style: styles.refreshBtn,
										onClick: checkUpdate,
										children: t("meter.updateCheck"),
									}),
									upd?.newer && react_jsx_runtime.jsx("button", {
										type: "button",
										style: styles.refreshBtn,
										onClick: runUpdate,
										disabled: updating,
										children: updating ? t("meter.updating") : t("meter.updateBtn"),
									}),
								] }),
							] }),
							updMsg !== null && react_jsx_runtime.jsx("div", {
								style: updMsg === t("meter.updateDone") ? styles.updateMsgOk : updMsg === t("meter.updateFailGeneric") || (typeof updMsg === "string" && updMsg.indexOf("失败") >= 0) ? styles.updateMsgErr : styles.updateMsg,
								children: updMsg,
							}),
							react_jsx_runtime.jsx("div", { style: styles.footer, children: [
								prices.live
									? t("meter.verifiedLive", { date: prices.verifiedAt })
									: t("meter.verified", { date: VERIFIED_AT }),
								" · " + t("meter.model") + " " + normalizeModel(model),
								(hasChartData || modelRows.length > 0) ? " · " + t("meter.chartNote") : null,
								pricingHistory.length >= 2 ? " · " + t("meter.historyNote", { n: pricingHistory.length }) : null,
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
