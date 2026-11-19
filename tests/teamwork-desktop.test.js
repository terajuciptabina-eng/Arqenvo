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

test("first-run setup shows admin credentials, LAN address, and local password recovery steps",()=>{
 assert.match(main,/First-time setup/);
 assert.match(main,/Username: admin/);
 assert.match(main,/Password: \"\+firstRunPassword/);
 assert.match(main,/HOST ADDRESS — share with team members/);
 assert.match(main,/Forgot Host Admin password\?/);
 assert.match(main,/No reinstall or data deletion is required/);
 assert.match(main,/clipboard\.writeText\(firstRunPassword\)/);
});

test("macOS Host declares local-network access and uses a stable app signature",()=>{
 assert.equal(config.version,"1.0.2");
 assert.equal(config.build.mac.identity,"-","macOS app must be ad-hoc signed for a stable app identity");
 assert.match(config.build.mac.extendInfo.NSLocalNetworkUsageDescription,/local network/i);
});

test("Teamwork server listens on all network interfaces for LAN clients",()=>{
 const server=fs.readFileSync(path.join(root,"server","teamwork-host.js"),"utf8");
 assert.match(server,/process\.env\.ARQENVO_TEAMWORK_HOST\s*\|\|\s*"0\.0\.0\.0"/);
 assert.match(server,/server\.listen\(PORT,\s*HOST/);
 assert.match(main,/ARQENVO_TEAMWORK_HOST:"0\.0\.0\.0"/);
});

test("desktop Host packages and exposes the in-app updater",()=>{
 assert.ok(config.dependencies?.["electron-updater"],"electron-updater must be a runtime dependency");
 assert.ok(config.build.files.includes("preload.cjs"),"secure updater preload must be packaged");
 assert.equal(config.build.publish[0].provider,"github");
 assert.equal(config.build.publish[0].owner,"terajuciptabina-eng");
 assert.equal(config.build.publish[0].repo,"Arqenvo");
 assert.ok(config.build.mac.target.includes("zip"),"macOS updater requires a ZIP update artifact");
 assert.match(main,/autoUpdater\.checkForUpdates/);
 assert.match(main,/autoUpdater\.quitAndInstall/);
 assert.match(main,/arqenvo:check-updates/);
 assert.match(main,/preload\.cjs/);
});
