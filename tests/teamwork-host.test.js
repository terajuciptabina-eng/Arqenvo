import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let child, base, dataDir, adminToken, memberToken, port;
async function freePort() {
  const server=createServer();
  await new Promise((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve));
  const value=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return value;
}
async function request(route,{token,method="GET",body}={}) {
  const response=await fetch(base+route,{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
}
before(async()=>{
  port=await freePort();base="http://127.0.0.1:"+port;dataDir=fs.mkdtempSync(path.join(os.tmpdir(),"arqenvo-teamwork-"));
  child=spawn(process.execPath,["server/teamwork-host.js"],{cwd:process.cwd(),env:{...process.env,ARQENVO_TEAMWORK_HOST:"127.0.0.1",ARQENVO_TEAMWORK_PORT:String(port),ARQENVO_TEAMWORK_DATA:dataDir,ARQENVO_TEAMWORK_ADMIN_USER:"admin",ARQENVO_TEAMWORK_ADMIN_PASSWORD:"Correct-Horse-Battery-42"},stdio:["ignore","pipe","pipe"]});
  let output="";
  child.stdout.on("data",chunk=>output+=chunk.toString());child.stderr.on("data",chunk=>output+=chunk.toString());
  let ready=false;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw new Error("Teamwork host exited early: "+output);
    try{const response=await fetch(base+"/api/teamwork/health");if(response.ok){ready=true;break}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(ready,true,"Host should start and expose health endpoint");
  const login=await request("/api/teamwork/login",{method:"POST",body:{username:"admin",password:"Correct-Horse-Battery-42"}});
  assert.equal(login.status,200);adminToken=login.data.token;
});
after(async()=>{
  if(child&&!child.killed)child.kill("SIGTERM");
  if(dataDir)fs.rmSync(dataDir,{recursive:true,force:true});
});
test("host health is public but project data requires authentication",async()=>{
  const health=await request("/api/teamwork/health");assert.equal(health.status,200);assert.equal(health.data.ok,true);
  const project=await request("/api/teamwork/project");assert.equal(project.status,401);
});
test("authoritative project writes use revision checks and create backups",async()=>{
  const initial=await request("/api/teamwork/project",{token:adminToken});assert.equal(initial.status,200);assert.equal(initial.data.revision,0);assert.equal(initial.data.project,null);
  const project={format:"ARQENVO-PROJECT",version:2,project:{id:"p1",name:"Shared"},stories:[{id:"story-ground",name:"Ground Floor",elevation:0,height:3}],elements:[]};
  const first=await request("/api/teamwork/project",{token:adminToken,method:"PUT",body:{expectedRevision:0,project,changedElementIds:[]}});assert.equal(first.status,200);assert.equal(first.data.revision,1);
  const stale=await request("/api/teamwork/project",{token:adminToken,method:"PUT",body:{expectedRevision:0,project,changedElementIds:[]}});assert.equal(stale.status,409);assert.equal(stale.data.revision,1);
  const changed={...project,project:{...project.project,name:"Shared updated"}};
  const second=await request("/api/teamwork/project",{token:adminToken,method:"PUT",body:{expectedRevision:1,project:changed,changedElementIds:[]}});assert.equal(second.status,200);assert.equal(second.data.revision,2);
  const backups=fs.readdirSync(path.join(dataDir,"backups")).filter(name=>name.endsWith(".json"));assert.equal(backups.length,1);
});
test("reservation prevents another team member from taking the same element",async()=>{
  const created=await request("/api/teamwork/members",{token:adminToken,method:"POST",body:{username:"editor1",password:"Editor-Password-1234",role:"member"}});
  assert.equal(created.status,201);
  const login=await request("/api/teamwork/login",{method:"POST",body:{username:"editor1",password:"Editor-Password-1234"}});assert.equal(login.status,200);memberToken=login.data.token;
  const reserved=await request("/api/teamwork/reserve",{token:adminToken,method:"POST",body:{elementIds:["wall-1"]}});assert.equal(reserved.status,200);
  const conflict=await request("/api/teamwork/reserve",{token:memberToken,method:"POST",body:{elementIds:["wall-1"]}});assert.equal(conflict.status,423);assert.equal(conflict.data.reservedBy,"admin");
  const write=await request("/api/teamwork/project",{token:memberToken,method:"PUT",body:{expectedRevision:2,project:{format:"ARQENVO-PROJECT",version:2,project:{id:"p1"},stories:[{id:"s1",name:"Ground",elevation:0,height:3}],elements:[{id:"wall-1",type:"wall"}]},changedElementIds:["wall-1"]}});
  assert.equal(write.status,423);
});

test("viewer accounts cannot publish changes",async()=>{
  const created=await request("/api/teamwork/members",{token:adminToken,method:"POST",body:{username:"viewer1",password:"Viewer-Password-1234",role:"viewer"}});
  assert.equal(created.status,201);
  const login=await request("/api/teamwork/login",{method:"POST",body:{username:"viewer1",password:"Viewer-Password-1234"}});
  assert.equal(login.status,200);
  const denied=await request("/api/teamwork/project",{token:login.data.token,method:"PUT",body:{expectedRevision:2,project:{format:"ARQENVO-PROJECT",version:2,project:{id:"p1"},stories:[{id:"s1",name:"Ground",elevation:0,height:3}],elements:[]},changedElementIds:[]}});
  assert.equal(denied.status,403);
});
