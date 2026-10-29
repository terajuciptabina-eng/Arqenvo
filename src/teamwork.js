/* Optional Local Teamwork client. Connect by opening the host PC's LAN URL in this browser. */
(() => {
  const state = { token:"", user:null, revision:0, syncedProject:null, dirty:false, conflictRevision:null, syncing:false, timer:0, polling:0, reservations:{} };
  const api = async (route, options={}) => {
    const response = await fetch("/api/teamwork/"+route, {...options, headers:{"content-type":"application/json",...(state.token?{authorization:"Bearer "+state.token}:{}),...(options.headers||{})},cache:"no-store"});
    const data = await response.json().catch(()=>({error:"Host returned an unreadable response"}));
    if(!response.ok)throw Object.assign(new Error(data.error||("HTTP "+response.status)),{status:response.status,data});
    return data;
  };
  const el=(tag,attrs={},text="")=>{const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs)){if(key==="class")node.className=value;else if(["id","type","placeholder","autocomplete","title","href","download"].includes(key))node.setAttribute(key,value);else if(key==="hidden")node.hidden=value;}if(text)node.textContent=text;return node;};
  const style=el("style");
  style.textContent="#arqenvoTeamworkPanel{box-sizing:border-box;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto;background:#f4f5f6;color:#26313b;border:1px solid #c5cbd1;padding:0;font:12px/1.4 Inter,\"Segoe UI\",Arial,sans-serif}#arqenvoTeamworkPanel[hidden]{display:none}#arqenvoTeamworkPanel.tw-floating{position:absolute;right:14px;top:10px;z-index:1401;width:min(360px,calc(100% - 20px));max-height:calc(100% - 20px);border-radius:5px;box-shadow:0 8px 28px #15233135}#arqenvoTeamworkTitlebar{display:flex;align-items:center;gap:5px;flex:0 0 auto;margin:0;padding:7px 8px;background:#edf0f2;border-bottom:1px solid #cbd2d8;cursor:grab;touch-action:none;user-select:none;color:#596671;font-size:10px;font-weight:700;letter-spacing:.1em}#arqenvoTeamworkTitlebar h3{flex:1;margin:0!important;color:#596671;font-size:10px!important;font-weight:700;letter-spacing:.1em;text-transform:uppercase}#arqenvoTeamworkTitlebar button{min-height:27px;padding:3px 6px;border:1px solid #c3c9ce;border-radius:3px;background:linear-gradient(#fff,#f1f3f5);color:#36414a;font-size:11px;white-space:nowrap}#arqenvoTeamworkPanel .tw-content{padding:10px;overflow:auto;min-height:0}#arqenvoTeamworkPanel p{margin:5px 0 10px;color:#596773}#arqenvoTeamworkPanel .tw-row{display:flex;gap:7px;margin:8px 0}#arqenvoTeamworkPanel .tw-row>*{min-width:0;flex:1}#arqenvoTeamworkPanel input,#arqenvoTeamworkPanel select{width:100%;min-height:34px;border:1px solid #b8c2cb;border-radius:3px;padding:7px;background:#fff;color:#26313b}#arqenvoTeamworkPanel button{min-height:32px;border:1px solid #bcc3ca;border-radius:3px;padding:6px 8px;background:#f9fafb;color:#26313b;font:inherit}#arqenvoTeamworkPanel button:hover{border-color:#72aeb3;background:#e1f0f1}#arqenvoTeamworkPanel button:disabled{opacity:.45}#arqenvoTeamworkPanel .tw-primary{background:#087e8b;color:white;border-color:#087e8b}#arqenvoTeamworkStatus{padding:9px;border-radius:4px;background:#edf1f4;color:#34424e;white-space:pre-wrap;overflow-wrap:anywhere}#arqenvoTeamworkStatus[data-kind=error]{background:#fff0ee;color:#9b2d22}#arqenvoTeamworkStatus[data-kind=ok]{background:#e7f5ee;color:#17633c}#arqenvoTeamworkPanel .tw-small{font-size:11px;color:#687580}#arqenvoTeamworkPanel .tw-sep{border:0;border-top:1px solid #d8dee3;margin:12px 0}@media(max-width:600px){#arqenvoTeamworkPanel.tw-floating{max-width:calc(100% - 8px)}}";
  document.head.append(style);
  const panel=el("section",{id:"arqenvoTeamworkPanel",hidden:true});
  const title=el("h3",{},"Teamwork");const titlebar=el("div",{id:"arqenvoTeamworkTitlebar"});const dockLeft=el("button",{type:"button",title:"Dock palette left"},"◧←"),dockRight=el("button",{type:"button",title:"Dock palette right"},"→◨"),floatPanel=el("button",{type:"button",title:"Float palette"},"↗");titlebar.append(title,dockLeft,dockRight,floatPanel);
  const intro=el("p",{},"Host project files stay on this PC/Mac. Team members must open this host's LAN address, not the GitHub Pages URL.");
  const status=el("div",{id:"arqenvoTeamworkStatus","data-kind":"info"},"Checking whether this browser is connected to a local Teamwork host…");
  const loginBox=el("div"),user=el("input",{type:"text",placeholder:"Username",autocomplete:"username"}),pass=el("input",{type:"password",placeholder:"Password",autocomplete:"current-password"}),login=el("button",{type:"button",class:"tw-primary"},"Sign in");
  const loginRow=el("div",{class:"tw-row"});loginRow.append(login);
  const authControls=el("div");authControls.hidden=true;
  const who=el("p"),load=el("button",{type:"button"},"Receive host project"),publish=el("button",{type:"button",class:"tw-primary"},"Create shared project from this model"),send=el("button",{type:"button",class:"tw-primary"},"Send changes"),download=el("button",{type:"button"},"Download local copy"),reserve=el("button",{type:"button"},"Reserve selected"),release=el("button",{type:"button"},"Release selected"),restart=el("button",{type:"button"},"Restart host"),logout=el("button",{type:"button"},"Sign out");
  const row1=el("div",{class:"tw-row"});row1.append(load,publish);const row2=el("div",{class:"tw-row"});row2.append(send,download);const row3=el("div",{class:"tw-row"});row3.append(reserve,release);const row4=el("div",{class:"tw-row"});row4.append(restart,logout);
  const memberBox=el("div");memberBox.hidden=true;const memberHeading=el("p",{},"Host admin: add team members"),memberName=el("input",{type:"text",placeholder:"Username (1-40 characters)",autocomplete:"off"}),memberPassword=el("input",{type:"password",placeholder:"Temporary password (4+ characters)",autocomplete:"new-password"}),memberRole=el("select"),memberListButton=el("button",{type:"button"},"View registered members"),memberList=el("div",{class:"tw-small"});memberList.hidden=true;
  for(const [v,label] of [["member","Architect / Editor"],["viewer","Viewer"],["admin","Admin"]]){const option=el("option",{},label);option.value=v;memberRole.append(option)}
  const addMember=el("button",{type:"button"},"Add member");const memberRow1=el("div",{class:"tw-row"});memberRow1.append(memberName,memberRole);const memberRow2=el("div",{class:"tw-row"});memberRow2.append(memberPassword,addMember);
  memberBox.append(el("hr",{class:"tw-sep"}),memberHeading,memberRow1,memberRow2,memberListButton,memberList);
  const panelContent=el("div",{class:"tw-content"});panelContent.append(intro,status,loginBox,authControls);panel.append(titlebar,panelContent);loginBox.append(user,pass,loginRow);
  let panelMode="float",dragStart=null;
  const work=document.querySelector(".work"),toolbox=document.getElementById("toolbox"),nav=work?.querySelector(":scope > .navigator"),workspace=work?.querySelector(":scope > .workspace"),inspector=work?.querySelector(":scope > .inspector");
  const clearGridOverrides=()=>{work?.classList.remove("teamwork-docked");work?.style.removeProperty("grid-template-columns");[panel,toolbox,nav,workspace,inspector].forEach(node=>{node?.style.removeProperty("grid-column");node?.style.removeProperty("grid-row")});};
  const applyPanelMode=mode=>{
    panelMode=mode;
    panel.classList.remove("tw-docked-left","tw-docked-right","tw-floating");
    clearGridOverrides();
    if(mode==="left"||mode==="right"){
      if(!work||!toolbox||!workspace||!nav){mode="float";panelMode="float";}
      else{
        panel.classList.add("tw-docked-"+mode);
        panel.style.position="relative";panel.style.left="";panel.style.right="";panel.style.top="";panel.style.bottom="";
        panel.style.width="auto";panel.style.maxHeight="none";panel.style.alignSelf="stretch";panel.style.display="flex";
        const toolW=Math.round(toolbox.getBoundingClientRect().width)||142;
        const navVisible=getComputedStyle(nav).display!=="none";
        const navW=navVisible?(Math.round(nav.getBoundingClientRect().width)||218):0;
        const inspectorVisible=inspector&&getComputedStyle(inspector).display!=="none";
        const insW=inspectorVisible?(Math.round(inspector.getBoundingClientRect().width)||238):0;
        const twW=280;
        const cols=mode==="left"
          ?[toolW+"px",twW+"px","minmax(0,1fr)",...(navVisible?[navW+"px"]:[]),...(insW?[insW+"px"]:[])]
          :[toolW+"px","minmax(0,1fr)",twW+"px",...(navVisible?[navW+"px"]:[]),...(insW?[insW+"px"]:[])];
        work.classList.add("teamwork-docked");
        work.style.setProperty("grid-template-columns",cols.join(" "),"important");
        toolbox.style.setProperty("grid-column","1","important");toolbox.style.setProperty("grid-row","1","important");
        workspace.style.setProperty("grid-column",mode==="left"?"3":"2","important");workspace.style.setProperty("grid-row","1","important");
        panel.style.setProperty("grid-column",mode==="left"?"2":"3","important");panel.style.setProperty("grid-row","1","important");
        let col=4;
        if(navVisible){nav.style.setProperty("grid-column",String(col++),"important");nav.style.setProperty("grid-row","1","important")}
        if(insW){inspector.style.setProperty("grid-column",String(col),"important");inspector.style.setProperty("grid-row","1","important")}
      }
    }
    if(mode==="float"){
      panel.classList.add("tw-floating");
      panel.style.position="absolute";panel.style.left="auto";panel.style.right="14px";panel.style.top="10px";panel.style.bottom="auto";
      panel.style.width="min(360px,calc(100% - 20px))";panel.style.maxHeight="calc(100% - 20px)";panel.style.display="flex";
    }
    try{localStorage.setItem("arqenvo-teamwork-palette-mode",mode)}catch{}
  };
  try{const saved=localStorage.getItem("arqenvo-teamwork-palette-mode");applyPanelMode(saved==="left"||saved==="right"?saved:"float")}catch{applyPanelMode("float")}
  dockLeft.addEventListener("click",()=>applyPanelMode("left"));
  dockRight.addEventListener("click",()=>applyPanelMode("right"));
  floatPanel.addEventListener("click",()=>applyPanelMode("float"));
  titlebar.addEventListener("pointerdown",event=>{if(event.target.closest("button")||panelMode!=="float")return;dragStart={x:event.clientX,y:event.clientY,left:panel.getBoundingClientRect().left,top:panel.getBoundingClientRect().top};titlebar.setPointerCapture?.(event.pointerId)});
  titlebar.addEventListener("pointermove",event=>{if(!dragStart||panelMode!=="float")return;panel.style.left=Math.max(0,Math.min(window.innerWidth-panel.offsetWidth,dragStart.left+event.clientX-dragStart.x))+"px";panel.style.right="auto";panel.style.top=Math.max(28,Math.min(window.innerHeight-90,dragStart.top+event.clientY-dragStart.y))+"px"});
  const finishPanelDrag=()=>{if(!dragStart)return;dragStart=null;if(panel.getBoundingClientRect().left<24)applyPanelMode("left");else if(window.innerWidth-panel.getBoundingClientRect().right<24)applyPanelMode("right")};
  titlebar.addEventListener("pointerup",finishPanelDrag);titlebar.addEventListener("pointercancel",finishPanelDrag);
  authControls.append(who,row1,row2,row3,memberBox,row4,el("hr",{class:"tw-sep"}),el("div",{class:"tw-small"},"Reservation leases expire after 90 seconds without a heartbeat. Project writes use revision checks; conflicting changes are not silently overwritten."));
  (document.querySelector(".work")||document.body).append(panel);
  const showStatus=(message,kind="info")=>{status.textContent=message;status.dataset.kind=kind;};
  const model=()=>window.arqenvoTeamworkAdapter?.getProject?.();
  const applyRemote=project=>{if(!project)throw new Error("The host does not have a shared project yet.");window.arqenvoTeamworkAdapter.applyProject(project);state.syncedProject=structuredClone(project);state.dirty=false;};
  const changedIds=(before,after)=>{const a=new Map((before?.elements||[]).map(item=>[item.id,item])),b=new Map((after?.elements||[]).map(item=>[item.id,item]));return [...new Set([...a.keys(),...b.keys()])].filter(id=>JSON.stringify(a.get(id))!==JSON.stringify(b.get(id)));};
  async function refresh(){
    if(!state.token||state.syncing)return;
    state.syncing=true;
    try{
      const data=await api("project");state.reservations=data.reservations||{};
      if(state.conflictRevision!==null){showStatus("Sync paused: host revision "+state.conflictRevision+" conflicts with local edits. Download the local copy, then choose Receive host project to discard local edits and resume syncing.","error");}
      else if(data.revision!==state.revision){
        if(!data.project){state.revision=data.revision;showStatus("Signed in. No shared project exists yet. Create one from the current model.","ok");}
        else if(!state.syncedProject||!state.dirty){if(window.arqenvoTeamworkAdapter?.hasActiveEdit?.()){showStatus("Host update received, but sync is waiting for your active CAD edit to finish. Complete or cancel the current drawing/edit, then send changes.","info");}else{applyRemote(data.project);state.revision=data.revision;showStatus("Connected · revision "+state.revision+" · host changes received.","ok");}}
        else showStatus("Conflict detected: host is now revision "+data.revision+" while this browser has unsent edits. Local model is preserved. Download it or use Receive host project after reviewing.","error");
      }else if(state.syncedProject)showStatus("Connected · revision "+state.revision+" · "+Object.keys(state.reservations).length+" reserved element(s).","ok");
    }catch(error){showStatus("Teamwork sync failed: "+error.message,"error");}finally{state.syncing=false;}
  }
  async function sendProject(){
    if(!state.token)return showStatus("Sign in to the host first.","error");
    if(state.conflictRevision!==null)return showStatus("Sync is paused because of a revision conflict. Download the local copy if needed, then explicitly choose Receive host project before editing further.","error");
    if(state.syncing)return;
    const project=model();if(!project)return showStatus("Arqenvo model adapter is unavailable. Reload the host URL.","error");
    state.syncing=true;
    try{
      const data=await api("project",{method:"PUT",body:JSON.stringify({expectedRevision:state.revision,project,changedElementIds:changedIds(state.syncedProject,project)})});
      state.revision=data.revision;state.syncedProject=structuredClone(project);state.dirty=false;showStatus("Changes saved to host · revision "+state.revision+".","ok");
    }catch(error){
      if(error.status===409){state.conflictRevision=error.data.revision;showStatus("Revision conflict: host advanced to revision "+error.data.revision+". Local changes remain here and were not uploaded. Sync is paused. Download a local copy first if needed, then choose Receive host project to resume.","error");}
      else showStatus("Could not send changes: "+error.message,"error");
    }finally{state.syncing=false;}
  }
  function startPolling(){clearInterval(state.polling);state.polling=setInterval(()=>{if(state.token){api("reservation-heartbeat",{method:"POST",body:"{}"}).catch(()=>{});refresh();}},3000);}
  function renderAuth(){const signed=!!state.token;loginBox.hidden=signed;authControls.hidden=!signed;if(signed){who.textContent="Signed in as "+state.user.username+" ("+state.user.role+")";memberBox.hidden=state.user.role!=="admin";}else{who.textContent="";memberBox.hidden=true;}restart.hidden=!signed||state.user.role!=="admin";const viewer=signed&&state.user.role==="viewer";document.querySelector(".app")?.classList.toggle("arqenvo-teamwork-viewer",viewer);publish.disabled=send.disabled=load.disabled=!signed;reserve.disabled=release.disabled=viewer;}
  async function signIn(){
    try{
      const result=await api("login",{method:"POST",body:JSON.stringify({username:user.value.trim(),password:pass.value})});
      state.token=result.token;state.user=result.user;pass.value="";state.revision=0;state.syncedProject=null;state.dirty=false;state.conflictRevision=null;renderAuth();
      const data=await api("project");state.revision=data.revision;state.reservations=data.reservations||{};
      if(data.project){applyRemote(data.project);showStatus("Connected · loaded host project revision "+state.revision+".","ok");}
      else showStatus("Signed in. No shared project exists yet. Click “Create shared project from this model”.","ok");
      startPolling();
    }catch(error){showStatus("Sign in failed: "+error.message+" If this page is on GitHub Pages, open the host PC's http://LAN-IP:8080 address instead.","error");}
  }
  login.addEventListener("click",signIn);pass.addEventListener("keydown",event=>{if(event.key==="Enter")signIn()});const teamworkMenu=document.getElementById("teamworkMenuGroup");teamworkMenu?.querySelector("summary")?.addEventListener("click",event=>{event.preventDefault();const willOpen=panel.hidden;document.querySelectorAll(".menu-group[open]").forEach(menu=>menu.removeAttribute("open"));if(willOpen){panel.hidden=false;applyPanelMode(panelMode);}else{panel.hidden=true;panel.style.display="none";if(panelMode==="left"||panelMode==="right"){clearGridOverrides();panel.classList.remove("tw-docked-left","tw-docked-right");}}teamworkMenu.setAttribute("aria-expanded",String(willOpen));});
  load.addEventListener("click",async()=>{if(state.dirty&&!confirm("Discard this browser's unsent edits and replace them with the host project? Download a local copy first if needed."))return;try{const data=await api("project");if(!data.project)return showStatus("No shared project exists on host yet.","error");applyRemote(data.project);state.revision=data.revision;state.conflictRevision=null;state.reservations=data.reservations||{};showStatus("Host project received · revision "+state.revision+". Sync resumed.","ok");}catch(error){showStatus("Receive failed: "+error.message,"error");}});
  publish.addEventListener("click",async()=>{if(state.revision!==0||state.syncedProject)return showStatus("The host already has a project. Use Receive host project or Send changes.","error");if(!confirm("Create the host's shared project from the model currently open in this browser? This becomes the authoritative project for the team."))return;await sendProject();});
  send.addEventListener("click",sendProject);
  download.addEventListener("click",()=>{try{const project=model();if(!project)throw new Error("Arqenvo model adapter is unavailable");const blob=new Blob([JSON.stringify(project,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const link=el("a",{href:url,download:(project.project?.name||"arqenvo-project").replace(/[^a-z0-9_-]+/gi,"-")+".arq"});link.style.display="none";document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);showStatus("Local project copy downloaded. Keep it safe before resolving a sync conflict.","ok");}catch(error){showStatus("Could not download local copy: "+error.message,"error");}});
  reserve.addEventListener("click",async()=>{try{const ids=window.arqenvoTeamworkAdapter?.getSelectedElementIds?.()||[];if(!ids.length)return showStatus("Select one or more elements in the drawing first.","error");const data=await api("reserve",{method:"POST",body:JSON.stringify({elementIds:ids})});state.reservations=data.reservations;showStatus("Reserved "+ids.length+" selected element(s).","ok");}catch(error){showStatus("Reservation failed: "+error.message,"error");}});
  release.addEventListener("click",async()=>{try{const ids=window.arqenvoTeamworkAdapter?.getSelectedElementIds?.()||[];if(!ids.length)return showStatus("Select one or more elements first.","error");const data=await api("release",{method:"POST",body:JSON.stringify({elementIds:ids})});state.reservations=data.reservations;showStatus("Released selected element reservations.","ok");}catch(error){showStatus("Release failed: "+error.message,"error");}});
  addMember.addEventListener("click",async()=>{try{const result=await api("members",{method:"POST",body:JSON.stringify({username:memberName.value.trim(),password:memberPassword.value,role:memberRole.value})});memberPassword.value="";showStatus("Created member "+result.user.username+" ("+result.user.role+"). Share credentials securely.","ok");}catch(error){showStatus("Could not add member: "+error.message,"error");}});
  memberListButton.addEventListener("click",async()=>{if(!memberList.hidden){memberList.hidden=true;memberListButton.textContent="View registered members";return;}try{memberListButton.disabled=true;memberList.textContent="Loading registered members…";const result=await api("members");memberList.replaceChildren();if(!result.users.length){memberList.textContent="No registered members yet."; }else{const list=el("div",{class:"tw-member-list"});for(const member of result.users){const item=el("div",{class:"tw-member-item"});const label=member.username+" · "+({admin:"Admin",member:"Architect / Editor",viewer:"Viewer"}[member.role]||member.role);item.textContent=label;list.append(item);}memberList.append(list);}memberList.hidden=false;memberListButton.textContent="Hide registered members";}catch(error){showStatus("Could not load members: "+error.message,"error");}finally{memberListButton.disabled=false;}});
  restart.addEventListener("click",async()=>{if(state.dirty&&!confirm("Local changes may not have reached the host. Restart anyway? Choose Cancel and click Send changes first to protect your work."))return;if(!confirm("Restart the Teamwork host? All team members will briefly disconnect; it should come back automatically."))return;try{restart.disabled=true;showStatus("Restarting host… wait for the LAN host to come back online.","info");await api("restart",{method:"POST",body:"{}"});showStatus("Restart request accepted. Host is restarting.","ok");}catch(error){showStatus("Host restart failed: "+error.message,"error");restart.disabled=false;}});
  logout.addEventListener("click",async()=>{try{await api("logout",{method:"POST",body:"{}"});}catch{}clearInterval(state.polling);state.token="";state.user=null;state.syncedProject=null;state.dirty=false;state.conflictRevision=null;renderAuth();showStatus("Signed out. Local autosave remains on this browser.");});
  window.arqenvoTeamwork={markDirty(){if(!state.token||!state.syncedProject)return;state.dirty=true;clearTimeout(state.timer);state.timer=setTimeout(()=>{if(state.dirty)sendProject();},1400);}};
  renderAuth();
  api("health").then(data=>showStatus("Local host detected · "+data.host+" · revision "+data.projectRevision+". Sign in to connect.","ok")).catch(()=>showStatus("No Local Teamwork host detected at this address. Run the host service and open its LAN URL on this device.","info"));
})();
