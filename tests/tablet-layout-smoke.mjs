import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon"};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);
    const requested=pathname==="/"?"/index.html":pathname;
    const file=path.resolve(root,"."+requested);
    if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end("Forbidden");return}
    const body=await readFile(file);
    res.writeHead(200,{"content-type":mime[path.extname(file)]||"application/octet-stream"});res.end(body);
  }catch{res.writeHead(404).end("Not found")}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address(),browser=await chromium.launch({headless:true});
try{
  const errors=[];
  async function touchScenario(options){
    const width=options.width,height=options.height,isMobile=options.isMobile,phone=!!options.phone;
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:phone?3:1,hasTouch:true,isMobile});
    page.setDefaultTimeout(8000);page.on("pageerror",e=>errors.push(e.message));
    await page.goto("http://127.0.0.1:"+address.port+"/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>80&&document.querySelector("#toolboxToggle")&&document.querySelector("#navigatorToggle"));
    const initial=await page.evaluate(()=>{
      const rect=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width,display:getComputedStyle(e).display}};
      return{coarse:matchMedia("(pointer:coarse)").matches,toolbox:rect("#toolbox"),nav:rect(".navigator"),inspector:rect(".inspector"),workspace:rect(".workspace"),toolToggleHidden:document.querySelector("#toolboxToggle").hidden,navToggleHidden:document.querySelector("#navigatorToggle").hidden,bodyWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth};
    });
    assert.equal(initial.coarse,true,"Touch layout must be detected");
    assert.ok(initial.workspace.width>120,"Drawing workspace must remain usable when panels are closed");
    assert.equal(initial.nav.display,"none","Navigator must be hidden by default on touch devices");
    assert.equal(initial.inspector.display,"none","Properties must be hidden by default on touch devices");
    assert.equal(initial.toolToggleHidden,false,"Toolbox toggle must be available");
    assert.equal(initial.navToggleHidden,false,"Navigator toggle must be available");
    if(phone)assert.ok(initial.bodyWidth>=initial.scrollWidth-1,"Phone layout must not overflow horizontally");

    await page.locator("#toolboxToggle").click({force:true});
    await page.waitForFunction(()=>document.querySelector(".work")?.classList.contains("toolbox-open"));
    const toolboxOpen=await page.evaluate(()=>({
      toolbox:getComputedStyle(document.querySelector("#toolbox")).display,
      nav:getComputedStyle(document.querySelector(".navigator")).display,
      inspector:getComputedStyle(document.querySelector(".inspector")).display,
      dockGrips:[...document.querySelectorAll(".arq-dock-resize")].filter(e=>getComputedStyle(e).display!=="none").length,
      floatingGrips:[...document.querySelectorAll(".arq-floating-resize")].filter(e=>getComputedStyle(e).display!=="none").length
    }));
    assert.notEqual(toolboxOpen.toolbox,"none","Toolbox must open from its tab button");
    assert.equal(toolboxOpen.nav,"none","Opening Toolbox must not leave Navigator overlapping it");
    assert.equal(toolboxOpen.inspector,"none","Opening Toolbox must not leave Properties overlapping it");
    assert.equal(toolboxOpen.dockGrips,0,"Dock splitters must not overlay a temporary touch panel");
    assert.equal(toolboxOpen.floatingGrips,0,"Floating resize handles must not overlay a temporary touch panel");

    await page.locator("#toolboxToggle").click({force:true});
    await page.waitForFunction(()=>!document.querySelector(".work")?.classList.contains("toolbox-open"));
    await page.locator("#navigatorToggle").click({force:true});
    await page.waitForFunction(()=>document.querySelector(".work")?.classList.contains("navigator-open"));
    const navOpen=await page.evaluate(()=>{
      const n=document.querySelector(".navigator"),r=n.getBoundingClientRect(),t=document.querySelector("#toolbox").getBoundingClientRect();
      return{display:getComputedStyle(n).display,x:r.x,width:r.width,toolboxRight:t.right,toolbox:getComputedStyle(document.querySelector("#toolbox")).display,inspector:getComputedStyle(document.querySelector(".inspector")).display,grips:[...document.querySelectorAll(".arq-dock-resize")].filter(e=>getComputedStyle(e).display!=="none").length};
    });
    assert.notEqual(navOpen.display,"none","Navigator must open from its tab button");
    assert.ok(navOpen.width>100,"Navigator overlay must have a useful width");
    if(phone)assert.notEqual(navOpen.toolbox,"none","Phone keeps the fixed Toolbox icon rail visible beside Navigator");else assert.equal(navOpen.toolbox,"none","Tablet Navigator and Toolbox overlays must be mutually exclusive");
    assert.equal(navOpen.inspector,"none","Navigator and Properties overlays must be mutually exclusive");
    assert.equal(navOpen.grips,0,"Dock splitters must be hidden while Navigator is open");
    if(phone)assert.ok(navOpen.x>=navOpen.toolboxRight-1,"Phone Navigator must start after the fixed Toolbox rail");

    await page.locator("#navigatorToggle").click({force:true});
    await page.waitForFunction(()=>!document.querySelector(".work")?.classList.contains("navigator-open"));
    await page.locator("#propsToggle").click({force:true});
    await page.waitForFunction(()=>document.querySelector(".work")?.classList.contains("inspector-open"));
    const propsOpen=await page.evaluate(()=>({display:getComputedStyle(document.querySelector(".inspector")).display,toolbox:getComputedStyle(document.querySelector("#toolbox")).display,nav:getComputedStyle(document.querySelector(".navigator")).display,grips:[...document.querySelectorAll(".arq-dock-resize")].filter(e=>getComputedStyle(e).display!=="none").length}));
    assert.notEqual(propsOpen.display,"none","Properties must open from its tab button");
    if(phone)assert.notEqual(propsOpen.toolbox,"none","Phone keeps the fixed Toolbox icon rail beside Properties");else assert.equal(propsOpen.toolbox,"none");assert.equal(propsOpen.nav,"none");assert.equal(propsOpen.grips,0);
    await page.locator("#propsToggle").click({force:true});
    await page.waitForFunction(()=>!document.querySelector(".work")?.classList.contains("inspector-open"));
    await page.close();
  }

  await touchScenario({width:1180,height:820,isMobile:false});
  await touchScenario({width:700,height:900,isMobile:false});
  await touchScenario({width:390,height:844,isMobile:true,phone:true});

  const desktop=await browser.newPage({viewport:{width:1440,height:1000}});
  desktop.on("pageerror",e=>errors.push(e.message));
  await desktop.goto("http://127.0.0.1:"+address.port+"/",{waitUntil:"domcontentloaded"});
  await desktop.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100&&document.querySelector("#navigatorToggle"));
  const desktopState=await desktop.evaluate(()=>({
    mobilePanels:document.querySelector(".work").classList.contains("mobile-panels"),
    navToggleHidden:document.querySelector("#navigatorToggle").hidden,
    toolbox:getComputedStyle(document.querySelector("#toolbox")).display,
    nav:getComputedStyle(document.querySelector(".navigator")).display,
    workspace:document.querySelector(".workspace").getBoundingClientRect().width,
    splitter:[...document.querySelectorAll(".arq-dock-resize")].some(e=>getComputedStyle(e).display!=="none")
  }));
  assert.equal(desktopState.mobilePanels,false,"Desktop must not use touch overlay mode");
  assert.equal(desktopState.navToggleHidden,true,"Desktop must not show the mobile Navigator toggle");
  assert.notEqual(desktopState.toolbox,"none");assert.notEqual(desktopState.nav,"none");
  assert.ok(desktopState.workspace>200);assert.equal(desktopState.splitter,true,"Desktop palette splitter remains available");
  assert.deepEqual(errors,[],"Responsive panel controls must not introduce browser errors");
  await desktop.close();
  console.log("Touch overlay and desktop palette smoke passed.");
}finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));
}
