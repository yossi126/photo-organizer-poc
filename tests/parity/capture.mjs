/**
 * capture.mjs — drives the WebGL side of the render-parity harness.
 *
 * Usage:
 *   1. npm run dev            (vite on http://localhost:1420)
 *   2. node tests/parity/capture.mjs
 *   3. venv/Scripts/python python-backend/tests/test_render_parity.py
 *
 * Writes PNGs to tests/parity/out/.
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
const BASE = process.env.PARITY_BASE_URL || "http://localhost:1420";

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader"], // deterministic software rendering
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.error("BROWSER:", m.text());
});

await page.goto(`${BASE}/?parity=1`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__parityReady === true, { timeout: 15000 });

console.log("Running WebGL parity renders...");
const results = await page.evaluate(() => window.__runParity(), { timeout: 120000 });

let count = 0;
for (const [name, b64] of Object.entries(results)) {
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(b64, "base64"));
  count++;
}
console.log(`Wrote ${count} PNGs to ${OUT_DIR}`);

await browser.close();
