// Local end-to-end smoke test for Harness 0.2.x.
//
// It installs the *packed* workspace plugin into a throwaway web profile, boots
// `dsh web` with a throwaway DSH_HOME, opens the page in headless Chrome, and
// asserts that:
//   1. web boot reports no failed entry (the 0.2.2 composer-dock id collision
//      used to make @deepseek-ai/dsh-client-ui-chat fail and blank the app);
//   2. the host half serves /usage-meter/state;
//   3. the legacy settings.yaml section was imported into the profile Config and
//      reaches the client (currency/budget/pricing), i.e. Harness 0.2.2's
//      one-time migration actually ran.
//
// Requirements: macOS Harness install + Chrome (or Chromium/Edge) + network for
// the plugin's single official dependency (@deepseek-ai/schemastery).
// Override paths with DSH_APP_BIN, DSH_CLI_BIN, DSH_PNPM, CHROME_PATH.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const APP_BIN = process.env.DSH_APP_BIN ?? "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
const RESOURCES = join(dirname(dirname(APP_BIN)), "Resources");
const CLI_BIN = process.env.DSH_CLI_BIN ?? join(RESOURCES, "app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
const PNPM_CJS = process.env.DSH_PNPM ?? join(RESOURCES, "runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs");
const CHROME =
  process.env.CHROME_PATH ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((candidate) => existsSync(candidate));

const children = new Set();
function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
async function stop(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** Collect output while resolving when a line matches. */
function waitForLine(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${pattern}; output:\n${buffer.slice(-3000)}`));
    }, timeoutMs);
    const onData = (data) => {
      buffer += String(data);
      const match = pattern.exec(buffer);
      if (match !== null) {
        cleanup();
        resolve(match);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`process exited (${code}) before ${pattern}; output:\n${buffer.slice(-3000)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function packPlugin(destination) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : "npm";
  const args = npmCli
    ? [npmCli, "pack", "--pack-destination", destination, "--cache", join(destination, "npm-cache"), "--json"]
    : ["pack", "--pack-destination", destination, "--cache", join(destination, "npm-cache"), "--json"];
  const child = start(command, args, { cwd: repo });
  let output = "";
  child.stdout.on("data", (data) => (output += String(data)));
  child.stderr.on("data", (data) => (output += String(data)));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`npm pack failed (${code}):\n${output}`);
  const parsed = JSON.parse(output.slice(output.indexOf("[")));
  const filename = parsed[0]?.filename;
  assert.ok(filename, `npm pack did not report a filename:\n${output}`);
  return join(destination, filename);
}

/** Minimal CDP client for console capture and page evaluation. */
async function connectChrome(port) {
  let page;
  for (let i = 0; i < 80 && page === undefined; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = targets.find((target) => target.type === "page");
    } catch {
      /* not ready */
    }
    if (page === undefined) await sleep(250);
  }
  if (page === undefined) throw new Error("Chrome DevTools endpoint did not become ready");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP WebSocket failed"));
  });
  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      logs.push({ level: message.params.type, text: (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ") });
    } else if (message.method === "Runtime.exceptionThrown") {
      logs.push({ level: "exception", text: message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text ?? "" });
    } else if (message.method === "Log.entryAdded") {
      logs.push({ level: message.params.entry.level, text: message.params.entry.text });
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails !== undefined) throw new Error(`page evaluation failed: ${JSON.stringify(response.result.exceptionDetails)}`);
    return response.result?.result?.value;
  };
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  return { ws, send, evaluate, logs };
}

async function main() {
  assert.ok(CHROME !== undefined, "no Chrome/Chromium found; set CHROME_PATH");
  const home = await mkdtemp(join(tmpdir(), "usage-meter-smoke-"));
  const work = await mkdtemp(join(tmpdir(), "usage-meter-smoke-work-"));
  let web;
  let chrome;
  let cdp;
  try {
    // 1. Install the packed plugin (a link: install would not pull its dependency).
    const tarball = await packPlugin(work);
    const shimDir = join(work, "bin");
    await mkdir(shimDir, { recursive: true });
    await writeFile(
      join(shimDir, "pnpm"),
      `#!/bin/sh\nexec "${process.execPath}" "${PNPM_CJS}" "$@"\n`,
      { mode: 0o755 },
    );
    const install = start(APP_BIN, ["--expose-internals", CLI_BIN, "plugin", "--profile", "web", "add", tarball], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DSH_HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      },
    });
    let installLog = "";
    install.stdout.on("data", (data) => (installLog += String(data)));
    install.stderr.on("data", (data) => (installLog += String(data)));
    const installCode = await new Promise((resolve) => install.on("exit", resolve));
    if (installCode !== 0) throw new Error(`plugin install failed (${installCode}):\n${installLog}`);
    assert.match(installLog, /dsh-plugin-usage-meter/, `install did not report the plugin:\n${installLog}`);

    // 2. Legacy settings: 0.2.2 must import this into the entry Config.
    await writeFile(
      join(home, "settings.yaml"),
      [
        "usage-meter:",
        "  currency: USD",
        "  budget: 3",
        "  pricing:",
        "    deepseek-flash:",
        "      peak: { cacheMissInput: 0.5, cacheHitInput: 0.01, output: 1.5 }",
        "",
      ].join("\n"),
    );

    // 3. Boot the web profile without opening a real browser window.
    const port = await freePort();
    web = start(APP_BIN, ["--expose-internals", CLI_BIN, "web", "--port", String(port), "--no-open"], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DSH_HOME: home,
        DEEPSEEK_API_KEY: "sk-smoke-test",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
        USAGE_METER_AUTO_PLATFORM_TOKEN: "0",
      },
    });
    const webLog = [];
    web.stdout.on("data", (data) => webLog.push(String(data)));
    web.stderr.on("data", (data) => webLog.push(String(data)));
    const urlMatch = await waitForLine(web, /dsh web: (http:\/\/[^\s]+)/, 90_000);
    const url = urlMatch[1];

    // 4. Open the page and watch for boot failures.
    const cdpPort = await freePort();
    chrome = start(CHROME, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(work, "chrome")}`,
      `--remote-debugging-port=${cdpPort}`,
      "--remote-allow-origins=*",
      "about:blank",
    ]);
    cdp = await connectChrome(cdpPort);
    await cdp.send("Page.navigate", { url });
    await sleep(7000);

    const bootErrors = cdp.logs.filter(
      (entry) =>
        entry.level === "error" &&
        (/web boot/i.test(entry.text) || /did not activate/i.test(entry.text) || /Failed to load plugins/i.test(entry.text)),
    );
    const body = (await cdp.evaluate("document.body.innerText")) ?? "";
    assert.deepEqual(bootErrors, [], `web boot failed:\n${JSON.stringify(bootErrors, null, 2)}`);
    assert.doesNotMatch(body, /Failed to load plugins/, "page reported a plugin loading failure");
    assert.match(body, /HARNESS|新会话|New session/i, `page did not render the app shell:\n${body.slice(0, 800)}`);

    // 5. The host half and the settings migration must both be live.
    let state = null;
    for (let i = 0; i < 30; i++) {
      state = await cdp.evaluate(
        "fetch('/usage-meter/state').then((r) => (r.ok ? r.json() : null)).catch(() => null)",
      );
      if (state?.settings?.currency === "USD" && state.settings.budget === 3) break;
      await sleep(500);
    }
    assert.ok(state !== null, "/usage-meter/state did not answer");
    assert.equal(state.settings.currency, "USD", `legacy currency was not imported: ${JSON.stringify(state.settings)}`);
    assert.equal(state.settings.budget, 3, `legacy budget was not imported: ${JSON.stringify(state.settings)}`);
    assert.equal(
      state.settings.pricing?.["deepseek-flash"]?.peak?.cacheMissInput,
      0.5,
      `legacy pricing was not imported: ${JSON.stringify(state.settings)}`,
    );

    console.log(`smoke: ok (${url.replace(/\?.*$/, "")})`);
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    await stop(chrome);
    await stop(web);
    for (const child of children) await stop(child);
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`smoke: FAILED\n${error?.stack ?? error}`);
  for (const child of children) child.kill("SIGKILL");
  process.exitCode = 1;
});
