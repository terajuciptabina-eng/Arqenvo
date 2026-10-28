import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon"};
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);const requested=pathname==="/"?"/index.html":pathname;const file=path.resolve(root,"."+requested);if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end("Forbidden");return}const body=await readFile(file);res.writeHead(200,{"content-type":mime[path.extname(file)]||"application/octet-stream"});res.end(body)}catch{res.writeHead(404).end("Not found")}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address(),browser=await chromium.launch({headless:true});
try{
 const errors=[],tablet=await browser.newPage({viewport:{width:1180,height:820},hasTouch:true,isMobile:false});tablet.setDefaultTimeout(8000);tablet.on("pageerror",e=>errors.push(e.message));
 await tablet.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});await tablet.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100&&document.querySelector("#navigatorToggle"));
 const before=await tablet.evaluate(()=>{const rect=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,display:getComputedStyle(e).display}};return{coarse:matchMedia("(pointer:coarse)").matches,work:rect(".work"),toolbox:rect("#toolbox"),nav:rect(".navigator"),workspace:rect(".workspace"),inspector:rect(".inspector"),toggleHidden:document.querySelector("#navigatorToggle").hidden}});
 assert.equal(before.coarse,true);assert.ok(before.nav.width>100&&before.workspace.width>100);assert.equal(before.inspector.display,"none");assert.ok(before.nav.x<before.workspace.x&&Math.abs(before.workspace.right-before.work.right)<3,"Tablet canvas must fill the available right edge without a hidden Inspector track");assert.equal(before.toggleHidden,false);
 // Docked Toolbox splitter must be a live hit target outside the scrollable palette and change its width.
 const toolboxWidthBefore=await tablet.locator("#toolbox").evaluate(e=>e.getBoundingClientRect().width);
 const toolboxGrip=await tablet.locator(".arq-dock-resize.toolbox-resize").boundingBox();assert.ok(toolboxGrip&&toolboxGrip.width>=8,"Toolbox dock splitter must be visible");
 await tablet.mouse.move(toolboxGrip.x+toolboxGrip.width/2,toolboxGrip.y+Math.min(100,toolboxGrip.height/2));await tablet.mouse.down();await tablet.mouse.move(toolboxGrip.x+toolboxGrip.width/2+35,toolboxGrip.y+Math.min(100,toolboxGrip.height/2),{steps:5});await tablet.mouse.up();
 const toolboxWidthAfter=await tablet.locator("#toolbox").evaluate(e=>e.getBoundingClientRect().width);assert.ok(toolboxWidthAfter>toolboxWidthBefore+20,"Dragging the docked Toolbox splitter must resize its actual grid track");
 // Refresh the geometry baseline because resizing Toolbox moves Navigator and reduces the canvas track.
 Object.assign(before.nav,await tablet.locator(".navigator").evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}}));
 Object.assign(before.workspace,await tablet.locator(".workspace").evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}}));

 // Palette movement regression: the Toolbox drag header must remain visible on a collapsed touch tablet.
 const toolboxHeader=tablet.locator("#toolbox .toolbox-title");
 const toolboxHeaderStyle=await toolboxHeader.evaluate(e=>({display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,height:e.getBoundingClientRect().height}));
 assert.notEqual(toolboxHeaderStyle.display,"none","Touch tablet Toolbox needs a visible drag handle even when collapsed");
 assert.equal(toolboxHeaderStyle.visibility,"visible");
 assert.ok(toolboxHeaderStyle.height>=20,"Touch tablet Toolbox drag target must be large enough to use");
 const toolboxStart=await toolboxHeader.boundingBox();
 // Drive the same pointer events consumed by addDrag. The collapsed touch
 // palette can reflow during mouse movement in headless Chromium, so a physical
 // mouse drag is not a deterministic way to test this pointer-state transition.
 await tablet.evaluate(({x,y})=>{
  const header=document.querySelector("#toolbox .toolbox-title");
  const emit=(target,type,px,py)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:77,pointerType:"mouse",button:0,buttons:type==="pointerup"?0:1,clientX:px,clientY:py}));
  emit(header,"pointerdown",x,y);
  // Move beyond the resized dock track and its hit tolerance so this
  // scenario unambiguously tests floating rather than dropping back to dock.
  emit(document,"pointermove",x+300,y+100);
  emit(document,"pointerup",x+300,y+100);
 },{x:toolboxStart.x+Math.min(10,toolboxStart.width/2),y:toolboxStart.y+toolboxStart.height/2});
 await tablet.waitForFunction(()=>document.querySelector("#toolbox")?.classList.contains("arq-palette-floating"),null,{timeout:3000});
 const toolboxFloating=await tablet.evaluate(()=>{const e=document.querySelector("#toolbox"),r=e.getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,mode:JSON.parse(localStorage.getItem("arqenvo-palette-toolbox")||"{}").mode,expanded:document.querySelector(".work").classList.contains("toolbox-expanded"),title:getComputedStyle(e.querySelector(".toolbox-title")).visibility}});
 assert.equal(toolboxFloating.mode,"float");assert.ok(toolboxFloating.left>60&&toolboxFloating.top>40,"Dragging Toolbox header should move the palette over the workspace");assert.ok(toolboxFloating.width>100);assert.equal(toolboxFloating.expanded,true);assert.equal(toolboxFloating.title,"visible");
 const floatingHeader=await toolboxHeader.boundingBox();
 await tablet.mouse.move(floatingHeader.x+Math.min(10,floatingHeader.width/2),floatingHeader.y+floatingHeader.height/2);
 await tablet.mouse.down();await tablet.mouse.move(22,Math.max(35,floatingHeader.y+floatingHeader.height/2),{steps:8});await tablet.mouse.up();
 await tablet.waitForFunction(()=>!document.querySelector("#toolbox")?.classList.contains("arq-palette-floating"));
 assert.equal(JSON.parse(await tablet.evaluate(()=>localStorage.getItem("arqenvo-palette-toolbox"))).mode,"dock","Dropping Toolbox back at its original edge should dock it");
 const navHeader=tablet.locator(".navigator > .section").first();
 const navHeaderBox=await navHeader.boundingBox();
 await tablet.mouse.move(navHeaderBox.x+Math.min(25,navHeaderBox.width/3),navHeaderBox.y+navHeaderBox.height/2);
 await tablet.mouse.down();await tablet.mouse.move(navHeaderBox.x+450,navHeaderBox.y+90,{steps:8});await tablet.mouse.up();
 await tablet.waitForFunction(()=>document.querySelector(".navigator")?.classList.contains("arq-palette-floating"));
 assert.equal(JSON.parse(await tablet.evaluate(()=>localStorage.getItem("arqenvo-palette-navigator"))).mode,"float","Navigator header should allow moving to a floating position");
 const navFloatingHeader=await navHeader.boundingBox();
 // Start away from the embedded Navigator toggle; it intentionally isn't a drag handle.
 await tablet.mouse.move(navFloatingHeader.x+Math.min(80,navFloatingHeader.width-12),navFloatingHeader.y+navFloatingHeader.height/2);
 // Return to the captured dock slot after the floating palette has reflowed.
 await tablet.mouse.down();await tablet.mouse.move(Math.round(before.nav.x+Math.min(80,before.nav.width/2)),Math.round(before.nav.y+Math.min(80,before.nav.height/2)),{steps:8});await tablet.mouse.up();
 await tablet.waitForFunction(()=>!document.querySelector(".navigator")?.classList.contains("arq-palette-floating")).catch(async error=>{
  const diagnostic=await tablet.evaluate(()=>{const e=document.querySelector(".navigator"),r=e?.getBoundingClientRect(),w=document.querySelector(".work")?.getBoundingClientRect(),saved=JSON.parse(localStorage.getItem("arqenvo-palette-navigator")||"{}");return{classes:e?.className,rect:r?{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}:null,work:w?{x:w.x,y:w.y,width:w.width,height:w.height,right:w.right,bottom:w.bottom}:null,saved,header:document.querySelector(".navigator > .section")?.getBoundingClientRect().toJSON()||null}}).catch(e=>({diagnosticError:e.message}));
  throw new Error("Navigator failed to dock after return drag: "+JSON.stringify(diagnostic)+"; "+error.message);
 });
 assert.equal(JSON.parse(await tablet.evaluate(()=>localStorage.getItem("arqenvo-palette-navigator"))).mode,"dock","Dropping Navigator back at its dock area should restore its docked layout");
 await tablet.locator("#navigatorToggle").click({force:true});await tablet.waitForFunction(()=>document.querySelector(".work")?.classList.contains("navigator-hidden"));
 const hidden=await tablet.evaluate(()=>({nav:getComputedStyle(document.querySelector(".navigator")).display,inspector:getComputedStyle(document.querySelector(".inspector")).display,toggleHidden:document.querySelector("#navigatorToggle").hidden,workspaceWidth:document.querySelector(".workspace").getBoundingClientRect().width,workWidth:document.querySelector(".work").getBoundingClientRect().width}));
 assert.equal(hidden.nav,"none");assert.equal(hidden.inspector,"none");assert.ok(hidden.workspaceWidth>100&&hidden.workspaceWidth>before.workspace.width&&!hidden.toggleHidden,"Hiding Navigator must collapse its track and return space to the canvas");
 await tablet.locator("#navigatorToggle").click({force:true});await tablet.waitForFunction(()=>!document.querySelector(".work")?.classList.contains("navigator-hidden"));
 const after=await tablet.evaluate(()=>{const r=document.querySelector(".navigator").getBoundingClientRect();return{x:r.x,width:r.width,display:getComputedStyle(document.querySelector(".navigator")).display}});
 assert.equal(after.display,"block");assert.equal(Math.round(after.x),Math.round(before.nav.x));assert.equal(Math.round(after.width),Math.round(before.nav.width));
 // Docked Navigator splitter must resize the panel in its actual layout direction (it is left of canvas on tablets).
 const navWidthBeforeResize=await tablet.locator(".navigator").evaluate(e=>e.getBoundingClientRect().width);
 const navGrip=await tablet.locator(".arq-dock-resize.navigator-resize").boundingBox();assert.ok(navGrip&&navGrip.width>=8,"Navigator dock splitter must be visible");
 await tablet.mouse.move(navGrip.x+navGrip.width/2,navGrip.y+Math.min(100,navGrip.height/2));await tablet.mouse.down();await tablet.mouse.move(navGrip.x+navGrip.width/2+35,navGrip.y+Math.min(100,navGrip.height/2),{steps:5});await tablet.mouse.up();
 const navWidthAfterResize=await tablet.locator(".navigator").evaluate(e=>e.getBoundingClientRect().width);assert.ok(navWidthAfterResize>navWidthBeforeResize+20,"Dragging the docked Navigator splitter must resize its actual grid track");await tablet.close();
 const narrowTablet=await browser.newPage({viewport:{width:700,height:900},hasTouch:true,isMobile:false});narrowTablet.setDefaultTimeout(8000);narrowTablet.on("pageerror",e=>errors.push(e.message));
 await narrowTablet.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});await narrowTablet.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100&&document.querySelector("#navigatorToggle"));
 const narrowBefore=await narrowTablet.evaluate(()=>{const rect=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width,display:getComputedStyle(e).display}};return{coarse:matchMedia("(pointer:coarse)").matches,work:rect(".work"),nav:rect(".navigator"),workspace:rect(".workspace"),inspector:rect(".inspector"),toggleHidden:document.querySelector("#navigatorToggle").hidden}});
 assert.equal(narrowBefore.coarse,true,"Narrow touch viewport must use the docked tablet layout");assert.ok(narrowBefore.nav.width>100&&narrowBefore.workspace.width>100);assert.equal(narrowBefore.inspector.display,"none");assert.ok(narrowBefore.nav.x<narrowBefore.workspace.x&&Math.abs(narrowBefore.workspace.right-narrowBefore.work.right)<3);assert.equal(narrowBefore.toggleHidden,false);
 await narrowTablet.locator("#navigatorToggle").click({force:true});await narrowTablet.waitForFunction(()=>document.querySelector(".work")?.classList.contains("navigator-hidden"));
 const narrowHidden=await narrowTablet.evaluate(()=>({nav:getComputedStyle(document.querySelector(".navigator")).display,inspector:getComputedStyle(document.querySelector(".inspector")).display,workspaceWidth:document.querySelector(".workspace").getBoundingClientRect().width,toggleHidden:document.querySelector("#navigatorToggle").hidden}));
 assert.equal(narrowHidden.nav,"none");assert.equal(narrowHidden.inspector,"none");assert.ok(narrowHidden.workspaceWidth>narrowBefore.workspace.width&&!narrowHidden.toggleHidden);
 await narrowTablet.locator("#navigatorToggle").click({force:true});await narrowTablet.waitForFunction(()=>!document.querySelector(".work")?.classList.contains("navigator-hidden"));
 const narrowAfter=await narrowTablet.evaluate(()=>{const r=document.querySelector(".navigator").getBoundingClientRect();return{x:r.x,width:r.width,display:getComputedStyle(document.querySelector(".navigator")).display}});
 assert.equal(narrowAfter.display,"block");assert.equal(Math.round(narrowAfter.x),Math.round(narrowBefore.nav.x));assert.equal(Math.round(narrowAfter.width),Math.round(narrowBefore.nav.width));await narrowTablet.close();
 const phone=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});phone.setDefaultTimeout(8000);phone.on("pageerror",e=>errors.push(e.message));
 await phone.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});await phone.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>50&&document.querySelector("#navigatorToggle"));
 const phoneBefore=await phone.evaluate(()=>{const r=s=>{const e=document.querySelector(s),b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,display:getComputedStyle(e).display}};return{mobile:matchMedia("(max-width:600px)").matches,coarse:matchMedia("(pointer:coarse)").matches,work:r(".work"),toolbox:r("#toolbox"),workspace:r(".workspace"),canvas:r("#canvas"),nav:r(".navigator"),inspector:r(".inspector"),toggleHidden:document.querySelector("#navigatorToggle").hidden,bodyWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}});
 assert.equal(phoneBefore.mobile,true);assert.equal(phoneBefore.coarse,true);assert.equal(phoneBefore.toggleHidden,false);assert.ok(phoneBefore.workspace.width>150&&phoneBefore.canvas.width>150);assert.ok(phoneBefore.bodyWidth>=phoneBefore.scrollWidth-1,"Phone layout must not overflow horizontally");assert.equal(phoneBefore.nav.display,"none");assert.equal(phoneBefore.inspector.display,"none");
 await phone.locator("#navigatorToggle").click({force:true});await phone.waitForFunction(()=>document.querySelector(".work")?.classList.contains("navigator-open"));
 const phoneOpen=await phone.evaluate(()=>{const r=s=>{const e=document.querySelector(s),b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,display:getComputedStyle(e).display}};return{nav:r(".navigator"),toolbox:r("#toolbox"),workspace:r(".workspace"),canvas:r("#canvas"),inspector:r(".inspector"),toggleHidden:document.querySelector("#navigatorToggle").hidden}});
 assert.equal(phoneOpen.nav.display,"block");assert.ok(phoneOpen.nav.width>150&&phoneOpen.nav.x>=phoneOpen.toolbox.x+phoneOpen.toolbox.width-1,"Navigator overlay must begin after the fixed Toolbox");assert.ok(phoneOpen.workspace.width>150&&phoneOpen.canvas.width>150);assert.equal(phoneOpen.inspector.display,"none");
 await phone.locator("#navigatorToggle").click({force:true});await phone.waitForFunction(()=>!document.querySelector(".work")?.classList.contains("navigator-open"));await phone.close();
 const desktop=await browser.newPage({viewport:{width:1440,height:1000}});desktop.on("pageerror",e=>errors.push(e.message));await desktop.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});await desktop.waitForFunction(()=>document.querySelector("#canvas")?.clientWidth>100&&document.querySelector("#navigatorToggle"));
 const state=await desktop.evaluate(()=>({toggleHidden:document.querySelector("#navigatorToggle").hidden,toolbox:document.querySelector("#toolbox").getBoundingClientRect().width,workspace:document.querySelector(".workspace").getBoundingClientRect().width,nav:getComputedStyle(document.querySelector(".navigator")).display,inspector:getComputedStyle(document.querySelector(".inspector")).display}));
 assert.equal(state.toggleHidden,true,"Desktop must not expose the Hide/Show Navigator control");assert.ok(state.workspace>100&&state.toolbox>0&&state.nav==="block"&&state.inspector==="none","Desktop layout must not retain a hidden Inspector panel");
 const desktopNavWidthBefore=await desktop.locator(".navigator").evaluate(e=>e.getBoundingClientRect().width),desktopGrip=await desktop.locator(".arq-dock-resize.navigator-resize").boundingBox();assert.ok(desktopGrip&&desktopGrip.width>=8,"Desktop Navigator splitter must be visible");
 await desktop.mouse.move(desktopGrip.x+desktopGrip.width/2,desktopGrip.y+Math.min(100,desktopGrip.height/2));await desktop.mouse.down();await desktop.mouse.move(desktopGrip.x+desktopGrip.width/2-35,desktopGrip.y+Math.min(100,desktopGrip.height/2),{steps:5});await desktop.mouse.up();
 const desktopNavWidthAfter=await desktop.locator(".navigator").evaluate(e=>e.getBoundingClientRect().width);assert.ok(desktopNavWidthAfter>desktopNavWidthBefore+20,"Dragging the right-docked Navigator splitter left must increase its width");
 // Desktop regression: moving a palette must float it, preserve the workspace, and allow docking at its original edge.
 const desktopToolboxHeader=desktop.locator("#toolbox .toolbox-title"),desktopToolboxBox=await desktopToolboxHeader.boundingBox();
 await desktop.mouse.move(desktopToolboxBox.x+desktopToolboxBox.width/2,desktopToolboxBox.y+desktopToolboxBox.height/2);await desktop.mouse.down();
 await desktop.mouse.move(desktopToolboxBox.x+desktopToolboxBox.width/2+180,desktopToolboxBox.y+desktopToolboxBox.height/2+90,{steps:8});await desktop.mouse.up();
 await desktop.waitForFunction(()=>document.querySelector("#toolbox")?.classList.contains("arq-palette-floating"));
 assert.equal(JSON.parse(await desktop.evaluate(()=>localStorage.getItem("arqenvo-palette-toolbox"))).mode,"float");
 const desktopFloatToolbox=await desktopToolboxHeader.boundingBox();
 await desktop.mouse.move(desktopFloatToolbox.x+10,desktopFloatToolbox.y+desktopFloatToolbox.height/2);await desktop.mouse.down();await desktop.mouse.move(20,Math.max(35,desktopFloatToolbox.y+desktopFloatToolbox.height/2),{steps:8});await desktop.mouse.up();
 await desktop.waitForFunction(()=>!document.querySelector("#toolbox")?.classList.contains("arq-palette-floating"));
 const desktopNavHeader=desktop.locator(".navigator > .section").first(),desktopNavBox=await desktopNavHeader.boundingBox();
 await desktop.mouse.move(desktopNavBox.x+Math.min(25,desktopNavBox.width/3),desktopNavBox.y+desktopNavBox.height/2);await desktop.mouse.down();
 await desktop.mouse.move(800,desktopNavBox.y+90,{steps:8});await desktop.mouse.up();
 await desktop.waitForFunction(()=>document.querySelector(".navigator")?.classList.contains("arq-palette-floating"));
 assert.equal(JSON.parse(await desktop.evaluate(()=>localStorage.getItem("arqenvo-palette-navigator"))).mode,"float");
 const desktopFloatNav=await desktopNavHeader.boundingBox();
 await desktop.mouse.move(desktopFloatNav.x+15,desktopFloatNav.y+desktopFloatNav.height/2);await desktop.mouse.down();await desktop.mouse.move(1420,Math.max(35,desktopFloatNav.y+desktopFloatNav.height/2),{steps:8});await desktop.mouse.up();
 await desktop.waitForFunction(()=>!document.querySelector(".navigator")?.classList.contains("arq-palette-floating"));
 assert.equal(JSON.parse(await desktop.evaluate(()=>localStorage.getItem("arqenvo-palette-navigator"))).mode,"dock");
 assert.deepEqual(errors,[],"Palette movement must not introduce browser errors");
 const svgAudit=await desktop.evaluate(()=>{const host=document.querySelector("#contextToolIcon"),svg=host?.querySelector("svg"),path=svg?.querySelector("path"),s=path?getComputedStyle(path):null;return{exists:!!svg,color:host?getComputedStyle(host).color:null,fill:s?.fill,stroke:s?.stroke}});
 assert.equal(svgAudit.exists,true);assert.equal(svgAudit.color,"rgb(38, 61, 71)","Context Toolbar icon must use the canonical dark icon color on its light background");assert.notEqual(svgAudit.fill,"none");assert.notEqual(svgAudit.stroke,"none");assert.deepEqual(errors,[]);await desktop.close();console.log("Tablet layout smoke passed.");
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
