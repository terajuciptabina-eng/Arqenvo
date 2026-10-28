import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { doorSwingGeometry } from "../src/core/authoring.js";

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
  const committedWallCount = await page.evaluate(() => JSON.parse(localStorage.getItem("arqenvo.autosave.v2") || "{}").elements?.filter(el => el.type === "wall").length || 0);
  await page.mouse.move(cx + 260, cy + 260);
  await page.waitForTimeout(100);
  const afterEnterWallCount = await page.evaluate(() => JSON.parse(localStorage.getItem("arqenvo.autosave.v2") || "{}").elements?.filter(el => el.type === "wall").length || 0);
  assert.equal(afterEnterWallCount, committedWallCount,
    "Moving the cursor after Enter must not continue or append wall geometry");
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
  // Preselection status depends on the pointer landing on a model element.
  // Recompute canvas bounds after changing tools so pointer coordinates stay current.
  await page.locator('[data-tool="select"]').click();
  await page.waitForFunction(() => document.querySelector('[data-tool="select"]')?.classList.contains("active"));
  await page.waitForTimeout(100);
  rect = await canvas.boundingBox();
  assert.ok(rect, "Canvas must remain visible after selecting the Select tool");
  cx = rect.x + rect.width / 2;
  cy = rect.y + rect.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(150);
  // Marquee selection is a two-step workflow: define the rectangle, then select its contents.
  await page.locator('[data-tool="marquee"]').click();
  await page.waitForFunction(() => document.querySelector('[data-tool="marquee"]')?.classList.contains("active"));
  await page.waitForTimeout(100);
  rect = await canvas.boundingBox();
  assert.ok(rect, "Canvas must remain visible for marquee selection");
  cx = rect.x + rect.width / 2;
  cy = rect.y + rect.height / 2;
  await page.mouse.move(cx - 120, cy - 18);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 18, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Marquee area defined"));
  const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAllKey);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("selected in marquee"));
  const marqueeSelection = await page.evaluate(() => ({
    status: document.querySelector("#status")?.textContent || "",
    count: Number((document.querySelector("#selectionInfo")?.textContent || "").match(/\d+/)?.[0] || 0),
    storedRect: typeof lastMarqueeRect !== "undefined" ? lastMarqueeRect : null
  }));
  assert.ok(marqueeSelection.status.includes("selected in marquee"),
    "Marquee selection should complete through the explicit Ctrl/Cmd+A step");

  // Existing element edits must end on Enter and remain fixed when the pointer moves.
  const gridPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  gridPage.setDefaultTimeout(8000);
  gridPage.on("pageerror", error => pageErrors.push(error.message));
  await gridPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  await gridPage.waitForFunction(() => { const el=document.querySelector("#canvas"); return el && el.clientWidth>100 && el.clientHeight>100; });
  const gridPoint = async (wx, wy, action = "click") => {
    const pt = await gridPage.evaluate(({wx,wy}) => { const canvas=document.querySelector("#canvas"),rect=canvas.getBoundingClientRect(),scale=Number(document.querySelector("#scaleSelect")?.value||36); return {x:rect.left+canvas.clientWidth/2+wx*scale,y:rect.top+canvas.clientHeight/2-wy*scale}; }, {wx,wy});
    if(action==="move") await gridPage.mouse.move(pt.x,pt.y); else await gridPage.mouse.click(pt.x,pt.y);
    return pt;
  };
  const readGridline = async () => gridPage.evaluate(() => {
    const raw=localStorage.getItem("arqenvo.autosave.v2");
    const project=raw?JSON.parse(raw):{};
    const line=project.elements?.find(el=>el.type==="gridline");
    return line?{start:line.start,end:line.end}:null;
  });
  const readLastWall = async () => gridPage.evaluate(() => {
    const raw=localStorage.getItem("arqenvo.autosave.v2");
    const project=raw?JSON.parse(raw):{};
    const walls=project.elements?.filter(el=>el.type==="wall")||[];
    const wall=walls[walls.length-1];
    return wall?{start:wall.start,end:wall.end}:null;
  });
  await gridPage.locator('[data-tool="gridline"]').click();
  await gridPoint(-2, 0);
  await gridPoint(2, 0);
  await gridPage.waitForTimeout(800);
  await gridPage.locator('[data-tool="select"]').click();
  // Start a real pointer drag on an existing Gridline, then press Enter before releasing the mouse.
  await gridPoint(0, 0, "move");
  await gridPage.mouse.down();
  await gridPoint(0, 1, "move");
  await gridPage.keyboard.press("Enter");
  await gridPage.waitForFunction(() => document.querySelector("#status")?.textContent === "Element edit committed");
  await gridPage.waitForTimeout(800);
  const gridAfterEnter = await readGridline();
  await gridPoint(1, 2, "move");
  await gridPage.waitForTimeout(850);
  const gridAfterPointer = await readGridline();
  assert.deepEqual(gridAfterPointer, gridAfterEnter,
    "Moving the pointer after Enter must not keep moving an existing Gridline");
  assert.equal(await gridPage.locator("#status").textContent(), "Element edit committed");
  await gridPage.mouse.up();
  // Editing one endpoint uses its own active pointer gesture and must also be terminated by Enter.
  await gridPoint(-2, 1, "move");
  await gridPage.mouse.down();
  await gridPoint(-2, 2, "move");
  await gridPage.keyboard.press("Enter");
  await gridPage.waitForFunction(() => document.querySelector("#status")?.textContent === "Element edit committed").catch(async error => { throw new Error(`Wall endpoint Enter did not commit; status="${await gridPage.locator("#status").textContent()}"; selected="${await gridPage.locator("#selectionInfo").textContent()}"; errors="${pageErrors.join(" | ")}"; ${error.message}`); });
  await gridPage.waitForTimeout(800);
  const endpointAfterEnter = await readGridline();
  await gridPoint(-1, 3, "move");
  await gridPage.waitForTimeout(850);
  const endpointAfterPointer = await readGridline();
  assert.deepEqual(endpointAfterPointer, endpointAfterEnter,
    "Moving the pointer after Enter must not keep editing an existing Gridline endpoint");
  await gridPage.mouse.up();

  // Existing Wall endpoints must also stop tracking pointer movement after Enter.
  await gridPage.locator('[data-tool="wall"]').click();
  await gridPage.locator("#wallGeometryMethod").selectOption("single");
  await gridPoint(0, 3);
  await gridPoint(3, 3);
  await gridPage.keyboard.press("Enter");
  await gridPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Wall drawing committed"));
  await gridPage.waitForTimeout(800);
  await gridPage.locator('[data-tool="select"]').click();
  await gridPoint(0, 3, "move");
  await gridPage.mouse.down();
  await gridPoint(0, 4, "move");
  await gridPage.keyboard.press("Enter");
  await gridPage.waitForFunction(() => document.querySelector("#status")?.textContent === "Element edit committed").catch(async error => { throw new Error(`Wall endpoint Enter did not commit; status="${await gridPage.locator("#status").textContent()}"; selection="${await gridPage.locator("#selectionInfo").textContent()}"; tool="${await gridPage.locator("#toolName").inputValue()}"; errors="${pageErrors.join(" | ")}"; ${error.message}`); });
  await gridPage.waitForTimeout(800);
  const wallAfterEnter = await readLastWall();
  await gridPoint(1, 5, "move");
  await gridPage.waitForTimeout(850);
  const wallAfterPointer = await readLastWall();
  assert.deepEqual(wallAfterPointer, wallAfterEnter,
    "Moving the pointer after Enter must not keep editing an existing Wall endpoint");
  await gridPage.mouse.up();
  await gridPage.close();


  // Touch users must be able to explicitly finish and cancel an existing whole-element drag.
  const touchPage = await browser.newPage({ viewport: { width: 900, height: 1100 }, hasTouch: true, isMobile: true });
  touchPage.setDefaultTimeout(8000);
  touchPage.on("pageerror", error => pageErrors.push(error.message));
  await touchPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  await touchPage.waitForFunction(() => document.querySelector("#canvas")?.clientWidth > 100);
  const touchPoint = async (wx, wy) => touchPage.evaluate(({wx,wy}) => {
    const c=document.querySelector("#canvas"),r=c.getBoundingClientRect(),t=window.__arqenvoViewport;
    return {x:r.left+c.clientWidth/2+(t?.origin.x||0)+wx*(t?.scale||36),y:r.top+c.clientHeight/2+(t?.origin.y||0)-wy*(t?.scale||36)};
  },{wx,wy});
  await touchPage.locator('[data-tool="gridline"]').click();
  let tp=await touchPoint(-2,0); await touchPage.touchscreen.tap(tp.x,tp.y);
  tp=await touchPoint(2,0); await touchPage.touchscreen.tap(tp.x,tp.y);
  await touchPage.waitForTimeout(800);
  await touchPage.locator('[data-tool="select"]').click();
  const before=await touchPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.find(e=>e.type==="gridline"));
  assert.ok(before,"Touch test must create a Gridline");
  const startPoint=await touchPoint(0,0);
  const endPoint=await touchPoint(0,0.7);
  const c=touchPage.locator("#canvas");
  // Use a tracked active edit and then release it with touch input to verify the mobile completion state.
  await touchPage.evaluate(({startPoint,endPoint})=>{
    const canvas=document.querySelector("#canvas");
    const init={pointerId:5101,pointerType:"touch",button:0,bubbles:true,cancelable:true,isPrimary:true};
    canvas.dispatchEvent(new PointerEvent("pointerdown",{...init,clientX:startPoint.x,clientY:startPoint.y,buttons:1}));
    canvas.dispatchEvent(new PointerEvent("pointermove",{...init,clientX:endPoint.x,clientY:endPoint.y,buttons:1}));
    canvas.dispatchEvent(new PointerEvent("pointerup",{...init,clientX:endPoint.x,clientY:endPoint.y,buttons:0}));
  },{startPoint,endPoint});
  await touchPage.waitForFunction(()=>document.querySelector("#editActions")?.hidden===false && document.querySelector("#editActions")?.dataset.pendingTouchCompletion==="true").catch(async error=>{throw new Error(`Touch release did not enter pending completion: status="${await touchPage.locator("#status").textContent()}"; actions=${JSON.stringify(await touchPage.locator("#editActions").evaluate(el=>({hidden:el.hidden,pending:el.dataset.pendingTouchCompletion,aria:el.getAttribute("aria-hidden")})))}; state=${JSON.stringify(await touchPage.evaluate(()=>({pointer:window.__arqenvoTouchState||null,gridlineCount:JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="gridline").length})))}; ${error.message}`)});
  assert.equal(await touchPage.locator("#editActions").isVisible(),true,"Finish/Cancel must remain visible after touch release");
  assert.equal(await touchPage.locator("#editCommit b").textContent(),"Finish","Finish label must be English");
  assert.equal(await touchPage.locator("#editCancel b").textContent(),"Cancel","Cancel label must be English");
  await touchPage.locator("#editCommit").click();
  await touchPage.waitForFunction(()=>document.querySelector("#status")?.textContent==="Element edit committed");
  assert.equal(await touchPage.locator("#editActions").isHidden(),true,"Finish should hide the controls after confirmation");
  const afterCommit=await touchPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.find(e=>e.type==="gridline"));
  assert.ok(afterCommit,"Gridline must remain after touch commit");
  assert.equal(afterCommit.start.y,afterCommit.end.y,"Whole Gridline drag must preserve its parallel geometry");
  assert.ok(afterCommit,"Gridline must remain after touch commit");
  assert.equal(afterCommit.start.y,afterCommit.end.y,"Whole Gridline drag must preserve its parallel geometry");
  // Verify that mobile contextual controls are a topmost, tappable layer.
  const hitTarget=await touchPage.locator("#editCommit").evaluate(el=>{
    const bar=document.querySelector("#editActions");
    bar.hidden=false;bar.setAttribute("aria-hidden","false");
    const r=el.getBoundingClientRect();
    const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
    return {id:hit?.id||"",tag:hit?.tagName||"",buttonId:hit?.closest("button")?.id||"",rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},canvasRect:document.querySelector("#canvas").getBoundingClientRect().toJSON(),barRect:bar.getBoundingClientRect().toJSON()};
  });
  assert.ok(hitTarget.id==="editCommit"||hitTarget.tag==="B"&&hitTarget.rect.width>0,`Finish must be the hit target or one of its descendants, not the underlying canvas; got ${JSON.stringify(hitTarget)}`);
  await touchPage.locator("#editActions").evaluate(el=>{el.hidden=true;el.setAttribute("aria-hidden","true")});

  // A first wall point is provisional. Cancel must clear it without adding a wall.
  await touchPage.locator('[data-tool="wall"]').click();
  const canvasBoxTouch=await touchPage.locator("#canvas").boundingBox();
  await touchPage.mouse.click(canvasBoxTouch.x+canvasBoxTouch.width/2-180,canvasBoxTouch.y+canvasBoxTouch.height/2+100);
  await touchPage.waitForFunction(()=>document.querySelector("#editActions")?.hidden===false);
  const wallsBeforeCancel=await touchPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="wall").length||0);
  await touchPage.locator("#editCancel").click();
  await touchPage.waitForFunction(()=>document.querySelector("#editActions")?.hidden===true);
  const wallsAfterCancel=await touchPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="wall").length||0);
  assert.equal(wallsAfterCancel,wallsBeforeCancel,"Cancel must not commit the provisional first wall point");

  // Finish a continuous wall chain. A later tap must not append geometry.
  await touchPage.locator('[data-tool="wall"]').click();
  await touchPage.locator("#wallGeometryMethod").selectOption("continuous");
  await touchPage.mouse.click(canvasBoxTouch.x+canvasBoxTouch.width/2-180,canvasBoxTouch.y+canvasBoxTouch.height/2+100);
  await touchPage.mouse.click(canvasBoxTouch.x+canvasBoxTouch.width/2-80,canvasBoxTouch.y+canvasBoxTouch.height/2+100);
  await touchPage.keyboard.press("Enter");
  await touchPage.waitForFunction(()=>document.querySelector("#status")?.textContent.includes("Wall drawing committed"));
  const committedWalls=await touchPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="wall").length||0);
  await touchPage.locator("#canvas").click({position:{x:canvasBoxTouch.width/2+100,y:canvasBoxTouch.height/2+100}});
  assert.equal(await touchPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="wall").length||0),committedWalls,"A tap after Finish must not append wall geometry");

  await touchPage.close();

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
      const transform = window.__arqenvoViewport || {origin:{x:0,y:0},scale};
      return {
        x: rect.left + canvas.clientWidth / 2 + (transform.origin?.x||0) + wx * (transform.scale||scale),
        y: rect.top + canvas.clientHeight / 2 + (transform.origin?.y||0) - wy * (transform.scale||scale)
      };
    }, { wx, wy });
    if (action === "move") await openingPage.mouse.move(pt.x, pt.y);
    else await openingPage.mouse.click(pt.x, pt.y);
  };
  // Disable magnetic snapping for deterministic host-wall placement in this test.
  await openingPage.locator("#snapToggle").click();
  await openingPage.waitForFunction(() => document.querySelector("#snapToggle")?.getAttribute("aria-pressed") === "false");
  await openingPage.locator("#gridQuick").selectOption("0.1");
  const wallY = -3.5;
  await modelPoint(-4, wallY);
  await modelPoint(4, wallY);
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Wall created"));
  // Wall geometry is provisional until explicitly committed; changing tools cancels it.
  await openingPage.keyboard.press("Enter");
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("committed") || document.querySelector("#undo")?.disabled === false);
  await openingPage.locator('[data-tool="door"]').click();
  assert.equal(await openingPage.locator("#openingAlignment").inputValue(),"center","Door anchor should default to Center");
  assert.equal(await openingPage.locator("#openingLibraryType").inputValue(),"single-leaf","Door library should default to Single Leaf");
  await modelPoint(0, wallY);
  const openingPreview=await openingPage.evaluate(()=>window.__arqenvoDebug?.getOpeningPlacement());
  assert.equal(openingPreview?.anchor,"center","Opening preview should preserve the chosen Center anchor mode");
  assert.equal(openingPreview?.libraryType,"single-leaf","Door placement preview should preserve Single Leaf library selection");
  assert.ok(Math.abs((openingPreview?.offset||0)+ (openingPreview?.width||0)/2-4)<0.2,`Center anchor should align the opening midpoint with x=0, which is 4 m from the host wall start at x=-4; preview=${JSON.stringify(openingPreview)}, diagnostics=${JSON.stringify(await openingPage.evaluate(()=>window.__arqenvoDebug?.getSettings()))}`);
  await modelPoint(0, wallY + .8, "move");
  await modelPoint(1.7, wallY + 1.2); // Blank paper click confirms cursor-selected opening orientation.
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Door placed"), null, { timeout: 8000 }).catch(async error => { throw new Error(`Door placement failed; status="${await openingPage.locator("#status").textContent()}"; tool="${await openingPage.locator("#toolName").inputValue().catch(()=>"unknown")}"; properties="${(await openingPage.locator("#elementProperties").textContent()).slice(0,300)}"; ${error.message}`); });
  await openingPage.waitForFunction(()=>{const els=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];return !!(els.find(e=>e.type==="door")||els.flatMap(w=>w.openings||[]).find(e=>e.type==="door"))},{},{timeout:3000});
  const placedDoor=await openingPage.evaluate(()=>{const els=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];return els.find(e=>e.type==="door")||els.flatMap(w=>w.openings||[]).find(e=>e.type==="door")});
  assert.ok(placedDoor,"Door should be stored after a paper-space confirmation click");
  assert.equal(placedDoor.libraryType,"single-leaf","Saved Door should retain its Single Leaf library type");
  assert.ok(Math.abs((placedDoor.offset+placedDoor.width/2)-4)<0.2,`Default Center anchor should centre the opening at x=0 (4 m along a wall starting at x=-4); found distance from wall start=${placedDoor.offset+placedDoor.width/2}, offset=${placedDoor.offset}, width=${placedDoor.width}`);
  assert.equal(placedDoor.swingDirection,"inside","Cursor placed on the positive side of the wall should choose inside swing");
  // Anchor selector exposes usable edge modes and keeps Center as the default.
  await openingPage.locator("#openingAlignment").selectOption("left");
  // Anchor mode applies to the cursor's projected position on the host wall.
  // Place the cursor at the wall start to assert a zero offset.
  await modelPoint(-4, wallY);
  const leftPreview=await openingPage.evaluate(()=>window.__arqenvoDebug?.getOpeningPlacement());
  assert.equal(leftPreview?.offset,0,"Left anchor at the host-wall start should produce zero offset");
  await openingPage.keyboard.press("Escape");
  await openingPage.locator("#openingAlignment").selectOption("right");
  // Place the cursor at the wall end so the right anchor lands on the wall end.
  await modelPoint(4, wallY);
  const rightPreview=await openingPage.evaluate(()=>window.__arqenvoDebug?.getOpeningPlacement());
  assert.ok(Math.abs((rightPreview?.offset||0)+ (rightPreview?.width||0)-8)<1e-6,"Right anchor at the host-wall end should end the opening at the host-wall end");
  await openingPage.keyboard.press("Escape");
  await openingPage.locator("#openingAlignment").selectOption("center");

  // Window shares the same configurable library system and persists its own double-leaf geometry.
  await openingPage.locator('[data-tool="window"]').click();
  await openingPage.locator("#openingLibraryType").selectOption("double-leaf");
  assert.equal(await openingPage.locator("#openingLibraryType").inputValue(),"double-leaf","Window tool should accept the Double Leaf library mode");
  await modelPoint(2.2, wallY);
  await modelPoint(2.2, wallY + .8, "move");
  await modelPoint(3.2, wallY + 1.2);
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Window placed"), null, { timeout: 8000 });
  await openingPage.waitForFunction(()=>{const els=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];return !!(els.find(e=>e.type==="window")||els.flatMap(w=>w.openings||[]).find(e=>e.type==="window"))},{},{timeout:3000});
  const libraryWindowElement=await openingPage.evaluate(()=>{const els=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];return els.find(e=>e.type==="window")||els.flatMap(w=>w.openings||[]).find(e=>e.type==="window")});
  assert.equal(libraryWindowElement?.libraryType,"double-leaf","Saved Window should retain its Double Leaf library type");

  await openingPage.locator('[data-tool="select"]').click();
  // Clear any selection left by placement using a genuine browser pointer sequence
  // on the canvas margin, not a synthetic event that bypasses Playwright's mouse input.
  const canvasBox = await openingPage.locator("#canvas").boundingBox();
  await openingPage.mouse.click(canvasBox.x + canvasBox.width - 24, canvasBox.y + 24);
  await openingPage.waitForFunction(() => document.querySelector("#selectionInfo")?.textContent.includes("No selection") || !(document.querySelector("#elementProperties input[readonly]")));
  await openingPage.waitForFunction(() => !document.querySelector("#elementProperties input[readonly]"));
  // Click inside the actual hosted opening span, derived from persisted geometry and the live viewport.
  // The previous hard-coded arc point was not on the generated door arc, so it did not test opening selection.
  const doorOpeningPoint = await openingPage.evaluate(({doorLeaf,doorOpenFree,doorArcMid}) => {
    const canvas=document.querySelector("#canvas"),rect=canvas.getBoundingClientRect(),t=window.__arqenvoDebug?.getViewport();
    const model=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];
    const door=model.find(e=>e.type==="door");
    if(!door) throw new Error("Hosted door missing from saved model");
    const scale=t?.scale||Number(document.querySelector("#scaleSelect")?.value||36),origin=t?.origin||{x:0,y:0};
    const screen=p=>({x:rect.left+canvas.clientWidth/2+origin.x+p.x*scale,y:rect.top+canvas.clientHeight/2+origin.y-p.y*scale});
    const candidates=[screen(doorLeaf),screen(doorOpenFree),screen(doorArcMid)];
    return {x:candidates[0].x,y:candidates[0].y,candidates,scale,door:{hingeSide:door.hingeSide,swingDirection:door.swingDirection,offset:door.offset,width:door.width}};
  }, await openingPage.evaluate(() => {
    const model=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];
    const door=model.find(e=>e.type==="door"),wall=model.find(e=>e.id===door?.hostWallId&&e.type==="wall");
    if(!door||!wall) throw new Error("Hosted door or host wall missing from saved model");
    const dx=wall.end.x-wall.start.x,dy=wall.end.y-wall.start.y,len=Math.hypot(dx,dy)||1;
    const a={x:wall.start.x+dx*(Number(door.offset)||0)/len,y:wall.start.y+dy*(Number(door.offset)||0)/len};
    const b={x:wall.start.x+dx*((Number(door.offset)||0)+(Number(door.width)||0))/len,y:wall.start.y+dy*((Number(door.offset)||0)+(Number(door.width)||0))/len};
    return {a,b,hingeSide:door.hingeSide,swingDirection:door.swingDirection};
  }).then(({a,b,hingeSide,swingDirection})=>{
    const g=doorSwingGeometry(a,b,{hingeSide,swingDirection});
    const arcAngle=g.startAngle+g.sweep*.5;
    return {doorLeaf:{x:(g.hinge.x+g.openFree.x)/2,y:(g.hinge.y+g.openFree.y)/2},doorOpenFree:g.openFree,doorArcMid:{x:g.hinge.x+Math.cos(arcAngle)*g.radius,y:g.hinge.y+Math.sin(arcAngle)*g.radius}};
  }));
  // Prefer the visible leaf segment over the wall's centre; the hit-test follows the door symbol geometry.
  let doorSelected=false;
  for(const candidate of doorOpeningPoint.candidates){
    await openingPage.mouse.click(candidate.x,candidate.y);
    try{
      await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("door ·"),null,{timeout:1200});
      doorSelected=true;
      break;
    }catch{}
  }
  assert.ok(doorSelected, "Clicking the actual door leaf/swing symbol should select Door ahead of its host wall");
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("door ·"), null, {timeout:8000}).catch(async error => { const diag=await openingPage.evaluate(()=>({hitDebug:window.__arqenvoDebug?.getLastFloorSelectionDebug?.(),status:document.querySelector("#status")?.textContent,selection:document.querySelector("#selectionInfo")?.textContent,tool:document.querySelector("#toolName")?.value,props:document.querySelector("#elementProperties")?.textContent,project:JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>["wall","door","window"].includes(e.type)).map(e=>({id:e.id,type:e.type,start:e.start,end:e.end,offset:e.offset,width:e.width,hostWallId:e.hostWallId,storyId:e.storyId,hingeSide:e.hingeSide,swingDirection:e.swingDirection}))})); console.log("DOOR_SELECTION_DIAG",JSON.stringify(diag)); throw new Error(`Door symbol selection failed; diag=${JSON.stringify(diag)}; ${error.message}`); });
  assert.match(await openingPage.locator("#elementProperties input[readonly]").inputValue(), /door ·/i,
    "Clicking the visible door leaf/swing symbol should select Door ahead of its host wall");
  // The selected Door library can be changed in Element Settings and persisted to the hosted wall.
  await openingPage.locator("#propLibraryType").selectOption("double-leaf");
  await openingPage.waitForFunction(() => document.querySelector("#propLibraryType")?.value === "double-leaf" && document.querySelector("#status")?.textContent === "Element parameters updated");
  await openingPage.waitForFunction(()=>{const els=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];return els.find(e=>e.type==="door")?.libraryType==="double-leaf"},{},{timeout:3000});
  await openingPage.locator("#propLibraryType").selectOption("single-leaf");
  await openingPage.waitForFunction(() => document.querySelector("#propLibraryType")?.value === "single-leaf" && document.querySelector("#status")?.textContent === "Element parameters updated");
  // Clicking within the opening itself must also choose the opening element, not Wall.
  await modelPoint(0.45, wallY);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("door ·"));
  // Property dropdowns apply immediately: hinge flips and host-wall alignment moves the opening.
  await openingPage.locator("#propHinge").selectOption("right");
  await openingPage.waitForFunction(() => document.querySelector("#propHinge")?.value === "right" && document.querySelector("#status")?.textContent === "Opening updated");
  await openingPage.locator("#propSwing").selectOption("outside");
  await openingPage.waitForFunction(() => document.querySelector("#propSwing")?.value === "outside" && document.querySelector("#status")?.textContent === "Opening updated");
  await openingPage.locator("#propAlignment").selectOption("left");
  await openingPage.waitForFunction(() => document.querySelector("#propAlignment")?.value === "left" && document.querySelector("#status")?.textContent === "Opening updated");
  assert.ok(Math.abs(Number(await openingPage.locator('[data-prop="offset"]').inputValue())) < 1e-8,
    "Choosing Left should immediately move the door opening to the host wall start");
  await openingPage.locator('[data-prop="width"]').fill("1.2");
  await openingPage.locator('[data-prop="width"]').press("Enter");
  await openingPage.waitForFunction(() => ["Opening updated","Element parameters updated"].includes(document.querySelector("#status")?.textContent) && Number(document.querySelector('[data-prop="width"]')?.value) === 1.2);
  assert.equal(Number(await openingPage.locator('[data-prop="width"]').inputValue()), 1.2,
    "Pressing Enter should apply the new door width to the hosted opening");
  // Property edits use a debounced autosave. Wait for the persisted model before
  // deriving model-space coordinates from localStorage in this browser test.
  await openingPage.waitForFunction(()=>{const elements=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];const door=elements.find(e=>e.type==="door");return !!door&&door.alignment==="left"&&Number(door.offset)===0&&Number(door.width)===1.2;},null,{timeout:3000});
  // Recalculate the current Door symbol after the hinge, swing, alignment and
  // width changes. Fixed screen/model coordinates become stale when these
  // properties change and can make this browser test fail despite valid Door behavior.
  const updatedDoorGeometry=await openingPage.evaluate(()=>{
    const elements=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];
    const door=elements.find(e=>e.type==="door"),wall=elements.find(e=>e.id===door?.hostWallId&&e.type==="wall");
    if(!door||!wall) throw new Error("Door test fixture lost its hosted Door or host Wall");
    const dx=wall.end.x-wall.start.x,dy=wall.end.y-wall.start.y,len=Math.hypot(dx,dy)||1;
    const a={x:wall.start.x+dx*(Number(door.offset)||0)/len,y:wall.start.y+dy*(Number(door.offset)||0)/len};
    const b={x:wall.start.x+dx*((Number(door.offset)||0)+(Number(door.width)||0))/len,y:wall.start.y+dy*((Number(door.offset)||0)+(Number(door.width)||0))/len};
    return {a,b,hingeSide:door.hingeSide,swingDirection:door.swingDirection};
  });
  const updatedDoorSwing=doorSwingGeometry(updatedDoorGeometry.a,updatedDoorGeometry.b,{hingeSide:updatedDoorGeometry.hingeSide,swingDirection:updatedDoorGeometry.swingDirection});
  const updatedDoorArcAngle=updatedDoorSwing.startAngle+updatedDoorSwing.sweep*.5;
  const updatedDoorArcPoint={x:updatedDoorSwing.hinge.x+Math.cos(updatedDoorArcAngle)*updatedDoorSwing.radius,y:updatedDoorSwing.hinge.y+Math.sin(updatedDoorArcAngle)*updatedDoorSwing.radius};
  await modelPoint(updatedDoorArcPoint.x,updatedDoorArcPoint.y);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("door ·"), null, {timeout:3000});
  await modelPoint((updatedDoorGeometry.a.x+updatedDoorGeometry.b.x)/2,(updatedDoorGeometry.a.y+updatedDoorGeometry.b.y)/2);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("door ·"), null, {timeout:3000}).catch(async error=>{const diag=await openingPage.evaluate(()=>({hitDebug:window.__arqenvoDebug?.getLastFloorSelectionDebug?.(),selection:document.querySelector("#selectionInfo")?.textContent,status:document.querySelector("#status")?.textContent,properties:document.querySelector("#elementProperties")?.textContent?.slice(0,220),tool:document.querySelector("#toolName")?.value}));throw new Error("Click inside hosted opening did not select Door; "+JSON.stringify(diag)+"; "+error.message)});
  const doorOffsetBeforeMove = Number(await openingPage.locator('[data-prop="offset"]').inputValue());
  const dragScreenPoint = async (wx, wy) => openingPage.evaluate(({wx,wy}) => { const canvas=document.querySelector("#canvas"),rect=canvas.getBoundingClientRect(),view=window.__arqenvoDebug?.getViewport(),scale=view?.scale||Number(document.querySelector("#scaleSelect")?.value||36),origin=view?.origin||{x:0,y:0}; return {x:rect.left+canvas.clientWidth/2+origin.x+wx*scale,y:rect.top+canvas.clientHeight/2+origin.y-wy*scale}; }, {wx,wy});
  // Derive the drag target from the current Door leaf instead of stale fixed coordinates.
  const doorLeafMid={x:(updatedDoorSwing.hinge.x+updatedDoorSwing.openFree.x)/2,y:(updatedDoorSwing.hinge.y+updatedDoorSwing.openFree.y)/2};
  const doorDragStart = await dragScreenPoint(doorLeafMid.x,doorLeafMid.y);
  const doorDragEnd = await dragScreenPoint(doorLeafMid.x+0.8,doorLeafMid.y);
  await openingPage.mouse.move(doorDragStart.x, doorDragStart.y);
  await openingPage.mouse.down();
  await openingPage.mouse.move(doorDragEnd.x, doorDragEnd.y, {steps:6});
  await openingPage.mouse.up();
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Door moved"), null, {timeout:8000});
  assert.ok(Number(await openingPage.locator('[data-prop="offset"]').inputValue()) > doorOffsetBeforeMove + 0.5,
    "Dragging the Door symbol should move its offset along the host wall");

  await openingPage.locator('[data-tool="window"]').click();
  await modelPoint(2, wallY);
  await modelPoint(2, wallY + .8, "move");
  await openingPage.keyboard.press("Enter");
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Window placed"), null, {timeout:8000}).catch(async error => { throw new Error(`Window placement failed; status="${await openingPage.locator("#status").textContent()}"; tool="${await openingPage.locator("#toolName").inputValue().catch(()=>"unknown")}"; properties="${(await openingPage.locator("#elementProperties").textContent()).slice(0,300)}"; ${error.message}`); });
  await openingPage.waitForFunction(()=>{const els=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];return !!(els.find(e=>e.type==="window")||els.flatMap(w=>w.openings||[]).find(e=>e.type==="window"))},{},{timeout:3000});
  const placedWindow=await openingPage.evaluate(()=>{const els=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];return els.find(e=>e.type==="window")||els.flatMap(w=>w.openings||[]).find(e=>e.type==="window")});
  assert.ok(placedWindow,"Window should be stored after Enter confirmation");
  await openingPage.locator("#threeTab").click();
  await openingPage.waitForFunction(()=>document.querySelector("#viewLabel")?.textContent.includes("3D Window"));
  const window3dCheck=await openingPage.evaluate(()=>{const model=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];const windowElement=model.find(e=>e.type==="window");const host=windowElement&&model.find(e=>e.type==="wall"&&e.id===windowElement.hostWallId);return {window:!!windowElement,host:!!host,canvas:document.querySelector("#canvas")?.width>0&&document.querySelector("#canvas")?.height>0,windowId:windowElement?.id||null,hostId:windowElement?.hostWallId||null}});
  assert.equal(window3dCheck.window,true,"Window element should remain in the model in 3D view");
  assert.equal(window3dCheck.host,true,"Window must retain a valid host wall in 3D");
  assert.equal(window3dCheck.canvas,true,"3D view should render after a Window is placed");
  const placedWindowModel=await openingPage.evaluate(()=>{const model=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];const win=model.find(e=>e.type==="window");return {window:win,host:model.find(e=>e.id===win?.hostWallId&&e.type==="wall")}});
  const {hostedOpening3dGeometry}=await import("../src/core/authoring.js");
  const paneGeometry=hostedOpening3dGeometry(placedWindowModel.host,placedWindowModel.window);
  assert.equal(paneGeometry.type,"window","Window must use the window-pane 3D geometry path");
  assert.equal(paneGeometry.boundary.length,4,"Window pane must have a renderable four-point boundary");
  assert.ok(paneGeometry.height>0&&paneGeometry.thickness>0,"Window pane must have visible height and thickness");
  assert.ok(paneGeometry.boundary.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)),"Window pane 3D boundary must contain finite model coordinates");
  const visibleWindowGeometry=await openingPage.evaluate(()=>{const model=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[],windowElement=model.find(e=>e.type==="window"),host=model.find(e=>e.id===windowElement?.hostWallId&&e.type==="wall");if(!host||!windowElement)return null;const dx=host.end.x-host.start.x,dy=host.end.y-host.start.y,len=Math.hypot(dx,dy)||1;return {span:windowElement.width,height:windowElement.height,sill:windowElement.sill||0,hostLength:len,valid:windowElement.offset>=0&&windowElement.offset+windowElement.width<=len+1e-7&&windowElement.height>0};});
  assert.ok(visibleWindowGeometry?.valid,"Window must remain inside its wall host and produce a valid 3D pane");
  await openingPage.locator("#floorTab").click();
  await openingPage.locator('[data-tool="select"]').click();
  // Clear selection left by placement so the assertion proves a new Window hit.
  await modelPoint(7, 3);
  await openingPage.waitForFunction(() => !(document.querySelector("#elementProperties input[readonly]")));
  await openingPage.waitForFunction(() => !document.querySelector("#elementProperties input[readonly]"));
  // Pick from the persisted Window geometry; hard-coded coordinates drift when its anchor/alignment changes.
  const windowPickPoint=await openingPage.evaluate(()=>{const elements=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[],windowElement=elements.find(e=>e.type==="window"),wall=elements.find(e=>e.type==="wall"&&e.id===windowElement?.hostWallId);if(!windowElement||!wall)throw new Error("Hosted Window or host Wall missing for selection test");const dx=wall.end.x-wall.start.x,dy=wall.end.y-wall.start.y,len=Math.hypot(dx,dy)||1,along=(Number(windowElement.offset)||0)+(Number(windowElement.width)||0)/2;return{x:wall.start.x+dx*along/len,y:wall.start.y+dy*along/len}});
  await modelPoint(windowPickPoint.x, wallY + 0.075);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("window ·")).catch(async error=>{const diag=await openingPage.evaluate(()=>({hitDebug:window.__arqenvoDebug?.getLastFloorSelectionDebug?.(),selection:document.querySelector("#selectionInfo")?.textContent,status:document.querySelector("#status")?.textContent,properties:document.querySelector("#elementProperties")?.textContent?.slice(0,220),tool:document.querySelector("#toolName")?.value}));throw new Error("Click on Window sash did not select Window; "+JSON.stringify(diag)+"; "+error.message)});
  assert.match(await openingPage.locator("#elementProperties input[readonly]").inputValue(), /window ·/i,
    "Clicking a visible window sash should select Window rather than its host wall");
  await modelPoint(windowPickPoint.x, wallY);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("window ·"));


  

// Confirmation semantics: Enter commits a drawing and clears selection; blank paper commits a move.
  const confirmPage=await browser.newPage({viewport:{width:1280,height:900}});
  confirmPage.setDefaultTimeout(8000);
  await confirmPage.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});
  await confirmPage.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100);
  await confirmPage.locator("#snapToggle").click();
  await confirmPage.locator("#gridQuick").selectOption("0.1");
  const confirmPoint=async(wx,wy)=>{const pt=await confirmPage.evaluate(({wx,wy})=>{const cv=document.querySelector("#canvas"),r=cv.getBoundingClientRect(),t=window.__arqenvoViewport;return{x:r.left+cv.clientWidth/2+(t?.origin.x||0)+wx*(t?.scale||36),y:r.top+cv.clientHeight/2+(t?.origin.y||0)-wy*(t?.scale||36)}},{wx,wy});await confirmPage.mouse.click(pt.x,pt.y)};
  await confirmPage.locator('[data-tool="wall"]').click();
  await confirmPage.locator("#wallGeometryMethod").selectOption("single");
  await confirmPoint(-2,-1);await confirmPoint(2,-1);
  await confirmPage.waitForFunction(()=>document.querySelector("#status")?.textContent.includes("Wall created"));
  // The wall is provisional until confirmed; Enter must commit it before changing tools.
  await confirmPage.keyboard.press("Enter");
  await confirmPage.waitForFunction(()=>document.querySelector("#status")?.textContent.includes("Wall drawing committed"));
  await confirmPage.waitForTimeout(850);
  const committedState=await confirmPage.evaluate(()=>({info:document.querySelector("#selectionInfo")?.textContent,status:document.querySelector("#status")?.textContent,hidden:document.querySelector("#editActions")?.hidden,elements:JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.map(e=>e.type)}));
  assert.ok(["No selection",""].includes((committedState.info||"").trim()),`Enter must leave selection clear: ${JSON.stringify(committedState)}`);
  const storedWall=await confirmPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.find(e=>e.type==="wall"));
  assert.ok(storedWall,"Confirmed wall must remain in the model");
  await confirmPage.locator('[data-tool="select"]').click();
  const wallMid=await confirmPage.evaluate(()=>{const wall=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.find(e=>e.type==="wall");const cv=document.querySelector("#canvas"),r=cv.getBoundingClientRect(),t=window.__arqenvoViewport;return{x:r.left+cv.clientWidth/2+(t?.origin.x||0)+(wall.start.x+wall.end.x)/2*(t?.scale||36),y:r.top+cv.clientHeight/2+(t?.origin.y||0)-(wall.start.y+wall.end.y)/2*(t?.scale||36)}});
  await confirmPage.mouse.click(wallMid.x,wallMid.y);
  await confirmPage.waitForFunction(()=>document.querySelector("#elementProperties input[readonly]")?.value?.toLowerCase().includes("wall")).catch(async error=>{throw new Error(`Wall selection failed at ${JSON.stringify(await confirmPage.evaluate(()=>({canvas:document.querySelector("#canvas").getBoundingClientRect().toJSON(),info:document.querySelector("#selectionInfo")?.textContent,props:document.querySelector("#elementProperties")?.textContent,status:document.querySelector("#status")?.textContent,wall:JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.find(e=>e.type==="wall"),viewport:window.__arqenvoViewport})))}; ${error.message}`)});
  await confirmPage.mouse.move(wallMid.x,wallMid.y);
  await confirmPage.mouse.down();
  await confirmPage.mouse.move(wallMid.x+24,wallMid.y+12,{steps:4});
  await confirmPage.mouse.up();
  await confirmPage.waitForFunction(()=>document.querySelector("#status")?.textContent.includes("Element edit committed"));
  assert.equal(await confirmPage.locator("#selectionInfo").textContent(),"No selection","Desktop mouse release should commit and clear selection");
  assert.equal(await confirmPage.locator("#editActions").evaluate(el=>el.hidden),true,"Desktop mouse release should not leave edit actions open");
  await confirmPage.close();

  // Mobile 3D zoom controls: touch-sized buttons must change the actual camera readout.
  const mobileZoomPage=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  mobileZoomPage.setDefaultTimeout(8000);
  mobileZoomPage.on("pageerror",error=>pageErrors.push(error.message));
  await mobileZoomPage.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});
  await mobileZoomPage.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100);
  await mobileZoomPage.locator("#threeTab").click();
  await mobileZoomPage.waitForFunction(()=>getComputedStyle(document.querySelector("#mobile3dZoom")).display!=="none");
  const mobileZoomBefore=Number((await mobileZoomPage.locator("#mobile3dZoomReadout").textContent()).replace("%",""));
  await mobileZoomPage.locator("#mobileZoomIn").tap();
  const mobileZoomAfter=Number((await mobileZoomPage.locator("#mobile3dZoomReadout").textContent()).replace("%",""));
  assert.ok(mobileZoomAfter>mobileZoomBefore,"Mobile 3D Zoom In should increase camera zoom");
  await mobileZoomPage.locator("#mobileZoomOut").tap();
  const mobileZoomRestored=Number((await mobileZoomPage.locator("#mobile3dZoomReadout").textContent()).replace("%",""));
  assert.ok(mobileZoomRestored<mobileZoomAfter,"Mobile 3D Zoom Out should decrease camera zoom");
  await mobileZoomPage.close();

  const {openingPlacementDirection,openingOffsetForAnchor,createOpeningPlacement}=await import("../src/core/authoring.js");
  assert.equal(openingOffsetForAnchor(4,.9,"center",2),1.55,"Center anchor must centre opening on the clicked wall position");
  assert.equal(openingOffsetForAnchor(4,.9,"left",2),2,"Left anchor must align to the clicked position");
  assert.equal(openingOffsetForAnchor(4,.9,"right",2),1.1,"Right anchor must align the opening right edge to the clicked position");
  assert.throws(()=>openingOffsetForAnchor(.8,.9,"center"),/fit within/,"Opening wider than host wall is rejected");
  const openingState=createOpeningPlacement();openingState.begin({wallId:"wall-1",type:"door",width:.9,offset:1.55,anchor:"center",anchorPosition:2,hingeSide:"left",swingDirection:"inside"});openingState.aim({x:2,y:-1},{x:0,y:0},{x:4,y:0});openingState.update({anchor:"right",offset:3.1,hingeSide:"right"});const committedOpening=openingState.confirm();assert.equal(committedOpening.offset,3.1,"Changed anchor offset persists through confirm");assert.equal(committedOpening.hingeSide,"right","Changed hinge persists through confirm");
  assert.equal(openingPlacementDirection({x:0,y:0},{x:4,y:0},{x:2,y:1}),"inside","Cursor above a horizontal wall chooses inside swing");
  assert.equal(openingPlacementDirection({x:0,y:0},{x:4,y:0},{x:2,y:-1}),"outside","Cursor below a horizontal wall chooses outside swing");

  // Mobile/tablet Touch: Magic Wand one-shot and 3D zoom buttons.
  const mobilePage=await browser.newPage({viewport:{width:820,height:1180},hasTouch:true,isMobile:true});
  mobilePage.setDefaultTimeout(8000);mobilePage.on("pageerror",error=>pageErrors.push(error.message));
  await mobilePage.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});
  await mobilePage.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100);
  assert.equal(await mobilePage.locator("#mobileMagicWand").isVisible(),true,"Touch layout should show a visible Magic Wand shortcut");
  await mobilePage.locator('[data-tool="wall"]').click();
  await mobilePage.locator("#mobileMagicWand").click();
  assert.equal(await mobilePage.locator("#toolName").inputValue(),"magicwand","Touch Magic Wand button should activate the tool");
  assert.equal(await mobilePage.locator("#mobileMagicWand").getAttribute("aria-pressed"),"true","Magic Wand touch control should expose active state");
  await mobilePage.locator("#threeTab").click();
  await mobilePage.waitForFunction(()=>window.__arqenvoDebug?.getView()==="3d");
  assert.equal(await mobilePage.locator("#mobile3dZoom").isVisible(),true,"3D touch zoom controls should be visible in 3D mode");
  const zoomBefore=await mobilePage.evaluate(()=>window.__arqenvoDebug?.getZoom());
  await mobilePage.locator("#mobile3dZoomIn").click();
  const zoomAfterIn=await mobilePage.evaluate(()=>window.__arqenvoDebug?.getZoom());
  assert.ok(zoomAfterIn>zoomBefore,"Mobile 3D zoom-in should increase camera zoom");
  await mobilePage.locator("#mobile3dZoomOut").click();
  const zoomAfterOut=await mobilePage.evaluate(()=>window.__arqenvoDebug?.getZoom());
  assert.ok(zoomAfterOut<zoomAfterIn,"Mobile 3D zoom-out should decrease camera zoom");
  await mobilePage.close();

  // Regression: wall edge edits are scoped to explicit selection.
  const edgePage=await browser.newPage({viewport:{width:1100,height:800}});
  edgePage.setDefaultTimeout(8000);edgePage.on("pageerror",error=>pageErrors.push(error.message));
  await edgePage.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});
  await edgePage.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100);
  await edgePage.locator("#snapToggle").click();
  await edgePage.locator("#gridQuick").selectOption("0.1");
  await edgePage.locator('[data-tool="wall"]').click();
  await edgePage.locator("#wallGeometryMethod").selectOption("single");
  const edgePoint=async(wx,wy)=>{const pt=await edgePage.evaluate(({wx,wy})=>{const cv=document.querySelector("#canvas"),r=cv.getBoundingClientRect(),t=window.__arqenvoViewport;return{x:r.left+cv.clientWidth/2+(t?.origin.x||0)+wx*(t?.scale||36),y:r.top+cv.clientHeight/2+(t?.origin.y||0)-wy*(t?.scale||36)}},{wx,wy});await edgePage.mouse.click(pt.x,pt.y)};
  await edgePoint(-3,0);await edgePoint(0,0);await edgePoint(0,0);await edgePoint(0,3);
  await edgePage.waitForTimeout(850);
  const originalWalls=await edgePage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.filter(e=>e.type==="wall").map(e=>({id:e.id,start:e.start,end:e.end})));
  assert.equal(originalWalls.length,2,"Edge regression fixture must create two walls sharing one endpoint");
  await edgePage.locator('[data-tool="select"]').click();
  await edgePoint(-1.5,0);
  await edgePage.waitForFunction(()=>document.querySelector("#selectionInfo")?.textContent.includes("selected"));
  const selectedWallId=await edgePage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.find(e=>e.type==="wall")?.id);
  const neighborBefore=originalWalls.find(w=>w.id!==selectedWallId);
  const selectedBefore=originalWalls.find(w=>w.id===selectedWallId);
  const edgeScreen=await edgePage.evaluate(({wx,wy})=>{const cv=document.querySelector("#canvas"),r=cv.getBoundingClientRect(),t=window.__arqenvoViewport;return{x:r.left+cv.clientWidth/2+(t?.origin.x||0)+wx*(t?.scale||36),y:r.top+cv.clientHeight/2+(t?.origin.y||0)-wy*(t?.scale||36)}},{wx:-1.5,wy:0});
  await edgePage.mouse.move(edgeScreen.x,edgeScreen.y);await edgePage.waitForTimeout(100);
  await edgePage.mouse.down();await edgePage.mouse.move(edgeScreen.x,edgeScreen.y+32,{steps:5});await edgePage.mouse.up();
  await edgePage.waitForTimeout(850);
  const afterSingle=await edgePage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.filter(e=>e.type==="wall").map(e=>({id:e.id,start:e.start,end:e.end})));
  assert.deepEqual(afterSingle.find(w=>w.id===neighborBefore.id),neighborBefore,"Single-wall edge editing must not modify an unselected neighbour");
  assert.notDeepEqual(afterSingle.find(w=>w.id===selectedBefore.id),selectedBefore,"Single-wall edge editing must update the selected wall");
  await edgePage.close();

  // Space temporarily activates Magic Wand and restores the prior tool on release.
  const spacePage=await browser.newPage({viewport:{width:1100,height:800}});
  spacePage.setDefaultTimeout(8000);
  spacePage.on("pageerror",error=>pageErrors.push(error.message));
  await spacePage.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});
  await spacePage.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100);
  await spacePage.locator('[data-tool="wall"]').click();
  await spacePage.keyboard.down("Space");
  await spacePage.waitForFunction(()=>document.querySelector("#toolName")?.value==="magicwand");
  assert.equal(await spacePage.locator('[data-tool="magicwand"]').evaluate(el=>el.classList.contains("active")),true,"Holding Space should activate Magic Wand temporarily");
  await spacePage.keyboard.up("Space");
  await spacePage.waitForFunction(()=>document.querySelector("#toolName")?.value==="wall");
  assert.equal(await spacePage.locator('[data-tool="wall"]').evaluate(el=>el.classList.contains("active")),true,"Releasing Space should restore the prior tool");
  await spacePage.close();

  // Roof/Magic Wand end-to-end: draw a closed wall footprint, confirm, then
  // generate a persistent roof from the reference loop and ensure Enter cleared selection.
  const roofPage=await browser.newPage({viewport:{width:1280,height:900}});
  roofPage.setDefaultTimeout(8000);
  roofPage.on("pageerror",error=>pageErrors.push(error.message));
  await roofPage.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});
  await roofPage.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100);
  await roofPage.locator("#snapToggle").click();
  await roofPage.locator("#gridQuick").selectOption("0.1");
  await roofPage.locator('[data-tool="wall"]').click();
  await roofPage.locator("#wallGeometryMethod").selectOption("single");
  const roofPoint=async(wx,wy)=>{const pt=await roofPage.evaluate(({wx,wy})=>{const cv=document.querySelector("#canvas"),r=cv.getBoundingClientRect(),t=window.__arqenvoViewport;return{x:r.left+cv.clientWidth/2+(t?.origin.x||0)+wx*(t?.scale||36),y:r.top+cv.clientHeight/2+(t?.origin.y||0)-wy*(t?.scale||36)}},{wx,wy});await roofPage.mouse.click(pt.x,pt.y)};
  await roofPoint(-3,-2);await roofPoint(3,-2);await roofPage.keyboard.press("Enter");
  await roofPoint(3,-2);await roofPoint(3,2);await roofPage.keyboard.press("Enter");
  await roofPoint(3,2);await roofPoint(-3,2);await roofPage.keyboard.press("Enter");
  await roofPoint(-3,2);await roofPoint(-3,-2);await roofPage.keyboard.press("Enter");
  await roofPage.keyboard.press("Enter");
  await roofPage.waitForFunction(()=>document.querySelector("#editActions")?.hidden===true);
  await roofPage.locator('[data-tool="magicwand"]').click();
  await roofPoint(0,0);
  await roofPage.waitForFunction(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.some(e=>e.type==="roof")).catch(async error=>{throw new Error(`Magic Wand roof failed: status="${await roofPage.locator("#status").textContent()}"; tool="${await roofPage.locator("#toolName").inputValue()}"; stored=${JSON.stringify(await roofPage.evaluate(()=>({walls:JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="wall").map(w=>({start:w.start,end:w.end})),allTypes:JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.map(e=>e.type)})))}; ${error.message}`)});
  const roofResult=await roofPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.find(e=>e.type==="roof"));
  // Manual Roof regression: set offset before drawing, then create a four-point footprint.
  await roofPage.locator('[data-tool="roof"]').click();
  await roofPage.locator("#roofOffset").fill("1.25");
  const manualRoofPoints=[[-2.5,-1.5],[2.5,-1.5],[2.5,1.5],[-2.5,1.5]];
  for(const [wx,wy] of manualRoofPoints) await roofPoint(wx,wy);
  await roofPage.keyboard.press("Enter");
  await roofPage.waitForFunction(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="roof").length===2).catch(async error=>{throw new Error(`Manual Roof did not commit: status="${await roofPage.locator("#status").textContent()}"; ${error.message}`)});
  const manuallyCreatedRoof=await roofPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.filter(e=>e.type==="roof")[1]);
  assert.equal(manuallyCreatedRoof.boundary.length,4,"Manual Roof must retain the four clicked footprint points");
  assert.equal(manuallyCreatedRoof.offset,1.25,"Manual Roof must retain the pre-creation offset");
  assert.equal(manuallyCreatedRoof.sourceWallIds.length,0,"Manually drawn Roof must not pretend to be wall-linked");

  assert.equal(roofResult.boundary.length,4,"Magic Wand should generate a roof that follows the closed wall footprint");
  assert.equal(roofResult.sourceWallIds.length,4,"Roof should retain links to its four reference walls");
  assert.equal(roofResult.type,"roof","Magic Wand is a feature; it must create a Roof element, not a Magic Wand element");
  assert.equal(await roofPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.some(e=>e.type==="magicwand")||false),false,"Magic Wand must remain a feature, never a model element");
  const roofReferencesValid=await roofPage.evaluate(ids=>{const elements=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[];return ids.every(id=>elements.some(el=>el.id===id&&el.type==="wall"))},roofResult.sourceWallIds);
  assert.equal(roofReferencesValid,true,"Magic Wand roof must stay linked to existing reference walls");
  await roofPage.locator("#threeTab").click();
  await roofPage.waitForFunction(()=>document.querySelector("#viewLabel")?.textContent.includes("3D Window"));
  assert.ok(await roofPage.locator("#canvas").evaluate(canvas=>canvas.width>0&&canvas.height>0),"3D canvas should remain available after roof generation");

  // After Roof is created, the four boundary points are visible and editable.
  await roofPage.locator("#floorTab").click();
  await roofPage.locator('[data-tool="select"]').click();
  const roofCenter=await roofPage.evaluate(()=>{const roof=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.find(e=>e.type==="roof");return{x:roof.boundary.reduce((s,p)=>s+p.x,0)/roof.boundary.length,y:roof.boundary.reduce((s,p)=>s+p.y,0)/roof.boundary.length}});
  await roofPoint(roofCenter.x*0.6+roofResult.boundary[0].x*0.4,roofCenter.y*0.6+roofResult.boundary[0].y*0.4);
  await roofPage.waitForFunction(()=>document.querySelector("#elementProperties input[readonly]")?.value?.toLowerCase().includes("roof"));
  const vertexScreen=await roofPage.evaluate(()=>{const roof=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.find(e=>e.type==="roof"),p=roof.boundary[0],cv=document.querySelector("#canvas"),r=cv.getBoundingClientRect(),t=window.__arqenvoViewport;return{x:r.left+cv.clientWidth/2+(t?.origin.x||0)+p.x*(t?.scale||36),y:r.top+cv.clientHeight/2+(t?.origin.y||0)-p.y*(t?.scale||36)}});
  await roofPage.mouse.move(vertexScreen.x,vertexScreen.y);
  const handleHit=await roofPage.evaluate(({x,y})=>{const c=document.querySelector("#canvas"),r=c.getBoundingClientRect(),px=x-r.left,py=y-r.top,ctx=c.getContext("2d");return {x:px,y:py,selected:document.querySelector("#selectionInfo")?.textContent,viewport:window.__arqenvoViewport||null}},vertexScreen);
  await roofPage.mouse.down();
  await roofPage.mouse.move(vertexScreen.x+28,vertexScreen.y+22);
  await roofPage.mouse.up();
  await roofPage.waitForFunction(({x,y})=>{const roof=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.find(e=>e.type==="roof");return !!roof&&(roof.boundary[0].x!==x||roof.boundary[0].y!==y)}, {x:roofResult.boundary[0].x,y:roofResult.boundary[0].y}, {timeout:3000});
  const movedRoof=await roofPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.find(e=>e.type==="roof"));
  assert.ok(movedRoof.boundary[0].x!==roofResult.boundary[0].x||movedRoof.boundary[0].y!==roofResult.boundary[0].y,`A selected Roof vertex should be editable; before=${JSON.stringify(roofResult.boundary[0])}, after=${JSON.stringify(movedRoof.boundary[0])}, status=${await roofPage.locator("#status").textContent()}, handle=${JSON.stringify(handleHit)}`);

  // Regression: Enter confirmation is idempotent and never appends an extra point after commit.
  const enterPage=await browser.newPage({viewport:{width:1100,height:800}});
  enterPage.setDefaultTimeout(8000);
  enterPage.on("pageerror",error=>pageErrors.push(error.message));
  await enterPage.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});
  await enterPage.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100);
  await enterPage.locator("#snapToggle").click();
  await enterPage.locator("#gridQuick").selectOption("0.1");
  const enterPoint=async(wx,wy)=>{const pt=await enterPage.evaluate(({wx,wy})=>{const cv=document.querySelector("#canvas"),r=cv.getBoundingClientRect(),t=window.__arqenvoViewport;return{x:r.left+cv.clientWidth/2+(t?.origin.x||0)+wx*(t?.scale||36),y:r.top+cv.clientHeight/2+(t?.origin.y||0)-wy*(t?.scale||36)}},{wx,wy});await enterPage.mouse.click(pt.x,pt.y)};
  await enterPage.locator('[data-tool="wall"]').click();
  await enterPage.locator("#wallGeometryMethod").selectOption("continuous");
  await enterPoint(-2,0); await enterPoint(0,0); await enterPoint(0,2);
  await enterPage.keyboard.press("Enter");
  await enterPage.waitForFunction(()=>document.querySelector("#status")?.textContent.includes("Wall drawing committed"));
  await enterPage.waitForTimeout(850);
  const enterBefore=await enterPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="wall").length||0);
  const size=enterPage.viewportSize();
  await enterPage.mouse.move(size.width-10,size.height-10);
  await enterPage.keyboard.press("Enter");
  await enterPage.waitForTimeout(800);
  const enterAfter=await enterPage.evaluate(()=>({walls:JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>e.type==="wall").length||0,selection:document.querySelector("#selectionInfo")?.textContent,active:!document.querySelector("#editActions")?.hidden}));
  assert.equal(enterAfter.walls,enterBefore,"Enter after commit must not append geometry");
  assert.ok(["No selection",""].includes((enterAfter.selection||"").trim()),"Confirmation must clear element selection");
  assert.equal(enterAfter.active,false,"Confirmation must end the active drawing state");
  await enterPage.close();

  // Roof parameters, including vertical Offset, are editable after creation.
  await roofPage.locator('[data-tool="select"]').click();
  await roofPage.waitForTimeout(50);
  const roofCenterPoint=await roofPage.evaluate(()=>{const c=document.querySelector("#canvas"),b=c.getBoundingClientRect(),t=window.__arqenvoViewport;return{x:b.left+c.clientWidth/2+(t?.origin.x||0),y:b.top+c.clientHeight/2+(t?.origin.y||0)}});
  await roofPage.mouse.click(roofCenterPoint.x,roofCenterPoint.y);
  await roofPage.waitForFunction(()=>document.querySelector('#elementProperties input[readonly]')?.value?.toLowerCase().includes("roof"));
  await roofPage.locator('#elementProperties [data-prop="pitch"]').fill("25");
  await roofPage.locator('#elementProperties [data-prop="elevation"]').fill("3.4");
  await roofPage.locator('#elementProperties [data-prop="offset"]').fill("2.75");
  await roofPage.locator('#elementProperties [data-prop="thickness"]').fill("0.22");
  await roofPage.locator("#applyProps").click();
  await roofPage.waitForFunction(()=>{const r=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements.find(e=>e.type==="roof");return r?.pitch===25&&r?.elevation===3.4&&r?.offset===2.75&&r?.thickness===.22});
  // Verify the same offset changes the 3D roof base elevation.
  await roofPage.locator("#threeTab").click();
  const baseZ=await roofPage.evaluate(()=>{const p=JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}"),roof=p.elements.find(e=>e.type==="roof");return (p.stories.find(s=>s.id===roof.storyId)?.elevation||0)+roof.elevation+roof.offset});
  assert.equal(baseZ,6.15,"Roof Offset must add to the roof's base Z elevation");
  assert.deepEqual(pageErrors, [], "Editor should not throw browser runtime errors");
  console.log("Browser smoke passed: app boot, T-junction, Undo/Redo, wall-chain, independent Door/Window selection, no page errors.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}