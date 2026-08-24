// Render a local HTML file to PNG via Edge headless + Chrome DevTools Protocol.
// Usage: node scripts/render-preview.mjs <file:///...html> <out.png> [width] [height] [scale]
// Why CDP instead of --screenshot: this Edge build ignores --window-size in
// --screenshot mode, producing tiny unpredictable captures. Emulation.setDeviceMetricsOverride
// gives an exact viewport and device scale (default 2x for crisp text).
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const [url, out] = process.argv.slice(2);
const width = parseInt(process.argv[4] ?? "440", 10);
const height = parseInt(process.argv[5] ?? "700", 10);
const scale = parseInt(process.argv[6] ?? "2", 10);
if (!url || !out) {
  console.error("usage: node render-preview.mjs <file:///...html> <out.png> [w] [h] [scale]");
  process.exit(2);
}

const port = 9300 + Math.floor(Math.random() * 400);
const userDataDir = await mkdtemp(join(tmpdir(), "edge-cdp-"));
const child = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function devtoolsJson(path) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      if (r.ok) return r.json();
    } catch {
      /* not ready yet */
    }
    await sleep(200);
  }
  throw new Error(`DevTools endpoint not ready: ${path}`);
}

let ws;
try {
  const targets = await devtoolsJson("/json");
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("WebSocket connect failed"));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  await sleep(300); // let the metrics override settle before navigating
  await send("Page.navigate", { url });
  await sleep(2000);
  const debug = process.argv.includes("--debug");
  if (debug) {
    const lm = await send("Page.getLayoutMetrics");
    console.log("layoutMetrics:", JSON.stringify({ cssContentSize: lm.result?.cssContentSize, cssVisualViewport: lm.result?.cssVisualViewport }));
  }
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!shot.result?.data) throw new Error(`capture failed: ${JSON.stringify(shot).slice(0, 200)}`);
  await writeFile(out, Buffer.from(shot.result.data, "base64"));
  console.log(`rendered ${width}x${height} @${scale}x -> ${out}`);
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  child.kill();
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
