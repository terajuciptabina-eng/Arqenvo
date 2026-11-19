const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("arqenvoUpdater",{
 check:()=>ipcRenderer.invoke("arqenvo:check-updates"),
 onStatus:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on("arqenvo:update-status",listener);return()=>ipcRenderer.removeListener("arqenvo:update-status",listener);}
});
