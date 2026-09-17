// Pricing-parser regression test.
//
// Why: 官方定价页改版过一次（3 模型列 → 2 模型列 + 模型改名），当时解析器静默失败、
// 面板退回内置旧价。这个测试用「真实页面存档 + 旧版结构合成样本」锁住解析契约，
// 官方再改版时 `npm test` 会第一时间失败，而不是等用户发现价格不对。
//
// Run: node scripts/test-pricing.mjs   (or: npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePricing } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "test", "fixtures");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

console.log("pricing parser");

// ---- 新版页面（2026-09 起：2 模型列）------------------------------------
const modern = parsePricing(readFileSync(join(fixtures, "pricing-2026-09-new.html"), "utf8"));
check("新版页面可解析", () => assert.ok(modern, "parsePricing returned null"));
check("新版：模型列为 deepseek-flash / deepseek-v4-pro", () =>
  assert.deepEqual(Object.keys(modern.models).sort(), ["deepseek-flash", "deepseek-v4-pro"]));
check("新版：flash 价格正确（peak 0.30/0.006/1.20）", () =>
  assert.deepEqual(modern.models["deepseek-flash"].peak, { miss: 0.3, hit: 0.006, out: 1.2 }));
check("新版：flash 空闲价正确（0.15/0.003/0.60）", () =>
  assert.deepEqual(modern.models["deepseek-flash"].offPeak, { miss: 0.15, hit: 0.003, out: 0.6 }));
check("新版：pro 价格未变（peak 1.32/0.044/3.96）", () =>
  assert.deepEqual(modern.models["deepseek-v4-pro"].peak, { miss: 1.32, hit: 0.044, out: 3.96 }));
check("新版：空闲价 = 高峰价一半", () => {
  const m = modern.models["deepseek-v4-pro"];
  for (const k of ["miss", "hit", "out"]) {
    assert.ok(Math.abs(m.offPeak[k] * 2 - m.peak[k]) < 1e-9, `${k}: ${m.offPeak[k]} * 2 != ${m.peak[k]}`);
  }
});
check("高峰时段为 [[1,4],[6,10],weekdays]", () =>
  assert.deepEqual(modern.peakHours, [[1, 4], [6, 10], "weekdays"]));

// ---- 旧版页面（3 模型列，用于回归兼容）---------------------------------
const legacy = parsePricing(readFileSync(join(fixtures, "pricing-legacy-3col.html"), "utf8"));
check("旧版页面仍可解析（3 列）", () => assert.ok(legacy, "legacy parsePricing returned null"));
check("旧版：三个模型列", () =>
  assert.deepEqual(Object.keys(legacy.models).sort(), ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"]));
check("旧版：flash 旧价正确（0.44/0.014/1.32）", () =>
  assert.deepEqual(legacy.models["deepseek-v4-flash"].peak, { miss: 0.44, hit: 0.014, out: 1.32 }));
check("旧版：vision-exp 列不被错位到 pro 上", () =>
  assert.deepEqual(legacy.models["deepseek-v4-flash-vision-exp"].offPeak, { miss: 0.15, hit: 0.005, out: 0.5 }));

// ---- 异常输入 -----------------------------------------------------------
check("缺少 PRICING 标记时返回 null", () => assert.equal(parsePricing("<html><body>hello</body></html>"), null));
check("有 PRICING 但无模型名时返回 null", () => assert.equal(parsePricing("<p>PRICING $1.00 $2.00</p>"), null));
check("数字不足时返回 null", () =>
  assert.equal(parsePricing("<p>PRICING deepseek-flash deepseek-v4-pro 1M INPUT TOKENS (CACHE HIT) OFF-PEAK $0.1 PEAK $0.2</p>"), null));

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
