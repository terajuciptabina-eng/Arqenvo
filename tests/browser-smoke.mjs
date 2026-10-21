import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const requested = pathname === "/" ? "/index.html" : pathname;
    const file = path.resolve(root, "." + requested);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const canvas = document.querySelector("#canvas");
    return canvas && canvas.clientWidth > 100 && canvas.clientHeight > 100;
  });
  const canvas = page.locator("#canvas");
  await page.locator('[data-tool="wall"]').click();
  await page.locator("#wallGeometryMethod").selectOption("single");
  // Tool selection can resize the workspace; calculate coordinates only after the UI settles.
  await page.waitForTimeout(80);
  let rect = await canvas.boundingBox();
  assert.ok(rect, "Floor-plan canvas must be visible");
  let cx = rect.x + rect.width / 2;
  let cy = rect.y + rect.height / 2;

  // Draw a horizontal wall, then a vertical branch ending at its midpoint (T junction).
  await page.mouse.click(cx - 72, cy);
  await page.mouse.click(cx + 72, cy);
  // Single-segment mode leaves the next wall independent, allowing a true T-junction test.
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx, cy - 72);
  await page.waitForFunction(() => document.querySelector("#undo")?.disabled === false);
  await page.waitForTimeout(50);

  const centerPixel = await canvas.evaluate(el => {
    const ctx = el.getContext("2d");
    // The world origin is always the live canvas centre; do not reuse stale screen-space coordinates.
    return Array.from(ctx.getImageData(Math.round(el.width / 2), Math.round(el.height / 2), 1, 1).data);
  });
  assert.ok(centerPixel[0] < 170 && centerPixel[1] < 180 && centerPixel[2] < 190,
    `T-junction centre should render as a wall, got rgba(${centerPixel.join(",")})`);

  await page.locator("#undo").click();
  await page.waitForFunction(() => document.querySelector("#redo")?.disabled === false);
  await page.locator("#redo").click();
  await page.waitForFunction(() => document.querySelector("#undo")?.disabled === false);

  // Returning to the first point must not auto-close an active chain.
  await page.locator('[data-tool="wall"]').click();
  await page.locator("#wallGeometryMethod").selectOption("continuous");
  await page.mouse.click(cx - 200, cy + 180);
  await page.mouse.click(cx - 100, cy + 180);
  await page.mouse.click(cx - 100, cy + 80);
  await page.mouse.click(cx - 200, cy + 180);
  await page.waitForTimeout(50);
  assert.ok(!(await page.locator("#status").textContent()).includes("Wall loop closed"),
    "Continuous wall must not auto-close when cursor returns near its first point");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Wall drawing committed"));
  // Enter finishes an open chain without adding a closing segment.
  await page.mouse.click(cx + 150, cy + 140);
  await page.mouse.click(cx + 230, cy + 140);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Wall drawing committed"));

  // Backspace removes only the last segment of an active chain.
  await page.mouse.click(cx + 150, cy + 220);
  await page.mouse.click(cx + 230, cy + 220);
  await page.mouse.click(cx + 230, cy + 290);
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Last wall-chain segment undone"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Drawing cancelled · provisional elements removed"));
  // Archicad-style element picking: run opening regression in a clean editor state so
  // earlier wall-chain/undo interactions cannot leave a stale pointer or transient canvas state.
  const openingPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  openingPage.setDefaultTimeout(8000);
  openingPage.on("pageerror", error => pageErrors.push(error.message));
  await openingPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  await openingPage.waitForFunction(() => {
    const el = document.querySelector("#canvas");
    return el && el.clientWidth > 100 && el.clientHeight > 100;
  });
  const openingCanvas = openingPage.locator("#canvas");
  await openingPage.locator('[data-tool="wall"]').click();
  await openingPage.locator("#wallGeometryMethod").selectOption("single");
  // Drive clicks from fixed model-space coordinates, not canvas-relative coordinates:
  // changing tools can resize the canvas and shift its centre.
  const modelPoint = async (wx, wy, action = "click") => {
    const pt = await openingPage.evaluate(({ wx, wy }) => {
      const canvas = document.querySelector("#canvas");
      const rect = canvas.getBoundingClientRect();
      const scale = Number(document.querySelector("#scaleSelect")?.value || 36);
      return {
        x: rect.left + canvas.clientWidth / 2 + wx * scale,
        y: rect.top + canvas.clientHeight / 2 - wy * scale
      };
    }, { wx, wy });
    if (action === "move") await openingPage.mouse.move(pt.x, pt.y);
    else await openingPage.mouse.click(pt.x, pt.y);
  };
  const wallY = -3.5;
  await modelPoint(-4, wallY);
  await modelPoint(4, wallY);
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Wall created"));
  await openingPage.locator('[data-tool="door"]').click();
  await modelPoint(0, wallY);
  await modelPoint(0, wallY + .8, "move");
  await openingPage.keyboard.press("Enter");
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Door placed"), null, { timeout: 8000 }).catch(async error => { throw new Error(`Door placement failed; status="${await openingPage.locator("#status").textContent()}"; tool="${await openingPage.locator("#toolName").inputValue().catch(()=>"unknown")}"; properties="${(await openingPage.locator("#elementProperties").textContent()).slice(0,300)}"; ${error.message}`); });
  await openingPage.locator('[data-tool="select"]').click();
  await modelPoint(0, wallY);
  await openingPage.waitForFunction(() => document.querySelector("#elementProperties")?.textContent.includes("door ·"));
  assert.match(await openingPage.locator("#elementProperties").textContent(), /door ·/i,
    "Clicking the door symbol should select the door rather than its host wall");

  await openingPage.locator('[data-tool="window"]').click();
  await modelPoint(2, wallY);
  await modelPoint(2, wallY + .8, "move");
  await openingPage.keyboard.press("Enter");
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Window placed"));
  await openingPage.locator('[data-tool="select"]').click();
  await modelPoint(2, wallY);
  await openingPage.waitForFunction(() => document.querySelector("#elementProperties")?.textContent.includes("window ·"));
  assert.match(await openingPage.locator("#elementProperties").textContent(), /window ·/i,
    "Clicking the window symbol should select the window rather than its host wall");

  assert.deepEqual(pageErrors, [], "Editor should not throw browser runtime errors");
  console.log("Browser smoke passed: app boot, T-junction, Undo/Redo, wall-chain, independent Door/Window selection, no page errors.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
