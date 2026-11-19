const {app,BrowserWindow,dialog,shell,clipboard}=require("electron");
const {spawn}=require("node:child_process");
const crypto=require("node:crypto");
const fs=require("node:fs");
const net=require("node:net");
const path=require("node:path");
const PORT=8080, SERVICE="ARQENVO Local Teamwork";
let child=null, port=PORT, stopping=false, ready=false, firstRunPassword="", hostLog="";

function root(){return app.isPackaged?path.join(process.resourcesPath,"arqenvo-app"):path.resolve(__dirname,"../..");}
function dataDir(){return path.join(app.getPath("home"),".arqenvo","teamwork");}
async function health(p){try{const r=await fetch("http://127.0.0.1:"+p+"/api/teamwork/health",{signal:AbortSignal.timeout(800),cache:"no-store"});if(!r.ok)return null;const d=await r.json();return d.service===SERVICE?d:null;}catch{return null;}}
function free(p){return new Promise(resolve=>{const s=net.createServer();s.once("error",()=>resolve(false));s.listen(p,"0.0.0.0",()=>s.close(()=>resolve(true)));});}
function ephemeral(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once("error",reject);s.listen(0,"0.0.0.0",()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
function startProcess(){
 const env={...process.env,ELECTRON_RUN_AS_NODE:"1",ELECTRON_NO_ATTACH_CONSOLE:"1",ARQENVO_TEAMWORK_HOST:"0.0.0.0",ARQENVO_TEAMWORK_PORT:String(port),ARQENVO_TEAMWORK_DATA:dataDir()};
 if(firstRunPassword){env.ARQENVO_TEAMWORK_ADMIN_USER="admin";env.ARQENVO_TEAMWORK_ADMIN_PASSWORD=firstRunPassword;}
 child=spawn(process.execPath,[path.join(root(),"server","teamwork-host.js")],{cwd:root(),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
 const capture=stream=>stream.on("data",chunk=>{hostLog=(hostLog+chunk.toString()).slice(-5000);});
 capture(child.stdout);capture(child.stderr);
 child.on("error",e=>{if(!stopping)fail(e);});
 child.on("exit",code=>{child=null;if(stopping)return;if(code===75){setTimeout(startProcess,400);return;}if(ready)fail(new Error("Teamwork Host stopped unexpectedly (exit "+code+")."));});
}
async function waitReady(){
 for(let i=0;i<80;i++){if(!child)throw new Error("Teamwork Host exited before starting.");const h=await health(port);if(h){ready=true;return;}await new Promise(r=>setTimeout(r,250));}
 throw new Error("Teamwork Host did not start within 20 seconds. Check firewall permissions.\n\n"+hostLog.slice(-2500));
}
function fail(e){dialog.showErrorBox("ARQENVO Teamwork Host",e.message||String(e));app.quit();}
async function showFirstRunPassword(){
 if(!firstRunPassword)return;
 clipboard.writeText(firstRunPassword);
 const info=await health(port);
 const addresses=(info?.lanAddresses||[]).map(ip=>"http://"+ip+":"+port);
 const addressText=addresses.length?addresses.join("\n"):"No LAN address detected yet. Open the Teamwork panel to check again.";
 const detail="HOST ADMIN LOGIN\nUsername: admin\nPassword: "+firstRunPassword+"\n\nHOST ADDRESS — share with team members\n"+addressText+"\n\nSAVE THESE DETAILS NOW. The password is shown only once and copied to your clipboard.\n\nIF YOU FORGET THE PASSWORD\nOn this Host computer, open ARQENVO > Teamwork > Forgot Host Admin password? Set a new password there. No reinstall or data deletion is required. Projects and team accounts are preserved.";
 await dialog.showMessageBox({type:"info",title:"ARQENVO Teamwork Host — First-time setup",message:"Your Host administrator account is ready.",detail,buttons:["Continue"],defaultId:0});
 firstRunPassword="";
}
function openApp(){
 const origin="http://127.0.0.1:"+port;
 const win=new BrowserWindow({width:1480,height:940,minWidth:980,minHeight:680,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 win.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith("https://"))shell.openExternal(url);return{action:"deny"};});
 win.webContents.on("will-navigate",(event,url)=>{if(!url.startsWith(origin))event.preventDefault();});
 win.once("ready-to-show",()=>win.show());
 win.loadURL(origin).catch(fail);
}
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();
else{
 app.on("second-instance",()=>{const w=BrowserWindow.getAllWindows()[0];if(w){if(w.isMinimized())w.restore();w.focus();}});
 app.on("before-quit",()=>{stopping=true;if(child&&!child.killed)child.kill();});
 app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit();});
 app.on("activate",()=>{if(BrowserWindow.getAllWindows().length===0&&ready)openApp();});
 app.whenReady().then(async()=>{
  try{
   const existing=await health(PORT);
   if(existing){port=PORT;ready=true;}
   else{
    if(!fs.existsSync(path.join(dataDir(),"users.json")))firstRunPassword=crypto.randomBytes(24).toString("base64url");
    port=await free(PORT)?PORT:await ephemeral();
    startProcess();
    await waitReady();
    await showFirstRunPassword();
   }
   openApp();
  }catch(e){fail(e);}
 });
}
