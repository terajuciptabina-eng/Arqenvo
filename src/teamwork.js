/* Optional Local Teamwork client. Connect by opening the host PC's LAN URL in this browser. */
(() => {
  const state = { token:"", user:null, revision:0, syncedProject:null, dirty:false, syncing:false, timer:0, polling:0, reservations:{} };
  const api = async (route, options={}) => {
    const response = await fetch("/api/teamwork/"+route, {...options, headers:{"content-type":"application/json",...(state.token?{authorization:"Bearer "+state.token}:{}),...(options.headers||{})},cache:"no-store"});
    const data = await response.json().catch(()=>({error:"Host returned an unreadable response"}));
    if(!response.ok)throw Object.assign(new Error(data.error||("HTTP "+response.status)),{status:response.status,data});
    return data;
  };
  const el=(tag,attrs={},text="")=>{const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs)){if(key==="class")node.className=value;else if(["id","type","placeholder","autocomplete","title","href","download"].includes(key))node.setAttribute(key,value);else if(key==="hidden")node.hidden=value;}if(text)node.textContent=text;return node;};
  const style=el("style");
  style.textContent="#arqenvoTeamworkToggle{position:fixed;right:14px;bottom:14px;z-index:1400;border:1px solid #087e8b;background:#087e8b;color:#fff;border-radius:7px;padding:10px 14px;font:600 13px/1.2 Inter,Arial,sans-serif;box-shadow:0 3px 12px #0002}"+
  "#arqenvoTeamworkPanel{position:fixed;right:14px;bottom:62px;z-index:1401;width:min(360px,calc(100vw - 20px));max-height:min(76dvh,620px);overflow:auto;background:#f8fafb;color:#26313b;border:1px solid #bcc6ce;border-radius:10px;box-shadow:0 12px 36px #0003;padding:14px;font:13px/1.4 Inter,Arial,sans-serif}"+
  "#arqenvoTeamworkPanel[hidden]{display:none}#arqenvoTeamworkPanel h3{font-size:15px;margin:0 0 5px}#arqenvoTeamworkPanel p{margin:5px 0 10px;color:#596773}#arqenvoTeamworkPanel .tw-row{display:flex;gap:7px;margin:8px 0}#arqenvoTeamworkPanel .tw-row>*{min-width:0;flex:1}#arqenvoTeamworkPanel input,#arqenvoTeamworkPanel select{width:100%;min-height:34px;border:1px solid #b8c2cb;border-radius:5px;padding:7px;background:#fff;color:#26313b}#arqenvoTeamworkPanel button{min-height:34px;border:1px solid #b8c2cb;border-radius:5px;padding:7px 9px;background:#fff;color:#26313b;font:inherit}#arqenvoTeamworkPanel button:disabled{opacity:.45}#arqenvoTeamworkPanel .tw-primary{background:#087e8b;color:white;border-color:#087e8b}#arqenvoTeamworkStatus{padding:9px;border-radius:6px;background:#edf1f4;color:#34424e;white-space:pre-wrap;overflow-wrap:anywhere}#arqenvoTeamworkStatus[data-kind=error]{background:#fff0ee;color:#9b2d22}#arqenvoTeamworkStatus[data-kind=ok]{background:#e7f5ee;color:#17633c}#arqenvoTeamworkPanel .tw-small{font-size:11px;color:#687580}#arqenvoTeamworkPanel .tw-sep{border:0;border-top:1px solid #d8dee3;margin:12px 0}@media(max-width:600px){#arqenvoTeamworkToggle{right:8px;bottom:8px}#arqenvoTeamworkPanel{right:8px;bottom:54px}}";
  document.head.append(style);
  const toggle=el("button",{id:"arqenvoTeamworkToggle",type:"button"},"Teamwork");
  const panel=el("section",{id:"arqenvoTeamworkPanel",hidden:true});
  const title=el("h3",{},"Arqenvo Local Teamwork");
  const intro=el("p",{},"Host project files stay on this PC/Mac. Team members must open this host's LAN address, not the GitHub Pages URL.");
  const status=el("div",{id:"arqenvoTeamworkStatus","data-kind":"info"},"Checking whether this browser is connected to a local Teamwork host…");
  const loginBox=el("div"),user=el("input",{type:"text",placeholder:"Username",autocomplete:"username"}),pass=el("input",{type:"password",placeholder:"Password",autocomplete:"current-password"}),login=el("button",{type:"button",class:"tw-primary"},"Sign in");
  const loginRow=el("div",{class:"tw-row"});loginRow.append(login);
  const authControls=el("div");authControls.hidden=true;
  const who=el("p"),load=el("button",{type:"button"},"Receive host project"),publish=el("button",{type:"button",class:"tw-primary"},"Create shared project from this model"),send=el("button",{type:"button",class:"tw-primary"},"Send changes"),download=el("button",{type:"button"},"Download local copy"),reserve=el("button",{type:"button"},"Reserve selected"),release=el("button",{type:"button"},"Release selected"),logout=el("button",{type:"button"},"Sign out");
  const row1=el("div",{class:"tw-row"});row1.append(load,publish);const row2=el("div",{class:"tw-row"});row2.append(send,download);const row3=el("div",{class:"tw-row"});row3.append(reserve,release);const row4=el("div",{class:"tw-row"});row4.append(logout);
  const memberBox=el("div");memberBox.hidden=true;const memberHeading=el("p",{},"Host admin: add team members"),memberName=el("input",{type:"text",placeholder:"New username",autocomplete:"off"}),memberPassword=el("input",{type:"password",placeholder:"Temporary password (12+ characters)",autocomplete:"new-password"}),memberRole=el("select");
  for(const [v,label] of [["member","Architect / Editor"],["viewer","Viewer"],["admin","Admin"]]){const option=el("option",{},label);option.value=v;memberRole.append(option)}
  const addMember=el("button",{type:"button"},"Add member");const memberRow1=el("div",{class:"tw-row"});memberRow1.append(memberName,memberRole);const memberRow2=el("div",{class:"tw-row"});memberRow2.append(memberPassword,addMember);
  memberBox.append(el("hr",{class:"tw-sep"}),memberHeading,memberRow1,memberRow2);
  panel.append(title,intro,status,loginBox,authControls);loginBox.append(user,pass,loginRow);
  authControls.append(who,row1,row2,row3,memberBox,row4,el("hr",{class:"tw-sep"}),el("div",{class:"tw-small"},"Reservation leases expire after 90 seconds without a heartbeat. Project writes use revision checks; conflicting changes are not silently overwritten."));
  document.body.append(toggle,panel);
  const showStatus=(message,kind="info")=>{status.textContent=message;status.dataset.kind=kind;};
  const model=()=>window.arqenvoTeamworkAdapter?.getProject?.();
  const applyRemote=project=>{if(!project)throw new Error("The host does not have a shared project yet.");window.arqenvoTeamworkAdapter.applyProject(project);state.syncedProject=structuredClone(project);state.dirty=false;};
  const changedIds=(before,after)=>{const a=new Map((before?.elements||[]).map(item=>[item.id,item])),b=new Map((after?.elements||[]).map(item=>[item.id,item]));return [...new Set([...a.keys(),...b.keys()])].filter(id=>JSON.stringify(a.get(id))!==JSON.stringify(b.get(id)));};
  async function refresh(){
    if(!state.token||state.syncing)return;
    state.syncing=true;
    try{
      const data=await api("project");state.reservations=data.reservations||{};
      if(data.revision!==state.revision){
        if(!data.project){state.revision=data.revision;showStatus("Signed in. No shared project exists yet. Create one from the current model.","ok");}
        else if(!state.syncedProject||!state.dirty){applyRemote(data.project);state.revision=data.revision;showStatus("Connected · revision "+state.revision+" · host changes received.","ok");}
        else showStatus("Conflict detected: host is now revision "+data.revision+" while this browser has unsent edits. Local model is preserved. Download it or use Receive host project after reviewing.","error");
      }else if(state.syncedProject)showStatus("Connected · revision "+state.revision+" · "+Object.keys(state.reservations).length+" reserved element(s).","ok");
    }catch(error){showStatus("Teamwork sync failed: "+error.message,"error");}finally{state.syncing=false;}
  }
  async function sendProject(){
    if(!state.token)return showStatus("Sign in to the host first.","error");
    if(state.syncing)return;
    const project=model();if(!project)return showStatus("Arqenvo model adapter is unavailable. Reload the host URL.","error");
    state.syncing=true;
    try{
      const data=await api("project",{method:"PUT",body:JSON.stringify({expectedRevision:state.revision,project,changedElementIds:changedIds(state.syncedProject,project)})});
      state.revision=data.revision;state.syncedProject=structuredClone(project);state.dirty=false;showStatus("Changes saved to host · revision "+state.revision+".","ok");
    }catch(error){
      if(error.status===409){showStatus("Revision conflict: host advanced to revision "+error.data.revision+". Local changes remain here and were not uploaded. Sending again is blocked until you explicitly resolve the conflict by receiving the host project or saving a local copy.","error");}
      else showStatus("Could not send changes: "+error.message,"error");
    }finally{state.syncing=false;}
  }
  function startPolling(){clearInterval(state.polling);state.polling=setInterval(()=>{if(state.token){api("reservation-heartbeat",{method:"POST",body:"{}"}).catch(()=>{});refresh();}},3000);}
  function renderAuth(){const signed=!!state.token;loginBox.hidden=signed;authControls.hidden=!signed;if(signed){who.textContent="Signed in as "+state.user.username+" ("+state.user.role+")";memberBox.hidden=state.user.role!=="admin";}else{who.textContent="";memberBox.hidden=true;}publish.disabled=send.disabled=load.disabled=!signed;}
  async function signIn(){
    try{
      const result=await api("login",{method:"POST",body:JSON.stringify({username:user.value.trim(),password:pass.value})});
      state.token=result.token;state.user=result.user;pass.value="";state.revision=0;state.syncedProject=null;state.dirty=false;renderAuth();
      const data=await api("project");state.revision=data.revision;state.reservations=data.reservations||{};
      if(data.project){applyRemote(data.project);showStatus("Connected · loaded host project revision "+state.revision+".","ok");}
      else showStatus("Signed in. No shared project exists yet. Click “Create shared project from this model”.","ok");
      startPolling();
    }catch(error){showStatus("Sign in failed: "+error.message+" If this page is on GitHub Pages, open the host PC's http://LAN-IP:8080 address instead.","error");}
  }
  login.addEventListener("click",signIn);pass.addEventListener("keydown",event=>{if(event.key==="Enter")signIn()});toggle.addEventListener("click",()=>{panel.hidden=!panel.hidden;});
  load.addEventListener("click",async()=>{if(state.dirty&&!confirm("Discard this browser's unsent edits and replace them with the host project? Download a local copy first if needed."))return;try{const data=await api("project");if(!data.project)return showStatus("No shared project exists on host yet.","error");applyRemote(data.project);state.revision=data.revision;state.reservations=data.reservations||{};showStatus("Host project received · revision "+state.revision+".","ok");}catch(error){showStatus("Receive failed: "+error.message,"error");}});
  publish.addEventListener("click",async()=>{if(state.revision!==0||state.syncedProject)return showStatus("The host already has a project. Use Receive host project or Send changes.","error");if(!confirm("Create the host's shared project from the model currently open in this browser? This becomes the authoritative project for the team."))return;await sendProject();});
  send.addEventListener("click",sendProject);
  download.addEventListener("click",()=>{try{const project=model();if(!project)throw new Error("Arqenvo model adapter is unavailable");const blob=new Blob([JSON.stringify(project,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const link=el("a",{href:url,download:(project.project?.name||"arqenvo-project").replace(/[^a-z0-9_-]+/gi,"-")+".arq"});link.style.display="none";document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);showStatus("Local project copy downloaded. Keep it safe before resolving a sync conflict.","ok");}catch(error){showStatus("Could not download local copy: "+error.message,"error");}});
  reserve.addEventListener("click",async()=>{try{const ids=window.arqenvoTeamworkAdapter?.getSelectedElementIds?.()||[];if(!ids.length)return showStatus("Select one or more elements in the drawing first.","error");const data=await api("reserve",{method:"POST",body:JSON.stringify({elementIds:ids})});state.reservations=data.reservations;showStatus("Reserved "+ids.length+" selected element(s).","ok");}catch(error){showStatus("Reservation failed: "+error.message,"error");}});
  release.addEventListener("click",async()=>{try{const ids=window.arqenvoTeamworkAdapter?.getSelectedElementIds?.()||[];if(!ids.length)return showStatus("Select one or more elements first.","error");const data=await api("release",{method:"POST",body:JSON.stringify({elementIds:ids})});state.reservations=data.reservations;showStatus("Released selected element reservations.","ok");}catch(error){showStatus("Release failed: "+error.message,"error");}});
  addMember.addEventListener("click",async()=>{try{const result=await api("members",{method:"POST",body:JSON.stringify({username:memberName.value.trim(),password:memberPassword.value,role:memberRole.value})});memberPassword.value="";showStatus("Created member "+result.user.username+" ("+result.user.role+"). Share credentials securely.","ok");}catch(error){showStatus("Could not add member: "+error.message,"error");}});
  logout.addEventListener("click",async()=>{try{await api("logout",{method:"POST",body:"{}"});}catch{}clearInterval(state.polling);state.token="";state.user=null;state.syncedProject=null;state.dirty=false;renderAuth();showStatus("Signed out. Local autosave remains on this browser.");});
  window.arqenvoTeamwork={markDirty(){if(!state.token||!state.syncedProject)return;state.dirty=true;clearTimeout(state.timer);state.timer=setTimeout(()=>{if(state.dirty)sendProject();},1400);}};
  renderAuth();
  api("health").then(data=>showStatus("Local host detected · "+data.host+" · revision "+data.projectRevision+". Sign in to connect.","ok")).catch(()=>showStatus("No Local Teamwork host detected at this address. Run the host service and open its LAN URL on this device.","info"));
})();
