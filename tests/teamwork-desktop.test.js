import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const config=JSON.parse(fs.readFileSync(path.join(root,"desktop/teamwork-host/package.json"),"utf8"));
const main=fs.readFileSync(path.join(root,"desktop/teamwork-host/main.cjs"),"utf8");

test("desktop Host packages the existing ARQENVO client and Teamwork server",()=>{
 for(const [from,to] of [
  ["../../server","arqenvo-app/server"],
  ["../../src","arqenvo-app/src"],
  ["../../assets","arqenvo-app/assets"],
  ["../../index.html","arqenvo-app/index.html"],
  ["../../manifest.webmanifest","arqenvo-app/manifest.webmanifest"],
  ["../../package.json","arqenvo-app/package.json"]
 ]) assert.ok(config.build.extraResources.some(item=>item.from===from&&item.to===to),`Missing packaged resource: ${from}`);
 assert.equal(config.build.asar,false);
 assert.equal(config.build.electronFuses.runAsNode,true);
});

test("desktop Host starts the bundled server without a terminal",()=>{
 assert.match(main,/ELECTRON_RUN_AS_NODE:\s*"1"/);
 assert.match(main,/windowsHide:true/);
 assert.match(main,/stdio:\["ignore","pipe","pipe"\]/);
 assert.match(main,/ARQENVO_TEAMWORK_DATA/);
 assert.match(main,/process\.resourcesPath/);
 assert.match(main,/contextIsolation:true/);
 assert.match(main,/nodeIntegration:false/);
 assert.match(main,/sandbox:true/);
});
