import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png" };
const server = createServer(async (req,res)=>{
  try {
    const pathname=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);
    const requested=pathname==="/"?"/index.html":pathname;
    const file=path.resolve(root,"."+requested);
    if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end("Forbidden");return}
    res.writeHead(200,{"content-type":mime[path.extname(file)]||"application/octet-stream"});
    res.end(await readFile(file));
  } catch {res.writeHead(404).end("Not found")}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address();
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];
 page.on("pageerror",error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:"domcontentloaded"});
 await page.waitForFunction(()=>{const c=document.querySelector("#canvas");return c&&c.clientWidth>100&&c.clientHeight>100});
 await page.locator('[data-tool="text"]').click();
 await page.waitForFunction(()=>document.querySelector("[data-tool].active")?.dataset.tool==="text");
 const canvas=page.locator("#canvas"), rect=await canvas.boundingBox();
 assert.ok(rect,"Canvas must be visible");
 const start={x:rect.x+rect.width*.36,y:rect.y+rect.height*.38};
 const end={x:start.x+150,y:start.y+60};
 await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:6});await page.mouse.up();
 await page.waitForFunction(()=>!!document.querySelector("#arqInlineTextEditor"),null,{timeout:3000}).catch(async error=>{
  const diag=await page.evaluate(()=>({status:document.querySelector("#status")?.textContent,gesture:window.__arqenvoTextGestureDebug,last:window.__arqenvoLastTextDiagnostic,adapter:!!window.arqenvoTeamworkAdapter,active:document.querySelector("[data-tool].active")?.dataset.tool}));
  throw new Error("Text Tool did not open editor: "+JSON.stringify(diag)+"; "+error.message);
 });
 assert.equal(await page.locator("#arqInlineTextEditor").count(),1);
 const live=await page.evaluate(()=>({adapter:!!window.arqenvoTeamworkAdapter,textCount:window.arqenvoTeamworkAdapter?.getProject?.().elements?.filter(e=>e.type==="text").length,editor:!!document.querySelector("#arqInlineTextEditor"),diagnostic:window.__arqenvoLastTextDiagnostic}));
 assert.equal(live.adapter,true,"Teamwork model adapter must be present");
 assert.equal(live.textCount,1,"One text element must be present in the live project");
 assert.equal(live.editor,true,"Inline text editor must be open");
 await page.locator("#arqInlineTextValue").fill("Arqenvo Teamwork Text Smoke");
 await page.locator("#arqInlineTextEditor button").filter({hasText:"Finish"}).click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem("arqenvo.autosave.v2")||"{}").elements?.some(e=>e.type==="text"&&e.text==="Arqenvo Teamwork Text Smoke"));
 assert.deepEqual(errors,[],"No browser runtime errors expected");
 console.log("Teamwork Text Tool smoke passed: toolbar activation, drag/release, exactly one model element, inline editor, save.");
} finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
