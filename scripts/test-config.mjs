// Config/slot regression test for the 0.2.x compatibility fix.
//
// Covers the two failure modes that are invisible at runtime until a user
// upgrades: a duplicate composer-dock slot id (crashes ui-chat's activation)
// and a Config schema that cannot accept the legacy settings.yaml shape.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Config, normalizeConfig, parseUsageMeterSettings } from "../lib/index.js";

const legacy = `# legacy settings.yaml
usage-meter:
  currency: USD
  budget: 3
  pricing:
    deepseek-flash:
      peak: { cacheMissInput: 0.5, cacheHitInput: 0.01, output: 1.5 }
      offPeak: { cacheMissInput: 0.25, cacheHitInput: 0.005, output: 0.75 }
`;

const parsed = parseUsageMeterSettings(legacy);
assert.deepEqual(parsed, {
  currency: "USD",
  budget: 3,
  pricing: {
    "deepseek-flash": {
      peak: { cacheMissInput: 0.5, cacheHitInput: 0.01, output: 1.5 },
      offPeak: { cacheMissInput: 0.25, cacheHitInput: 0.005, output: 0.75 },
    },
  },
});
assert.equal(parseUsageMeterSettings("other:\n  x: 1\n"), null);

const validated = Config["~standard"].validate(parsed);
assert.equal(validated.issues, undefined, "legacy settings must satisfy the Config schema");
assert.deepEqual(normalizeConfig(validated.value), parsed);

// volatile fields are what let Settings -> Plugins rewrite the entry live and
// what makes 0.2.2's settings.yaml importer accept the section at all.
for (const field of ["currency", "budget", "pricing"]) {
  assert.equal(Config.dict[field].meta.volatile, true, `${field} must be volatile`);
}

// Defaults: a plugin entry without config still serves a usable shape.
const defaults = normalizeConfig(Config["~standard"].validate({}).value);
assert.deepEqual(defaults, { currency: "CNY", budget: 0, pricing: {} });

// Invalid currency is rejected instead of silently leaking to the UI.
assert.notEqual(Config["~standard"].validate({ currency: "EUR" }).issues, undefined);

const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
assert.match(client, /id:\s*"usage-meter"/, "composer dock id must be namespaced");
assert.match(client, /order:\s*2/, "the chip must sort after native activity(0)/usage(1)");
assert.doesNotMatch(client, /id:\s*"usage"/, "the bare `usage` id collides with ui-chat's native pill");
assert.doesNotMatch(client, /ctx\.settingsScope/, "0.2.x no longer has settingsScope");

console.log("config/slot: ok");
