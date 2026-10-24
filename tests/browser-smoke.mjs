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


  // Touch users must be able to finish/cancel after the physical touch has ended.
  const touchPage = await browser.newPage({ viewport: { width: 900, height: 1100 }, hasTouch: true, isMobile: true });
  touchPage.setDefaultTimeout(8000);
  touchPage.on("pageerror", error => pageErrors.push(error.message));
  await touchPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  await touchPage.waitForFunction(() => document.querySelector("#canvas")?.clientWidth > 100);
  const touchPoint = async (wx, wy) => touchPage.evaluate(({wx,wy}) => {
    const c=document.querySelector("#canvas"),r=c.getBoundingClientRect(),t=window.__arqenvoViewport;
    return {x:r.left+c.clientWidth/2+(t?.origin.x||0)+wx*(t?.scale||36),y:r.top+c.clientHeight/2+(t?.origin.y||0)-wy*(t?.scale||36)};
  },{wx,wy});
  const projectElements = async () => touchPage.evaluate(() => JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements||[]);
  const actionsVisible = async () => touchPage.locator("#editActions").evaluate(el => !el.hidden && el.getAttribute("aria-hidden")!=="true");
  const pointerSequence = async (startPt,endPt,pointerId) => {
    await touchPage.evaluate(({startPt,endPt,pointerId}) => {
      const canvas=document.querySelector("#canvas");
      const init={pointerId,pointerType:"touch",button:0,bubbles:true,cancelable:true};
      canvas.dispatchEvent(new PointerEvent("pointerdown",{...init,clientX:startPt.x,clientY:startPt.y,buttons:1}));
      canvas.dispatchEvent(new PointerEvent("pointermove",{...init,clientX:endPt.x,clientY:endPt.y,buttons:1}));
      canvas.dispatchEvent(new PointerEvent("pointerup",{...init,clientX:endPt.x,clientY:endPt.y,buttons:0}));
    },{startPt,endPt,pointerId});
  };

  // Existing element edit: use a deterministic synthetic pointer lifecycle.
  // Element drag activation is registered on pointerdown; a move exceeding the threshold
  // must keep the gesture active until Finish/Cancel, including following pointerup.
  await touchPage.locator('[data-tool="gridline"]').click();
  let tp=await touchPoint(-2,0); await touchPage.touchscreen.tap(tp.x,tp.y);
  tp=await touchPoint(2,0); await touchPage.touchscreen.tap(tp.x,tp.y);
  await touchPage.waitForTimeout(800);
  await touchPage.locator('[data-tool="select"]').click();
  const before=await touchPage.evaluate(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.find(e=>e.type==="gridline"));
  assert.ok(before,"Touch test must create a Gridline");
  const startPt=await touchPoint(0,0),endPt=await touchPoint(0,0.7);
  await touchPage.evaluate(({startPt,endPt})=>{
    const canvas=document.querySelector("#canvas");
    const rect=canvas.getBoundingClientRect();
    const localStart={x:startPt.x-rect.left,y:startPt.y-rect.top};
    const localEnd={x:endPt.x-rect.left,y:endPt.y-rect.top};
    const init={pointerId:5101,pointerType:"touch",button:0,bubbles:true,cancelable:true};
    canvas.dispatchEvent(new PointerEvent("pointerdown",{...init,clientX:startPt.x,clientY:startPt.y,buttons:1}));
    canvas.dispatchEvent(new PointerEvent("pointermove",{...init,clientX:endPt.x,clientY:endPt.y,buttons:1}));
  },{startPt,endPt});
  assert.equal(await actionsVisible(),true,"Finish/Cancel must be visible during an active element edit");
  assert.match(await touchPage.locator("#status").textContent(),/Moving Gridline|Gridline selected/,"Touch sequence must activate a Gridline edit before release");
  // Capture release state exactly as Safari/iOS reports it; the canvas may be the release target.
  await touchPage.evaluate(({endPt})=>document.querySelector("#canvas").dispatchEvent(new PointerEvent("pointerup",{pointerId:5101,pointerType:"touch",clientX:endPt.x,clientY:endPt.y,button:0,buttons:0,bubbles:true})),{endPt});
  assert.equal(await actionsVisible(),true,`Finish/Cancel must remain visible after touch release during element edit; status="${await touchPage.locator("#status").textContent()}"; selection="${await touchPage.locator("#selectionInfo").textContent()}"; visible="${await touchPage.locator("#editActions").isVisible()}"; intent/state=${JSON.stringify(await touchPage.evaluate(()=>({hidden:document.querySelector("#editActions")?.hidden,aria:document.querySelector("#editActions")?.getAttribute("aria-hidden"),tool:document.querySelector("#toolName")?.value})))}`);
  assert.ok((await touchPage.locator("#editCommit").innerText()).includes("Finish"),"Finish button label must be English");
  await touchPage.locator("#editCommit").tap();
  await touchPage.waitForFunction(()=>document.querySelector("#status")?.textContent==="Element edit committed");
  assert.equal(await actionsVisible(),false,"Finish should close contextual actions after committing the edit");
  const afterCommit=await projectElements().then(items=>items.find(e=>e.type==="gridline"));
  assert.ok(afterCommit,"Gridline must remain after touch commit");
  assert.equal(afterCommit.start.y,afterCommit.end.y,"Whole Gridline drag must preserve its parallel geometry");
  assert.ok(afterCommit,"Gridline must remain after touch commit");
  assert.equal(afterCommit.start.y,afterCommit.end.y,"Whole Gridline drag must preserve its parallel geometry");
  assert.deepEqual(afterCommit.start,before.start,"Whole Gridline drag keeps the original start point fixed");
  assert.deepEqual(afterCommit.end,before.end,"Whole Gridline drag keeps the original end point fixed");

  // Cancel a second pending edit without starting another pointer lifecycle.
  const baselineCancel=await projectElements().then(items=>items.find(e=>e.type==="gridline"));
  const cancelStart=await touchPoint(0,0),cancelEnd=await touchPoint(0,0.6);
  await touchPage.evaluate(({startPt,endPt})=>{
    const canvas=document.querySelector("#canvas");
    const init={pointerId:5102,pointerType:"touch",button:0,bubbles:true,cancelable:true};
    canvas.dispatchEvent(new PointerEvent("pointerdown",{...init,clientX:startPt.x,clientY:startPt.y,buttons:1}));
    canvas.dispatchEvent(new PointerEvent("pointermove",{...init,clientX:endPt.x,clientY:endPt.y,buttons:1}));
    window.dispatchEvent(new PointerEvent("pointerup",{...init,clientX:endPt.x,clientY:endPt.y,buttons:0}));
  },{startPt:cancelStart,endPt:cancelEnd});
  assert.equal(await actionsVisible(),true,"Finish/Cancel must remain visible after release before cancel");
  await touchPage.locator("#editCancel").tap();
  await touchPage.waitForFunction(()=>document.querySelector("#status")?.textContent==="Element edit cancelled");
  assert.equal(await actionsVisible(),false,"Cancel should close contextual actions after cancelling an edit");
  const afterCancel=await projectElements().then(items=>items.find(e=>e.type==="gridline"));
  assert.deepEqual(afterCancel.start,baselineCancel.start,"Cancel must restore the original Gridline start point");
  assert.deepEqual(afterCancel.end,baselineCancel.end,"Cancel must restore the original Gridline end point");

  // Drawing: Finish and Cancel must persist after release and must not start an extra wall point.
  await touchPage.locator('[data-tool="wall"]').click();
  await touchPage.locator("#wallGeometryMethod").selectOption("continuous");
  tp=await touchPoint(-3,-2); await touchPage.touchscreen.tap(tp.x,tp.y);
  tp=await touchPoint(0,-2); await touchPage.touchscreen.tap(tp.x,tp.y);
  await touchPage.waitForFunction(()=>document.querySelector("#editActions")?.hidden===false);
  assert.equal(await actionsVisible(),true,"Wall-chain controls should appear while drawing");
  await touchPage.locator("#editCommit").tap();
  await touchPage.waitForFunction(()=>document.querySelector("#status")?.textContent.includes("Wall drawing committed"));
  assert.equal(await actionsVisible(),false,"Finish must close the wall chain");
  const wallCountAfterFinish=await projectElements().then(items=>items.filter(e=>e.type==="wall").length);
  await touchPage.locator("#canvas").tap().catch(()=>{});
  assert.equal((await projectElements()).filter(e=>e.type==="wall").length,wallCountAfterFinish,"Tapping after Finish must not create an additional wall point");

  // A provisional rectangle can be cancelled without leaving pending wall geometry behind.
  await touchPage.locator("#wallGeometryMethod").selectOption("rectangle");
  tp=await touchPoint(-2,1); await touchPage.touchscreen.tap(tp.x,tp.y);
  tp=await touchPoint(1,3); await touchPage.touchscreen.tap(tp.x,tp.y);
  await touchPage.waitForFunction(()=>document.querySelector("#editActions")?.hidden===false);
  const wallCountBeforeCancel=await projectElements().then(items=>items.filter(e=>e.type==="wall").length);
  assert.equal(await actionsVisible(),true,"Provisional drawing controls should remain visible");
  await touchPage.locator("#editCancel").tap();
  await touchPage.waitForFunction(()=>document.querySelector("#status")?.textContent.includes("Drawing cancelled"));
  assert.equal(await actionsVisible(),false,"Cancel should close provisional drawing controls");
  assert.equal((await projectElements()).filter(e=>e.type==="wall").length,wallCountBeforeCancel-4,"Cancelling a provisional rectangle must remove its four pending wall segments");
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
  await modelPoint(0, wallY);
  await modelPoint(0, wallY + .8, "move");
  await openingPage.keyboard.press("Enter");
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Door placed"), null, { timeout: 8000 }).catch(async error => { throw new Error(`Door placement failed; status="${await openingPage.locator("#status").textContent()}"; tool="${await openingPage.locator("#toolName").inputValue().catch(()=>"unknown")}"; properties="${(await openingPage.locator("#elementProperties").textContent()).slice(0,300)}"; ${error.message}`); });
  await openingPage.locator('[data-tool="select"]').click();
  // Clear any selection left by placement using a genuine browser pointer sequence
  // on the canvas margin, not a synthetic event that bypasses Playwright's mouse input.
  const canvasBox = await openingPage.locator("#canvas").boundingBox();
  await openingPage.mouse.click(canvasBox.x + canvasBox.width - 24, canvasBox.y + 24);
  await openingPage.waitForFunction(() => document.querySelector("#selectionInfo")?.textContent.includes("No selection") || !(document.querySelector("#elementProperties input[readonly]")));
  await openingPage.waitForFunction(() => !document.querySelector("#elementProperties input[readonly]"));
  // Click the visible Door swing arc in screen coordinates derived from the real host wall.
  // Include current model geometry in a failure report so browser automation identifies the actual hit-test result.
  await openingPage.evaluate(() => {
    const canvas=document.querySelector("#canvas"),rect=canvas.getBoundingClientRect(),t=window.__arqenvoViewport;
    const wx=0.566,wy=-2.934;
    const scale=t?.scale||Number(document.querySelector("#scaleSelect")?.value||36),origin=t?.origin||{x:0,y:0};
    const x=rect.left+canvas.clientWidth/2+origin.x+wx*scale,y=rect.top+canvas.clientHeight/2+origin.y-wy*scale;
    canvas.dispatchEvent(new PointerEvent("pointerdown",{pointerId:992,clientX:x,clientY:y,button:0,buttons:1,bubbles:true}));
    canvas.dispatchEvent(new PointerEvent("pointerup",{pointerId:992,clientX:x,clientY:y,button:0,buttons:0,bubbles:true}));
  });
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("door ·"), null, {timeout:8000}).catch(async error => { const diag=await openingPage.evaluate(()=>({status:document.querySelector("#status")?.textContent,selection:document.querySelector("#selectionInfo")?.textContent,tool:document.querySelector("#toolName")?.value,props:document.querySelector("#elementProperties")?.textContent,project:JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.filter(e=>["wall","door","window"].includes(e.type)).map(e=>({id:e.id,type:e.type,start:e.start,end:e.end,offset:e.offset,width:e.width,hostWallId:e.hostWallId,storyId:e.storyId,hingeSide:e.hingeSide,swingDirection:e.swingDirection}))})); console.log("DOOR_SELECTION_DIAG",JSON.stringify(diag)); throw new Error(`Door symbol selection failed; diag=${JSON.stringify(diag)}; ${error.message}`); });
  assert.match(await openingPage.locator("#elementProperties input[readonly]").inputValue(), /door ·/i,
    "Clicking the visible door leaf/swing symbol should select Door ahead of its host wall");
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
  await openingPage.waitForFunction(() => document.querySelector("#status")?.textContent === "Opening updated");
  assert.equal(Number(await openingPage.locator('[data-prop="width"]').inputValue()), 1.2,
    "Pressing Enter should apply the new door width to the hosted opening");
  // Alignment=Left moved the opening to the host wall start (-4 m); hit the updated visible arc and opening span.
  await modelPoint(-3.434, wallY + 0.566);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("door ·"), null, {timeout:8000});
  await modelPoint(-3.55, wallY);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("door ·"), null, {timeout:8000});
  const doorOffsetBeforeMove = Number(await openingPage.locator('[data-prop="offset"]').inputValue());
  const dragScreenPoint = async (wx, wy) => openingPage.evaluate(({wx,wy}) => { const canvas=document.querySelector("#canvas"),rect=canvas.getBoundingClientRect(),scale=Number(document.querySelector("#scaleSelect")?.value||36); return {x:rect.left+canvas.clientWidth/2+wx*scale,y:rect.top+canvas.clientHeight/2-wy*scale}; }, {wx,wy});
  const doorDragStart = await dragScreenPoint(-3.434, wallY + 0.566);
  const doorDragEnd = await dragScreenPoint(-2.634, wallY + 0.566);
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
  await openingPage.locator('[data-tool="select"]').click();
  // Clear selection left by placement so the assertion proves a new Window hit.
  await modelPoint(7, 3);
  await openingPage.waitForFunction(() => !(document.querySelector("#elementProperties input[readonly]")));
  await openingPage.waitForFunction(() => !document.querySelector("#elementProperties input[readonly]"));
  // Window sash lines are offset from the host wall centreline in the rendered plan.
  await modelPoint(2.6, wallY + 0.075);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("window ·"));
  assert.match(await openingPage.locator("#elementProperties input[readonly]").inputValue(), /window ·/i,
    "Clicking a visible window sash should select Window rather than its host wall");
  await modelPoint(2.6, wallY);
  await openingPage.waitForFunction(() => (document.querySelector("#elementProperties input[readonly]")?.value || "").toLowerCase().includes("window ·"));

  assert.deepEqual(pageErrors, [], "Editor should not throw browser runtime errors");
  console.log("Browser smoke passed: app boot, T-junction, Undo/Redo, wall-chain, independent Door/Window selection, no page errors.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
