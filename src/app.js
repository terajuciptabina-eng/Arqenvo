import {createProject,createWall,createSlab,createColumn,createBeam,createRoof,addOpening,wallLength,serializeProject,deserializeProject,pointSegmentDistance,polygonArea,elementSchedule,validateProject} from "./core/model.js";
import {detectRooms as detectClosedRooms} from "./core/rooms.js";
import {serializeScheduleCsv} from "./core/csv.js";
import {extractSection} from "./core/section.js";
import {exportFloorPlanDxf} from "./core/dxf.js";
import {createOpeningPlacement, openingOffsetForAnchor, resolveHostedOpeningEdit, openingPlacementDirection, doorSwingGeometry, hostedOpening3dGeometry, hostedDoorLeaf3dGeometry, findClosedWallLoops, mergeHostedOpeningRecords} from "./core/authoring.js";
import {ModelHistory, transactModel} from "./core/transactions.js";
import {wallEndJoin, segmentIntersection, selectWallJunctionCandidate, wallHostFaceSide, resolveWallEndCorner, wallCrossingCut, segmentCoveredByPolygon2D } from "./core/geometry.js";
import {normalizeUnitSystem,formatLength,formatArea} from "./core/units.js";
const $=id=>document.getElementById(id), c=$("canvas"), x=c.getContext("2d");
let gridVisible=true,hiddenLayers=new Set(),groupsSuspended=false;
const modelHistory=new ModelHistory({limit:80});
let pendingHistorySnapshot=null,historyCommitQueued=false;
const escapeHtml=value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("\\'","&#39;");
let p=createProject(), tool="select", view="floor", layoutMode=false, activeLayoutId=null, draft=[], floorDrawGesture=null, selected=new Set(), scale=36, drawingScaleDenominator=100, viewportZoom=1, origin={x:0,y:0}, mouse=null, activeStoryId=p.stories[0].id, isPanning=false, panStart=null, spaceHeld=false, wallGeometryMethod="continuous", wallChainStart=null, wallChainPoints=[], wallChainHasSegment=false, trackerDistanceOverride=null, trackerAngleOverride=null, activeSnapPoint=null, openingHingeSide="left", openingSwingDirection="inside", openingAlignment="center", openingLibraryType="single-leaf", openingDoorWidth=.9, openingDoorHeight=2.1, openingDoorSill=0, openingWindowWidth=1.2, openingWindowHeight=1.2, openingWindowSill=.9, pendingOpeningPlacement=null, openingMoveGesture=null;
let gridlineMoveGesture=null, genericMoveGesture=null, genericNodeMoveGesture=null, genericEdgeMoveGesture=null, roomLabelMoveGesture=null, pendingGridSystem=null;
let spaceMagicWandActive=false,spaceMagicWandReturnTool=null,spaceActivationTimer=null,textBoxGesture=null;
let lastFloorSelectionDebug=null;
let hoveredElementId=null;
let tabSelectionCandidates=[],tabSelectionIndex=-1,selectionBoxGesture=null,lastMarqueeRect=null;
let marqueeGeometryMethod="rectangle",marqueeDraftPoints=[],marqueePreviewPoint=null,lastMarqueePolygon=null;
let releasedTouchEditPending=false;
let releasedTouchEditSnapshot=null;
let releasedTouchEditKind=null;
const openingPlacement=createOpeningPlacement();
let provisionalDrawingSnapshot=null,provisionalDrawingTool=null,provisionalDrawingActive=false,provisionalWallClosed=false;
const els=()=>p.elements, story=()=>p.stories.find(s=>s.id===activeStoryId)||p.stories[0], chosen=()=>els().filter(e=>selected.has(e.id)),groupKey=e=>e?.groupId||e?.gridSystemId||null,groupMembers=e=>{const key=groupKey(e);return key&&!groupsSuspended?els().filter(v=>groupKey(v)===key):[e]};
const wpos=q=>({x:(q.x-c.clientWidth/2-origin.x)/scale,y:(c.clientHeight/2+origin.y-q.y)/scale});
// Read-only viewport transform for deterministic browser smoke geometry helpers.
try{Object.defineProperty(window,"__arqenvoViewport",{configurable:true,get:()=>({origin:{...origin},scale,canvasWidth:c.clientWidth,canvasHeight:c.clientHeight})})}catch{}
const spos=q=>({x:c.clientWidth/2+origin.x+q.x*scale,y:c.clientHeight/2+origin.y-q.y*scale});
const baseScaleForDrawing=()=>3600/Math.max(1,drawingScaleDenominator);
const applyViewportZoom=()=>{viewportZoom=Math.max(.05,Math.min(5,180/baseScaleForDrawing(),viewportZoom));scale=Math.max(1,Math.min(180,baseScaleForDrawing()*viewportZoom))};
const AUTOSAVE_KEY="arqenvo.autosave.v2";
const unitSystem=()=>normalizeUnitSystem(p.project?.units);
const imperialLengthKeys=new Set(["height","thickness","baseOffset","width","depth","elevation","sill","offset","gridDimensionValue"]);
const parsePropertyInput=(value,key,input=null)=>unitSystem()==="imperial"&&imperialLengthKeys.has(key)?(input?.dataset.unitEdited!=="true"&&Number.isFinite(Number(input?.dataset.originalMetres))?Number(input.dataset.originalMetres):parseLength(value,"imperial")):Number(value);
function applyUnitSystem(next){p.project.units=normalizeUnitSystem(next);scheduleAutoSave();redraw();renderProperties();updateUnitButton();$("status").textContent="Project units set to "+(p.project.units==="imperial"?"Imperial (ft + whole in)":"Metric (m, mm, m²)")}
function updateUnitButton(){const b=$("unitSettingsButton");if(b){const label=b.querySelector("span");if(label)label.textContent="Units: "+(unitSystem()==="imperial"?"Imperial":"Metric");b.title="Set project measurement units";}const input=$("trackerDistance"),label=input?.previousElementSibling?.querySelector("span");if(input){input.type=unitSystem()==="imperial"?"text":"number";input.setAttribute("aria-label",unitSystem()==="imperial"?"Distance in feet and whole inches":"Distance in millimetres")}if(label)label.textContent=unitSystem()==="imperial"?"↗ Distance (ft + in)":"↗ Distance (mm)"}
let autosaveTimer=null;
// 3D navigation camera: orbit (left-drag), pan (middle/space-drag), zoom (wheel/pinch).
let camera3d={yaw:-Math.PI/4,pitch:Math.PI/5,zoom:1,panX:0,panY:0,targetZ:1.5};
let orbiting=false,lastCameraPointer=null,pending3dPointer=null,hitPolys3d=[],shiftHeld=false,mobileShiftToggleActive=false,shiftAngleLock=null;
// Floor-plan touch navigation: two fingers pan/zoom without creating geometry.
const floorTouchPointers=new Map();let floorTouchGesture=null;const threeTouchPointers=new Map();let threeTouchGesture=null;
function scheduleAutoSave(){if(autosaveTimer)clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>{try{localStorage.setItem(AUTOSAVE_KEY,serializeProject(p))}catch(error){$("status").textContent="Autosave unavailable: "+error.message}},700);window.arqenvoTeamwork?.markDirty?.()}
function hist(label="Edit model"){if(!pendingHistorySnapshot)pendingHistorySnapshot=structuredClone(p);if(historyCommitQueued)return;historyCommitQueued=true;queueMicrotask(()=>{const before=pendingHistorySnapshot;pendingHistorySnapshot=null;historyCommitQueued=false;if(!before)return;try{if(JSON.stringify(before)===JSON.stringify(p)){updateHistoryButtons();return}const transaction=transactModel(before,{label,mutate:draft=>{for(const key of Object.keys(draft))delete draft[key];Object.assign(draft,structuredClone(p));return {changedNodes:["model"]}},validate:draft=>validateProject(draft),history:modelHistory});p=transaction.model;updateHistoryButtons();scheduleAutoSave()}catch(error){p=before;activeStoryId=p.stories.some(s=>s.id===activeStoryId)?activeStoryId:p.stories[0].id;selected=new Set([...selected].filter(id=>els().some(e=>e.id===id)));refreshStories();redraw();renderProperties();updateHistoryButtons();$("status").textContent="Edit rejected: "+error.message}})}
function restore(json){p=deserializeProject(json);updateUnitButton();selected=new Set([...selected].filter(id=>els().some(e=>e.id===id)));redraw();renderProperties();updateHistoryButtons()}
function updateHistoryButtons(){$("undo").disabled=!modelHistory.canUndo;$("redo").disabled=!modelHistory.canRedo}
function syncSelection(){const validIds=new Set(els().map(e=>e.id));selected=new Set([...selected].filter(id=>validIds.has(id)));return chosen()}function selectOnly(id){const validIds=new Set(els().map(e=>e.id));const hit=id&&els().find(e=>e.id===id);selected=id&&validIds.has(id)?new Set(groupMembers(hit).map(e=>e.id)):new Set();renderProperties();const list=syncSelection();const info=$("selectionInfo");if(info)info.textContent=list.length?list.length+" selected · "+list.map(e=>e.type).join(", "):"No selection";const count=$("contextSelectionCount");if(count)count.textContent=list.length+" element"+(list.length===1?"":"s")}
function clearSelection(){selected.clear();selectOnly(null);const info=$("selectionInfo");if(info)info.textContent="No selection";const count=$("contextSelectionCount");if(count)count.textContent="0 elements"}
function elementLayer(el){return el.layer||({"wall":"A-WALL","slab":"A-SLAB","roof":"A-ROOF","column":"A-COLS","beam":"A-BEAM","door":"A-DOOR","window":"A-WIND","dimension":"A-DIMS","room":"A-ROOM"}[el.type]||"A-MISC")}
function isLayerVisible(el){return !hiddenLayers.has(elementLayer(el))}
function pointInRect(p,r){return p.x>=r.left&&p.x<=r.right&&p.y>=r.top&&p.y<=r.bottom}
function segmentIntersectsRect(a,b,r){
 const minX=Math.min(a.x,b.x),maxX=Math.max(a.x,b.x),minY=Math.min(a.y,b.y),maxY=Math.max(a.y,b.y);
 if(maxX<r.left||minX>r.right||maxY<r.top||minY>r.bottom)return false;
 if(pointInRect(a,r)||pointInRect(b,r))return true;
 const edges=[[{x:r.left,y:r.top},{x:r.right,y:r.top}],[{x:r.right,y:r.top},{x:r.right,y:r.bottom}],[{x:r.right,y:r.bottom},{x:r.left,y:r.bottom}],[{x:r.left,y:r.bottom},{x:r.left,y:r.top}]];
 const orient=(p,q,s)=>(q.x-p.x)*(s.y-p.y)-(q.y-p.y)*(s.x-p.x);
 return edges.some(([p,q])=>{const o1=orient(a,b,p),o2=orient(a,b,q),o3=orient(p,q,a),o4=orient(p,q,b);return o1*o2<=0&&o3*o4<=0});
}
function elementIntersectsScreenRect(el,r){
 if(el.type==="door"||el.type==="window"){
  const w=els().find(v=>v.id===el.hostWallId&&v.type==="wall");if(!w)return false;
  const len=wallLength(w)||1,at=off=>spos({x:w.start.x+(w.end.x-w.start.x)*off/len,y:w.start.y+(w.end.y-w.start.y)*off/len});
  return segmentIntersectsRect(at(el.offset),at(el.offset+el.width),r);
 }
 if(el.start&&el.end)return segmentIntersectsRect(spos(el.start),spos(el.end),r);
 if(el.position){const p=spos(el.position);return pointInRect(p,r)}
 if(el.boundary?.length){const pts=el.boundary.map(spos);return pts.some(p=>pointInRect(p,r))||pts.some((p,i)=>segmentIntersectsRect(p,pts[(i+1)%pts.length],r))||pointInRect({x:(r.left+r.right)/2,y:(r.top+r.bottom)/2},r)&&pointInPolygon(wpos({x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}),el.boundary)}
 return false;
}
function pointInScreenPolygon(point,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if(((a.y>point.y)!==(b.y>point.y))&&(point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y||1e-12)+a.x))inside=!inside}return inside}
function screenSegmentsIntersect(a,b,c,d){const cross=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);const on=(p,q,r)=>Math.min(p.x,q.x)-1e-8<=r.x&&r.x<=Math.max(p.x,q.x)+1e-8&&Math.min(p.y,q.y)-1e-8<=r.y&&r.y<=Math.max(p.y,q.y)+1e-8;const o1=cross(a,b,c),o2=cross(a,b,d),o3=cross(c,d,a),o4=cross(c,d,b);if(((o1>0&&o2<0)||(o1<0&&o2>0))&&((o3>0&&o4<0)||(o3<0&&o4>0)))return true;return Math.abs(o1)<1e-8&&on(a,b,c)||Math.abs(o2)<1e-8&&on(a,b,d)||Math.abs(o3)<1e-8&&on(c,d,a)||Math.abs(o4)<1e-8&&on(c,d,b)}
function segmentIntersectsScreenPolygon(a,b,poly){if(pointInScreenPolygon(a,poly)||pointInScreenPolygon(b,poly))return true;for(let i=0;i<poly.length;i++)if(screenSegmentsIntersect(a,b,poly[i],poly[(i+1)%poly.length]))return true;return false}
function elementIntersectsScreenPolygon(el,poly){
 if(!poly||poly.length<3)return false;
 if(el.type==="door"||el.type==="window"){const w=els().find(v=>v.id===el.hostWallId&&v.type==="wall");if(!w)return false;const len=wallLength(w)||1,at=off=>spos({x:w.start.x+(w.end.x-w.start.x)*off/len,y:w.start.y+(w.end.y-w.start.y)*off/len});return segmentIntersectsScreenPolygon(at(el.offset),at(el.offset+el.width),poly)}
 if(el.start&&el.end)return segmentIntersectsScreenPolygon(spos(el.start),spos(el.end),poly);
 if(el.position)return pointInScreenPolygon(spos(el.position),poly);
 if(el.boundary?.length){const pts=el.boundary.map(spos);return pts.some(q=>pointInScreenPolygon(q,poly))||poly.some(q=>pointInPolygon(wpos(q),el.boundary))||pts.some((q,i)=>segmentIntersectsScreenPolygon(q,pts[(i+1)%pts.length],poly))}
 return false;
}
function selectionCandidatesAt(q){
 const candidates=[],seen=new Set(),screen=spos(q),tol=16;
 const add=el=>{if(el&&!seen.has(el.id)){seen.add(el.id);candidates.push(el)}};
 const base=nearestElement(q);if(base)add(base);
 if(view==="floor"){
  for(const w of els().filter(el=>el.type==="wall"&&el.storyId===story().id&&isLayerVisible(el))){
   const a=spos(w.start),b=spos(w.end),distance=pointSegmentDistance(screen,a,b);
   if(distance<=tol)add(w);
   const dx=w.end.x-w.start.x,dy=w.end.y-w.start.y,len=Math.hypot(dx,dy)||1;
   const along=((q.x-w.start.x)*dx+(q.y-w.start.y)*dy)/len;
   for(const o of els().filter(el=>(el.type==="door"||el.type==="window")&&el.hostWallId===w.id&&isLayerVisible(el)&&(el.storyId===w.storyId||!el.storyId))){
    const start=Math.max(0,Number(o.offset)||0),width=Math.max(0,Number(o.width)||0);
    if(width>0&&along>=start-tol/Math.max(1,scale)&&along<=start+width+tol/Math.max(1,scale)&&distance<=tol)add(o);
   }
  }
 }
 return candidates;
}
function nearestElement(q){
 const allElements=els();const visibleWalls=new Set(allElements.filter(e=>e.type==="wall"&&isLayerVisible(e)&&(view!=="floor"||e.storyId===story().id)).map(e=>e.id));const candidates=allElements.filter(e=>isLayerVisible(e)&&(view!=="floor"||e.storyId===story().id||((e.type==="door"||e.type==="window")&&visibleWalls.has(e.hostWallId))));
 const hitTolerance=10/Math.max(1,scale);
 let best=null,bestScore=Infinity;
 const screenQ=spos(q),pixelTolerance=12;
 const openings=candidates.filter(el=>el.type==="door"||el.type==="window");
 for(const el of openings){
  const host=candidates.find(v=>v.id===el.hostWallId&&v.type==="wall");
  if(!host)continue;
  const dx=host.end.x-host.start.x,dy=host.end.y-host.start.y,len=Math.hypot(dx,dy);
  if(len<1e-8)continue;
  const start=Math.max(0,Number(el.offset)||0),width=Math.max(0,Number(el.width)||0),end=start+width;
  if(width<=0)continue;
  const aModel={x:host.start.x+dx*start/len,y:host.start.y+dy*start/len};
  const bModel={x:host.start.x+dx*end/len,y:host.start.y+dy*end/len};
  const a=spos(aModel),b=spos(bModel),sdx=b.x-a.x,sdy=b.y-a.y,slen=Math.hypot(sdx,sdy);
  if(slen<1e-6)continue;
  const nx=-sdy/slen,ny=sdx/slen,wallPixels=Math.max(1,(Number(host.thickness)||.15)*scale);
  let symbolDistance=Infinity;
  if(el.type==="door"){
   // Door swing direction is authored in model coordinates (Y-up). Build the
   // leaf there, then transform its endpoints to screen space; constructing
   // the swing from screen-space endpoints mirrors inside/outside on the Y flip.
   const leafHitDistance=(p1,p2,hingeSide)=>{const g=doorSwingGeometry(p1,p2,{hingeSide,swingDirection:el.swingDirection}),hinge=spos(g.hinge),openFree=spos(g.openFree),radial=Math.abs(Math.hypot(q.x-g.hinge.x,q.y-g.hinge.y)-g.radius),angle=Math.atan2(q.y-g.hinge.y,q.x-g.hinge.x),sweepContains=angleInArc(angle,g.startAngle,g.endAngle,g.anticlockwise);return Math.min(pointSegmentDistance(screenQ,hinge,openFree),sweepContains?radial*scale:Infinity)};
   if((el.libraryType||"single-leaf")==="double-leaf"){const mid={x:(aModel.x+bModel.x)/2,y:(aModel.y+bModel.y)/2};symbolDistance=Math.min(leafHitDistance(aModel,mid,"left"),leafHitDistance(mid,bModel,"right"))}else symbolDistance=leafHitDistance(aModel,bModel,el.hingeSide||"left");
  }else{
   const offset=wallPixels*.28;
   symbolDistance=Math.min(
    pointSegmentDistance(screenQ,{x:a.x+nx*offset,y:a.y+ny*offset},{x:b.x+nx*offset,y:b.y+ny*offset}),
    pointSegmentDistance(screenQ,{x:a.x-nx*offset,y:a.y-ny*offset},{x:b.x-nx*offset,y:b.y-ny*offset})
   );
  }
  const along=((q.x-host.start.x)*dx+(q.y-host.start.y)*dy)/len;
  // An opening is selectable only when the pointer is near its actual wall/symbol, not merely aligned with its length.
  // Only the visible door/window symbol is a hit target. The opening interval along the wall is not enough;
  // otherwise starting a marquee near a wall incorrectly becomes an opening move.
  if(symbolDistance<=pixelTolerance){
   const score=symbolDistance-1000;
   if(score<bestScore){best=el;bestScore=score}
  }
 }
 if(best)return best;
 for(const el of candidates){
  if(el.type==="door"||el.type==="window")continue;
  let d=Infinity;
  if(el.type==="wall"||el.type==="beam"){
   const half=(el.type==="wall"?(Number(el.thickness)||.15):(Number(el.width)||0))/2;
   d=Math.max(0,pointSegmentDistance(q,el.start,el.end)-half);
  }else if(el.type==="column"){
   d=Math.max(0,Math.hypot(q.x-el.position.x,q.y-el.position.y)-Math.max(el.width||0,el.depth||0)/2);
  }else if(el.type==="slab"||el.type==="room"||el.type==="roof"){
   if(pointInPolygon(q,el.boundary))d=0;
   else d=Math.min(...el.boundary.map((v,i)=>pointSegmentDistance(q,v,el.boundary[(i+1)%el.boundary.length])));
  }else if(el.type==="text"&&el.position){
   const sp=spos(el.position),font=Math.max(.5,Number(el.textSizeMm)||2.5)*Math.max(.5,scale*drawingScaleDenominator/1000),lines=String(el.text||"Text").split("\n"),width=Math.max(8,...lines.map(line=>line.length*font*.58)),height=Math.max(font,lines.length*font*1.25),align=["left","center","right"].includes(el.alignment)?el.alignment:"left",left=align==="center"?sp.x-width/2:align==="right"?sp.x-width:sp.x,screen=spos(q);
   d=Math.hypot(Math.max(0,left-screen.x,screen.x-(left+width)),Math.max(0,sp.y-screen.y,screen.y-(sp.y+height)))/Math.max(1,scale);
  }else if(el.type==="dimension"||el.type==="gridline"){
   d=pointSegmentDistance(q,el.start,el.end);
  }
  if(d<=hitTolerance&&d<bestScore){best=el;bestScore=d}
 }
 return best
}
function angleInArc(angle,start,end,anticlockwise){
 const normalize=value=>((value%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
 const a=normalize(angle),s=normalize(start),e=normalize(end);
 return anticlockwise ? normalize(s-a)<=normalize(s-e)+1e-8 : normalize(a-s)<=normalize(e-s)+1e-8;
}
function snapPoint(q,radius){
 activeSnapPoint=null;
 if(p.settings?.snap===false)return q;
 const threshold=radius??(10/Math.max(1,scale));
 let best=null,bestDistance=threshold,bestKind="";
 const consider=(point,kind="node")=>{
  if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return;
  const d=Math.hypot(q.x-point.x,q.y-point.y);
  if(d<bestDistance){best={x:point.x,y:point.y};bestDistance=d;bestKind=kind}
 };
 const snapSegments=[];
 const near=(a,b)=>Math.max(Math.min(a.x,b.x)-q.x,0,q.x-Math.max(a.x,b.x))<=threshold&&Math.max(Math.min(a.y,b.y)-q.y,0,q.y-Math.max(a.y,b.y))<=threshold;
 const addSegment=(a,b,id,force=false)=>{if(a&&b&&Number.isFinite(a.x)&&Number.isFinite(a.y)&&Number.isFinite(b.x)&&Number.isFinite(b.y)&&(force||near(a,b)))snapSegments.push({a,b,id})};
 const seenPoints=new Set();
 const addNode=(point,kind="endpoint")=>{
  if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return;
  const key=point.x.toFixed(8)+","+point.y.toFixed(8);
  if(!seenPoints.has(key)){seenPoints.add(key);consider(point,kind)}
 };
 const visible=els().filter(el=>isLayerVisible(el)&&(view!=="floor"||el.storyId===story().id));
 for(const el of visible){
  const id=el.id;
  // Every element's explicit geometric nodes are snap targets, not just wall/beam nodes.
  for(const key of ["start","end","position","center","origin","p1","p2","a","b","node","anchor","referencePoint"])if(el[key]&&typeof el[key]==="object"&&Number.isFinite(el[key].x)&&Number.isFinite(el[key].y))addNode(el[key],key==="position"||key==="center"?"center":"endpoint");
  for(const key of ["boundary","points","vertices","nodes","controlPoints","dimensionPoints","referencePoints","handles"]){
   const arr=el[key];
   if(!Array.isArray(arr))continue;
   for(const point of arr)if(point&&Number.isFinite(point.x)&&Number.isFinite(point.y))addNode(point,"endpoint");
   if(["boundary","points","vertices"].includes(key)&&arr.length>1)for(let i=0;i<arr.length;i++)addSegment(arr[i],arr[(i+1)%arr.length],id);
  }
  if(el.start&&el.end){
   // Grid-system axes are long construction lines: keep them in the intersection set even when their full bounding box extends beyond the cursor radius.
   addSegment(el.start,el.end,id,el.type==="gridline"&&!!el.gridSystemId);
   const dx=el.end.x-el.start.x,dy=el.end.y-el.start.y,len2=dx*dx+dy*dy;
   if(len2>1e-9){
    addNode({x:(el.start.x+el.end.x)/2,y:(el.start.y+el.end.y)/2},"midpoint");
    const t=Math.max(0,Math.min(1,((q.x-el.start.x)*dx+(q.y-el.start.y)*dy)/len2));
    if(t>0.025&&t<0.975)consider({x:el.start.x+t*dx,y:el.start.y+t*dy},"nearest");
   }
  }
  if(Array.isArray(el.boundary)&&el.boundary.length>1){
   for(let i=0;i<el.boundary.length;i++)addSegment(el.boundary[i],el.boundary[(i+1)%el.boundary.length],id);
  }
  // Door/window jamb endpoints are nodes on their host wall.
  if(el.type==="door"||el.type==="window"){
   const host=visible.find(v=>v.id===el.hostWallId&&v.type==="wall");
   if(host&&host.start&&host.end){
    const len=wallLength(host)||Math.hypot(host.end.x-host.start.x,host.end.y-host.start.y);
    if(len>1e-9){
     const ux=(host.end.x-host.start.x)/len,uy=(host.end.y-host.start.y)/len;
     for(const off of [Number(el.offset)||0,(Number(el.offset)||0)+(Number(el.width)||0)]){
      const point={x:host.start.x+ux*off,y:host.start.y+uy*off};addNode(point,"endpoint");
     }
    }
   }
  }
 }
 // Find intersections across all nearby element edges (not only walls, beams and gridlines).
 for(let i=0;i<snapSegments.length;i++)for(let j=i+1;j<snapSegments.length;j++){
  const a=snapSegments[i],b=snapSegments[j];if(a.id===b.id)continue;
  const rx=a.b.x-a.a.x,ry=a.b.y-a.a.y,sx=b.b.x-b.a.x,sy=b.b.y-b.a.y,den=rx*sy-ry*sx;
  if(Math.abs(den)<1e-10)continue;
  const qx=b.a.x-a.a.x,qy=b.a.y-a.a.y,t=(qx*sy-qy*sx)/den,u=(qx*ry-qy*rx)/den;
  if(t>=-1e-8&&t<=1+1e-8&&u>=-1e-8&&u<=1+1e-8){const point={x:a.a.x+t*rx,y:a.a.y+t*ry},distance=Math.hypot(q.x-point.x,q.y-point.y);if(distance<=threshold){if(!best||bestKind!=="intersection"||distance<bestDistance){best=point;bestDistance=distance;bestKind="intersection"}}}
 }
 if(view==="floor"&&gridVisible){
  const step=Math.max(.1,Number($("grid")?.value)||.5);
  consider({x:Math.round(q.x/step)*step,y:Math.round(q.y/step)*step},"grid");
 }
 if(best)activeSnapPoint={...best,kind:bestKind};
 return best||q;
}
function pointInPolygon(p,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){let a=poly[i],b=poly[j];if(((a.y>p.y)!==(b.y>p.y))&&(p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x))inside=!inside}return inside}
function drawWallJunctions(){
 const walls=els().filter(e=>e.type==="wall"&&e.storyId===story().id&&isLayerVisible(e)&&Number.isFinite(e.thickness)&&e.thickness>0);
 const tolerance=1e-6, cellSize=tolerance, same=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<=tolerance;
 const records=[];
 for(const wall of walls){records.push({wall,name:"start",point:wall.start,neighbors:[],index:records.length});records.push({wall,name:"end",point:wall.end,neighbors:[],index:records.length})}
 const cell=p=>({x:Math.floor(p.x/cellSize),y:Math.floor(p.y/cellSize)}), buckets=new Map();
 const key=(x,y)=>x+","+y;
 for(const record of records){const c=cell(record.point),k=key(c.x,c.y);if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(record)}
 for(const record of records){
  const c=cell(record.point);
  for(let ox=-1;ox<=1;ox++)for(let oy=-1;oy<=1;oy++)for(const other of buckets.get(key(c.x+ox,c.y+oy))||[]){
   if(other.index<=record.index||other.wall.id===record.wall.id||!same(record.point,other.point))continue;
   record.neighbors.push(other);other.neighbors.push(record);
  }
 }
 const cores=new Map();
 const addCore=(point,first,second)=>{
  const k=Math.round(point.x/tolerance)+","+Math.round(point.y/tolerance);
  if(!cores.has(k))cores.set(k,{point,walls:new Map()});
  const core=cores.get(k);core.walls.set(first.id,first);core.walls.set(second.id,second);
 };
 for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++){
  const first=walls[i],second=walls[j];
  let intersection;
  try{intersection=segmentIntersection(first.start,first.end,second.start,second.end,{tolerance})}catch{continue}
  if(!intersection)continue;
  if(!intersection.endpointA||!intersection.endpointB){addCore(intersection.point,first,second);continue}
  const ea=records[i*2+(intersection.t<=.5?0:1)];
  const eb=records[j*2+(intersection.u<=.5?0:1)];
  if(!ea||!eb||ea.neighbors.length!==1||eb.neighbors.length!==1)addCore(intersection.point,first,second);
 }
 for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++){
  const first=walls[i],second=walls[j];
  for(const ea of [records[i*2],records[i*2+1]])for(const eb of [records[j*2],records[j*2+1]]){
   if(!same(ea.point,eb.point)||ea.neighbors.length!==1||eb.neighbors.length!==1||ea.index>eb.index)continue;
   const joint=ea.point;
   const a=ea.name==="end"?{start:first.start,end:first.end}:{start:first.end,end:first.start};
   const b=eb.name==="start"?{start:second.start,end:second.end}:{start:second.end,end:second.start};
   let join;
   try{join=wallEndJoin(a,b,first.thickness,second.thickness,{miterLimit:10,tolerance})}catch{continue}
   const da={x:a.end.x-a.start.x,y:a.end.y-a.start.y},la=Math.hypot(da.x,da.y);
   const db={x:b.end.x-b.start.x,y:b.end.y-b.start.y},lb=Math.hypot(db.x,db.y);
   if(la<tolerance||lb<tolerance)continue;
   const na={x:-da.y/la,y:da.x/la},nb={x:-db.y/lb,y:db.x/lb},ha=first.thickness/2,hb=second.thickness/2;
   const aLeft={x:joint.x+na.x*ha,y:joint.y+na.y*ha},aRight={x:joint.x-na.x*ha,y:joint.y-na.y*ha};
   const bLeft={x:joint.x+nb.x*hb,y:joint.y+nb.y*hb},bRight={x:joint.x-nb.x*hb,y:joint.y-nb.y*hb};
   const polygon=[aLeft,...join.left.points,bLeft,bRight,...[...join.right.points].reverse(),aRight];
   if(polygon.some(pt=>!Number.isFinite(pt.x)||!Number.isFinite(pt.y)))continue;
   x.save();x.fillStyle=selected.has(first.id)||selected.has(second.id)?"#087e8b":"#4b5660";x.strokeStyle=x.fillStyle;x.lineWidth=1;
   polygon.forEach((pt,k)=>{const q=spos(pt);if(k===0){x.beginPath();x.moveTo(q.x,q.y)}else{x.lineTo(q.x,q.y)}});
   x.closePath();x.fill();x.restore();
  }
 }
 for(const {point,walls:incidentMap} of cores.values()){
  const incident=[...incidentMap.values()],first=incident[0],half=Math.max(...incident.map(w=>w.thickness))/2;
  const dx=first.end.x-first.start.x,dy=first.end.y-first.start.y,len=Math.hypot(dx,dy);
  if(len<tolerance)continue;
  const ux=dx/len,uy=dy/len,nx=-uy,ny=ux;
  const polygon=[
   {x:point.x-ux*half-nx*half,y:point.y-uy*half-ny*half},
   {x:point.x+ux*half-nx*half,y:point.y+uy*half-ny*half},
   {x:point.x+ux*half+nx*half,y:point.y+uy*half+ny*half},
   {x:point.x-ux*half+nx*half,y:point.y-uy*half+ny*half}
  ];
  x.save();x.fillStyle=incident.some(w=>selected.has(w.id))?"#087e8b":"#4b5660";x.beginPath();
  polygon.forEach((pt,i)=>{const q=spos(pt);i?x.lineTo(q.x,q.y):x.moveTo(q.x,q.y)});
  x.closePath();x.fill();x.restore();
 }
}
let wallTopologyCacheKey=null,wallTopologyCache=null;
function render3DScene(ctx,items,project3d,options={}){
 const faces3d=[];
 const wallById=new Map(items.filter(v=>v.type==="wall").map(v=>[v.id,v]));
 const storyElevationById=new Map(p.stories.map(v=>[v.id,v.elevation||0]));
 const endpointTolerance=.025;
 const wallEndResolvedCorners=new Set();
 const wallCrossingResolvedCorners=new Set();
 const wallCrossingCornerCache=new Map();
 const visibleWalls=items.filter(v=>v.type==="wall"&&isLayerVisible(v));
 const cross2=(a,b)=>a.x*b.y-a.y*b.x;
 const wallCellSize=4;
 const wallTopologyKey=visibleWalls.slice().sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(w=>
  [w.id,w.storyId,w.start.x,w.start.y,w.end.x,w.end.y,Number(w.thickness)||.15].join(":")
 ).join("|");
 let wallEndNeighbors,wallCrossingCutsByWall;
 if(wallTopologyCache&&wallTopologyCache.key===wallTopologyKey){
  wallEndNeighbors=wallTopologyCache.wallEndNeighbors;
  wallCrossingCutsByWall=wallTopologyCache.wallCrossingCutsByWall;
 }else{
  wallEndNeighbors=new Map();
  wallCrossingCutsByWall=new Map();
  const maxWallHalfThickness=visibleWalls.reduce((max,w)=>Math.max(max,(Number(w.thickness)||.15)/2),0);
  const wallBuckets=new Map();
  const wallBucketKey=(storyId,cx,cy)=>storyId+":"+cx+":"+cy;
  for(const candidate of visibleWalls){
   const margin=maxWallHalfThickness+endpointTolerance;
   const minX=Math.floor((Math.min(candidate.start.x,candidate.end.x)-margin)/wallCellSize);
   const maxX=Math.floor((Math.max(candidate.start.x,candidate.end.x)+margin)/wallCellSize);
   const minY=Math.floor((Math.min(candidate.start.y,candidate.end.y)-margin)/wallCellSize);
   const maxY=Math.floor((Math.max(candidate.start.y,candidate.end.y)+margin)/wallCellSize);
   for(let cx=minX;cx<=maxX;cx++)for(let cy=minY;cy<=maxY;cy++){
    const key=wallBucketKey(candidate.storyId,cx,cy);
    if(!wallBuckets.has(key))wallBuckets.set(key,[]);
    wallBuckets.get(key).push(candidate);
   }
  }
  const wallOrder=new Map(visibleWalls.map((wall,index)=>[wall.id,index]));
  const candidatesForWall=wall=>{
   const margin=maxWallHalfThickness+endpointTolerance,nearby=new Set();
   const minX=Math.floor((Math.min(wall.start.x,wall.end.x)-margin)/wallCellSize);
   const maxX=Math.floor((Math.max(wall.start.x,wall.end.x)+margin)/wallCellSize);
   const minY=Math.floor((Math.min(wall.start.y,wall.end.y)-margin)/wallCellSize);
   const maxY=Math.floor((Math.max(wall.start.y,wall.end.y)+margin)/wallCellSize);
   for(let cx=minX;cx<=maxX;cx++)for(let cy=minY;cy<=maxY;cy++){
    for(const candidate of wallBuckets.get(wallBucketKey(wall.storyId,cx,cy))||[])nearby.add(candidate);
   }
   return nearby;
  };
  // Endpoint joins cover L/T junctions. Proper interior segment crossings are
  // separately given a deterministic host and a finite cut interval.
  for(const wall of visibleWalls){
   for(const candidate of candidatesForWall(wall)){
    if(candidate.id===wall.id||candidate.storyId!==wall.storyId||
       wallOrder.get(wall.id)>=wallOrder.get(candidate.id))continue;
    const cut=wallCrossingCut(wall,candidate,{tolerance:endpointTolerance,minSineAngle:.05});
    if(!cut)continue;
    const sec=cut.cutWall;
    if(!wallCrossingCutsByWall.has(sec.id))wallCrossingCutsByWall.set(sec.id,[]);
    wallCrossingCutsByWall.get(sec.id).push({
     start:cut.start,end:cut.end,centerDistance:cut.centerDistance,
     hostWall:cut.hostWall,intersection:cut.intersection,halfSpan:cut.halfSpan,
     sineAngle:cut.sineAngle
    });
   }
  }
  // Build the local endpoint candidate index only once per stable wall geometry.
  for(const wall of visibleWalls)for(const atStart of [true,false]){
   const joint=atStart?wall.start:wall.end,candidates=[];
   const bucket=wallBuckets.get(wallBucketKey(wall.storyId,Math.floor(joint.x/wallCellSize),Math.floor(joint.y/wallCellSize)))||[];
   for(const candidate of bucket){
    if(candidate.id===wall.id||candidate.storyId!==wall.storyId)continue;
    const vx=candidate.end.x-candidate.start.x,vy=candidate.end.y-candidate.start.y,l2=vx*vx+vy*vy;
    if(l2<1e-10)continue;
    const tRaw=((joint.x-candidate.start.x)*vx+(joint.y-candidate.start.y)*vy)/l2;
    const t=Math.max(0,Math.min(1,tRaw)),q={x:candidate.start.x+vx*t,y:candidate.start.y+vy*t};
    const distance=Math.hypot(q.x-joint.x,q.y-joint.y);
    const tolerance=(candidate.thickness||.15)/2+endpointTolerance;
    if(distance<=tolerance){
     const nlen=Math.sqrt(l2),wallLen=Math.hypot(wall.end.x-wall.start.x,wall.end.y-wall.start.y)||1;
     const alignment=Math.abs(cross2({x:wall.end.x-wall.start.x,y:wall.end.y-wall.start.y},{x:vx,y:vy}))/(wallLen*nlen||1);
     candidates.push({neighbor:candidate,neighborT:t,closest:q,isT:t>.025&&t<.975,distance,alignment});
    }
   }
   if(candidates.length)wallEndNeighbors.set(wall.id+":"+(atStart?"start":"end"),candidates);
  }
  for(const cuts of wallCrossingCutsByWall.values())cuts.sort((a,b)=>a.start-b.start||a.end-b.end||String(a.hostWall.id).localeCompare(String(b.hostWall.id)));
  wallTopologyCache={key:wallTopologyKey,wallEndNeighbors,wallCrossingCutsByWall};
 }
 const hostedOpeningsByWall=new Map();
 for(const opening of items){
  if((opening.type!=="door"&&opening.type!=="window")||!opening.hostWallId)continue;
  if(!hostedOpeningsByWall.has(opening.hostWallId))hostedOpeningsByWall.set(opening.hostWallId,[]);
  hostedOpeningsByWall.get(opening.hostWallId).push(opening);
 }
  const wallEndCorner=(wall,atStart,side)=>{
  const endpoint=atStart?"start":"end";
  const candidates=wallEndNeighbors.get(wall.id+":"+endpoint)||[];
  const result=resolveWallEndCorner(wall,atStart,side,candidates,{endpointTolerance,maxMiterRatio:8});
  if(result.resolved)wallEndResolvedCorners.add(wall.id+":"+endpoint+":"+side);
  return result.point;
 };

const materialColors={wall:"#d8e0e4",door:"#b88760",glass:"rgba(123,198,214,.46)",frame:"#5f737d",handle:"#aeb8bd",slab:"#c9d4d9",concrete:"#b9c6cd",roof:"#a97b5b"};
const shadeHex=(hex,amount)=>{const value=parseInt(hex.slice(1),16),r=value>>16,g=(value>>8)&255,b=value&255,adjust=c=>Math.max(0,Math.min(255,Math.round(c+(amount>=0?(255-c)*amount:c*amount))));return "#"+[adjust(r),adjust(g),adjust(b)].map(c=>c.toString(16).padStart(2,"0")).join("")};
const prism=(e,footprint,z0,height,material,geometryOptions={})=>{if(!Array.isArray(footprint)||footprint.length<3||!(height>0))return;const base=footprint.map(pt=>project3d(pt,z0)),top=footprint.map(pt=>project3d(pt,z0+height)),chosenElement=(!!options.interactive&&selected.has(e.id)),surface=material||({wall:"wall",door:"door",window:"glass",slab:"slab",column:"concrete",beam:"concrete",roof:"roof"}[e.type]||"wall");
for(let i=0;i<base.length;i++){if(geometryOptions.skipSides?.includes(i))continue;const j=(i+1)%base.length,poly=[base[i],base[j],top[j],top[i]],shade=i%2?-.035:-.13;faces3d.push({id:e.id,poly,depth:poly.reduce((sum,pt)=>sum+pt.depth,0)/poly.length,material:surface,shade,selected:chosenElement,...(geometryOptions.wallSegment?{wallSegment:geometryOptions.wallSegment,wallSideIndex:i}:{})})}
faces3d.push({id:e.id,poly:top,depth:top.reduce((sum,pt)=>sum+pt.depth,0)/top.length,material:surface,shade:.13,selected:chosenElement,topFace:true,skipTopEdges:geometryOptions.skipTopEdges||[]})};
for(const e of items){if(!isLayerVisible(e)||!["wall","beam","column","slab","door","window","roof"].includes(e.type))continue;const storyElevation=storyElevationById.get(e.storyId)||0;if(e.type==="roof"){const center={x:e.boundary.reduce((s,v)=>s+v.x,0)/e.boundary.length,y:e.boundary.reduce((s,v)=>s+v.y,0)/e.boundary.length},radius=Math.min(...e.boundary.map(v=>Math.hypot(v.x-center.x,v.y-center.y))),baseZ=storyElevation+(e.elevation||0)+(e.offset||0),rise=Math.tan((e.pitch||30)*Math.PI/180)*radius,base=e.boundary.map(v=>project3d(v,baseZ)),inner=e.boundary.map(v=>project3d(v,baseZ-(e.thickness||.18))),peak=project3d(center,baseZ+rise),chosenElement=(!!options.interactive&&selected.has(e.id));for(let i=0;i<base.length;i++){const j=(i+1)%base.length,poly=[base[i],base[j],peak];faces3d.push({id:e.id,poly,depth:poly.reduce((sum,pt)=>sum+pt.depth,0)/poly.length,material:"roof",shade:.1,selected:chosenElement,topFace:true});faces3d.push({id:e.id,poly:[base[j],base[i],inner[i],inner[j]],depth:(base[i].depth+base[j].depth)/2,material:"roof",shade:-.22,selected:chosenElement})}continue}if(e.type==="door"||e.type==="window"){
 const host=wallById.get(e.hostWallId);if(!host)continue;
 const g=hostedOpening3dGeometry(host,e),baseZ=storyElevation+(host.baseOffset||0)+g.zOffset;
 if(e.type==="window"){
  const frame=.045,depth=(g.thickness||.025)*1.8;
  const dx=host.end.x-host.start.x,dy=host.end.y-host.start.y,len=Math.hypot(dx,dy)||1,nx=-dy/len*depth/2,ny=dx/len*depth/2;
  const offset=e.offset||0,width=e.width||0,a={x:host.start.x+dx*offset/len,y:host.start.y+dy*offset/len},b={x:host.start.x+dx*(offset+width)/len,y:host.start.y+dy*(offset+width)/len};
  const zBottom=baseZ,zTop=baseZ+g.height;
  const frameRects=[
   [{x:a.x,y:a.y},{x:b.x,y:b.y},0,frame],
   [{x:a.x,y:a.y},{x:b.x,y:b.y},g.height-frame,g.height],
  ];
  for(const [u,v,lo,hi] of frameRects){const poly=[{x:u.x+nx,y:u.y+ny},{x:v.x+nx,y:v.y+ny},{x:v.x-nx,y:v.y-ny},{x:u.x-nx,y:u.y-ny}];prism(e,poly,zBottom+lo,Math.max(.015,hi-lo),"frame")}
  const jambs=[a,b];
  for(const jamb of jambs){const poly=[{x:jamb.x+nx,y:jamb.y+ny},{x:jamb.x+nx+dx/len*frame,y:jamb.y+ny+dy/len*frame},{x:jamb.x-nx+dx/len*frame,y:jamb.y-ny+dy/len*frame},{x:jamb.x-nx,y:jamb.y-ny}];prism(e,poly,zBottom,g.height,"frame")}
  if((e.libraryType||"single-leaf")==="double-leaf"){const half=e.width/2,first=hostedOpening3dGeometry(host,{...e,width:half}),second=hostedOpening3dGeometry(host,{...e,offset:e.offset+half,width:half}),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},mullion=[{x:mid.x+nx,y:mid.y+ny},{x:mid.x+dx/len*frame+nx,y:mid.y+dy/len*frame+ny},{x:mid.x+dx/len*frame-nx,y:mid.y+dy/len*frame-ny},{x:mid.x-nx,y:mid.y-ny}];prism(e,first.boundary,baseZ,first.height);prism(e,second.boundary,baseZ,second.height);prism(e,mullion,zBottom,Math.max(.015,g.height))}else prism(e,g.boundary,baseZ,g.height,"glass");
 }else{
  const dx=host.end.x-host.start.x,dy=host.end.y-host.start.y,len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len,nx=-uy,ny=ux;
  const wallDepth=Math.max(.07,(host.thickness||.15)*.72),frameWidth=.065,offset=Number(e.offset)||0,width=Number(e.width)||0;
  const at=distance=>({x:host.start.x+ux*distance,y:host.start.y+uy*distance});
  const wallRect=(center,along,depth)=>[{x:center.x-ux*along/2-nx*depth/2,y:center.y-uy*along/2-ny*depth/2},{x:center.x+ux*along/2-nx*depth/2,y:center.y+uy*along/2-ny*depth/2},{x:center.x+ux*along/2+nx*depth/2,y:center.y+uy*along/2+ny*depth/2},{x:center.x-ux*along/2+nx*depth/2,y:center.y-uy*along/2+ny*depth/2}];
  const left=at(offset+frameWidth/2),right=at(offset+width-frameWidth/2),headZ=baseZ+Math.max(0,g.height-frameWidth);
  prism(e,wallRect(left,frameWidth,wallDepth),baseZ,Math.max(.04,g.height),"frame");
  prism(e,wallRect(right,frameWidth,wallDepth),baseZ,Math.max(.04,g.height),"frame");
  prism(e,wallRect(at(offset+width/2),Math.max(.04,width-frameWidth),wallDepth),headZ,frameWidth,"frame");
  if((e.libraryType||"single-leaf")==="double-leaf"){
   const half=width/2,meetingGap=.003,first=hostedDoorLeaf3dGeometry(host,{...e,width:half,hingeSide:"left"},{startInset:frameWidth,endInset:meetingGap/2}),second=hostedDoorLeaf3dGeometry(host,{...e,offset:e.offset+half,width:half,hingeSide:"right"},{startInset:meetingGap/2,endInset:frameWidth});
   prism(e,first.boundary,baseZ,first.height,"door");prism(e,second.boundary,baseZ,second.height,"door");
  }else{
   const leaf=hostedDoorLeaf3dGeometry(host,e,{frameWidth});
   prism(e,leaf.boundary,baseZ,leaf.height,"door");
   const handleDistance=offset+width*.78,handleCenter={x:host.start.x+ux*handleDistance+nx*wallDepth*.48,y:host.start.y+uy*handleDistance+ny*wallDepth*.48},handleLength=.035,handleDepth=.018;
   const handleFoot=[{x:handleCenter.x-ux*handleLength/2-nx*handleDepth/2,y:handleCenter.y-uy*handleLength/2-ny*handleDepth/2},{x:handleCenter.x+ux*handleLength/2-nx*handleDepth/2,y:handleCenter.y+uy*handleLength/2-ny*handleDepth/2},{x:handleCenter.x+ux*handleLength/2+nx*handleDepth/2,y:handleCenter.y+uy*handleLength/2+ny*handleDepth/2},{x:handleCenter.x-ux*handleLength/2+nx*handleDepth/2,y:handleCenter.y-uy*handleLength/2+ny*handleDepth/2}];
   const handleZ=baseZ+Math.min(g.height*.58,1.0);
   prism(e,handleFoot,handleZ,.045,"handle");
  }
 }
 continue
}let footprint=[],z0=storyElevation,height=0;
if(e.type==="wall"){const dx=e.end.x-e.start.x,dy=e.end.y-e.start.y,len=Math.hypot(dx,dy);if(len<1e-6)continue;const nx=-dy/len*e.thickness/2,ny=dx/len*e.thickness/2,base=storyElevation+(e.baseOffset||0),openings=mergeHostedOpeningRecords(e.openings,hostedOpeningsByWall.get(e.id)||[]);const junctionCuts=wallCrossingCutsByWall.get(e.id)||[];const cuts=[0,len];for(const o of openings){cuts.push(Math.max(0,Math.min(len,o.offset)),Math.max(0,Math.min(len,o.offset+o.width)))}for(const cut of junctionCuts)cuts.push(cut.start,cut.end);const positions=[...new Set(cuts.filter(Number.isFinite).sort((u,v)=>u-v).map(v=>Number(v.toFixed(6))))];for(let i=0;i<positions.length-1;i++){const lo=positions[i],hi=positions[i+1];if(hi-lo<1e-5)continue;const mid=(lo+hi)/2;if(junctionCuts.some(cut=>mid>cut.start-1e-7&&mid<cut.end+1e-7))continue;const holes=openings.filter(o=>o.offset<mid&&o.offset+o.width>mid).map(o=>[Math.max(0,o.sill||0),Math.min(e.height,(o.sill||0)+o.height)]).filter(v=>v[1]>v[0]).sort((u,v)=>u[0]-v[0]);const merged=[];for(const hole of holes){const last=merged[merged.length-1];if(last&&hole[0]<=last[1])last[1]=Math.max(last[1],hole[1]);else merged.push([...hole])}const solids=[];let z=0;for(const hole of merged){if(hole[0]>z)solids.push([z,hole[0]]);z=Math.max(z,hole[1])}if(z<e.height)solids.push([z,e.height]);const at=t=>({x:e.start.x+dx*t/len,y:e.start.y+dy*t/len});
const crossingCornerKey=(distance,side)=>e.id+":"+Number(distance.toFixed(6))+":"+side;
const crossingCorner=(cut,boundary,side)=>{
 const targetDistance=boundary==="start"?cut.start:cut.end,key=crossingCornerKey(targetDistance,side);
 const cached=wallCrossingCornerCache.get(key);if(cached)return cached.point;
 const point=at(targetDistance),atStart=boundary==="end";
 const virtualWall=boundary==="start"?{...e,start:e.start,end:point}:{...e,start:point,end:e.end};
 const host=cut.hostWall,hdx=host.end.x-host.start.x,hdy=host.end.y-host.start.y,h2=hdx*hdx+hdy*hdy,hostLen=Math.sqrt(h2);
 if(hostLen<1e-8){const fallback={x:point.x+nx*side,y:point.y+ny*side};wallCrossingCornerCache.set(key,{point:fallback,resolved:false});return fallback}
 const rawT=((point.x-host.start.x)*hdx+(point.y-host.start.y)*hdy)/h2,param=Math.max(0,Math.min(1,rawT));
 const closest={x:host.start.x+hdx*param,y:host.start.y+hdy*param};
 const alignment=Math.abs(cross2({x:dx,y:dy},{x:hdx,y:hdy}))/(len*hostLen||1);
 const candidate={neighbor:host,neighborT:param,closest,isT:true,distance:Math.hypot(point.x-closest.x,point.y-closest.y),alignment};
 const resolved=resolveWallEndCorner(virtualWall,atStart,side,[candidate],{endpointTolerance,maxMiterRatio:8});
 if(resolved.resolved)wallCrossingResolvedCorners.add(key);
 wallCrossingCornerCache.set(key,{point:resolved.point,resolved:resolved.resolved});
 return resolved.point;
};
const cornerAt=(distance,side)=>{
 if(distance<=endpointTolerance)return wallEndCorner(e,true,side);
 if(len-distance<=endpointTolerance)return wallEndCorner(e,false,side);
 for(const cut of junctionCuts){
  if(Math.abs(distance-cut.start)<1e-5)return crossingCorner(cut,"start",side);
  if(Math.abs(distance-cut.end)<1e-5)return crossingCorner(cut,"end",side);
 }
 const q=at(distance);return{x:q.x+nx*side,y:q.y+ny*side};
};
const crossingResolved=(distance)=>[-1,1].every(side=>wallCrossingResolvedCorners.has(crossingCornerKey(distance,side)));
for(const [low,high] of solids){
 const poly=[cornerAt(lo,1),cornerAt(hi,1),cornerAt(hi,-1),cornerAt(lo,-1)],skipSides=[],skipTopEdges=[];
 // Opening-boundary end caps are internal wall faces, not exterior surfaces.
 // Suppress their vertical caps to avoid persistent full-height stripes.
 const openingBoundaryAt=distance=>openings.some(o=>
  Math.abs((Number(o.offset)||0)-distance)<1e-5||
  Math.abs((Number(o.offset)||0)+(Number(o.width)||0)-distance)<1e-5
 );
 if(openingBoundaryAt(lo)){skipSides.push(3);skipTopEdges.push(3)}
 if(openingBoundaryAt(hi)){skipSides.push(1);skipTopEdges.push(1)}
 if(lo<=endpointTolerance&&wallEndResolvedCorners.has(e.id+":start:1")&&wallEndResolvedCorners.has(e.id+":start:-1")){skipSides.push(3);skipTopEdges.push(3)}
 if(hi>=len-endpointTolerance&&wallEndResolvedCorners.has(e.id+":end:1")&&wallEndResolvedCorners.has(e.id+":end:-1")){skipSides.push(1);skipTopEdges.push(1)}
 const startCut=junctionCuts.find(cut=>Math.abs(lo-cut.end)<1e-5);
 const endCut=junctionCuts.find(cut=>Math.abs(hi-cut.start)<1e-5);
 // A junction cut is an internal join, never a physical wall end. Do not
 // render a thickness cap there: if miter resolution falls back, the cap
 // becomes the conspicuous vertical strip at the wall intersection.
 if(startCut){skipSides.push(3);skipTopEdges.push(3)}
 if(endCut){skipSides.push(1);skipTopEdges.push(1)}
 prism(e,poly,base+low,high-low,undefined,{skipSides,skipTopEdges,wallSegment:{lo,hi,length:len,zLow:low,zHigh:high,openings:openings.map(o=>({offset:Number(o.offset)||0,width:Number(o.width)||0,sill:Number(o.sill)||0,height:Number(o.height)||0}))}});
} }continue}else if(e.type==="beam"){const dx=e.end.x-e.start.x,dy=e.end.y-e.start.y,len=Math.hypot(dx,dy);if(len<1e-6)continue;const nx=-dy/len*e.width/2,ny=dx/len*e.width/2;footprint=[{x:e.start.x+nx,y:e.start.y+ny},{x:e.end.x+nx,y:e.end.y+ny},{x:e.end.x-nx,y:e.end.y-ny},{x:e.start.x-nx,y:e.start.y-ny}];z0+=e.elevation||0;height=e.depth}
else if(e.type==="column"){const angle=e.rotation||0,cos=Math.cos(angle),sin=Math.sin(angle),hx=e.width/2,hy=e.depth/2;footprint=[[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy]].map(([u,v])=>({x:e.position.x+u*cos-v*sin,y:e.position.y+u*sin+v*cos}));height=e.height}
else{footprint=e.boundary;z0+=e.elevation||0;height=e.thickness}
prism(e,footprint,z0,height)
}
const orderedFaces=faces3d.sort((a,b)=>a.depth-b.depth);
// Top faces are independently emitted by each wall prism. At a junction their
// coplanar footprints overlap or share a boundary, so blindly stroking every
// top polygon draws false white seams across a continuous wall cap.
// Index top faces in model-space cells so cap-edge visibility checks only
// inspect nearby faces instead of rescanning every wall cap at the same level.
// This keeps redraw/orbit cost bounded as models gain more walls and openings.
const topFaceGridSize=4,topFaceSpatialBuckets=new Map();
const topFaceCellKey=(elevation,x,y)=>elevation+":"+x+":"+y;
const topFaceCellRange=(min,max)=>[Math.floor((min-.001)/topFaceGridSize),Math.floor((max+.001)/topFaceGridSize)];
const indexTopFace=(face)=>{
 const elevation=Math.round(face.poly[0].worldZ*1000);
 const xs=face.poly.map(pt=>pt.worldX),ys=face.poly.map(pt=>pt.worldY);
 const [minX,maxX]=topFaceCellRange(Math.min(...xs),Math.max(...xs));
 const [minY,maxY]=topFaceCellRange(Math.min(...ys),Math.max(...ys));
 for(let ix=minX;ix<=maxX;ix++)for(let iy=minY;iy<=maxY;iy++){
  const key=topFaceCellKey(elevation,ix,iy);
  if(!topFaceSpatialBuckets.has(key))topFaceSpatialBuckets.set(key,[]);
  topFaceSpatialBuckets.get(key).push(face);
 }
};
for(const face of orderedFaces){
 if(face.material==="wall"&&face.topFace&&face.poly.length>=3)indexTopFace(face);
}
const topFaceEdgeCovered=(face,a,b)=>{
 const elevation=Math.round(a.worldZ*1000),start={x:a.worldX,y:a.worldY},end={x:b.worldX,y:b.worldY};
 const [minX,maxX]=topFaceCellRange(Math.min(start.x,end.x),Math.max(start.x,end.x));
 const [minY,maxY]=topFaceCellRange(Math.min(start.y,end.y),Math.max(start.y,end.y));
 const candidates=new Set();
 for(let ix=minX;ix<=maxX;ix++)for(let iy=minY;iy<=maxY;iy++){
  for(const other of topFaceSpatialBuckets.get(topFaceCellKey(elevation,ix,iy))||[])candidates.add(other);
 }
 for(const other of candidates){
  if(other===face||Math.abs(other.poly[0].worldZ-a.worldZ)>.001)continue;
  if(segmentCoveredByPolygon2D(start,end,other.poly.map(pt=>({x:pt.worldX,y:pt.worldY})),{tolerance:.001}))return true;
 }
 return false;
};
const wallSideEdges=new Map();
const edgePointKey=pt=>[pt.worldX,pt.worldY,pt.worldZ].map(v=>Number(v).toFixed(6)).join(",");
const edgeKey=(a,b)=>{const ka=edgePointKey(a),kb=edgePointKey(b);return ka<kb?ka+"|"+kb:kb+"|"+ka};
// Keep face incidence, not just a Set of element IDs: several split faces from
// one wall can share an edge. Only suppress the seam when those faces are
// coplanar; preserve genuine jamb/reveal and corner edges.
const faceNormal=face=>{
 const a=face.poly[0],b=face.poly[1],c=face.poly[2];
 const ux=b.worldX-a.worldX,uy=b.worldY-a.worldY,uz=b.worldZ-a.worldZ;
 const vx=c.worldX-a.worldX,vy=c.worldY-a.worldY,vz=c.worldZ-a.worldZ;
 const n={x:uy*vz-uz*vy,y:uz*vx-ux*vz,z:ux*vy-uy*vx};
 const length=Math.hypot(n.x,n.y,n.z)||1;
 return {x:n.x/length,y:n.y/length,z:n.z/length};
};
const wallFaceNormals=new Map();
for(const face of orderedFaces){
 if(face.material!=="wall"||face.topFace)continue;
 const normal=faceNormal(face);wallFaceNormals.set(face,normal);
 for(let i=0;i<face.poly.length;i++){
  const key=edgeKey(face.poly[i],face.poly[(i+1)%face.poly.length]);
  if(!wallSideEdges.has(key))wallSideEdges.set(key,[]);
  wallSideEdges.get(key).push(face);
 }
}
const coplanarWallFaceBuckets=new Map();
const canonicalPlane=face=>{
 const n=wallFaceNormals.get(face);if(!n)return null;
 let sign=1;for(const component of [n.x,n.y,n.z]){if(Math.abs(component)>1e-5){sign=component<0?-1:1;break}}
 const normal={x:n.x*sign,y:n.y*sign,z:n.z*sign},p=face.poly[0];
 const d=normal.x*p.worldX+normal.y*p.worldY+normal.z*p.worldZ;
 const normalKey=[normal.x,normal.y,normal.z].map(v=>Math.round(v*100000)).join(",");
 // Bucket by orientation only. Plane offsets are compared with a tolerance
 // below; quantizing d in the key can split two coplanar faces at rounding
 // boundaries and leave the internal seam visible.
 return {normal,d,key:normalKey};
};
const facePlaneKeys=new Map();
for(const face of wallFaceNormals.keys()){
 const plane=canonicalPlane(face);if(!plane)continue;
 facePlaneKeys.set(face,plane);
 if(!coplanarWallFaceBuckets.has(plane.key))coplanarWallFaceBuckets.set(plane.key,[]);
 coplanarWallFaceBuckets.get(plane.key).push(face);
}
for(const face of orderedFaces){
 const base=materialColors[face.material]||materialColors.wall;
 ctx.fillStyle=face.selected?(face.topFace?"#bce3e6":"#9acbd0"):(base.startsWith("#")?shadeHex(base,face.shade||0):base);
 ctx.strokeStyle=face.selected?"#087e8b":face.material==="glass"?"#5896a5":face.material==="door"?"#876044":"#71808a";
 ctx.lineWidth=face.selected?1.6:face.material==="glass"?.7:.8;
 ctx.shadowColor="transparent";ctx.shadowBlur=0;ctx.shadowOffsetX=0;ctx.shadowOffsetY=0;
 ctx.beginPath();face.poly.forEach((pt,i)=>i?ctx.lineTo(pt.x,pt.y):ctx.moveTo(pt.x,pt.y));ctx.closePath();ctx.fill();
 if(face.material!=="wall"||face.topFace||face.selected){
  if(face.material==="wall"&&face.topFace&&!face.selected){
   for(let i=0;i<face.poly.length;i++){
    if(face.skipTopEdges?.includes(i))continue;
    const a=face.poly[i],b=face.poly[(i+1)%face.poly.length];
    if(topFaceEdgeCovered(face,a,b))continue;
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
   }
  }else ctx.stroke();
  continue
 }
 for(let i=0;i<face.poly.length;i++){
  const a=face.poly[i],b=face.poly[(i+1)%face.poly.length];
  // The wall skin is emitted as separate prisms for openings and junction
  // cuts. Vertical edges at those internal stations are tessellation seams,
  // not physical edges; opening frames/reveals and resolved junction geometry
  // provide the real boundaries. Keep strokes only at actual source-wall ends.
  const ws=face.wallSegment,side=face.wallSideIndex;
  if(ws&&(side===0||side===2)&&(i===0||i===2)){
   const edgeZ=Math.abs(a.worldZ-b.worldZ)<=.001?(a.worldZ+b.worldZ)/2:NaN;
   const openingBoundary=ws.openings?.some(o=>{
    const inside=ws.lo>=o.offset-1e-4&&ws.hi<=o.offset+o.width+1e-4;
    return inside&&(Math.abs(edgeZ-(o.sill||0))<.001||Math.abs(edgeZ-((o.sill||0)+o.height))<.001);
   });
   if(openingBoundary)continue;
  }
  if(ws&&(side===0||side===2)&&(i===1||i===3)){
   const distance=side===0?(i===1?ws.hi:ws.lo):(i===1?ws.lo:ws.hi);
   const endpointTolerance=1e-4;
   const atWallStart=Math.abs(distance)<endpointTolerance;
   const atWallEnd=Math.abs(distance-ws.length)<endpointTolerance;
   const isPhysicalWallEnd=atWallStart||atWallEnd;
   if(!isPhysicalWallEnd)continue;
   // Joined source endpoints are internal junction edges, not exposed
   // silhouettes. Suppress the vertical stroke using the same endpoint
   // neighbour graph that resolved the wall geometry.
   const endpointKey=face.id+":"+(atWallStart?"start":"end");
   if((wallEndNeighbors.get(endpointKey)||[]).length)continue;
  }
  const owners=wallSideEdges.get(edgeKey(a,b))||[];
  const normal=wallFaceNormals.get(face);
  const edgeVec={x:b.worldX-a.worldX,y:b.worldY-a.worldY,z:b.worldZ-a.worldZ};
  const edgeLength=Math.hypot(edgeVec.x,edgeVec.y,edgeVec.z)||1;
  const exactSharedCoplanarEdge=owners.some(other=>{
   if(other===face)return false;
   const otherNormal=wallFaceNormals.get(other);
   return !!otherNormal&&!!normal&&Math.abs(normal.x*otherNormal.x+normal.y*otherNormal.y+normal.z*otherNormal.z)>.99999;
  });
  let containedCoplanarEdge=false;
  if(!exactSharedCoplanarEdge){
   const plane=facePlaneKeys.get(face),candidates=plane?(coplanarWallFaceBuckets.get(plane.key)||[]):[];
   const normal=wallFaceNormals.get(face);
   const dropAxis=Math.abs(normal.x)>Math.abs(normal.y)?(Math.abs(normal.x)>Math.abs(normal.z)?"x":"z"):(Math.abs(normal.y)>Math.abs(normal.z)?"y":"z");
   const uv=pt=>dropAxis==="x"?{x:pt.worldY,y:pt.worldZ}:dropAxis==="y"?{x:pt.worldX,y:pt.worldZ}:{x:pt.worldX,y:pt.worldY};
   const start2=uv(a),end2=uv(b);
   for(const other of candidates){
    if(other===face)continue;
    const otherPlane=facePlaneKeys.get(other);
    if(!otherPlane||Math.abs(plane.normal.x*otherPlane.normal.x+plane.normal.y*otherPlane.normal.y+plane.normal.z*otherPlane.normal.z)<.99999||Math.abs(plane.d-otherPlane.d)>.001)continue;
    if(segmentCoveredByPolygon2D(start2,end2,other.poly.map(uv),{tolerance:.001})){containedCoplanarEdge=true;break}
   }
  }
  const sharedCoplanarEdge=exactSharedCoplanarEdge||containedCoplanarEdge;
  if(sharedCoplanarEdge)continue;
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
 }
}
hitPolys3d=faces3d.map(({id,poly,depth})=>({id,poly,depth}));
}
function renderFloorPlanElements(ctx,items,pointAt,scaleFactor,options={}){
for(const e of items){if(e.type==="text"&&window.__arqInlineTextEditingId){const activeText=window.__arqInlineTextEditing;const sameText=activeText&&e.position&&activeText.position&&Math.abs(e.position.x-activeText.position.x)<1e-6&&Math.abs(e.position.y-activeText.position.y)<1e-6&&String(e.text||"")===String(activeText.text||"");if(e.id===window.__arqInlineTextEditingId||sameText)continue;}const isSel=!!options.interactive&&selected.has(e.id),isHover=!!options.interactive&&hoveredElementId===e.id&&!isSel;ctx.strokeStyle=isSel?"#087e8b":isHover?"#d97706":e.type==="room"?"#6aa5a8":"#4b5660";ctx.fillStyle=e.type==="room"?"rgba(217,240,242,.28)":"#e9eef0";ctx.lineWidth=isSel?2:isHover?1.8:1;
if(e.type==="gridline"){const a=pointAt(e.start),b=pointAt(e.end);ctx.save();ctx.strokeStyle=isSel?"#087e8b":"#6d8296";ctx.fillStyle="#fff";ctx.lineWidth=isSel?2:1.2;ctx.setLineDash([7,4]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);const markerFlags=e.markerSides||{start:true,end:false};const markerPoints=[];if(markerFlags.start)markerPoints.push([a,e.label||"A"]);if(markerFlags.end)markerPoints.push([b,e.label||"A"]);for(const [pt,label] of markerPoints){const markerRadius=10;ctx.beginPath();ctx.arc(pt.x,pt.y,markerRadius,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle=isSel?"#087e8b":"#526779";ctx.font="bold 11px Arial";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(String(label),pt.x,pt.y);ctx.fillStyle="#fff"}ctx.restore()}
else if(e.type==="wall"||e.type==="beam"){const a=pointAt(e.start),b=pointAt(e.end),dx=b.x-a.x,dy=b.y-a.y,screenLen=Math.hypot(dx,dy),ux=dx/(screenLen||1),uy=dy/(screenLen||1),nx=-uy,ny=ux,thick=Math.max(1,(e.type==="wall"?e.thickness:e.width)*scaleFactor);ctx.lineWidth=thick;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();if(e.type==="wall"){const hostedOpenings=[...(e.openings||[])];for(const hosted of items){if((hosted.type==="door"||hosted.type==="window")&&hosted.hostWallId===e.id&&!hostedOpenings.some(opening=>opening.id===hosted.id))hostedOpenings.push(hosted)}for(const o of[...hostedOpenings,...(options.includePending&&pendingOpeningPlacement?.wallId===e.id?[pendingOpeningPlacement]:[])]){const len=wallLength(e),startT=Math.max(0,Math.min(1,o.offset/(len||1))),endT=Math.max(startT,Math.min(1,(o.offset+o.width)/(len||1))),p1={x:a.x+dx*startT,y:a.y+dy*startT},p2={x:a.x+dx*endT,y:a.y+dy*endT},mid={x:(p1.x+p2.x)/2,y:(p1.y+p2.y)/2},radius=Math.hypot(p2.x-p1.x,p2.y-p1.y);ctx.save();ctx.lineCap="butt";ctx.strokeStyle="#fff";ctx.lineWidth=thick+3;ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.stroke();ctx.lineWidth=1.5;ctx.strokeStyle=o.type==="door"?"#a86f42":"#2796aa";if(o.type==="window"){ctx.beginPath();ctx.moveTo(p1.x+nx*(thick*.28),p1.y+ny*(thick*.28));ctx.lineTo(p2.x+nx*(thick*.28),p2.y+ny*(thick*.28));ctx.moveTo(p1.x-nx*(thick*.28),p1.y-ny*(thick*.28));ctx.lineTo(p2.x-nx*(thick*.28),p2.y-ny*(thick*.28));if((o.libraryType||"single-leaf")==="double-leaf"){const mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2;ctx.moveTo(mx+nx*(thick*.42),my+ny*(thick*.42));ctx.lineTo(mx-nx*(thick*.42),my-ny*(thick*.42))}ctx.stroke()}else{const wallDx=e.end.x-e.start.x,wallDy=e.end.y-e.start.y,modelP1={x:e.start.x+wallDx*startT,y:e.start.y+wallDy*startT},modelP2={x:e.start.x+wallDx*endT,y:e.start.y+wallDy*endT};const drawLeaf=(pA,pB,hingeSide)=>{const g=doorSwingGeometry(pA,pB,{hingeSide,swingDirection:o.swingDirection}),hinge=pointAt(g.hinge),openFree=pointAt(g.openFree);ctx.beginPath();ctx.moveTo(hinge.x,hinge.y);ctx.lineTo(openFree.x,openFree.y);ctx.stroke();ctx.beginPath();for(let step=0;step<=24;step++){const angle=g.startAngle+(g.endAngle-g.startAngle)*step/24,pt=pointAt({x:g.hinge.x+Math.cos(angle)*g.radius,y:g.hinge.y+Math.sin(angle)*g.radius});if(step===0)ctx.moveTo(pt.x,pt.y);else ctx.lineTo(pt.x,pt.y)}ctx.stroke()};if((o.libraryType||"single-leaf")==="double-leaf"){const mid={x:(modelP1.x+modelP2.x)/2,y:(modelP1.y+modelP2.y)/2};drawLeaf(modelP1,mid,"left");drawLeaf(mid,modelP2,"right")}else drawLeaf(modelP1,modelP2,o.hingeSide||"left")}ctx.restore()}}ctx.lineWidth=1}
else if(e.type==="slab"||e.type==="room"||e.type==="roof"){ctx.beginPath();e.boundary.forEach((v,i)=>{const q=pointAt(v);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y)});ctx.closePath();ctx.fillStyle=e.type==="roof"?"rgba(181,121,76,.2)":e.type==="room"?"rgba(217,240,242,.28)":"#e9eef0";ctx.fill();ctx.stroke();if(e.type==="roof"&&e.boundary.length>=3){const center={x:e.boundary.reduce((s,v)=>s+v.x,0)/e.boundary.length,y:e.boundary.reduce((s,v)=>s+v.y,0)/e.boundary.length},peak=pointAt(center);ctx.save();ctx.strokeStyle=isSel?"#087e8b":"#a86f42";ctx.setLineDash([5,3]);ctx.beginPath();for(const v of e.boundary){const q=pointAt(v);ctx.moveTo(q.x,q.y);ctx.lineTo(peak.x,peak.y)}ctx.stroke();ctx.setLineDash([]);ctx.restore()}if(e.type==="room"){const q=pointAt(e.labelPosition||e.center||e.boundary[0]),areaText=formatArea(Number(e.area)||polygonArea(e.boundary),unitSystem()),name=String(e.roomName||e.name||"").trim();ctx.save();ctx.fillStyle="#315e64";ctx.font="bold 12px Arial";ctx.textAlign="center";ctx.textBaseline="middle";const zoneNumber=String(e.zoneNumber||"").trim();const annotationScale=options.annotationScale||((scale*drawingScaleDenominator)/1000),zoneFont=2.5*annotationScale,nameFont=3*annotationScale,areaFont=2.5*annotationScale,labelGap=3.5*annotationScale;if(zoneNumber){ctx.font=zoneFont+"px Arial";ctx.fillStyle="#647b80";ctx.fillText(zoneNumber,q.x,q.y-labelGap*1.35)}if(name){ctx.font="bold "+nameFont+"px Arial";ctx.fillStyle="#315e64";ctx.fillText(name,q.x,q.y-labelGap*.45)}ctx.font=areaFont+"px Arial";ctx.fillStyle="#315e64";ctx.fillText(areaText,q.x,q.y+(name?labelGap*.65:0));ctx.textAlign="start";ctx.textBaseline="alphabetic";ctx.restore()}}
else if(e.type==="column"){const q=pointAt(e.position);ctx.fillRect(q.x-e.width*scaleFactor/2,q.y-e.depth*scaleFactor/2,e.width*scaleFactor,e.depth*scaleFactor);ctx.strokeRect(q.x-e.width*scaleFactor/2,q.y-e.depth*scaleFactor/2,e.width*scaleFactor,e.depth*scaleFactor)}
else if(e.type==="dimension"){const a=pointAt(e.start),b=pointAt(e.end),wa=e.witnessStart?pointAt(e.witnessStart):a,wb=e.witnessEnd?pointAt(e.witnessEnd):b,dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len,nx=-uy,ny=ux,vertical=Math.abs(dy)>Math.abs(dx),label=formatLength(Math.hypot(e.end.x-e.start.x,e.end.y-e.start.y),unitSystem());ctx.save();ctx.strokeStyle=isSel?"#087e8b":"#69747e";ctx.fillStyle="#39444e";ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(wa.x,wa.y);ctx.lineTo(a.x,a.y);ctx.moveTo(wb.x,wb.y);ctx.lineTo(b.x,b.y);ctx.moveTo(a.x-nx*4,a.y-ny*4);ctx.lineTo(a.x+nx*4,a.y+ny*4);ctx.moveTo(b.x-nx*4,b.y-ny*4);ctx.lineTo(b.x+nx*4,b.y+ny*4);ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();const annotationScale=options.annotationScale||((scale*drawingScaleDenominator)/1000),dimensionFont=Math.max(.5,Number(e.textSizeMm)||2.5)*annotationScale,dimensionTextWidth=Math.max(12*annotationScale,label.length*dimensionFont*.58),dimensionTextHeight=1.25*dimensionFont;ctx.font=dimensionFont+"px Arial";ctx.textAlign="center";ctx.textBaseline="middle";const midX=(a.x+b.x)/2,midY=(a.y+b.y)/2,labelOffset=3.5*annotationScale,labelX=midX+nx*labelOffset,labelY=midY+ny*labelOffset;if(vertical){ctx.translate(labelX,labelY);ctx.rotate(Math.atan2(dy,dx));ctx.fillStyle="#fff";ctx.fillRect(-dimensionTextWidth/2,-dimensionTextHeight/2,dimensionTextWidth,dimensionTextHeight);ctx.fillStyle="#39444e";ctx.fillText(label,0,0)}else{ctx.fillStyle="#fff";ctx.fillRect(labelX-dimensionTextWidth/2,labelY-dimensionTextHeight/2,dimensionTextWidth,dimensionTextHeight);ctx.fillStyle="#39444e";ctx.fillText(label,labelX,labelY)}ctx.restore()}
else if(e.type==="text"&&e.position){const q=pointAt(e.position),annotationScale=options.annotationScale||((scale*drawingScaleDenominator)/1000),font=Math.max(.5,Number(e.textSizeMm)||2.5)*annotationScale,lines=String(e.text||"Text").split("\n"),family=e.fontFamily||"Arial",weight=e.bold?"bold":"normal",style=e.italic?"italic":"normal";ctx.save();ctx.font=style+" "+weight+" "+font+"px "+JSON.stringify(family);ctx.textAlign=["center","right"].includes(e.alignment)?e.alignment:"left";ctx.textBaseline="top";ctx.fillStyle=isSel?"#087e8b":(e.color||"#263640");const naturalWidth=Math.max(8,...lines.map(line=>ctx.measureText(line).width)),width=e.alignment==="justify"?Math.max(naturalWidth,Math.max(10,Number(e.textWidthMm)||40)*annotationScale):naturalWidth,height=Math.max(font,lines.length*font*1.25),left=e.alignment==="center"?q.x-width/2:e.alignment==="right"?q.x-width:q.x;lines.forEach((line,i)=>{const y=q.y+i*font*1.25;if(e.alignment==="justify"&&i<lines.length-1&&line.trim().includes(" ")){const words=line.trim().split(/\s+/),spaces=Math.max(1,words.length-1),wordWidth=words.reduce((sum,word)=>sum+ctx.measureText(word).width,0),targetWidth=width;let cursor=q.x;const gap=(targetWidth-wordWidth)/spaces;for(const word of words){ctx.fillText(word,cursor,y);cursor+=ctx.measureText(word).width+gap}}else ctx.fillText(line,q.x,y);if(e.underline){const measured=ctx.measureText(line).width,ux=e.alignment==="center"?q.x-measured/2:e.alignment==="right"?q.x-measured:q.x;ctx.beginPath();ctx.lineWidth=Math.max(.6,font*.045);ctx.moveTo(ux,y+font*1.08);ctx.lineTo(ux+measured,y+font*1.08);ctx.strokeStyle=isSel?"#087e8b":(e.color||"#263640");ctx.stroke()}});if(isSel){ctx.strokeStyle="#087e8b";ctx.setLineDash([3,2]);ctx.strokeRect(left-3,q.y-3,width+6,height+6)}ctx.restore()}
}
}
function redraw(){syncSelection();updateEditActions();if(!document.querySelector('[data-navpanel="layers"]')?.hidden)renderLayerPanel();const w=c.clientWidth,h=c.clientHeight;if(!w||!h)return;const pixelRatio=window.devicePixelRatio||1;if(c.width!==Math.round(w*pixelRatio)||c.height!==Math.round(h*pixelRatio)){c.width=Math.max(1,Math.round(w*pixelRatio));c.height=Math.max(1,Math.round(h*pixelRatio))}x.setTransform(pixelRatio,0,0,pixelRatio,0,0);x.clearRect(0,0,w,h);x.fillStyle="#fff";x.fillRect(0,0,w,h);
if(layoutMode){renderLayoutCanvas(w,h);return;}
if(view==="floor"){const baseStep=Math.max(.1,Number($("grid")?.value)||.5),basePx=baseStep*scale;let displayStep=baseStep;while(displayStep*scale<12)displayStep*=2;while(displayStep*scale>96&&displayStep>baseStep)displayStep/=2;const gridPx=displayStep*scale,majorEvery=5,majorPx=gridPx*majorEvery;if(gridVisible){const ox=w/2+origin.x,oy=h/2+origin.y;const drawGridLines=(step,major)=>{const px=step*scale;if(px<3)return;x.beginPath();const startX=((ox%px)+px)%px,startY=((oy%px)+px)%px;for(let a=startX;a<w;a+=px){const index=Math.round((a-ox)/px);if(major&&Math.abs(index)%majorEvery!==0)continue;if(!major&&Math.abs(index)%majorEvery===0)continue;x.moveTo(a,0);x.lineTo(a,h)}for(let a=startY;a<h;a+=px){const index=Math.round((a-oy)/px);if(major&&Math.abs(index)%majorEvery!==0)continue;if(!major&&Math.abs(index)%majorEvery===0)continue;x.moveTo(0,a);x.lineTo(w,a)}x.stroke()};x.lineWidth=1;x.strokeStyle="#f0f2f4";drawGridLines(displayStep,false);x.strokeStyle="#dce2e7";drawGridLines(displayStep,true);if(majorPx<48){x.strokeStyle="#dce2e7";drawGridLines(displayStep*majorEvery,true)}}
renderFloorPlanElements(x,els().filter(e=>e.storyId===story().id&&isLayerVisible(e)),spos,scale,{interactive:true,includePending:true});

const activeHandleGesture=activeEditGesture();
const activeHandleId=activeHandleGesture?.elementId||(activeHandleGesture?.elementIds?.length===1?activeHandleGesture.elementIds[0]:null)||(selected.size===1?[...selected][0]:null);
if(tool==="select"&&activeHandleId){
 const el=els().find(v=>v.id===activeHandleId&&v.storyId===story().id&&isLayerVisible(v));
 if(el){
  let points=[];
  if(["wall","beam","dimension","gridline"].includes(el.type))points=[el.start,el.end];
  else if(["slab","roof"].includes(el.type))points=el.boundary||[];
  else if(el.type==="column")points=[el.position];
  else if(["door","window"].includes(el.type)){
   const host=els().find(v=>v.id===el.hostWallId&&v.type==="wall");
   if(host){const len=wallLength(host),at=off=>({x:host.start.x+(host.end.x-host.start.x)*off/(len||1),y:host.start.y+(host.end.y-host.start.y)*off/(len||1)});points=[at(el.offset),at(el.offset+el.width)]}
  }
  x.save();x.fillStyle="#fff";x.strokeStyle="#00a6b5";x.lineWidth=2;
  for(const point of points){if(!point)continue;const sp=spos(point);x.beginPath();x.rect(sp.x-4.5,sp.y-4.5,9,9);x.fill();x.stroke()}
  x.restore();
 }
}
// Dimension control points stay visible for every selected dimension, including grouped chains.
if(tool==="select"){
 const selectedDimensions=els().filter(el=>el.type==="dimension"&&selected.has(el.id)&&el.storyId===story().id&&isLayerVisible(el));
 if(selectedDimensions.length){
  x.save();x.fillStyle="#fff";x.strokeStyle="#00a6b5";x.lineWidth=2;
  const seen=new Set();
  for(const el of selectedDimensions){
   for(const point of [el.start,el.end]){
    if(!point)continue;
    const key=point.x+","+point.y;if(seen.has(key))continue;seen.add(key);
    const sp=spos(point);x.beginPath();x.rect(sp.x-4.5,sp.y-4.5,9,9);x.fill();x.stroke();
   }
  }
  x.restore();
 }
}
const marqueeDisplayRect=selectionBoxGesture?{left:Math.min(selectionBoxGesture.startScreen.x,selectionBoxGesture.currentScreen.x),top:Math.min(selectionBoxGesture.startScreen.y,selectionBoxGesture.currentScreen.y),right:Math.max(selectionBoxGesture.startScreen.x,selectionBoxGesture.currentScreen.x),bottom:Math.max(selectionBoxGesture.startScreen.y,selectionBoxGesture.currentScreen.y)}:lastMarqueeRect;if(view==="floor"&&tool==="marquee"&&(marqueeDraftPoints.length||marqueePreviewPoint)){const pts=marqueeDraftPoints.map(spos);if(marqueePreviewPoint)pts.push(spos(marqueePreviewPoint));if(pts.length){x.save();x.strokeStyle="#087e8b";x.fillStyle="rgba(8,126,139,.10)";x.lineWidth=1.5;x.setLineDash([5,3]);x.beginPath();x.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)x.lineTo(pts[i].x,pts[i].y);if(marqueeDraftPoints.length>=3)x.closePath();x.fill();x.stroke();x.restore()}}if(marqueeDisplayRect&&view==="floor"){x.save();x.strokeStyle="#087e8b";x.fillStyle="rgba(8,126,139,.10)";x.lineWidth=1.5;x.setLineDash([5,3]);if(!selectionBoxGesture&&lastMarqueePolygon&&lastMarqueePolygon.length>=3){const poly=lastMarqueePolygon.map(spos);x.beginPath();x.moveTo(poly[0].x,poly[0].y);for(let i=1;i<poly.length;i++)x.lineTo(poly[i].x,poly[i].y);x.closePath();x.fill();x.stroke()}else{const r=marqueeDisplayRect;x.fillRect(r.left,r.top,r.right-r.left,r.bottom-r.top);x.strokeRect(r.left,r.top,r.right-r.left,r.bottom-r.top)}x.restore()}drawWallJunctions();
if(draft.length){const anchor=draft[draft.length-1],raw=mouse?wpos(mouse):anchor,g=Math.max(.1,+$("grid").value||.5),snapped=mouse?(shiftHeld?{x:Math.round(raw.x/g)*g,y:Math.round(raw.y/g)*g}:snapPoint(raw)):anchor,constrained=["wall","beam","dimension","gridline","slab","roof","zone"].includes(tool)?constrain(anchor,snapped,{shiftKey:shiftHeld}):snapped,endpoint=mouse?trackerEndpoint(anchor,constrained):null,previewPoints=draft.map(point=>spos(point));if(endpoint)previewPoints.push(spos(endpoint));x.save();x.setLineDash([4,4]);x.strokeStyle="#087e8b";x.lineWidth=1.25;x.beginPath();previewPoints.forEach((point,index)=>index?x.lineTo(point.x,point.y):x.moveTo(point.x,point.y));if(endpoint&&draft.length>1&&["slab","roof","zone"].includes(tool)){const first=spos(draft[0]);x.lineTo(first.x,first.y)}x.stroke();x.setLineDash([]);x.restore()}
/* Canonical reference overlays for tools whose placement state is not stored in draft[]. */
if(view==="floor"&&pendingOpeningPlacement){
 const anchorPoint=pendingOpeningPlacement.anchorPoint,cursorPoint=pendingOpeningPlacement.cursor;
 if(anchorPoint&&cursorPoint){
  const a=spos(anchorPoint),b=spos(cursorPoint);
  x.save();x.strokeStyle="#087e8b";x.fillStyle="#087e8b";x.lineWidth=1.4;x.setLineDash([5,4]);
  x.beginPath();x.moveTo(a.x,a.y);x.lineTo(b.x,b.y);x.stroke();x.setLineDash([]);
  for(const pt of [a,b]){x.beginPath();x.arc(pt.x,pt.y,3,0,Math.PI*2);x.fill()}
  x.restore();
 }
}
if(view==="floor"&&pendingGridSystem){
 const gs=pendingGridSystem,originPoint=gs.origin,cursorPoint=mouse?wpos(mouse):originPoint;
 if(originPoint&&cursorPoint){
  const a=spos(originPoint),b=spos(cursorPoint),dx=cursorPoint.x-originPoint.x,dy=cursorPoint.y-originPoint.y,len=Math.hypot(dx,dy);
  x.save();x.strokeStyle="#087e8b";x.fillStyle="#087e8b";x.lineWidth=1.25;x.setLineDash([5,4]);
  x.beginPath();x.moveTo(a.x,a.y);x.lineTo(b.x,b.y);x.stroke();x.setLineDash([]);
  x.beginPath();x.arc(a.x,a.y,4,0,Math.PI*2);x.fill();
  if(len>=.1){
   const ux=dx/len,uy=dy/len,vx=-uy,vy=ux,corner=gs.startCorner||"bottom-left",xSign=corner.endsWith("right")?-1:1,ySign=corner.startsWith("top")?-1:1;
   const xs=[0],ys=[0];for(const value of gs.xSpacing||[])xs.push(xs[xs.length-1]+value);for(const value of gs.ySpacing||[])ys.push(ys[ys.length-1]+value);
   const totalX=xs[xs.length-1]||0,totalY=ys[ys.length-1]||0,ext=Math.max(0,Number(gs.extension)||0);
   const pointAtGrid=(gx,gy)=>({x:originPoint.x+ux*gx*xSign+vx*gy*ySign,y:originPoint.y+uy*gx*xSign+vy*gy*ySign});
   x.globalAlpha=.72;x.setLineDash([4,4]);
   for(const gx of xs){const p1=spos(pointAtGrid(gx,-ext)),p2=spos(pointAtGrid(gx,totalY+ext));x.beginPath();x.moveTo(p1.x,p1.y);x.lineTo(p2.x,p2.y);x.stroke()}
   for(const gy of ys){const p1=spos(pointAtGrid(-ext,gy)),p2=spos(pointAtGrid(totalX+ext,gy));x.beginPath();x.moveTo(p1.x,p1.y);x.lineTo(p2.x,p2.y);x.stroke()}
  }
  x.restore();
 }
}
if(view==="floor"&&tool==="column"&&mouse){
 const cursorPoint=activeSnapPoint||wpos(mouse),p=spos(cursorPoint);
 x.save();x.strokeStyle="#087e8b";x.lineWidth=1;x.setLineDash([4,4]);
 x.beginPath();x.moveTo(p.x,0);x.lineTo(p.x,c.clientHeight);x.moveTo(0,p.y);x.lineTo(c.clientWidth,p.y);x.stroke();x.setLineDash([]);
 x.beginPath();x.arc(p.x,p.y,4,0,Math.PI*2);x.fillStyle="#fff";x.fill();x.stroke();x.restore();
}
if(view==="floor"&&activeSnapPoint&&p.settings?.snap!==false){const q=spos(activeSnapPoint);x.save();x.strokeStyle="#00a6b5";x.fillStyle="rgba(0,166,181,.13)";x.lineWidth=1.5;x.beginPath();if(activeSnapPoint.kind==="intersection"){x.moveTo(q.x,q.y-7);x.lineTo(q.x+7,q.y+7);x.lineTo(q.x-7,q.y+7);x.closePath()}else if(activeSnapPoint.kind==="midpoint"){x.moveTo(q.x,q.y-6);x.lineTo(q.x+6,q.y);x.lineTo(q.x,q.y+6);x.lineTo(q.x-6,q.y);x.closePath()}else if(activeSnapPoint.kind==="center"){x.arc(q.x,q.y,5,0,Math.PI*2);x.moveTo(q.x-8,q.y);x.lineTo(q.x+8,q.y);x.moveTo(q.x,q.y-8);x.lineTo(q.x,q.y+8)}else if(activeSnapPoint.kind==="nearest"){x.arc(q.x,q.y,4,0,Math.PI*2);x.moveTo(q.x-7,q.y);x.lineTo(q.x+7,q.y)}else{x.rect(q.x-4,q.y-4,8,8)}x.fill();x.stroke();x.restore()}
if(textBoxGesture&&view==="floor"&&tool==="text"){const g=textBoxGesture,a=g.startScreen,b=g.currentScreen;x.save();x.fillStyle="rgba(8,126,139,.08)";x.strokeStyle="#087e8b";x.lineWidth=1.5;x.setLineDash([5,3]);x.fillRect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(b.x-a.x),Math.abs(b.y-a.y));x.strokeRect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(b.x-a.x),Math.abs(b.y-a.y));x.setLineDash([]);x.restore()}updateTrackerUI();
}else{
const project3d=(pt,z)=>{
const yaw=camera3d.yaw,pitch=camera3d.pitch,cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
const wx=pt.x,wy=pt.y,wz=z;
const rx=wx*cy-wy*sy,ry=wx*sy+wy*cy;
const px=(rx-camera3d.panX)*scale*.72*camera3d.zoom;
const py=((ry-camera3d.panY)*sp-(wz-camera3d.targetZ)*cp)*scale*.72*camera3d.zoom;
return{x:c.clientWidth/2+origin.x+px,y:c.clientHeight*.58+origin.y+py,depth:ry*cp+wz*sp,worldX:wx,worldY:wy,worldZ:wz};
};
render3DScene(x,els(),project3d,{interactive:true});if(draft.length&&tool!=="select"){const anchor=draft[draft.length-1],cursor=mouse?screenToWorld3d(mouse,story().elevation||0):anchor,points=[...draft,cursor].map(pt=>project3d(pt,story().elevation||0));x.save();x.strokeStyle="#087e8b";x.fillStyle="rgba(8,126,139,.12)";x.lineWidth=2;x.setLineDash([5,4]);x.beginPath();points.forEach((pt,i)=>i?x.lineTo(pt.x,pt.y):x.moveTo(pt.x,pt.y));if(tool==="slab"&&draft.length>1){x.closePath();x.fill()}x.stroke();x.setLineDash([]);x.restore()}
$("selectionInfo").textContent=selected.size?selected.size+" selected · "+chosen().map(e=>e.type).join(", "):"No selection";updateHistoryButtons()}}
function startInlineTextEditor(element){
 if(!element||element.type!=="text"||view!=="floor")return false;
 element=els().find(item=>item.id===element.id&&item.type==="text")||element;
 document.getElementById("arqInlineTextEditor")?.remove();window.__arqInlineTextEditing=element;window.__arqInlineTextEditingId=element.id;
 // Redraw immediately after entering edit mode so the original canvas glyphs are removed before the contenteditable is shown.
 redraw();
 const rect=c.getBoundingClientRect(),screen=spos(element.position),annotationScale=Math.max(.1,scale*drawingScaleDenominator/1000),fontPx=Math.max(.5,Number(element.textSizeMm)||2.5)*annotationScale,measureCtx=c.getContext("2d");measureCtx.save();measureCtx.font=(element.italic?"italic ":"")+(element.bold?"bold ":"")+fontPx+"px "+(element.fontFamily||"Arial");const lines=String(element.text||"").split("\n"),naturalTextWidth=Math.max(0,...lines.map(line=>measureCtx.measureText(line).width))+24,textWidth=Math.max(80,Math.min(window.innerWidth-32,Number(element.textWidthMm)>0?Number(element.textWidthMm)*annotationScale:naturalTextWidth));measureCtx.restore();const boxLeft=screen.x;
 const wrap=document.createElement("div");wrap.id="arqInlineTextEditor";wrap.style.cssText="position:fixed;z-index:100000;left:"+Math.max(0,Math.min(window.innerWidth-textWidth-8,rect.left+boxLeft-8))+"px;top:"+Math.max(48,Math.min(window.innerHeight-80,rect.top+screen.y-8))+"px;width:"+textWidth+"px;display:block;overflow:visible;filter:drop-shadow(0 1px 2px rgba(20,35,45,.10));";
 const bar=document.createElement("div");bar.style.cssText="position:absolute;left:0;bottom:calc(100% + 24px);display:flex;align-items:center;gap:3px;flex-wrap:wrap;width:max-content;max-width:min(560px,calc(100vw - 20px));padding:5px;background:#303236;color:#fff;border:1px solid #202226;border-radius:4px;font:12px Arial,sans-serif;box-shadow:0 2px 5px rgba(20,35,45,.18)";
 const makeButton=(label,title,active,action)=>{const b=document.createElement("button");b.type="button";b.textContent=label;b.title=title;b.setAttribute("aria-label",title);b.style.cssText="min-width:26px;height:25px;padding:2px 7px;border:1px solid "+(active?"#168d9a":"#5b6066")+";border-radius:3px;background:"+(active?"#087e8b":"#41454a")+";color:#fff;font:"+(label==="B"?"bold ":"")+(label==="I"?"italic ":"")+"12px Arial,sans-serif;cursor:pointer";b.addEventListener("mousedown",ev=>ev.preventDefault());b.addEventListener("click",action);bar.append(b);return b};
 const family=document.createElement("select");family.setAttribute("aria-label","Text font");family.title="Font family";family.style.cssText="height:25px;max-width:115px;padding:2px 4px;background:#fff;color:#26313b;border:1px solid #aab3ba;border-radius:3px;font:11px Arial,sans-serif";["Arial","Helvetica","Inter","Verdana","Tahoma","Times New Roman","Georgia","Courier New"].forEach(name=>{const o=document.createElement("option");o.value=name;o.textContent=name;family.append(o)});family.value=[...family.options].some(o=>o.value===(element.fontFamily||"Arial"))?(element.fontFamily||"Arial"):"Arial";bar.append(family);
 const size=document.createElement("input");size.type="number";size.min=".5";size.max="100";size.step=".1";size.value=String(Number(element.textSizeMm)||2.5);size.title="Text size on paper (mm)";size.setAttribute("aria-label","Text size in millimetres");size.style.cssText="box-sizing:border-box;width:54px;height:25px;padding:2px 4px;background:#fff;color:#26313b;border:1px solid #aab3ba;border-radius:3px;font:11px Arial,sans-serif";bar.append(size);const mm=document.createElement("span");mm.textContent="mm";mm.style.cssText="font-size:10px;color:#e0e4e7;margin-left:-2px";bar.append(mm);
 const color=document.createElement("input");color.type="color";color.value=/^#[0-9a-f]{6}$/i.test(element.color||"")?element.color:"#263640";color.title="Text color";color.setAttribute("aria-label","Text color");color.style.cssText="width:28px;height:25px;padding:1px;background:#fff;border:1px solid #aab3ba;border-radius:3px";bar.append(color);
 const ruler=document.createElement("div");ruler.setAttribute("aria-hidden","true");ruler.style.cssText="box-sizing:border-box;position:absolute;left:0;top:-19px;width:100%;height:16px;display:flex;align-items:stretch;justify-content:space-between;padding:0 4px;background:#f5f5f5;color:#35383b;border:1px solid #9aa3aa;font:9px Arial,sans-serif;overflow:hidden";ruler.append(...Array.from({length:41},(_,i)=>{const tick=document.createElement("span");tick.style.cssText="box-sizing:border-box;flex:1;position:relative;text-align:center;border-left:1px solid "+(i%5===0?"#747b80":"#c2c6c9")+";padding-top:"+(i%5===0?"2px":"0")+";height:"+(i%5===0?"100%":"45%");tick.textContent=i%5===0?String(i/5):"";return tick}));const input=document.createElement("div");input.id="arqInlineTextValue";input.contentEditable="true";input.setAttribute("role","textbox");input.setAttribute("aria-multiline","true");input.setAttribute("aria-label","Edit text directly on floor plan");input.spellcheck=true;input.textContent=element.text||"";input.style.cssText="box-sizing:border-box;width:100%;min-width:80px;min-height:32px;max-height:45vh;overflow:auto;padding:2px 3px;border:1px solid #087e8b;outline:none;background:rgba(255,255,255,.97);color:"+(element.color||"#263640")+";font:"+(element.italic?"italic ":"")+(element.bold?"bold ":"")+fontPx+"px "+(element.fontFamily||"Arial")+",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.25;text-align:"+(element.alignment||"left")+";cursor:text";
 const controls=document.createElement("div");controls.style.cssText="position:absolute;left:0;top:calc(100% + 3px);display:flex;gap:5px;align-items:center;flex-wrap:wrap;width:max-content;max-width:calc(100vw - 20px);padding:4px 5px;background:#fff;border:1px solid #d2dbe0;border-radius:3px;font:11px Arial,sans-serif;color:#52616b";
 const hint=document.createElement("span");hint.textContent="Enter = new line · ⌘/Ctrl+Enter = finish";const finish=document.createElement("button");finish.type="button";finish.textContent="Finish";finish.style.cssText="padding:4px 8px;border:0;border-radius:3px;background:#087e8b;color:#fff;cursor:pointer";const cancel=document.createElement("button");cancel.type="button";cancel.textContent="Cancel";cancel.style.cssText="padding:4px 8px;border:1px solid #c4cdd3;border-radius:3px;background:#f5f8fa;color:#263640;cursor:pointer";
 controls.append(hint,finish,cancel);wrap.append(input,ruler,bar,controls);document.body.append(wrap);
 const original=structuredClone({text:element.text||"",textSizeMm:element.textSizeMm||2.5,fontFamily:element.fontFamily||"Arial",bold:!!element.bold,italic:!!element.italic,underline:!!element.underline,alignment:element.alignment||"left",color:element.color||"#263640"});let closed=false;hist("Edit Text");
 const readText=()=>input.innerText.replace(/\r/g,"").replace(/\n$/,"");const sync=()=>{if(closed)return;element.text=readText();element.fontFamily=family.value;element.textSizeMm=Math.max(.5,Math.min(100,Number(size.value)||2.5));element.color=color.value;input.style.height="auto";input.style.height=Math.min(Math.max(input.scrollHeight,42),window.innerHeight*.45)+"px";input.style.color=element.color;input.style.fontFamily=element.fontFamily;input.style.fontSize=Math.max(.5,element.textSizeMm*annotationScale)+"px";input.style.fontWeight=element.bold?"bold":"normal";input.style.fontStyle=element.italic?"italic":"normal";input.style.textAlign=element.alignment||"left";scheduleAutoSave();redraw()};
 const styleAction=(key,value)=>{if(key==="alignment"&&value!==element.alignment){const ctx=c.getContext("2d"),oldAlign=element.alignment||"left",lines=String(element.text||"").split("\n");ctx.save();ctx.font=(element.italic?"italic ":"")+(element.bold?"bold ":"")+Math.max(.5,Number(element.textSizeMm)||2.5)*annotationScale+"px "+(element.fontFamily||"Arial");const naturalWidth=Math.max(8,...lines.map(line=>ctx.measureText(line).width)),oldWidth=oldAlign==="justify"?Math.max(naturalWidth,Math.max(10,Number(element.textWidthMm)||40)*annotationScale):naturalWidth,newWidth=value==="justify"?Math.max(naturalWidth,Math.max(10,Number(element.textWidthMm)||40)*annotationScale):naturalWidth,offset=a=>a==="center"?(a==="justify"?newWidth:naturalWidth)/2:a==="right"?naturalWidth:0,oldOffset=oldAlign==="center"?naturalWidth/2:oldAlign==="right"?naturalWidth:0,newOffset=value==="center"?newWidth/2:value==="right"?newWidth:0;ctx.restore();element.position={...element.position,x:element.position.x+(newOffset-oldOffset)/scale}}element[key]=value;boldButton.style.background=element.bold?"#087e8b":"#41454a";italicButton.style.background=element.italic?"#087e8b":"#41454a";underlineButton.style.background=element.underline?"#087e8b":"#41454a";["left","center","right","justify"].forEach((v,i)=>alignButtons[i].style.background=(element.alignment||"left")===v?"#087e8b":"#41454a");sync()};
 const boldButton=makeButton("B","Bold",element.bold,()=>styleAction("bold",!element.bold));const italicButton=makeButton("I","Italic",element.italic,()=>styleAction("italic",!element.italic));const underlineButton=makeButton("U","Underline",element.underline,()=>styleAction("underline",!element.underline));underlineButton.style.textDecoration="underline";
 const alignButtons=["left","center","right","justify"].map((v,i)=>{const b=makeButton("", "Align "+v,element.alignment===v,()=>styleAction("alignment",v));const lines=[[[2,2,13],[2,5,10],[2,8,15],[2,11,8]],[[3,2,14],[5,5,12],[2,8,15],[5,11,12]],[[4,2,15],[7,5,15],[2,8,15],[8,11,15]],[[2,2,15],[2,5,15],[2,8,15],[2,11,15]]][i];b.style.cssText+=";width:25px;min-width:25px;padding:2px 3px;display:flex;align-items:center;justify-content:center";b.innerHTML="<svg width=\"18\" height=\"15\" viewBox=\"0 0 18 15\" aria-hidden=\"true\">"+lines.map(([x1,y,x2])=>"<line x1=\""+x1+"\" y1=\""+y+"\" x2=\""+x2+"\" y2=\""+y+"\" stroke=\"white\" stroke-width=\"1.5\" stroke-linecap=\"square\"/>").join("")+"</svg>";return b});
 family.addEventListener("change",sync);size.addEventListener("change",sync);color.addEventListener("input",sync);input.addEventListener("input",sync);
 const close=apply=>{if(closed)return;closed=true;if(!apply){for(const [key,value] of Object.entries(original))element[key]=value;redraw()}else{element.text=readText();scheduleAutoSave()}wrap.remove();if(window.__arqInlineTextEditingId===element.id){window.__arqInlineTextEditing=null;window.__arqInlineTextEditingId=null}redraw();$("status").textContent=apply?"Text updated":"Text edit cancelled"};
 finish.addEventListener("click",()=>close(true));cancel.addEventListener("click",()=>close(false));
 input.addEventListener("keydown",event=>{if((event.metaKey||event.ctrlKey)&&event.key==="Enter"){event.preventDefault();close(true)}else if(event.key==="Escape"){event.preventDefault();close(false)}});
 
 input.style.height=Math.min(Math.max(input.scrollHeight,Math.max(32,fontPx*1.25+4)),window.innerHeight*.45)+"px";input.focus();const range=document.createRange();range.selectNodeContents(input);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return true
}
function renderProperties(){updateContextUI();const host=$("elementProperties"),info=$("selectionInfo");if(!host)return;const list=chosen();host.innerHTML="";if(info)info.textContent=list.length?list.length+" element"+(list.length===1?"":"s")+" selected":"";if(!list.length){host.replaceChildren();return}if(list.length>1||(list.length===1&&list[0].type==="gridline"&&!!list[0].gridSystemId)){
const type=list.every(e=>e.type===list[0].type)?list[0].type:"mixed";
const multiFields={wall:[["height","Height (m)",.1],["thickness","Thickness (m)",.01],["baseOffset","Base offset (m)",.01]],beam:[["width","Width (m)",.01],["depth","Depth (m)",.01],["elevation","Elevation (m)",.01]],column:[["width","Width (m)",.01],["depth","Depth (m)",.01],["height","Height (m)",.01],["rotation","Rotation (rad)",.01]],slab:[["thickness","Thickness (m)",.01],["elevation","Elevation (m)",.01]],door:[["width","Width (m)",.01],["height","Height (m)",.01],["sill","Sill / Base height (m)",.01]],window:[["width","Width (m)",.01],["height","Height (m)",.01],["sill","Sill / Base height (m)",.01]],dimension:[["textSizeMm","Text size on paper (mm)",.1]],text:[["textSizeMm","Text size on paper (mm)",.1]],roof:[["thickness","Thickness (m)",.01],["elevation","Eaves Height (m)",.01],["offset","Offset (m)",.01],["pitch","Pitch (degrees)",1]]};
const safeFields=(multiFields[type]||[]).filter(([key])=>key==="textSizeMm"?list.every(e=>["dimension","text"].includes(e.type)):list.every(e=>Number.isFinite(e[key])));
const gridSystemId=list[0]?.gridSystemId;
const isGridSystemSelection=!!gridSystemId&&list.every(e=>e.type==="gridline"&&e.gridSystemId===gridSystemId&&["vertical","horizontal"].includes(e.gridSystemAxis)&&Number.isInteger(e.gridSystemIndex));
const gridMembers=isGridSystemSelection?els().filter(e=>e.gridSystemId===gridSystemId):[];
const getGridSpacing=axis=>{const lines=gridMembers.filter(e=>e.type==="gridline"&&e.gridSystemAxis===axis).sort((a,b)=>a.gridSystemIndex-b.gridSystemIndex);return lines.slice(1).map((line,i)=>unitSystem()==="imperial"?formatLength(Math.hypot(line.start.x-lines[i].start.x,line.start.y-lines[i].start.y),"imperial"):(Math.hypot(line.start.x-lines[i].start.x,line.start.y-lines[i].start.y)*1000).toFixed(0)).join(", ")};
const esc=value=>String(value??"").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;").replaceAll(">","&gt;");
host.innerHTML='<p style="color:var(--muted);font-size:11px">'+list.length+' elements selected · '+type+'</p>'+'<div class="field"><label>Classification (apply to all)</label><select id="multiClassification"><option value="">Keep current classifications</option>'+["Architectural","Structural","Mechanical","Electrical","Plumbing","Fire Protection","Landscape","Zone / Space"].map(v=>'<option value="'+v+'">'+v+'</option>').join("")+'</select></div>'+(type==="room"?'<div class="field"><label>Zone number (apply to all)</label><input id="multiZoneNumber" placeholder="Leave blank to keep current"></div><div class="field"><label>Room name (apply to all)</label><input id="multiRoomName" placeholder="Leave blank to keep current"></div><div class="field"><label>Zone category (apply to all)</label><input id="multiZoneCategory" placeholder="Leave blank to keep current"></div>':"")+(type==="text"?'<div class="field"><label>Font family</label><select id="multiFontFamily"><option value="">Keep current</option>'+["Arial","Helvetica","Times New Roman","Georgia","Verdana","Tahoma","Courier New"].map(v=>'<option value="'+v+'">'+v+'</option>').join("")+'</select></div><div class="field"><label>Text alignment</label><select id="multiTextAlignment"><option value="">Keep current</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justify">Justify</option></select></div><div class="field"><label>Text color</label><input id="multiTextColor" type="color" value="#263640"></div><div class="field"><label>Text style</label><div style="display:flex;gap:8px;flex-wrap:wrap"><label><input id="multiTextBold" type="checkbox"> Bold</label><label><input id="multiTextItalic" type="checkbox"> Italic</label><label><input id="multiTextUnderline" type="checkbox"> Underline</label></div><small style="color:var(--muted)">Tick only the styles you want to turn on; leave unchecked to keep each element\'s current style.</small></div>':"")+( ['door','window'].includes(type)?'<div class="field"><label>Position on host wall (apply to all)</label><select id="multiOpeningAlignment"><option value="">Keep current</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div><div class="field"><label>Library / Leaf Configuration</label><select id="multiLibraryType"><option value="">Keep current</option><option value="single-leaf">Single Leaf</option><option value="double-leaf">Double Leaf</option></select></div><div class="field"><label>Hinge / Side</label><select id="multiHinge"><option value="">Keep current</option><option value="left">Left</option><option value="right">Right</option></select></div><div class="field"><label>Opening Direction</label><select id="multiSwing"><option value="">Keep current</option><option value="inside">Inside</option><option value="outside">Outside</option></select></div>':'')+(isGridSystemSelection?'<div class="field grid-interval-field"><label>Vertical intervals · '+(unitSystem()==="imperial"?"ft + in":"mm")+'</label><input id="editGridVertical" aria-label="Vertical grid intervals in millimetres" value="'+getGridSpacing("vertical")+'" style="width:112px;min-width:112px;max-width:112px"></div><div class="field grid-interval-field"><label>Horizontal intervals · '+(unitSystem()==="imperial"?"ft + in":"mm")+'</label><input id="editGridHorizontal" aria-label="Horizontal grid intervals in millimetres" value="'+getGridSpacing("horizontal")+'" style="width:112px;min-width:112px;max-width:112px"></div><button id="applyGridSpacing" type="button" style="align-self:center;white-space:nowrap">Apply</button>':'')+'<div class="field"><label>Building material (applies to all)</label><input id="multiMaterial" placeholder="Leave blank to keep current materials"></div>'+safeFields.map(([key,label,step])=>{const values=list.map(e=>key==="textSizeMm"?(Number(e[key])||2.5):e[key]);const same=values.every(v=>v===values[0]);return '<div class="field"><label>'+label+'</label><input data-multi-prop="'+key+'" type="number" step="'+step+'" value="'+(same?values[0]:"")+'" placeholder="'+(same?"":"Mixed values — enter to apply")+'"></div>'}).join("")+'<button id="applyMultiProps">Apply to selected</button>';
const applyMultiProps=()=>{const inputs=[...host.querySelectorAll("[data-multi-prop]")],values={};for(const input of inputs){if(input.value.trim()==="")continue;const key=input.dataset.multiProp,val=parsePropertyInput(input.value,key,input),positive=["height","thickness","width","depth"].includes(key);if(!Number.isFinite(val)||val<0||(positive&&val===0)){$("status").textContent="Invalid parameter: "+key;return}values[key]=val}const material=$("multiMaterial").value.trim(),classification=$("multiClassification")?.value||"",fontFamily=$("multiFontFamily")?.value||"",textAlignment=$("multiTextAlignment")?.value||"",textColor=$("multiTextColor")?.value||"",textBold=!!$("multiTextBold")?.checked,textItalic=!!$("multiTextItalic")?.checked,textUnderline=!!$("multiTextUnderline")?.checked,zoneNumber=$("multiZoneNumber")?.value.trim()||"",roomName=$("multiRoomName")?.value.trim()||"",zoneCategory=$("multiZoneCategory")?.value.trim()||"",libraryType=$("multiLibraryType")?.value||"",alignment=$("multiOpeningAlignment")?.value||"",hingeSide=$("multiHinge")?.value||"",swingDirection=$("multiSwing")?.value||"";if(type==="text"){if(fontFamily)values.fontFamily=fontFamily;if(textAlignment)values.alignment=textAlignment;if(textColor)values.color=textColor;if(textBold)values.bold=true;if(textItalic)values.italic=true;if(textUnderline)values.underline=true}let spacing=null;const isOpeningBulk=["door","window"].includes(type)&&list.every(e=>e.type===type);const openingUpdates=[];if(isOpeningBulk){for(const element of list){const wall=els().find(v=>v.id===element.hostWallId&&v.type==="wall");if(!wall){$("status").textContent="Cannot bulk-edit an opening without its host wall";return}const len=wallLength(wall),width=Number.isFinite(values.width)?values.width:element.width,changedKey=event?.target?.dataset?.prop||document.activeElement?.dataset?.prop||"",oldWidth=Number(element.width)||width,oldOffset=Number(element.offset)||0,anchorMode=String(alignment||element.alignment||"center").toLowerCase(),anchorPosition=oldOffset+(anchorMode==="left"?0:anchorMode==="right"?oldWidth:oldWidth/2);let offset=Number.isFinite(values.offset)?values.offset:oldOffset;if(changedKey==="width"){offset=anchorPosition-(anchorMode==="left"?0:anchorMode==="right"?width:width/2);offset=Math.max(0,Math.min(Math.max(0,len-width),offset));}else if(changedKey!=="offset")offset=oldOffset;if(!Number.isFinite(width)||width<=0||width>len+1e-8||!Number.isFinite(offset)||offset< -1e-8||offset+width>len+1e-8){$("status").textContent="Bulk opening cannot fit host wall at its fixed anchor";return}openingUpdates.push({element,wall,width,offset,anchorPosition:offset+(anchorMode==="left"?0:anchorMode==="right"?width:width/2)})}}if(isOpeningBulk){if(libraryType)values.libraryType=libraryType;if(hingeSide)values.hingeSide=hingeSide;if(swingDirection)values.swingDirection=swingDirection;if(alignment)values.alignment=alignment}if(isOpeningBulk&&!openingUpdates.length){$("status").textContent="Select at least one hosted Door or Window";return}if(isGridSystemSelection){const parse=id=>$(id).value.split(",").map(v=>v.trim()).filter(v=>v!=="").map(v=>unitSystem()==="imperial"?parseLength(v,"imperial"):Number(v)/1000),vertical=parse("editGridVertical"),horizontal=parse("editGridHorizontal"),verticalLines=gridMembers.filter(e=>e.type==="gridline"&&e.gridSystemAxis==="vertical").sort((a,b)=>a.gridSystemIndex-b.gridSystemIndex),horizontalLines=gridMembers.filter(e=>e.type==="gridline"&&e.gridSystemAxis==="horizontal").sort((a,b)=>a.gridSystemIndex-b.gridSystemIndex);if([...vertical,...horizontal].some(v=>!Number.isFinite(v)||v<=0)||vertical.length!==verticalLines.length-1||horizontal.length!==horizontalLines.length-1){$("status").textContent="Grid distance count mismatch: vertical needs "+Math.max(0,verticalLines.length-1)+" values; horizontal needs "+Math.max(0,horizontalLines.length-1)+" values. All values must be positive.";return}spacing={vertical,horizontal,verticalLines,horizontalLines}}if(!material&&!classification&&!Object.keys(values).length&&!spacing&&!libraryType&&!alignment&&!hingeSide&&!swingDirection&&!textColor&&!textAlignment&&!fontFamily&&!textBold&&!textItalic&&!textUnderline&&!zoneNumber&&!roomName&&!zoneCategory){$("status").textContent="Enter at least one parameter to apply";return}hist("Edit selected elements");const appliedValues={...values};if(isOpeningBulk)delete appliedValues.offset;for(const element of list){Object.assign(element,appliedValues);if(isOpeningBulk){const u=openingUpdates.find(item=>item.element.id===element.id);if(u){element.offset=u.offset;element.width=u.width;element.anchorPosition=u.anchorPosition;element.alignment=alignment||element.alignment||"center";const opening=u.wall.openings?.find(o=>o.id===element.id);if(opening)Object.assign(opening,appliedValues,{offset:u.offset,width:u.width,alignment:element.alignment,anchorPosition:u.anchorPosition});else{u.wall.openings=u.wall.openings||[];u.wall.openings.push({...element,...appliedValues,offset:u.offset,width:u.width,alignment:element.alignment,anchorPosition:u.anchorPosition})}}}if(material)element.buildingMaterial=material;if(classification)element.classification=classification;if(zoneNumber&&element.type==="room")element.zoneNumber=zoneNumber;if(roomName&&element.type==="room"){element.roomName=roomName;element.name=roomName}if(zoneCategory&&element.type==="room")element.zoneCategory=zoneCategory}if(spacing){
const moveAxis=(lines,distances,axis)=>{
if(lines.length<2)return;
const first={start:{...lines[0].start},end:{...lines[0].end}},vx=first.end.x-first.start.x,vy=first.end.y-first.start.y,len=Math.hypot(vx,vy)||1;
// Project the axis normal from the first line's direction so rotated grid systems retain
// the same orientation while distances are recalculated from a stable origin.
const normal=axis==="vertical"?{x:vy/len,y:-vx/len}:{x:-vy/len,y:vx/len};
let cumulative=0;
for(let i=1;i<lines.length;i++){
 cumulative+=distances[i-1];
 const target=lines[i],current={start:{...target.start},end:{...target.end}};
 const signedPosition=(current.start.x-first.start.x)*normal.x+(current.start.y-first.start.y)*normal.y;
 const desiredPosition=cumulative;
 const delta=desiredPosition-signedPosition,dx=normal.x*delta,dy=normal.y*delta;
 target.start={x:current.start.x+dx,y:current.start.y+dy};
 target.end={x:current.end.x+dx,y:current.end.y+dy};
}
};
moveAxis(spacing.verticalLines,spacing.vertical,"vertical");moveAxis(spacing.horizontalLines,spacing.horizontal,"horizontal");
// Grid dimensions preserve their independent annotation placement; only their witness points
// follow the resized gridlines, keeping extension lines connected without shifting dimension lines.
const dims=gridMembers.filter(e=>e.type==="dimension"&&e.gridDimension);
const vertical=spacing.verticalLines,horizontal=spacing.horizontalLines;
const markerPoint=line=>{const sides=line.markerSides||{};return sides.start?line.start:sides.end?line.end:line.start};
for(const d of dims){
const axis=d.gridDimensionAxis;
const lines=axis==="vertical"?vertical:axis==="horizontal"?horizontal:null;
if(!lines?.length)continue;
let firstIndex=0,lastIndex=lines.length-1;
if(d.gridDimension==="chain"){
firstIndex=Number(d.gridDimensionIndex);
lastIndex=firstIndex+1;
}
const lineA=lines[firstIndex],lineB=lines[lastIndex];
if(!lineA||!lineB)continue;
const baseA=markerPoint(lineA),baseB=markerPoint(lineB);
// Grid dimensions are parametric annotations. Keep their measured endpoints attached to the
// corresponding gridlines; preserve the authored offset from the first axis line.
// Move both endpoints of the dimension line and witness lines by the same displacement
// derived from the corresponding grid markers. This keeps the annotation offset and dimension
// value attached to the grid system while preserving the baseline orientation.
const baseStart=d.start?{...d.start}:null,baseEnd=d.end?{...d.end}:null;
const oldA=d.witnessStart?{...d.witnessStart}:baseA,oldB=d.witnessEnd?{...d.witnessEnd}:baseB;
const shiftA={x:baseA.x-oldA.x,y:baseA.y-oldA.y},shiftB={x:baseB.x-oldB.x,y:baseB.y-oldB.y};
d.witnessStart={...baseA};d.witnessEnd={...baseB};
if(baseStart&&baseEnd){
  if(axis==="vertical"){
    const move={x:(shiftA.x+shiftB.x)/2,y:(shiftA.y+shiftB.y)/2};
    d.start={x:baseStart.x+move.x,y:baseStart.y+move.y};
    d.end={x:baseEnd.x+move.x,y:baseEnd.y+move.y};
  }else{
    const move={x:(shiftA.x+shiftB.x)/2,y:(shiftA.y+shiftB.y)/2};
    d.start={x:baseStart.x+move.x,y:baseStart.y+move.y};
    d.end={x:baseEnd.x+move.x,y:baseEnd.y+move.y};
  }
}
}
}scheduleAutoSave();$("status").textContent=spacing?"Grid System spacing updated":isOpeningBulk?"Opening parameters applied to "+list.length+" "+type+" elements":"Parameters applied to "+list.length+" elements";redraw();renderProperties()};$("applyMultiProps").onclick=applyMultiProps;for(const input of host.querySelectorAll("[data-multi-prop]")){input.addEventListener("change",applyMultiProps);input.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();applyMultiProps()}})}for(const id of ["multiClassification","multiLibraryType","multiOpeningAlignment","multiHinge","multiSwing","multiFontFamily","multiTextAlignment","multiTextColor","multiTextBold","multiTextItalic","multiTextUnderline","multiZoneNumber","multiRoomName","multiZoneCategory"]){const control=$(id);if(control)control.addEventListener("change",applyMultiProps)}$("applyGridSpacing")?.addEventListener("click",applyMultiProps);for(const id of ["editGridVertical","editGridHorizontal"]){const input=$(id);if(input)input.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();applyMultiProps()}})}
return}
const e=list[0];const fields={wall:[["height","Height (m)",.1],["thickness","Thickness (m)",.01],["baseOffset","Base offset (m)",.01]],beam:[["width","Width (m)",.01],["depth","Depth (m)",.01],["elevation","Elevation (m)",.01]],column:[["width","Width (m)",.01],["depth","Depth (m)",.01],["height","Height (m)",.01],["rotation","Rotation (rad)",.01]],slab:[["thickness","Thickness (m)",.01],["elevation","Elevation (m)",.01]],roof:[["thickness","Thickness (m)",.01],["elevation","Eaves Height (m)",.01],["offset","Offset (m)",.01],["pitch","Pitch (degrees)",1]],door:[["width","Width (m)",.01],["height","Height (m)",.01],["sill","Sill / Base height (m)",.01]],window:[["width","Width (m)",.01],["height","Height (m)",.01],["sill","Sill / Base height (m)",.01]],dimension:[["textSizeMm","Text size on paper (mm)",.1]],text:[["textSizeMm","Text size on paper (mm)",.1]],room:[]}[e.type]||[];
host.innerHTML='<div class="field"><label>Element type / ID</label><input value="'+escapeHtml((e.type==="room"?"Zone":e.type)+' · '+e.id)+'" readonly></div>'+'<div class="field"><label>Classification</label><select id="propClassification"><option value="">Unclassified</option>'+["Architectural","Structural","Mechanical","Electrical","Plumbing","Fire Protection","Landscape","Zone / Space"].map(v=>'<option value="'+v+'"'+((e.classification||"")===v?" selected":"")+'>'+v+'</option>').join("")+'</select></div>'+(e.type==="room"?'<div class="field"><label>Zone Number</label><input id="propZoneNumber" value="'+escapeHtml(e.zoneNumber||"")+'" placeholder="e.g. Z-01"></div><div class="field"><label>Room name</label><input id="propRoomName" value="'+escapeHtml(e.roomName||e.name||"")+'" placeholder="e.g. Living Room"></div><div class="field"><label>Zone Category</label><input id="propZoneCategory" value="'+escapeHtml(e.zoneCategory||"")+'" placeholder="e.g. Living, Bedroom, Wet Area"></div><p style="font-size:11px;color:var(--muted)">Zone stamp: number, name and area. Drag the stamp on the floor plan to move all labels together.</p>':"")+'<div class="field"><label>Building material</label><input id="propMaterial" value="'+escapeHtml(e.buildingMaterial||"")+'"></div>'+fields.map(([key,label,step])=>'<div class="field"><label>'+label+'</label><input data-prop="'+key+'" type="number" step="'+step+'" value="'+(key==="gridDimensionValue"?Math.hypot(e.end.x-e.start.x,e.end.y-e.start.y):Number.isFinite(e[key])?e[key]:(key==="textSizeMm"?2.5:""))+'"></div>').join("")+(['door','window'].includes(e.type)?'<div class="field"><label>Position on host wall</label><select id="propAlignment"><option value="left"'+((e.alignment||"center")==="left"?" selected":"")+'>Left</option><option value="center"'+((e.alignment||"center")==="center"?" selected":"")+'>Center</option><option value="right"'+((e.alignment||"center")==="right"?" selected":"")+'>Right</option></select></div><div class="field"><label>Library / Leaf Configuration</label><select id="propLibraryType"><option value="single-leaf"'+((e.libraryType||"single-leaf")==="single-leaf"?" selected":"")+ '>Single Leaf</option><option value="double-leaf"'+(e.libraryType==="double-leaf"?" selected":"")+ '>Double Leaf</option></select></div><div class="field"><label>Hinge / Side</label><select id="propHinge"><option value="left"'+((e.hingeSide||"left")==="left"?" selected":"")+'>Left</option><option value="right"'+(e.hingeSide==="right"?" selected":"")+'>Right</option></select></div><div class="field"><label>Opening Direction (2D)</label><select id="propSwing"><option value="inside"'+((e.swingDirection||"inside")==="inside"?" selected":"")+'>Inside</option><option value="outside"'+(e.swingDirection==="outside"?" selected":"")+'>Outside</option></select></div>'+(e.type==="door"?'<div class="field"><label>3D Door Leaf</label><select id="prop3DState"><option value="closed"'+((e.model3dState||"closed")==="closed"?" selected":"")+'>Closed (default)</option><option value="open"'+(e.model3dState==="open"?" selected":"")+'>Open</option></select><small style="color:var(--muted)">Independent of the 2D floor-plan swing symbol.</small></div>':""): "");
if(e.type==="text"){const field=document.createElement("div");field.className="field text-edit-launcher";field.style.cssText="flex:0 0 auto!important;min-width:170px!important;display:flex;flex-direction:column;gap:4px;";field.innerHTML='<label>Text annotation</label><button type="button" id="editTextOnPlan" style="min-height:30px;padding:5px 10px;border:1px solid #087e8b;border-radius:4px;background:#087e8b;color:#fff;font-size:11px;white-space:nowrap">Edit text on plan…</button><small style="color:var(--muted);white-space:normal;line-height:1.25">Edit content and formatting directly beside the annotation.</small>';host.insertBefore(field,host.querySelector("#applyProps"));field.querySelector("#editTextOnPlan").addEventListener("click",()=>startInlineTextEditor(e));}if(e.type==="gridline"){const field=document.createElement("div");field.className="field";field.innerHTML='<label>Grid axis label</label><input id="propGridLabel" maxlength="8" value="'+escapeHtml(e.label||"A")+'">';host.insertBefore(field,host.querySelector("#applyProps"));const pointFields=document.createElement("div");pointFields.innerHTML='<p style="font-size:11px;font-weight:600">Start point (m)</p><div class="field"><label>X</label><input id="gridStartX" type="number" step="0.1" value="'+e.start.x+'"></div><div class="field"><label>Y</label><input id="gridStartY" type="number" step="0.1" value="'+e.start.y+'"></div><p style="font-size:11px;font-weight:600">End point (m)</p><div class="field"><label>X</label><input id="gridEndX" type="number" step="0.1" value="'+e.end.x+'"></div><div class="field"><label>Y</label><input id="gridEndY" type="number" step="0.1" value="'+e.end.y+'"></div>';host.insertBefore(pointFields,host.querySelector("#applyProps"))}if(e.type==="room"){$("propRoomName")?.addEventListener("input",event=>{const target=els().find(v=>v.id===e.id&&v.type==="room");if(!target)return;target.roomName=event.target.value;target.name=event.target.value;redraw();scheduleAutoSave()})}const applyPropsNow=(event)=>{const target=els().find(v=>v.id===e.id);if(!target)return;const edits=[...host.querySelectorAll("[data-prop]")],values={};let gridPoints=null;if(target.type==="gridline"){const label=$("propGridLabel")?.value.trim();if(!label){$("status").textContent="Grid axis label is required";return}gridPoints={start:{x:unitSystem()==="imperial"?($("gridStartX").dataset.unitEdited==="true"?parseLength($("gridStartX").value,"imperial"):Number($("gridStartX").dataset.originalMetres??$("gridStartX").value)):Number($("gridStartX").value),y:unitSystem()==="imperial"?($("gridStartY").dataset.unitEdited==="true"?parseLength($("gridStartY").value,"imperial"):Number($("gridStartY").dataset.originalMetres??$("gridStartY").value)):Number($("gridStartY").value)},end:{x:unitSystem()==="imperial"?($("gridEndX").dataset.unitEdited==="true"?parseLength($("gridEndX").value,"imperial"):Number($("gridEndX").dataset.originalMetres??$("gridEndX").value)):Number($("gridEndX").value),y:unitSystem()==="imperial"?($("gridEndY").dataset.unitEdited==="true"?parseLength($("gridEndY").value,"imperial"):Number($("gridEndY").dataset.originalMetres??$("gridEndY").value)):Number($("gridEndY").value)}};if(Object.values(gridPoints).some(pt=>!Number.isFinite(pt.x)||!Number.isFinite(pt.y))||Math.hypot(gridPoints.end.x-gridPoints.start.x,gridPoints.end.y-gridPoints.start.y)<0.01){$("status").textContent="Gridline points must be valid and at least 0.01 m apart";return}target.label=label}for(const input of edits){const key=input.dataset.prop,val=parsePropertyInput(input.value,key,input);const positive=["height","thickness","width","depth"].includes(key);if(input.value.trim()===""||!Number.isFinite(val)||(key!=="offset"&&val<0)||(positive&&val===0)){ $("status").textContent="Invalid parameter: "+key;return}values[key]=val}if(["door","window"].includes(target.type)){const wall=els().find(v=>v.id===target.hostWallId);if(!wall){$("status").textContent="Host wall not found";return}const alignment=$("propAlignment")?.value||target.alignment||"center",len=wallLength(wall),changedKey=event?.target?.dataset?.prop||document.activeElement?.dataset?.prop||"";values.width=Number(values.width??target.width);const oldWidth=Number(target.width)||values.width,oldOffset=Number(target.offset)||0,anchorMode=["left","right","center"].includes(String(alignment).toLowerCase())?String(alignment).toLowerCase():"center",anchorPosition=oldOffset+(anchorMode==="left"?0:anchorMode==="right"?oldWidth:oldWidth/2);values.anchorPosition=anchorPosition;if(changedKey==="width"||event?.target?.id==="propAlignment")values.offset=anchorPosition-(anchorMode==="left"?0:anchorMode==="right"?values.width:values.width/2);else if(changedKey==="offset"&&Number.isFinite(values.offset))values.anchorPosition=values.offset+(anchorMode==="left"?0:anchorMode==="right"?oldWidth:oldWidth/2);else values.offset=target.offset;values.offset=Number(values.offset??target.offset);const nextWidth=Number(values.width??target.width),nextOffset=Number(values.offset??target.offset),nextSill=Number(values.sill??target.sill??0),nextHeight=Number(values.height??target.height);if(!Number.isFinite(nextWidth)||nextWidth<=0||nextWidth>len+1e-8||!Number.isFinite(nextOffset)||!Number.isFinite(nextSill)||!Number.isFinite(nextHeight)||nextSill+nextHeight>wall.height||(changedKey==="offset"&&(nextOffset<0||nextOffset+nextWidth>len+1e-8))){$("status").textContent="Opening cannot fit host wall at the fixed anchor. Move the opening or use a smaller width.";return}values.alignment=anchorMode}hist();Object.assign(target,values);target.classification=$("propClassification")?.value||"";if(target.type==="room"){target.roomName=$("propRoomName")?.value.trim()||"";target.name=target.roomName;target.zoneNumber=$("propZoneNumber")?.value.trim()||target.zoneNumber||"";target.zoneCategory=$("propZoneCategory")?.value.trim()||""}if(target.type==="dimension"&&Number.isFinite(values.gridDimensionValue)){const wanted=values.gridDimensionValue;if(wanted<=0){$("status").textContent="Dimension must be greater than zero";return}const members=target.gridSystemId?els().filter(v=>v.gridSystemId===target.gridSystemId):[],axis=target.gridDimensionAxis,index=target.gridDimensionIndex,lines=members.filter(v=>v.type==="gridline"&&v.gridSystemAxis===axis).sort((a,b)=>a.gridSystemIndex-b.gridSystemIndex),lineA=lines[index],lineB=lines[index+1];if(!lineA||!lineB){$("status").textContent="Grid axes for this dimension could not be found";return}const oldDistance=Math.hypot(lineB.start.x-lineA.start.x,lineB.start.y-lineA.start.y),deltaDistance=wanted-oldDistance,dx=lineB.start.x-lineA.start.x,dy=lineB.start.y-lineA.start.y,len=Math.hypot(dx,dy)||1,shift={x:dx/len*deltaDistance,y:dy/len*deltaDistance};for(const line of lines){if(line.gridSystemIndex>index){line.start.x+=shift.x;line.start.y+=shift.y;line.end.x+=shift.x;line.end.y+=shift.y}}for(const member of members){if(member.type!=="dimension")continue;const shiftPoint=pt=>{if(!pt)return;const projection=(pt.x-lineA.start.x)*(dx/len)+(pt.y-lineA.start.y)*(dy/len);if(projection>oldDistance-0.001){pt.x+=shift.x;pt.y+=shift.y}};if(axis==="vertical"&&Math.abs(member.end.y-member.start.y)<Math.abs(member.end.x-member.start.x)){shiftPoint(member.start);shiftPoint(member.end);shiftPoint(member.witnessStart);shiftPoint(member.witnessEnd)}else if(axis==="horizontal"&&Math.abs(member.end.y-member.start.y)>=Math.abs(member.end.x-member.start.x)){shiftPoint(member.start);shiftPoint(member.end);shiftPoint(member.witnessStart);shiftPoint(member.witnessEnd)}}}if(target.type==="gridline"&&gridPoints){target.start=gridPoints.start;target.end=gridPoints.end}if(["door","window"].includes(target.type)){const wall=els().find(v=>v.id===target.hostWallId),opening=wall?.openings?.find(o=>o.id===target.id);if(opening)Object.assign(opening,values)}if(["door","window"].includes(target.type)){target.hingeSide=$("propHinge")?.value||target.hingeSide||"left";target.swingDirection=$("propSwing")?.value||target.swingDirection||"inside";target.libraryType=$("propLibraryType")?.value||target.libraryType||"single-leaf";const hostWall=els().find(v=>v.id===target.hostWallId);const opening=hostWall?.openings?.find(o=>o.id===target.id);if(opening)Object.assign(opening,values,{hingeSide:target.hingeSide,swingDirection:target.swingDirection,libraryType:target.libraryType,alignment:target.alignment||"center",revealSide:target.revealSide||"left"})}const mat=$("propMaterial").value.trim();if(mat)target.buildingMaterial=mat;if(target.type==="wall"){for(const o of target.openings||[])if(o.sill+o.height>target.height){$("status").textContent="Wall updated; check hosted opening heights";break}}$("status").textContent="Element parameters updated";redraw();scheduleAutoSave();renderProperties()};for(const control of host.querySelectorAll("[data-prop],#propClassification,#propMaterial,#propGridLabel,#gridStartX,#gridStartY,#gridEndX,#gridEndY,#propZoneNumber,#propZoneCategory,#propLibraryType")){if(["door","window"].includes(e.type)&&control.matches("[data-prop]"))continue;control.addEventListener("change",applyPropsNow)}$("propClassification")?.addEventListener("change",()=>{const target=els().find(v=>v.id===e.id);if(target){target.classification=$("propClassification").value||"";redraw();scheduleAutoSave()}});$("propMaterial")?.addEventListener("change",()=>{const target=els().find(v=>v.id===e.id);if(target){target.buildingMaterial=$("propMaterial").value.trim();redraw();scheduleAutoSave()}});const applyOpeningEdit=(event)=>{const target=els().find(v=>v.id===e.id);if(!target||!["door","window"].includes(target.type))return;const wall=els().find(v=>v.id===target.hostWallId&&v.type==="wall");if(!wall){$("status").textContent="Host wall not found";return}const changedKey=event?.target?.dataset?.prop||event?.target?.id||document.activeElement?.dataset?.prop||"",alignment=$("propAlignment")?.value||target.alignment||"center",hinge=$("propHinge")?.value||target.hingeSide||"left",swing=$("propSwing")?.value||target.swingDirection||"inside",libraryType=$("propLibraryType")?.value||target.libraryType||"single-leaf",model3dState=$("prop3DState")?.value||(target.model3dState||"closed");const readNumber=(key,fallback)=>{const input=host.querySelector('[data-prop="'+key+'"]');return input&&input.value.trim()!==""?Number(input.value):Number(fallback)};let geometry;try{geometry=resolveHostedOpeningEdit({hostLength:wallLength(wall),hostHeight:Number(wall.height),current:target,changes:{offset:readNumber("offset",target.offset),width:readNumber("width",target.width),height:readNumber("height",target.height),sill:readNumber("sill",target.sill??0),alignment},changedKey})}catch(error){$("status").textContent=error.message;renderProperties();return}hist("Edit hosted opening");Object.assign(target,geometry,{hingeSide:hinge,swingDirection:swing,libraryType});if(target.type==="door")target.model3dState=model3dState;wall.openings=Array.isArray(wall.openings)?wall.openings:[];let opening=wall.openings.find(o=>o.id===target.id);if(!opening){opening={...target};wall.openings.push(opening)}else Object.assign(opening,target);$("status").textContent=(target.type==="door"?"Door":"Window")+" parameters updated";scheduleAutoSave();redraw();renderProperties()};for(const id of ["propAlignment","propHinge","propSwing","prop3DState"])$(id)?.addEventListener("change",applyOpeningEdit);for(const input of host.querySelectorAll('[data-prop]')){input.addEventListener("change",event=>applyOpeningEdit(event));input.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();applyOpeningEdit(event)}})}}
function captureConnectedNode(point,sourceElementId=null){
 // A shared model node is an exact geometric coincidence within one active story.
 // Use a small sub-millimetre tolerance to survive arithmetic noise without merging nearby geometry.
 const eps=1e-4,records=[],seen=new Set();
 const add=(el,key,index,pt)=>{
  if(!pt||!Number.isFinite(pt.x)||!Number.isFinite(pt.y)||Math.hypot(pt.x-point.x,pt.y-point.y)>eps)return;
  const id=el.id+"|"+key+"|"+(index===null?"":index);
  if(seen.has(id))return;
  seen.add(id);records.push({id:el.id,key,index,start:{x:pt.x,y:pt.y}});
 };
 const scope=sourceElementId?(selected.size>1?new Set(selected):new Set([sourceElementId])):null;
 for(const el of els()){
  // A single selected element edits its own node independently. When multiple
  // elements are selected, only selected members participate in shared-node editing.
  if(scope&&!scope.has(el.id))continue;
  // Coordinates are story-local: equal X/Y on another story is not a shared node.
  if(view==="floor"&&el.storyId!==story().id)continue;
  for(const key of ["start","end","position","witnessStart","witnessEnd","center","labelPosition"])add(el,key,null,el[key]);
  for(const key of ["boundary","points","vertices","nodes"])if(Array.isArray(el[key]))el[key].forEach((pt,index)=>add(el,key,index,pt));
  // A hosted door/window is measured by its host wall, so its effective end points are
  // included in connected topology even though its persistent position is wall-relative.
  if((el.type==="door"||el.type==="window")&&Number.isFinite(el.offset)&&Number.isFinite(el.width)){
   const host=els().find(candidate=>candidate.id===el.hostWallId&&candidate.type==="wall");
   if(host){const len=wallLength(host)||1,dx=host.end.x-host.start.x,dy=host.end.y-host.start.y;
    add(el,"hostOpeningStart",null,{x:host.start.x+dx*el.offset/len,y:host.start.y+dy*el.offset/len});
    add(el,"hostOpeningEnd",null,{x:host.start.x+dx*(el.offset+el.width)/len,y:host.start.y+dy*(el.offset+el.width)/len});
   }
  }
 }
 return records;
}
function applyConnectedNodeMove(records,dx,dy){
 for(const rec of records||[]){
  const el=els().find(v=>v.id===rec.id);if(!el)continue;
  if(rec.key==="hostOpeningStart"||rec.key==="hostOpeningEnd"){
   // Keep openings hosted: shared end edits move the wall-relative opening offset,
   // while the opening's other end remains constrained by the same wall.
   const host=els().find(v=>v.id===el.hostWallId&&v.type==="wall");if(!host)continue;
   const len=wallLength(host)||1,ux=(host.end.x-host.start.x)/len,uy=(host.end.y-host.start.y)/len;
   const target={x:host.start.x+(host.end.x-host.start.x)*(rec.key==="hostOpeningStart"?el.offset:el.offset+el.width)/len,y:host.start.y+(host.end.y-host.start.y)*(rec.key==="hostOpeningStart"?el.offset:el.offset+el.width)/len};
   const moved={x:rec.start.x+dx,y:rec.start.y+dy};
   const next=(moved.x-host.start.x)*ux+(moved.y-host.start.y)*uy;
   if(rec.key==="hostOpeningStart")el.offset=Math.max(0,Math.min(len-el.width,next));
   else el.offset=Math.max(0,Math.min(len-el.width,next-el.width));
   const opening=host.openings?.find(v=>v.id===el.id);if(opening)opening.offset=el.offset;
   continue;
  }
  const target=rec.key==="boundary"||rec.key==="points"||rec.key==="vertices"||rec.key==="nodes"?el[rec.key]?.[rec.index]:el[rec.key];
  if(!target)continue;
  target.x=rec.start.x+dx;target.y=rec.start.y+dy;
 }
}
function elementEditablePoints(el){
 const out=[],add=(key,index,point,role="node")=>{if(point&&Number.isFinite(point.x)&&Number.isFinite(point.y))out.push({key,index,point,role})};
 if(["wall","beam","gridline","dimension"].includes(el.type)){add("start",null,el.start);add("end",null,el.end)}
 if(el.type==="dimension"){add("witnessStart",null,el.witnessStart);add("witnessEnd",null,el.witnessEnd)}
 if(el.type==="column")add("position",null,el.position);
 if(Array.isArray(el.boundary))el.boundary.forEach((point,index)=>add("boundary",index,point));
 for(const key of ["points","vertices","nodes"])if(Array.isArray(el[key]))el[key].forEach((point,index)=>add(key,index,point));
 if(el.type==="room"){add("center",null,el.center);add("labelPosition",null,el.labelPosition)}
 if((el.type==="door"||el.type==="window")&&Number.isFinite(el.offset)&&Number.isFinite(el.width)){
  const host=els().find(candidate=>candidate.id===el.hostWallId&&candidate.type==="wall");
  if(host){const len=wallLength(host)||1,dx=host.end.x-host.start.x,dy=host.end.y-host.start.y;add("hostOpeningStart",null,{x:host.start.x+dx*el.offset/len,y:host.start.y+dy*el.offset/len});add("hostOpeningEnd",null,{x:host.start.x+dx*(el.offset+el.width)/len,y:host.start.y+dy*(el.offset+el.width)/len})}
 }
 return out;
}
function captureConnectedNodes(points){
 const map=new Map();
 for(const point of points||[])for(const rec of captureConnectedNode(point))map.set(rec.id,rec);
 return [...map.values()];
}
function beginConnectedWallEdgeGesture(wall,edge){
 const same=(a,b)=>!!a&&!!b&&Math.hypot(a.x-b.x,a.y-b.y)<1e-4;
 const a={...edge.a.point},b={...edge.b.point};
 // Snapshot endpoints for the entire explicit selection. Shared topology is
 // resolved from this immutable snapshot, not from geometry already mutated
 // by an earlier pointer frame.
 const selectedWallEndpoints=[];
 for(const el of els()){
  if(!selected.has(el.id)||el.type!=="wall"||(view==="floor"&&el.storyId!==story().id))continue;
  if(!el.start||!el.end)continue;
  selectedWallEndpoints.push({id:el.id,start:{...el.start},end:{...el.end}});
 }
 return {wallId:wall.id,start:{...wall.start},end:{...wall.end},edgeA:a,edgeB:b,selectedWallEndpoints};
}
function moveConnectedWallEdge(g,dx,dy){
 // Move the picked wall on its normal and solve every selected shared junction
 // from immutable centre-lines. Connected walls retain their bearing; their
 // lengths change at intersections rather than their segments rotating.
 const records=(g.selectedWallEndpoints||[]).filter(r=>selected.has(r.id));
 const targetRecord=records.find(r=>r.id===g.wallId);
 const wall=els().find(el=>el.id===g.wallId&&el.type==="wall");
 if(!wall||!targetRecord)return;
 const vx=targetRecord.end.x-targetRecord.start.x,vy=targetRecord.end.y-targetRecord.start.y,len=Math.hypot(vx,vy);
 if(!(len>1e-8))return;
 const nx=-vy/len,ny=vx/len,offset=dx*nx+dy*ny;
 const same=(a,b)=>!!a&&!!b&&Math.hypot(a.x-b.x,a.y-b.y)<1e-4;
 const cross=(ax,ay,bx,by)=>ax*by-ay*bx;
 const intersect=(a,b,c,d)=>{
  const rx=b.x-a.x,ry=b.y-a.y,sx=d.x-c.x,sy=d.y-c.y,den=cross(rx,ry,sx,sy);
  if(Math.abs(den)<1e-8)return null;
  const t=cross(c.x-a.x,c.y-a.y,sx,sy)/den;
  return {x:a.x+t*rx,y:a.y+t*ry};
 };
 const lines=new Map(records.map(r=>[r.id,{
  start:{x:r.start.x+(r.id===g.wallId?nx*offset:0),y:r.start.y+(r.id===g.wallId?ny*offset:0)},
  end:{x:r.end.x+(r.id===g.wallId?nx*offset:0),y:r.end.y+(r.id===g.wallId?ny*offset:0)}
 }]));
 const endpoints=new Map(records.map(r=>[r.id,{start:{...r.start},end:{...r.end}}]));
 // Every coincident endpoint pair in the explicit selection is a junction.
 // Recompute it from the two centre-lines, then apply all endpoints together.
 for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
  const a=records[i],b=records[j],la=lines.get(a.id),lb=lines.get(b.id);
  for(const ka of ["start","end"])for(const kb of ["start","end"]){
   if(!same(a[ka],b[kb]))continue;
   const hit=intersect(la.start,la.end,lb.start,lb.end);if(!hit)continue;
   endpoints.get(a.id)[ka]={...hit};endpoints.get(b.id)[kb]={...hit};
  }
 }
 for(const rec of records){
  const el=els().find(v=>v.id===rec.id&&v.type==="wall");if(!el)continue;
  const pts=endpoints.get(rec.id);
  // Unconnected ends of the edited wall move with its parallel offset.
  if(rec.id===g.wallId){
   for(const key of ["start","end"])if(![...records].some(other=>other.id!==rec.id&&["start","end"].some(k=>same(rec[key],other[k]))))pts[key]={x:rec[key].x+nx*offset,y:rec[key].y+ny*offset};
  }
  el.start={...pts.start};el.end={...pts.end};
 }
}
function elementEditableEdges(el){
 const out=[];
 if(["wall","beam","gridline","dimension"].includes(el.type)&&el.start&&el.end)out.push({a:{key:"start",index:null,point:el.start},b:{key:"end",index:null,point:el.end}});
 if(Array.isArray(el.boundary)&&el.boundary.length>1)for(let i=0;i<el.boundary.length;i++)out.push({a:{key:"boundary",index:i,point:el.boundary[i]},b:{key:"boundary",index:(i+1)%el.boundary.length,point:el.boundary[(i+1)%el.boundary.length]}});
 for(const key of ["points","vertices","nodes"]){const points=el[key];if(Array.isArray(points)&&points.length>1)for(let i=0;i<points.length-1;i++)out.push({a:{key,index:i,point:points[i]},b:{key,index:i+1,point:points[i+1]}})}
 return out;
}
function groupSelected(){const list=chosen();if(list.length<2){$("status").textContent="Select at least two elements to group";return}const id=crypto.randomUUID();hist("Group elements");for(const el of list){el.groupId=id;delete el.gridSystemId;delete el.gridSystemAxis;delete el.gridSystemIndex}selected=new Set(list.map(el=>el.id));scheduleAutoSave();renderProperties();redraw();$("status").textContent=list.length+" elements grouped"}
function ungroupSelected(){gridlineMoveGesture=null;genericMoveGesture=null;genericNodeMoveGesture=null;genericEdgeMoveGesture=null;openingMoveGesture=null;isPanning=false;panStart=null;const list=chosen();if(!list.length){$("status").textContent="Select grouped elements to ungroup";return}const ids=new Set();for(const el of list){const key=groupKey(el);if(key){for(const member of els())if(groupKey(member)===key)ids.add(member.id)}else ids.add(el.id)}const members=els().filter(el=>ids.has(el.id));if(!members.some(el=>groupKey(el))){$("status").textContent="Selection contains no grouped elements";return}hist("Ungroup elements");for(const el of members){delete el.groupId;delete el.gridSystemId;delete el.gridSystemAxis;delete el.gridSystemIndex}selected=new Set(members.map(el=>el.id));scheduleAutoSave();renderProperties();redraw();$("status").textContent="Group separated into "+members.length+" independently editable elements"}
function toggleSuspendGroups(){groupsSuspended=!groupsSuspended;const button=document.querySelector('[data-command="suspendGroups"]');if(button){button.classList.toggle("active",groupsSuspended);button.textContent=groupsSuspended?"Resume Groups":"Suspend Groups"}if(!groupsSuspended){const ids=[...selected];selected=new Set();for(const id of ids){const el=els().find(v=>v.id===id);if(el)for(const member of groupMembers(el))selected.add(member.id)}}renderProperties();redraw();$("status").textContent=groupsSuspended?"Suspend Groups enabled · members can be selected individually":"Groups enabled · grouped elements select together"}
function insertNodeIntoSelectedWall(requestedPoint=null){
 const list=chosen();
 if(list.length!==1||list[0].type!=="wall"){$("status").textContent="Select one wall edge to insert a node";return}
 const wall=list[0],length=wallLength(wall);
 if(!(length>1e-6))return;
 const ax=wall.start.x,ay=wall.start.y,dx=wall.end.x-ax,dy=wall.end.y-ay,len2=dx*dx+dy*dy;
 const t=requestedPoint?Math.max(.02,Math.min(.98,((requestedPoint.x-ax)*dx+(requestedPoint.y-ay)*dy)/len2)):.5;
 const firstLength=length*t,secondLength=length-firstLength;
 const midpoint={x:ax+dx*t,y:ay+dy*t};
 if(firstLength<.01||secondLength<.01){$("status").textContent="Choose a point farther from the wall ends";return}
 const original={...wall,start:{...wall.start},end:{...wall.end},properties:{...(wall.properties||{})},openings:(wall.openings||[]).map(o=>({...o}))};
 const second={...original,id:crypto.randomUUID(),start:{...midpoint},end:{...original.end},properties:{...(original.properties||{})},openings:[]};
 const first={...original,end:{...midpoint},openings:[]};
 for(const opening of original.openings||[]){
  const openingStart=Number(opening.offset)||0,openingEnd=openingStart+(Number(opening.width)||0);
  if(openingEnd<=firstLength+1e-8)first.openings.push({...opening});
  else if(openingStart>=firstLength-1e-8)second.openings.push({...opening,offset:openingStart-firstLength});
  else{$("status").textContent="Cannot insert node through an existing opening. Choose a clear section of wall.";return}
 }
 const hosted=els().filter(el=>(el.type==="door"||el.type==="window")&&el.hostWallId===wall.id);
 for(const opening of hosted){
  const off=Number(opening.offset)||0,w=Number(opening.width)||0;
  if(off<firstLength&&off+w>firstLength){$("status").textContent="Cannot insert node through a door/window. Choose a clear section of wall.";return}
 }
 hist("Insert wall node");
 const index=els().findIndex(el=>el.id===wall.id);
 els()[index]=first;els().splice(index+1,0,second);
 for(const opening of hosted){
  const off=Number(opening.offset)||0;
  if(off>=firstLength){opening.hostWallId=second.id;opening.offset=off-firstLength}
 }
 selected=new Set([first.id,second.id]);
 scheduleAutoSave();renderProperties();redraw();
 $("status").textContent="Wall node inserted at clicked position · select the new node to edit";
}
function stretchSelectedWall(){
 const list=chosen();
 if(list.length!==1||list[0].type!=="wall"){$("status").textContent="Select one wall to stretch";return}
 const wall=list[0],len=wallLength(wall);
 if(!(len>1e-8))return;
 const value=prompt("New wall length (m)",String(Number(len.toFixed(3))));
 if(value===null)return;
 const next=Number(value);
 if(!Number.isFinite(next)||next<=0){$("status").textContent="Wall length must be greater than zero";return}
 const dx=(wall.end.x-wall.start.x)/len,dy=(wall.end.y-wall.start.y)/len,delta=next-len;
 // Move the far endpoint and only geometry genuinely sharing that endpoint.
 // Do not translate the entire selection or move both endpoints of the wall.
 hist("Stretch wall");
 const endRecords=captureConnectedNode(wall.end,wall.id);
 applyConnectedNodeMove(endRecords,dx*delta,dy*delta);
 scheduleAutoSave();renderProperties();redraw();
 $("status").textContent="Wall stretched to "+next.toFixed(3)+" m";
}
function offsetSelectedWall(){
 const list=chosen();
 if(list.length!==1||list[0].type!=="wall"){$("status").textContent="Select one wall to offset";return}
 const wall=list[0],len=wallLength(wall);
 if(!(len>1e-8))return;
 const value=prompt("Wall offset (m) · positive = left, negative = right","0.1");
 if(value===null)return;
 const amount=Number(value);
 if(!Number.isFinite(amount)){$("status").textContent="Enter a valid offset";return}
 if(Math.abs(amount)<1e-9)return;
 const dx=(wall.end.x-wall.start.x)/len,dy=(wall.end.y-wall.start.y)/len,ox=-dy*amount,oy=dx*amount;
 hist("Offset wall");
 // Offset only the selected wall axis; adjacent connected geometry remains fixed intentionally.
 wall.start.x+=ox;wall.start.y+=oy;wall.end.x+=ox;wall.end.y+=oy;
 const children=els().filter(el=>(el.type==="door"||el.type==="window")&&el.hostWallId===wall.id);
 for(const child of children){const opening=wall.openings?.find(o=>o.id===child.id);if(opening){child.offset=opening.offset;child.width=opening.width;child.height=opening.height;child.sill=opening.sill}}
 scheduleAutoSave();renderProperties();redraw();
 $("status").textContent="Wall offset by "+amount.toFixed(3)+" m";
}
let transformInteraction=null;
function transformSelected(mode,interactive=null){
const list=chosen();if(!list.length){transformInteraction=null;$("status").textContent="Select one or more elements first";return}
if(!interactive){transformInteraction={mode,points:[]};$("status").textContent=mode==="move"?"Move · click reference point, then destination":mode==="copy"?"Multiply · click reference point, then destination":mode==="rotate"?"Rotate · click rotation centre, reference point, then angle point":"Mirror · click first and second points of mirror axis";return}
const {dx=0,dy=0,angle:givenAngle=0,axis="x",pivot=null,axisStart=null,axisEnd=null}=interactive;
let angle=givenAngle;
const anchor=e=>{if((e.type==="door"||e.type==="window")&&Number.isFinite(e.offset)&&Number.isFinite(e.width)){const wall=els().find(v=>v.id===e.hostWallId&&v.type==="wall"),len=wall?wallLength(wall):0;if(wall&&len>1e-8)return{x:wall.start.x+(wall.end.x-wall.start.x)*(e.offset+e.width/2)/len,y:wall.start.y+(wall.end.y-wall.start.y)*(e.offset+e.width/2)/len}}return e.position||e.labelPosition||e.center||e.start||e.boundary?.[0]||{x:0,y:0}};
const cx=pivot?.x??list.reduce((sum,e)=>sum+anchor(e).x,0)/list.length;
const cy=pivot?.y??list.reduce((sum,e)=>sum+anchor(e).y,0)/list.length;
const point=q=>{let x=q.x,y=q.y;if(mode==="move"||mode==="copy"){x+=dx;y+=dy}else if(mode==="rotate"){const a=x-cx,b=y-cy;x=cx+a*Math.cos(angle)-b*Math.sin(angle);y=cy+a*Math.sin(angle)+b*Math.cos(angle)}else if(mode==="mirror"){if(axisStart&&axisEnd){const vx=axisEnd.x-axisStart.x,vy=axisEnd.y-axisStart.y,len2=vx*vx+vy*vy;if(len2>1e-12){const t=((x-axisStart.x)*vx+(y-axisStart.y)*vy)/len2,px=axisStart.x+t*vx,py=axisStart.y+t*vy;x=2*px-x;y=2*py-y}}else if(axis==="y")x=2*cx-x;else y=2*cy-y}return{x,y}};
const transform=(e,skipHostedOpening=false)=>{
 if(e.start)e.start=point(e.start);if(e.end)e.end=point(e.end);
 for(const key of ["position","center","witnessStart","witnessEnd","labelPosition"])if(e[key])e[key]=point(e[key]);
 for(const key of ["boundary","points","vertices","nodes"])if(Array.isArray(e[key]))e[key]=e[key].map(point);
 if(!skipHostedOpening&&(e.type==="door"||e.type==="window")&&Number.isFinite(e.offset)&&Number.isFinite(e.width)){
  const host=els().find(v=>v.id===e.hostWallId&&v.type==="wall");
  if(host){const len=wallLength(host);if(len>1e-8){const center={x:host.start.x+(host.end.x-host.start.x)*(e.offset+e.width/2)/len,y:host.start.y+(host.end.y-host.start.y)*(e.offset+e.width/2)/len},target=point(center),ux=(host.end.x-host.start.x)/len,uy=(host.end.y-host.start.y)/len;e.offset=Math.max(0,Math.min(len-e.width,(target.x-host.start.x)*ux+(target.y-host.start.y)*uy-e.width/2))}}
 }
 if(mode==="rotate"&&Number.isFinite(e.rotation))e.rotation+=angle;if(mode==="mirror"&&Number.isFinite(e.rotation))e.rotation=axisStart&&axisEnd?2*Math.atan2(axisEnd.y-axisStart.y,axisEnd.x-axisStart.x)-e.rotation:-e.rotation;
}
hist();
if(mode==="copy"){
const originals=[...list],idMap=new Map(originals.map(e=>[e.id,crypto.randomUUID()])),openingIdMap=new Map(),copiedGroupIds=new Map();for(const old of originals){const key=groupKey(old);if(key&&!copiedGroupIds.has(key))copiedGroupIds.set(key,crypto.randomUUID())}
for(const old of originals)if(old.type==="wall")for(const o of old.openings||[])openingIdMap.set(o.id,crypto.randomUUID());
const copies=originals.map(old=>{const clone=JSON.parse(JSON.stringify(old));clone.id=idMap.get(old.id);if(clone.type==="wall"&&Array.isArray(clone.openings))clone.openings=clone.openings.map(o=>({...o,id:openingIdMap.get(o.id)||crypto.randomUUID()}));if(clone.hostWallId&&idMap.has(clone.hostWallId))clone.hostWallId=idMap.get(clone.hostWallId);const oldGroup=groupKey(old);if(oldGroup){clone.groupId=copiedGroupIds.get(oldGroup);delete clone.gridSystemId;delete clone.gridSystemAxis;delete clone.gridSystemIndex}transform(clone,!!(old.hostWallId&&idMap.has(old.hostWallId)));return clone});
const openingCopies=[];
for(const old of originals){if(old.type!=="wall")continue;for(const child of els().filter(e=>["door","window"].includes(e.type)&&e.hostWallId===old.id&&!originals.some(item=>item.id===e.id))){const clone=JSON.parse(JSON.stringify(child));clone.id=openingIdMap.get(child.id)||crypto.randomUUID();clone.hostWallId=idMap.get(old.id);clone.storyId=old.storyId;openingCopies.push(clone)}}
p.elements.push(...copies,...openingCopies);for(const copy of [...copies,...openingCopies])if(copy.type==="door"||copy.type==="window"){const host=els().find(v=>v.id===copy.hostWallId&&v.type==="wall"),opening=host?.openings?.find(o=>o.id===copy.id);if(opening){opening.offset=copy.offset;opening.width=copy.width;opening.height=copy.height;opening.sill=copy.sill}}selected=new Set(copies.map(e=>e.id));
}else{for(const e of list)transform(e,list.some(v=>v.id===e.hostWallId));const wallIds=new Set(list.filter(e=>e.type==="wall").map(e=>e.id));for(const e of els())if(["door","window"].includes(e.type)&&(wallIds.has(e.hostWallId)||list.some(v=>v.id===e.id))){const wall=els().find(w=>w.id===e.hostWallId&&w.type==="wall");if(!wall)continue;let opening=wall.openings?.find(o=>o.id===e.id);if(!opening){if(!Array.isArray(wall.openings))wall.openings=[];opening={id:e.id,offset:e.offset,width:e.width,height:e.height,sill:e.sill};wall.openings.push(opening)}opening.offset=e.offset;opening.width=e.width;opening.height=e.height;opening.sill=e.sill;if(wallIds.has(e.hostWallId)){e.offset=opening.offset;e.width=opening.width;e.height=opening.height;e.sill=opening.sill}}}
scheduleAutoSave();redraw();renderProperties();$("status").textContent=mode==="copy"?"Selected elements duplicated":mode==="move"?"Selected elements moved":mode==="rotate"?"Selected elements rotated":"Selected elements mirrored";
}

const mobileShiftToggle=$("mobileShiftToggle");mobileShiftToggle?.addEventListener("click",()=>{mobileShiftToggleActive=!mobileShiftToggleActive;shiftHeld=mobileShiftToggleActive;shiftAngleLock=null;mobileShiftToggle.classList.toggle("active",mobileShiftToggleActive);mobileShiftToggle.setAttribute("aria-pressed",String(mobileShiftToggleActive));if(shiftHeld&&view==="floor"&&draft.length&&mouse){const cursor=wpos(mouse),anchor=draft[draft.length-1],reference=shiftReferencePoint(cursor,anchor);shiftAngleLock=lockCursorAxis(reference,cursor)}if(draft.length&&view==="floor")redraw();$("status").textContent=mobileShiftToggleActive?"Shift modifier ON · tap again to turn off":"Shift modifier OFF"});
function updateZoomReadout(){const percent=Math.round((view==="3d"?camera3d.zoom:viewportZoom)*100)+"%";const el=$("zoomReadout");if(el)el.textContent=percent;const mobile=$("mobile3dZoomReadout");if(mobile)mobile.textContent=Math.round(camera3d.zoom*100)+"%";const controls=$("mobile3dZoom");if(controls)controls.style.display=view==="3d"?"inline-flex":"none";if($("mobileMagicWand")){$("mobileMagicWand").style.display=window.matchMedia("(max-width: 760px), (pointer: coarse)").matches&&view==="floor"?"inline-flex":"none";$("mobileMagicWand").classList.toggle("active",tool==="magicwand");$("mobileMagicWand").setAttribute("aria-pressed",String(tool==="magicwand"))}}
function fitFloorPlan(){if(view==="3d"){$("fitModel").click();updateZoomReadout();return}const visible=els().filter(e=>e.storyId===story().id&&["wall","beam","column","slab","room","dimension"].includes(e.type));if(!visible.length){origin={x:0,y:0};viewportZoom=1;applyViewportZoom();redraw();updateZoomReadout();return}const pts=[];for(const e of visible){if(e.start)pts.push(e.start);if(e.end)pts.push(e.end);if(e.position)pts.push(e.position);if(e.boundary)pts.push(...e.boundary)}if(!pts.length)return;const minX=Math.min(...pts.map(v=>v.x)),maxX=Math.max(...pts.map(v=>v.x)),minY=Math.min(...pts.map(v=>v.y)),maxY=Math.max(...pts.map(v=>v.y));const availW=Math.max(100,c.clientWidth-100),availH=Math.max(100,c.clientHeight-100);const fitScale=Math.max(1,Math.min(180,Math.min(availW/Math.max(1,maxX-minX),availH/Math.max(1,maxY-minY))));viewportZoom=fitScale/baseScaleForDrawing();applyViewportZoom();origin.x=-((minX+maxX)/2)*scale;origin.y=((minY+maxY)/2)*scale;redraw();updateZoomReadout()}
function syncGridOptions(){const a=$("grid"),b=$("gridQuick");if(a&&b){if([...b.options].some(o=>o.value===a.value))b.value=a.value;else b.value="0.5"}}
function renderLayerPanel(){
 const host=$("layerPanel");if(!host)return;
 const layers=[...new Set(els().map(elementLayer))].sort((a,b)=>a.localeCompare(b));
 if(!layers.length){host.innerHTML='<p class="nav-note">No model layers yet. Create elements to populate this list.</p>';return}
 host.innerHTML=layers.map(layer=>{const hidden=hiddenLayers.has(layer),count=els().filter(e=>elementLayer(e)===layer).length;return '<label class="layer-row"><input type="checkbox" data-layer-visible="'+escapeHtml(layer)+'" '+(hidden?'':'checked')+'><span class="layer-swatch"></span><span class="layer-name">'+escapeHtml(layer)+'</span><small>'+count+'</small></label>'}).join("")+'<button id="showAllLayers" class="tree">Show All Layers</button>';
 host.querySelectorAll("[data-layer-visible]").forEach(input=>input.addEventListener("change",()=>{const layer=input.dataset.layerVisible;if(input.checked)hiddenLayers.delete(layer);else hiddenLayers.add(layer);for(const el of chosen())if(elementLayer(el)===layer&&!input.checked)selected.delete(el.id);redraw();renderProperties();renderLayerPanel();$("status").textContent=input.checked?"Layer shown: "+layer:"Layer hidden: "+layer}));
 $("showAllLayers").onclick=()=>{hiddenLayers.clear();redraw();renderProperties();renderLayerPanel();$("status").textContent="All layers visible"};
}
function ensureOpeningControls(){const toolbar=$("contextToolbar");if(!toolbar)return;const geometry=$("wallGeometryControl");const make=(id,label,opts)=>{if($(id+"Control"))return;const wrap=document.createElement("div");wrap.className="context-control";wrap.id=id+"Control";wrap.hidden=true;wrap.style.display="none";const lab=document.createElement("label");lab.htmlFor=id;lab.textContent=label;const sel=document.createElement("select");sel.id=id;sel.setAttribute("aria-label",label);for(const [value,text] of opts){const opt=document.createElement("option");opt.value=value;opt.textContent=text;sel.append(opt)}wrap.append(lab,sel);geometry?.after(wrap);sel.addEventListener("change",()=>{if(id==="openingHinge"){openingHingeSide=sel.value;if(pendingOpeningPlacement)pendingOpeningPlacement=openingPlacement.update({hingeSide:openingHingeSide})}else if(id==="openingSwing"){openingSwingDirection=sel.value;if(pendingOpeningPlacement)pendingOpeningPlacement=openingPlacement.update({swingDirection:openingSwingDirection})}else if(id==="openingLibraryType"){openingLibraryType=sel.value;if(pendingOpeningPlacement)pendingOpeningPlacement=openingPlacement.update({libraryType:openingLibraryType});redraw();$("status").textContent="Library: "+sel.options[sel.selectedIndex].text}else if(id==="openingAlignment"){openingAlignment=sel.value;if(pendingOpeningPlacement){const w=els().find(v=>v.id===pendingOpeningPlacement.wallId);if(w)pendingOpeningPlacement=openingPlacement.update({anchor:openingAlignment,offset:openingOffsetForAnchor(wallLength(w),pendingOpeningPlacement.width,openingAlignment,pendingOpeningPlacement.anchorPosition)})}redraw();$("status").textContent="Door / Window anchor: "+sel.options[sel.selectedIndex].text}});return wrap};make("openingHinge","Hinge / Side",[["left","Left"],["right","Right"]]);make("openingSwing","Opening Direction",[["inside","Inside"],["outside","Outside"]]);make("openingLibraryType","Library / Leaf",[["single-leaf","Single Leaf"],["double-leaf","Double Leaf"]]);make("openingAlignment","Anchor",[["center","Center (default)"],["left","Left edge"],["right","Right edge"]]);if(!$("roofPitchControl")){const pitch=document.createElement("div");pitch.className="context-control";pitch.id="roofPitchControl";pitch.hidden=true;pitch.style.display="none";const label=document.createElement("label");label.htmlFor="roofPitch";label.textContent="Roof Pitch (degrees)";const offsetLabel=document.createElement("label");offsetLabel.htmlFor="roofOffset";offsetLabel.textContent="Roof Offset (m)";const offsetInput=document.createElement("input");offsetInput.id="roofOffset";offsetInput.type="number";offsetInput.step="0.1";offsetInput.min="0";offsetInput.value="0";offsetInput.setAttribute("aria-label","Roof offset (m)");const offsetWrap=document.createElement("div");offsetWrap.className="context-control";offsetWrap.id="roofOffsetControl";offsetWrap.hidden=true;offsetWrap.style.display="none";offsetWrap.append(offsetLabel,offsetInput);geometry?.after(offsetWrap);const select=document.createElement("select");select.id="roofPitch";select.setAttribute("aria-label","Roof pitch");for(const value of [15,20,25,30,35,40,45]){const option=document.createElement("option");option.value=String(value);option.textContent=value+"°";if(value===30)option.selected=true;select.append(option)}pitch.append(label,select);geometry?.after(pitch);select.addEventListener("change",()=>{select.dataset.current=select.value})}}
$("openingLibraryType")?.addEventListener("change",()=>{openingLibraryType=$("openingLibraryType").value||"single-leaf";if(pendingOpeningPlacement)pendingOpeningPlacement=openingPlacement.update({libraryType:openingLibraryType});redraw();$("status").textContent="Library: "+$("openingLibraryType").options[$("openingLibraryType").selectedIndex]?.text});
function updateContextUI(){
 ensureOpeningControls();
 const names={select: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 3 19 15l-6 1-3 5z\"/></svg>","Select Tool","Select, inspect and edit model elements"],marquee: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"4\" y=\"5\" width=\"16\" height=\"14\" stroke-dasharray=\"2 2\"/></svg>","Marquee Tool","Drag a rectangular marquee, then use Ctrl/Cmd+A to select elements inside it"],wall: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 7h18v10H3zM8 7v10M16 7v10\"/></svg>","Wall Tool","Click start and end points to draw a wall"],slab: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m3 8 14-4 4 4-14 4zM3 8v8l4 4V12M7 20l14-4V8\"/></svg>","Slab Tool","Click at least three boundary points; double-click to finish"],zone: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 5h14v14H5z\"/><path d=\"M5 10h14M10 5v14\"/></svg>","Zone Tool","Click three or more boundary points to create a room zone; press Enter to finish"],roof: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m2 11 10-8 10 8M5 9v12h14V9M9 21v-7h6v7\"/></svg>","Roof Tool","Draw a roof footprint with three or more points; Enter to finish"],magicwand: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m4 20 11-11 4 4L8 24zM14 4V1M20 8h3M18 2l1-2M22 14l2 1\"/></svg>","Magic Wand","Click inside a closed wall loop to generate a roof from its reference lines"],column: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"7\" y=\"3\" width=\"10\" height=\"18\"/><path d=\"M4 3h16M4 21h16\"/></svg>","Column Tool","Click in the plan to place a column"],beam: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 6h18M3 18h18M8 6v12M16 6v12\"/></svg>","Beam Tool","Click start and end points to draw a beam"],door: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 21V3h11v18M5 3l11 3v15M13 12h.1\"/></svg>","Door Tool","Click close to a host wall to place a door"],window: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"14\"/><path d=\"M3 9h18M3 15h18M9 5v14M15 5v14\"/></svg>","Window Tool","Click close to a host wall to place a window"],dimension: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 12h18M3 12l5-5M3 12l5 5M21 12l-5-5M21 12l-5 5M6 5v14M18 5v14\"/></svg>","Dimension Tool","Click two points to create a dimension"],gridline: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M12 1v22M1 12h22\"/></svg>","Gridline Tool","Click two points to create a structural grid axis"],text:["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 5h16M12 5v14M8 19h8\"/></svg>","Text Tool","Click to place text · double-click existing text to edit · select text to move, copy or delete"]};
 const info=names[tool]||names.select;
 if($("contextToolIcon"))$("contextToolIcon").innerHTML=info[0];
 if($("contextToolName"))$("contextToolName").textContent=info[1];
 if($("contextToolHint"))$("contextToolHint").textContent=info[2];
 const show=(id,visible)=>{const node=$(id);if(node){node.hidden=!visible;node.style.display=visible?"":"none"}};
 show("wallHeightControl",tool==="wall");
 show("wallThicknessControl",tool==="wall");
 show("wallGeometryControl",tool==="wall");
 show("marqueeGeometryControl",tool==="marquee");
 if($("marqueeGeometryMethod")&&document.activeElement!==$("marqueeGeometryMethod"))$("marqueeGeometryMethod").value=marqueeGeometryMethod;
 if($("wallGeometryMethod")&&document.activeElement!==$("wallGeometryMethod"))$("wallGeometryMethod").value=wallGeometryMethod;
 show("openingHingeControl",tool==="door"||tool==="window");
 show("openingSwingControl",tool==="door"||tool==="window");show("openingLibraryTypeControl",tool==="door"||tool==="window");show("openingAlignmentControl",tool==="door"||tool==="window");if($("openingHinge")&&document.activeElement!==$("openingHinge"))$("openingHinge").value=openingHingeSide;if($("openingSwing")&&document.activeElement!==$("openingSwing"))$("openingSwing").value=openingSwingDirection;if($("openingLibraryType")&&document.activeElement!==$("openingLibraryType"))$("openingLibraryType").value=openingLibraryType;if($("openingAlignment")&&document.activeElement!==$("openingAlignment"))$("openingAlignment").value=openingAlignment;
 show("roofPitchControl",tool==="roof"||tool==="magicwand");
 show("roofOffsetControl",tool==="roof"||tool==="magicwand");
 if($("roofPitch")&&document.activeElement!==$("roofPitch"))$("roofPitch").value=String($("roofPitch").dataset.current||"30");
 if($("roofPitch"))$("roofPitch").addEventListener("change",()=>{$("roofPitch").dataset.current=$("roofPitch").value});
 if($("roofPitch")&&document.activeElement!==$("roofPitch"))$("roofPitch").value=String($("roofPitch").dataset.current||"30");

 if($("contextStoryName"))$("contextStoryName").textContent=story().name;
 if($("contextSelectionCount"))$("contextSelectionCount").textContent=selected.size+" element"+(selected.size===1?"":"s");
 if($("contextHeight")&&document.activeElement!==$("contextHeight"))$("contextHeight").value=$("height").value;
 if($("contextThickness")&&document.activeElement!==$("contextThickness"))$("contextThickness").value=$("thickness").value;
}

function resize(){const r=c.getBoundingClientRect(),d=window.devicePixelRatio||1;c.width=Math.max(1,r.width*d);c.height=Math.max(1,r.height*d);x.setTransform(d,0,0,d,0,0);redraw()}
function beginProvisionalDrawing(){if(provisionalDrawingActive)return;provisionalDrawingSnapshot=structuredClone(p);provisionalDrawingTool=tool;provisionalDrawingActive=true;provisionalWallClosed=false}
function commitProvisionalDrawing(){provisionalDrawingSnapshot=null;provisionalDrawingTool=null;provisionalDrawingActive=false;provisionalWallClosed=false}
function cancelProvisionalDrawing(){if(!provisionalDrawingActive)return false;const baseline=JSON.stringify(provisionalDrawingSnapshot);if(pendingHistorySnapshot){pendingHistorySnapshot=null;historyCommitQueued=false}let guard=0;while(JSON.stringify(p)!==baseline&&modelHistory.canUndo&&guard++<100){const previous=modelHistory.undo(p);if(!previous)break;p=previous}if(JSON.stringify(p)!==baseline){p=structuredClone(provisionalDrawingSnapshot);modelHistory.clear()}activeStoryId=p.stories.some(v=>v.id===activeStoryId)?activeStoryId:p.stories[0].id;selected=new Set([...selected].filter(id=>els().some(e=>e.id===id)));draft=[];floorDrawGesture=null;wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;trackerDistanceOverride=null;trackerAngleOverride=null;commitProvisionalDrawing();refreshStories();renderProperties();redraw();updateHistoryButtons();scheduleAutoSave();return true}
$("marqueeGeometryMethod")?.addEventListener("change",e=>{marqueeGeometryMethod=e.target.value;marqueeDraftPoints=[];marqueePreviewPoint=null;selectionBoxGesture=null;lastMarqueeRect=null;lastMarqueePolygon=null;redraw();$("status").textContent="Marquee Geometry Method: "+e.target.options[e.target.selectedIndex].text;});
function setTool(t){marqueeDraftPoints=[];marqueePreviewPoint=null;if(spaceMagicWandActive){spaceMagicWandActive=false;spaceMagicWandReturnTool=null;spaceHeld=false}if(releasedTouchEditPending)commitAndDeselect("Tool change");if(provisionalDrawingActive)cancelProvisionalDrawing();if(pendingOpeningPlacement){openingPlacement.cancel();pendingOpeningPlacement=null}tool=t;draft=[];floorDrawGesture=null;wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;trackerDistanceOverride=null;trackerAngleOverride=null;updateContextUI();document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool===t));$("toolName").value=t;document.querySelectorAll("[data-tool-command]").forEach(b=>b.classList.toggle("active",b.dataset.toolCommand===t));redraw()}

function activeEditGesture(){return gridlineMoveGesture||openingMoveGesture||genericNodeMoveGesture||genericEdgeMoveGesture||genericMoveGesture}
function hasActiveDrawing(){return !!(provisionalDrawingActive||draft.length>0||wallChainHasSegment||pendingOpeningPlacement)}
function finishElementEditGesture(action="commit"){
 releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null;
 const gestures=[gridlineMoveGesture,openingMoveGesture,genericNodeMoveGesture,genericEdgeMoveGesture,genericMoveGesture].filter(Boolean);
 if(!gestures.length)return false;
 const gesture=gestures[0];
 if(action==="cancel"){
  // Restore the complete pre-gesture model, not only the active element.
  if(gesture.modelBefore){
   p=structuredClone(gesture.modelBefore);
   activeStoryId=p.stories.some(v=>v.id===activeStoryId)?activeStoryId:p.stories[0].id;
  }else if(gesture===genericMoveGesture){
   for(const original of gesture.startElements||[]){const el=els().find(v=>v.id===original.id);if(!el)continue;const geo=original.geometry;for(const key of ["start","end","witnessStart","witnessEnd","position","boundary","offset","openings"]){if(geo[key]===null||geo[key]===undefined)delete el[key];else el[key]=structuredClone(geo[key])}}
  }else if(gesture===gridlineMoveGesture){
   if(gesture.groupStarts){for(const original of gesture.groupStarts){const member=els().find(v=>v.id===original.id);if(!member)continue;if(original.start&&original.end){member.start={...original.start};member.end={...original.end}}if(original.position)member.position={...original.position};if(original.boundary)member.boundary=original.boundary.map(pt=>({...pt}));if(original.witnessStart)member.witnessStart={...original.witnessStart};if(original.witnessEnd)member.witnessEnd={...original.witnessEnd}}}
   else{const el=els().find(v=>v.id===gesture.elementId&&v.type==="gridline");if(el){el.start={...gesture.start.start};el.end={...gesture.start.end}}}
  }else if(gesture===openingMoveGesture){
   const el=els().find(v=>v.id===gesture.elementId);if(el){el.offset=gesture.startOffset;const wall=els().find(v=>v.id===gesture.hostWallId&&v.type==="wall"),opening=wall?.openings?.find(o=>o.id===el.id);if(opening)opening.offset=gesture.startOffset}
  }
  if(gesture.historyStarted&&gesture.modelBefore)modelHistory.discardLast(gesture.modelBefore);
  $("status").textContent="Element edit cancelled";
 }else{
  if(gesture.didMove)scheduleAutoSave();
  $("status").textContent="Element edit committed";
 }
 const pointerIds=new Set(gestures.map(g=>g.pointerId).filter(Number.isFinite));
 for(const pointerId of pointerIds){try{if(c.hasPointerCapture?.(pointerId))c.releasePointerCapture(pointerId)}catch{}}
 genericMoveGesture=null;genericNodeMoveGesture=null;genericEdgeMoveGesture=null;gridlineMoveGesture=null;openingMoveGesture=null;
 isPanning=false;panStart=null;
 if(action!=="cancel")selected.clear();
 if(action==="cancel")scheduleAutoSave();
 redraw();renderProperties();updateEditActions();updateHistoryButtons();
 return true
}function updateEditActions(){const bar=$("editActions");if(!bar)return;const editActive=!!activeEditGesture(),active=editActive||hasActiveDrawing()||releasedTouchEditPending;bar.hidden=!active;bar.setAttribute("aria-hidden",String(!active));const identity=bar.querySelector("span"),commit=bar.querySelector("#editCommit"),cancel=bar.querySelector("#editCancel");if(identity)identity.textContent=editActive?"EDIT ELEMENT":pendingOpeningPlacement?"PLACE OPENING":"DRAW ELEMENT";if(commit){commit.setAttribute("aria-label",editActive?"Finish editing":pendingOpeningPlacement?"Place opening":"Finish drawing");commit.innerHTML="✓ <b>Finish</b>"}if(cancel){cancel.setAttribute("aria-label",editActive?"Cancel editing":pendingOpeningPlacement?"Cancel opening":"Cancel drawing");cancel.innerHTML="✕ <b>Cancel</b>"}bar.dataset.pendingTouchCompletion=String(releasedTouchEditPending)}

function finishDimensionChain(){
 if(tool!=="dimension"||draft.length<2)return false;
 const points=draft.map(pt=>({x:pt.x,y:pt.y}));
 const first=points[0],last=points[points.length-1],dx=last.x-first.x,dy=last.y-first.y,len=Math.hypot(dx,dy);
 if(len<.01){$("status").textContent="Dimension chain needs at least two distinct points";return false}
 const normal={x:-dy/len,y:dx/len};
 let offset=.5;
 if(mouse){const cursor=wpos(mouse),projection=(cursor.x-first.x)*normal.x+(cursor.y-first.y)*normal.y;if(Math.abs(projection)>.12)offset=projection}
 const groupId="dimension-chain-"+crypto.randomUUID();
 const segments=[];
 for(let i=0;i<points.length-1;i++){
  const a=points[i],b=points[i+1];
  if(Math.hypot(b.x-a.x,b.y-a.y)<.01)continue;
  const shift={x:normal.x*offset,y:normal.y*offset};
  segments.push({id:crypto.randomUUID(),type:"dimension",start:{x:a.x+shift.x,y:a.y+shift.y},end:{x:b.x+shift.x,y:b.y+shift.y},witnessStart:{x:a.x,y:a.y},witnessEnd:{x:b.x,y:b.y},groupId,dimensionChain:true,dimensionChainIndex:i,storyId:story().id});
 }
 if(!segments.length){$("status").textContent="Dimension chain needs distinct points";return false}
 hist("Create Dimension Chain");els().push(...segments);
 draft=[];floorDrawGesture=null;trackerDistanceOverride=null;trackerAngleOverride=null;selected=new Set(segments.map(el=>el.id));scheduleAutoSave();renderProperties();redraw();$("status").textContent="Dimension chain created · "+selected.size+" segments";return true;
}
function finishActiveDrawing(reason="Enter"){if(view!=="floor"&&view!=="3d")return false;const drawingTool=provisionalDrawingTool||tool;const hasDraft=draft.length>0;if(!provisionalDrawingActive&&!hasDraft&&!(drawingTool==="wall"&&wallChainHasSegment))return false;if(drawingTool==="wall"&&wallGeometryMethod==="continuous"&&!wallChainHasSegment)return false;if((drawingTool==="slab"||drawingTool==="roof")&&draft.length>=3){try{hist(drawingTool==="roof"?"Create roof":"Create slab");els().push(drawingTool==="roof"?createRoof(draft,{storyId:story().id,elevation:Number($("roofElevation")?.value??3),pitch:Number($("roofPitch")?.value??$("roofPitch")?.dataset.current??30),offset:Number($("roofOffset")?.value??0)}):createSlab(draft,{storyId:story().id}));$("status").textContent=drawingTool==="roof"?"Roof created":"Slab created"}catch(error){$("status").textContent=error.message;return false}}if(drawingTool==="zone"&&draft.length>=3){try{const boundary=draft.map(pt=>({x:pt.x,y:pt.y})),area=polygonArea(boundary);if(area<=0.01)throw new Error("Zone boundary must enclose a valid area");hist("Create Zone");const index=els().filter(el=>el.type==="room").length+1,center=boundary.reduce((acc,pt)=>({x:acc.x+pt.x/boundary.length,y:acc.y+pt.y/boundary.length}),{x:0,y:0});els().push({id:crypto.randomUUID(),type:"room",boundary,area,center,labelPosition:{...center},roomName:"",name:"",zoneNumber:"Z-"+String(index).padStart(2,"0"),zoneCategory:"",storyId:story().id,layer:"A-ROOM"});$("status").textContent="Zone created · "+area.toFixed(2)+" m²"}catch(error){$("status").textContent=error.message;return false}}if(drawingTool==="roof"&&draft.length<3){$("status").textContent="Roof needs at least three boundary points";return false}draft=[];floorDrawGesture=null;wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;trackerDistanceOverride=null;trackerAngleOverride=null;provisionalWallClosed=false;commitProvisionalDrawing();selected.clear();scheduleAutoSave();renderProperties();redraw();if(drawingTool!=="slab"&&drawingTool!=="roof")$("status").textContent=(drawingTool.charAt(0).toUpperCase()+drawingTool.slice(1))+" drawing committed";return true}
function confirmTrackerAndDraw(){if(view!=="floor"||!draft.length||!mouse||!["wall","beam","dimension","slab"].includes(tool))return false;const anchor=draft[draft.length-1],raw=wpos(mouse);let endpoint=trackerEndpoint(anchor,raw);if(trackerDistanceOverride===null&&trackerAngleOverride===null)endpoint=constrain(anchor,snapPoint(raw),{shiftKey:shiftHeld});const length=Math.hypot(endpoint.x-anchor.x,endpoint.y-anchor.y);if(!Number.isFinite(length)||length<.01){$("status").textContent="Tracker distance must be at least 0.01 m";return false}if(length>30){$("status").textContent="Drawing cancelled: segment exceeds 30 m";return false}if(tool==="wall"){if(wallGeometryMethod==="rectangle"){const ok=completeWallGeometry(anchor,endpoint,{shiftKey:false});if(ok){trackerDistanceOverride=null;trackerAngleOverride=null;redraw()}return ok}hist();const wall=createWall(anchor,endpoint,{storyId:story().id,height:+$("height").value||3,thickness:+$("thickness").value||.15});els().push(wall);if(wallGeometryMethod==="continuous"){wallChainStart??={x:anchor.x,y:anchor.y};if(!wallChainPoints.length)wallChainPoints.push({x:anchor.x,y:anchor.y});wallChainPoints.push({x:endpoint.x,y:endpoint.y});wallChainHasSegment=true;draft=[{x:endpoint.x,y:endpoint.y}]}else draft=[];floorDrawGesture=null;trackerDistanceOverride=null;trackerAngleOverride=null;$("status").textContent=wallGeometryMethod==="continuous"?"Wall segment created from tracker · continue clicking or press Enter to finish":"Wall created from tracker";if(wallGeometryMethod!=="continuous")commitProvisionalDrawing();renderProperties();redraw();return true}if(tool==="beam"||tool==="dimension"){hist();els().push(tool==="beam"?createBeam(anchor,endpoint,{storyId:story().id}):{id:crypto.randomUUID(),type:"dimension",start:anchor,end:endpoint,storyId:story().id});draft=[];floorDrawGesture=null;trackerDistanceOverride=null;trackerAngleOverride=null;commitProvisionalDrawing();$("status").textContent=tool.charAt(0).toUpperCase()+tool.slice(1)+" created from tracker";renderProperties();redraw();return true}if(tool==="slab"){draft.push(endpoint);trackerDistanceOverride=null;trackerAngleOverride=null;$("status").textContent="Slab point placed from tracker · continue or press Enter to finish";redraw();return true}return false}
function trackerEndpoint(anchor,raw){if(trackerDistanceOverride===null&&trackerAngleOverride===null)return raw;const dx=raw.x-anchor.x,dy=raw.y-anchor.y,d=Math.hypot(dx,dy),a=Math.atan2(dy,dx);const distance=trackerDistanceOverride===null?d:Math.max(0,Number(trackerDistanceOverride))/1000;const angle=trackerAngleOverride===null?a:Number(trackerAngleOverride)*Math.PI/180;return{x:anchor.x+Math.cos(angle)*distance,y:anchor.y+Math.sin(angle)*distance}}
function updateTrackerUI(){const box=$("dynamicTracker");if(!box)return;const active=view==="floor"&&draft.length&&mouse&&["wall","beam","dimension","slab"].includes(tool);box.hidden=!active;if(!active)return;const anchor=draft[draft.length-1],raw=wpos(mouse),endpoint=trackerEndpoint(anchor,(tool==="wall"||tool==="beam"||tool==="dimension"||tool==="slab")?constrain(anchor,raw,{shiftKey:shiftHeld}):raw),distance=Math.hypot(endpoint.x-anchor.x,endpoint.y-anchor.y)*1000,angle=((Math.atan2(endpoint.y-anchor.y,endpoint.x-anchor.x)*180/Math.PI)%360+360)%360;const wrap=$("canvas").parentElement,left=Math.max(6,Math.min(wrap.clientWidth-box.offsetWidth-6,mouse.x+16)),top=Math.max(6,Math.min(wrap.clientHeight-box.offsetHeight-6,mouse.y-box.offsetHeight-12));box.style.left=left+"px";box.style.top=top+"px";const di=$("trackerDistance"),ai=$("trackerAngle");if(document.activeElement!==di)di.value=unitSystem()==="imperial"?formatLength((trackerDistanceOverride===null?distance:trackerDistanceOverride)/1000,"imperial"):String(Math.round(trackerDistanceOverride===null?distance:trackerDistanceOverride));if(document.activeElement!==ai)ai.value=(trackerAngleOverride===null?angle:trackerAngleOverride).toFixed(1)}
function shiftReferencePoint(cursor,fallback){snapPoint(cursor);return activeSnapPoint?{x:activeSnapPoint.x,y:activeSnapPoint.y}:{x:fallback.x,y:fallback.y}}
 function lockCursorAxis(a,q){const dx=q.x-a.x,dy=q.y-a.y;return Math.abs(dx)>=Math.abs(dy)?(dx>=0?0:Math.PI):(dy>=0?Math.PI/2:-Math.PI/2)}
function constrain(a,b,e){if(!(e?.shiftKey||shiftHeld))return b;const angle=shiftAngleLock??lockCursorAxis(a,b);if(Math.abs(Math.sin(angle))<.5)return{x:b.x,y:a.y};return{x:a.x,y:b.y}}
function addWallSegment(a,b){const len=Math.hypot(b.x-a.x,b.y-a.y);if(!Number.isFinite(len)||len<.01||len>30)return false;els().push(createWall(a,b,{storyId:story().id,height:+$("height").value||3,thickness:+$("thickness").value||.15}));return true}
function completeWallGeometry(a,b,e){const end=constrain(a,b,e),len=Math.hypot(end.x-a.x,end.y-a.y);if(len<.01){$("status").textContent="Line too short — choose a farther endpoint";return false}if(wallGeometryMethod==="rectangle"){const p1=a,p2={x:end.x,y:a.y},p3=end,p4={x:a.x,y:end.y},sides=[[p1,p2],[p2,p3],[p3,p4],[p4,p1]];if(sides.some(([u,v])=>{const d=Math.hypot(v.x-u.x,v.y-u.y);return d<.01||d>30})){$("status").textContent="Rectangle sides must each be between 0.01 m and 30 m";return false}beginProvisionalDrawing();hist();for(const [u,v] of sides)addWallSegment(u,v);draft=[];floorDrawGesture=null;$("status").textContent="Wall rectangle pending · press Enter to commit or Esc to cancel";renderProperties();redraw();return true}if(len>30){$("status").textContent="Drawing cancelled: segment exceeds 30 m";draft=[];floorDrawGesture=null;wallChainStart=null;wallChainHasSegment=false;redraw();return false}beginProvisionalDrawing();hist();addWallSegment(a,end);if(wallGeometryMethod==="continuous"){wallChainStart??={x:a.x,y:a.y};if(!wallChainPoints.length)wallChainPoints.push({x:a.x,y:a.y});wallChainPoints.push({x:end.x,y:end.y});wallChainHasSegment=true;draft=[{x:end.x,y:end.y}]}else{wallChainStart=null;wallChainHasSegment=false;draft=[]}floorDrawGesture=null;$("status").textContent=wallGeometryMethod==="continuous"?"Wall segment created · continue clicking or press Esc":"Wall created";renderProperties();redraw();return true}

let scheduled3dRedrawFrame=0;function schedule3dRedraw(){if(scheduled3dRedrawFrame)return;scheduled3dRedrawFrame=requestAnimationFrame(()=>{scheduled3dRedrawFrame=0;redraw()})}
function orbitCameraBy(dx,dy){
 const oldYaw=camera3d.yaw,worldX=camera3d.panX*Math.cos(oldYaw)+camera3d.panY*Math.sin(oldYaw),worldY=-camera3d.panX*Math.sin(oldYaw)+camera3d.panY*Math.cos(oldYaw);
 camera3d.yaw+=dx;
 const cy=Math.cos(camera3d.yaw),sy=Math.sin(camera3d.yaw);
 camera3d.panX=worldX*cy-worldY*sy;camera3d.panY=worldX*sy+worldY*cy;
 camera3d.pitch=Math.max(-.08,Math.min(1.48,camera3d.pitch+dy));
}
function screenToWorld3d(q,z=story().elevation||0){const yaw=camera3d.yaw,pitch=camera3d.pitch,cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),factor=scale*.72*camera3d.zoom;const sp=Math.sin(pitch);if(!Number.isFinite(factor)||factor<=0)return{x:0,y:0};const rx=(q.x-c.clientWidth/2-origin.x)/factor+camera3d.panX;const vertical=(q.y-c.clientHeight*.58-origin.y)/factor;const stableSp=Math.abs(sp)<.12?(sp<0?-.12:.12):sp;const ry=vertical/stableSp+camera3d.panY+(z-camera3d.targetZ)*cp/stableSp;return{x:rx*cy+ry*sy,y:-rx*sy+ry*cy}}
function beginOpeningPlacement(q){
 const candidate=els().filter(w=>w.type==="wall"&&w.storyId===story().id).map(w=>({w,d:pointSegmentDistance(q,w.start,w.end)})).sort((a,b)=>a.d-b.d)[0];
 if(!candidate||candidate.d>.35){$("status").textContent=`Click within 350 mm of a host wall · cursor (${q.x.toFixed(2)}, ${q.y.toFixed(2)}) · nearest ${candidate?candidate.d.toFixed(2)+" m at "+candidate.w.start.x.toFixed(2)+","+candidate.w.start.y.toFixed(2)+" to "+candidate.w.end.x.toFixed(2)+","+candidate.w.end.y.toFixed(2):"no wall on active story"}`;return false}
 const w=candidate.w,width=tool==="door"?openingDoorWidth:openingWindowWidth,len=wallLength(w),anchor=$("openingAlignment")?.value||openingAlignment||"center",libraryType=$("openingLibraryType")?.value||openingLibraryType||"single-leaf";
 if(len+1e-8<width){$("status").textContent="Host wall is too short for this "+tool+" ("+width.toFixed(2)+" m required)";return false}
 openingAlignment=anchor;
 const dx=w.end.x-w.start.x,dy=w.end.y-w.start.y,position=((q.x-w.start.x)*dx+(q.y-w.start.y)*dy)/(len||1),anchorPosition=Math.max(0,Math.min(len,position));
 const offset=openingOffsetForAnchor(len,width,anchor,anchorPosition);
 const anchorPoint={x:w.start.x+dx*anchorPosition/(len||1),y:w.start.y+dy*anchorPosition/(len||1)};
 const cross=dx*(q.y-w.start.y)-dy*(q.x-w.start.x),revealSide=cross>=0?"left":"right";
 pendingOpeningPlacement=openingPlacement.begin({wallId:w.id,storyId:w.storyId,type:tool,offset,width,height:tool==="door"?openingDoorHeight:openingWindowHeight,sill:tool==="door"?openingDoorSill:openingWindowSill,hingeSide:openingHingeSide,swingDirection:openingSwingDirection,libraryType,revealSide,anchor,anchorPosition,anchorPoint,cursor:{x:q.x,y:q.y}});
 $("status").textContent="Move cursor to choose hinge left/right and swing inside/outside · Tab flips reveal side · Enter/tap blank paper places · Esc cancels";
 redraw();return true
}
function updatePendingOpening(q){
 if(!pendingOpeningPlacement)return;
 const wall=els().find(v=>v.id===pendingOpeningPlacement.wallId);
 if(!wall){openingPlacement.cancel();pendingOpeningPlacement=null;redraw();return}
 const aimed=openingPlacement.aim(q,wall.start,wall.end);
 // Archicad-style four-way aiming: along-wall cursor position selects hinge; wall side selects swing.
 const len=wallLength(wall),ux=(wall.end.x-wall.start.x)/len,uy=(wall.end.y-wall.start.y)/len;
 const openingCenter=pendingOpeningPlacement.offset+pendingOpeningPlacement.width/2;
 const cursorAlong=(q.x-wall.start.x)*ux+(q.y-wall.start.y)*uy;
 const hingeSide=cursorAlong<openingCenter?"left":"right";
 const offset=openingOffsetForAnchor(len,aimed.width,openingAlignment,aimed.anchorPosition);
 openingHingeSide=hingeSide;
 pendingOpeningPlacement=openingPlacement.update({anchor:openingAlignment,offset,hingeSide,swingDirection:aimed.swingDirection,cursor:{x:q.x,y:q.y}});
 if($("openingHinge"))$("openingHinge").value=hingeSide;
 openingSwingDirection=pendingOpeningPlacement.swingDirection;
 if($("openingSwing"))$("openingSwing").value=pendingOpeningPlacement.swingDirection;
 const hinge=pendingOpeningPlacement.hingeSide==="left"?"Left hinge":"Right hinge";
 const swing=pendingOpeningPlacement.swingDirection==="inside"?"Inside":"Outside";
 $("status").textContent=(pendingOpeningPlacement.type==="door"?"Door":"Window")+" preview · "+hinge+" · swings "+swing+" · anchor "+pendingOpeningPlacement.anchor+" · press Enter or tap blank paper to place";
 redraw();
}
document.addEventListener("keydown",e=>{if(e.key!=="Tab"||!pendingOpeningPlacement||/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName||""))return;e.preventDefault();e.stopPropagation();const revealSide=pendingOpeningPlacement.revealSide==="left"?"right":"left";pendingOpeningPlacement=openingPlacement.update({revealSide});$("status").textContent="Reveal side: "+revealSide+" · move cursor to choose hinge/swing · Enter to place";redraw()},true);
function commitPendingOpening(){if(!pendingOpeningPlacement)return false;const w0=els().find(v=>v.id===pendingOpeningPlacement.wallId);if(!w0){openingPlacement.cancel();pendingOpeningPlacement=null;redraw();return false}try{const expected=openingOffsetForAnchor(wallLength(w0),pendingOpeningPlacement.width,pendingOpeningPlacement.anchor||"center",pendingOpeningPlacement.anchorPosition);if(Math.abs(expected-pendingOpeningPlacement.offset)>1e-7||pendingOpeningPlacement.offset<0||pendingOpeningPlacement.offset+pendingOpeningPlacement.width>wallLength(w0)+1e-8)throw new RangeError("Opening anchor falls outside its host wall");const d=openingPlacement.confirm(),w=d&&els().find(v=>v.id===d.wallId);pendingOpeningPlacement=null;if(!w){redraw();return false}hist();const o=addOpening(w,d.type,d.offset,d.width,d.height,d.sill);o.hingeSide=d.hingeSide;o.swingDirection=d.swingDirection||"inside";o.libraryType=d.libraryType||"single-leaf";o.revealSide=d.revealSide||"left";o.alignment=d.anchor||"center";o.anchorPosition=Number(d.offset)+(o.alignment==="left"?0:o.alignment==="right"?Number(d.width):Number(d.width)/2);els().push({...o,hostWallId:w.id,storyId:w.storyId,alignment:d.anchor||"center",anchorPosition:o.anchorPosition,libraryType:d.libraryType||"single-leaf",revealSide:d.revealSide||"left"});$("status").textContent=(d.type==="door"?"Door":"Window")+" placed · opening direction confirmed";renderProperties();redraw();return true}catch(err){$("status").textContent=err.message;redraw();return false}}

function createRoofFromMagicWand(q){
 const loops=findClosedWallLoops(els().filter(e=>e.type==="wall"&&e.storyId===story().id&&isLayerVisible(e)),{tolerance:.06,minArea:.25}).filter(loop=>pointInPolygon(q,loop.boundary)).sort((a,b)=>a.area-b.area);
 if(!loops.length){$("status").textContent="Magic Wand: no closed wall reference at this point";return false}
 const loop=loops[0];
 if(els().some(e=>e.type==="roof"&&e.storyId===story().id&&e.sourceWallIds?.length===loop.wallIds.length&&loop.wallIds.every(id=>e.sourceWallIds.includes(id)))){$("status").textContent="Magic Wand: a roof already follows this wall loop";return false}
 try{hist("Magic Wand · Roof from walls");els().push(createRoof(loop.boundary,{storyId:story().id,elevation:Number($("roofElevation")?.value??3),pitch:Number($("roofPitch")?.value??$("roofPitch")?.dataset.current??30),offset:Number($("roofOffset")?.value??0),sourceWallIds:loop.wallIds}));selected.clear();scheduleAutoSave();renderProperties();redraw();$("status").textContent="Magic Wand created Roof from "+loop.wallIds.length+" reference walls";return true}catch(error){$("status").textContent="Magic Wand failed: "+error.message;return false}
}
function drawClick3d(q,e){const g=Math.max(.1,+$("grid").value||.5);q={x:Math.round(q.x/g)*g,y:Math.round(q.y/g)*g};q=snapPoint(q);if(tool==="select"){let hit=null;const rect=c.getBoundingClientRect(),px=e.clientX-rect.left,py=e.clientY-rect.top,screenPoint={x:px,y:py};const openingIds=new Set(els().filter(el=>el.type==="door"||el.type==="window").map(el=>el.id));const hitOpening=hitPolys3d.filter(item=>openingIds.has(item.id)).slice().reverse().find(item=>pointInPolygon(screenPoint,item.poly));if(hitOpening)hit=hitOpening.id;else for(let i=hitPolys3d.length-1;i>=0;i--){const item=hitPolys3d[i];if(openingIds.has(item.id))continue;if(pointInPolygon(screenPoint,item.poly)){hit=item.id;break}}if(e.shiftKey&&hit){selected.has(hit)?selected.delete(hit):selected.add(hit)}else selectOnly(hit);renderProperties();redraw();$("status").textContent=hit?"3D element selected":"No element at clicked position";return}if(tool==="column"){beginProvisionalDrawing();hist();els().push(createColumn(q,{storyId:story().id}));$("status").textContent="Column pending · press Enter to commit or Esc to cancel";redraw();return}if(tool==="door"||tool==="window"){if(pendingOpeningPlacement){if(view==="floor"){commitAndDeselect("Paper-space confirmation")}else $("status").textContent="Press Enter to confirm opening";return}beginOpeningPlacement(q);return}if(tool==="slab"||tool==="roof"){if(draft.length)q=constrain(draft[draft.length-1],q,e);draft.push(q);redraw();return}if(["wall","beam","dimension"].includes(tool)){if(draft.length){const a=draft[draft.length-1];if(tool==="wall"){completeWallGeometry(a,q,e);return}const b=constrain(a,q,e),len=Math.hypot(b.x-a.x,b.y-a.y);if(len<.01){$("status").textContent="Line too short — choose a farther endpoint";return}if(len>30){$("status").textContent="Drawing cancelled: segment exceeds 30 m";draft=[];floorDrawGesture=null;redraw();return}beginProvisionalDrawing();hist();if(tool==="beam")els().push(createBeam(a,b,{storyId:story().id}));else els().push({id:crypto.randomUUID(),type:"dimension",start:a,end:b,storyId:story().id});draft=[];floorDrawGesture=null;$("status").textContent=tool.charAt(0).toUpperCase()+tool.slice(1)+" pending · press Enter to commit or Esc to cancel";renderProperties();redraw();return}draft=[q];floorDrawGesture={pointerId:e.pointerId,tool,startScreen:{x:e.clientX,y:e.clientY},anchor:q,isStart:true,pointerWorld:{x:q.x,y:q.y}};$("status").textContent="Start point set — click endpoint or drag";redraw();return}}
c.addEventListener("pointermove",e=>{const r=c.getBoundingClientRect();if(textBoxGesture&&textBoxGesture.pointerId===e.pointerId){const g=textBoxGesture;g.currentScreen={x:e.clientX-r.left,y:e.clientY-r.top};g.currentWorld=wpos(g.currentScreen);g.didResize=Math.hypot(g.currentScreen.x-g.startScreen.x,g.currentScreen.y-g.startScreen.y)>=8;window.__arqenvoTextGestureDebug={phase:"pointermove",pointerId:e.pointerId,view,tool,didResize:g.didResize,startScreen:g.startScreen,currentScreen:g.currentScreen,elementCount:els().length,at:new Date().toISOString()};redraw();e.preventDefault();return}if(roomLabelMoveGesture&&roomLabelMoveGesture.pointerId===e.pointerId){const g=roomLabelMoveGesture,dx=e.clientX-g.startClient.x,dy=e.clientY-g.startClient.y;if(Math.hypot(dx,dy)>3){if(!g.historyStarted){hist("Move Room Label");g.historyStarted=true}const room=els().find(v=>v.id===g.roomId&&v.type==="room");if(room){room.labelPosition={x:g.startLabel.x+dx/scale,y:g.startLabel.y-dy/scale};g.didMove=true;$("status").textContent="Moving room name and area together";redraw()}}return}if(genericNodeMoveGesture&&genericNodeMoveGesture.pointerId===e.pointerId){
 const g=genericNodeMoveGesture;
 if(Math.hypot(e.clientX-g.startClient.x,e.clientY-g.startClient.y)>3){
  const raw=wpos({x:e.clientX-r.left,y:e.clientY-r.top});let q=snapPoint(raw);
  if(e.shiftKey||shiftHeld){if(!g.axisLock)g.axisLock=Math.abs(raw.x-g.startPoint.x)>=Math.abs(raw.y-g.startPoint.y)?"x":"y"}else if(!g.axisLockByKey)g.axisLock=null;
  if(g.axisLock==="x")q={x:q.x,y:g.startPoint.y};else if(g.axisLock==="y")q={x:g.startPoint.x,y:q.y};
  const dx=q.x-g.startPoint.x,dy=q.y-g.startPoint.y;
  if(Math.hypot(dx,dy)>1e-9){
   const el=els().find(v=>v.id===g.elementId);
   if(!g.historyStarted){hist("Move connected "+(g.role==="node"?"node":"point"));g.historyStarted=true}
   if(g.key==="boundary"&&el&&Array.isArray(el.boundary)){
    const next=el.boundary.map(pt=>({...pt}));next[g.index]={x:q.x,y:q.y};
    if(polygonArea(next)>1e-5)applyConnectedNodeMove(g.connectedPoints,dx,dy);
   }else applyConnectedNodeMove(g.connectedPoints,dx,dy);
   g.didMove=true;$("status").textContent="Moving connected node · shared geometry follows";redraw();
  }
 }
 return;
}
if(genericEdgeMoveGesture&&genericEdgeMoveGesture.pointerId===e.pointerId){
 const g=genericEdgeMoveGesture;
 if(Math.hypot(e.clientX-g.startClient.x,e.clientY-g.startClient.y)>3){
  const current=wpos({x:e.clientX-r.left,y:e.clientY-r.top});let dx=current.x-g.startWorld.x,dy=current.y-g.startWorld.y;
  if(e.shiftKey||shiftHeld){if(!g.axisLock)g.axisLock=Math.abs(dx)>=Math.abs(dy)?"x":"y"}else if(!g.axisLockByKey)g.axisLock=null;
  if(g.axisLock==="x")dy=0;else if(g.axisLock==="y")dx=0;
  if(p.settings?.snap!==false){const step=Math.max(.1,Number($("grid")?.value)||.5);if(!g.axisLock||g.axisLock==="x")dx=Math.round((g.startWorld.x+dx)/step)*step-g.startWorld.x;if(!g.axisLock||g.axisLock==="y")dy=Math.round((g.startWorld.y+dy)/step)*step-g.startWorld.y}
  if(Math.hypot(dx,dy)>1e-9){
   if(!g.historyStarted){hist("Move connected edge");g.historyStarted=true}
   // Walls need topology-aware junctions: translate the chosen wall edge, then
   // intersect adjacent wall axes so corners stay joined instead of skewing neighbours.
   if(g.wallEdge)moveConnectedWallEdge(g.wallEdge,dx,dy);
   else applyConnectedNodeMove(g.pointRecords,dx,dy);
   g.didMove=true;$("status").textContent=g.wallEdge?"Moving wall edge · connected corners maintained":"Moving edge · connected nodes move together";redraw()
  }
 }
 return;
}if(selectionBoxGesture&&selectionBoxGesture.pointerId===e.pointerId){const p={x:e.clientX-r.left,y:e.clientY-r.top};selectionBoxGesture.currentScreen=p;selectionBoxGesture.didDrag=Math.hypot(p.x-selectionBoxGesture.startScreen.x,p.y-selectionBoxGesture.startScreen.y)>4;redraw();return}if(tool==="marquee"&&marqueeDraftPoints.length){marqueePreviewPoint=wpos({x:e.clientX-r.left,y:e.clientY-r.top});redraw();return}if(view==="3d"&&e.pointerType==="touch"&&threeTouchPointers.has(e.pointerId)){threeTouchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(threeTouchGesture&&threeTouchPointers.size>=2){const pts=[...threeTouchPointers.values()],distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y)),next=Math.max(.2,Math.min(5,threeTouchGesture.zoom*distance/threeTouchGesture.distance));if(next!==camera3d.zoom){camera3d.zoom=next;schedule3dRedraw();updateZoomReadout()}e.preventDefault();return}}if(view==="floor"&&e.pointerType==="touch"&&floorTouchPointers.has(e.pointerId)){floorTouchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(floorTouchGesture&&floorTouchPointers.size>=2){const pts=[...floorTouchPointers.values()],mid={x:(pts[0].x+pts[1].x)/2-r.left,y:(pts[0].y+pts[1].y)/2-r.top},distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y)),nextScale=Math.max(1,Math.min(180,baseScaleForDrawing()*Math.max(.05,Math.min(5,floorTouchGesture.zoom*distance/floorTouchGesture.distance))));viewportZoom=Math.max(.05,Math.min(5,floorTouchGesture.zoom*distance/floorTouchGesture.distance));scale=nextScale;origin.x=mid.x-c.clientWidth/2-floorTouchGesture.world.x*scale;origin.y=mid.y-c.clientHeight/2+floorTouchGesture.world.y*scale;redraw();e.preventDefault();return}}if(view==="3d"&&pending3dPointer&&!threeTouchGesture&&threeTouchPointers.size<2){const dx=e.clientX-(lastCameraPointer?.x??pending3dPointer.x),dy=e.clientY-(lastCameraPointer?.y??pending3dPointer.y);if(!orbiting&&Math.hypot(e.clientX-pending3dPointer.x,e.clientY-pending3dPointer.y)>2){orbiting=true;c.style.cursor="grabbing"}if(orbiting){if(pending3dPointer.panGesture){const f=scale*.72*camera3d.zoom,sp=Math.sin(camera3d.pitch),cp=Math.cos(camera3d.pitch),safeSp=Math.max(.12,Math.abs(sp))*(sp<0?-1:1);camera3d.panX-=dx/f;camera3d.panY-=dy*safeSp/f;camera3d.targetZ+=dy*cp/f}else if(pending3dPointer.orbitGesture){orbitCameraBy(dx*.0028,dy*.0024)}lastCameraPointer={x:e.clientX,y:e.clientY};schedule3dRedraw()}return}if(isPanning&&panStart){if(view==="3d"){const dx=e.clientX-panStart.x,dy=e.clientY-panStart.y,f=scale*.72*camera3d.zoom,sp=Math.sin(camera3d.pitch),cp=Math.cos(camera3d.pitch),safeSp=Math.max(.12,Math.abs(sp))*(sp<0?-1:1);camera3d.panX-=dx/f;camera3d.panY-=dy*safeSp/f;camera3d.targetZ+=dy*cp/f}else{origin.x+=e.clientX-panStart.x;origin.y+=e.clientY-panStart.y}panStart={x:e.clientX,y:e.clientY};if(view==="3d")schedule3dRedraw();else redraw();return}if(view==="floor"&&genericMoveGesture&&genericMoveGesture.pointerId===e.pointerId){
 const g=genericMoveGesture,current=wpos({x:e.clientX-r.left,y:e.clientY-r.top});
 if(Math.hypot(e.clientX-g.startClient.x,e.clientY-g.startClient.y)>3){
  if(!g.historyStarted){hist("Move "+g.elementIds.length+" element"+(g.elementIds.length===1?"":"s"));g.historyStarted=true}
  let dx=current.x-g.startWorld.x,dy=current.y-g.startWorld.y;
  if(e.shiftKey||shiftHeld){if(!g.axisLock)g.axisLock=Math.abs(dx)>=Math.abs(dy)?"x":"y"}else if(!g.axisLockByKey)g.axisLock=null;if(g.axisLock==="x")dy=0;else if(g.axisLock==="y")dx=0;
  if(p.settings?.snap!==false){const step=Math.max(.1,Number($("grid")?.value)||.5);const nx=Math.round((g.startWorld.x+dx)/step)*step,ny=Math.round((g.startWorld.y+dy)/step)*step;if(!g.axisLock||g.axisLock==="x")dx=nx-g.startWorld.x;if(!g.axisLock||g.axisLock==="y")dy=ny-g.startWorld.y}
  for(const original of g.startElements||[]){const el=els().find(v=>v.id===original.id);if(!el)continue;const geo=original.geometry;if(geo.start&&geo.end){el.start={x:geo.start.x+dx,y:geo.start.y+dy};el.end={x:geo.end.x+dx,y:geo.end.y+dy}}if(geo.witnessStart)el.witnessStart={x:geo.witnessStart.x+dx,y:geo.witnessStart.y+dy};if(geo.witnessEnd)el.witnessEnd={x:geo.witnessEnd.x+dx,y:geo.witnessEnd.y+dy};if(geo.position)el.position={x:geo.position.x+dx,y:geo.position.y+dy};if(geo.boundary)el.boundary=geo.boundary.map(pt=>({x:pt.x+dx,y:pt.y+dy}));if(geo.offset!==null)el.offset=geo.offset;if(geo.openings&&el.openings)el.openings=geo.openings.map(o=>({...o}))}
  g.didMove=true;$("status").textContent="Moving "+g.elementIds.length+" element"+(g.elementIds.length===1?"":"s")+(g.axisLock?" · "+g.axisLock.toUpperCase()+" axis locked":"")+" · release or tap Finish";redraw();
 }
 return
}
if(view==="floor"&&gridlineMoveGesture&&gridlineMoveGesture.pointerId===e.pointerId){const g=gridlineMoveGesture,el=els().find(v=>v.id===g.elementId&&v.type==="gridline");if(el){const current=wpos({x:e.clientX-r.left,y:e.clientY-r.top});if(Math.hypot(e.clientX-g.startClient.x,e.clientY-g.startClient.y)>3){if(!g.historyStarted){hist("Move Gridline");g.historyStarted=true}let dx=current.x-g.startWorld.x,dy=current.y-g.startWorld.y;if(e.shiftKey||shiftHeld){if(!g.axisLock)g.axisLock=Math.abs(dx)>=Math.abs(dy)?"x":"y"}else if(!g.axisLockByKey)g.axisLock=null;if(g.axisLock==="x")dy=0;else if(g.axisLock==="y")dx=0;let nextStart={x:g.start.start.x+dx,y:g.start.start.y+dy},nextEnd={x:g.start.end.x+dx,y:g.start.end.y+dy};let snapCandidate=null,snapDistance=Infinity;if(p.settings?.snap!==false){const threshold=14/Math.max(1,scale),gridStep=Math.max(.1,Number($("grid")?.value)||.5);for(const endpoint of [nextStart,nextEnd]){const gridPoint={x:g.axisLock==="y"?endpoint.x:Math.round(endpoint.x/gridStep)*gridStep,y:g.axisLock==="x"?endpoint.y:Math.round(endpoint.y/gridStep)*gridStep};const gridDx=gridPoint.x-endpoint.x,gridDy=gridPoint.y-endpoint.y,gridDistance=Math.hypot(gridDx,gridDy);if(gridDistance<threshold&&gridDistance<snapDistance){snapDistance=gridDistance;snapCandidate={...gridPoint,kind:"grid",from:endpoint}}for(const target of els()){if(target.id===el.id||(groupKey(el)&&!groupsSuspended&&groupKey(target)===groupKey(el))||!isLayerVisible(target)||(view==="floor"&&target.storyId!==story().id))continue;const points=[];if(target.type==="wall"||target.type==="beam"){points.push({point:target.start,kind:"endpoint"},{point:target.end,kind:"endpoint"},{point:{x:(target.start.x+target.end.x)/2,y:(target.start.y+target.end.y)/2},kind:"midpoint"});const vx=target.end.x-target.start.x,vy=target.end.y-target.start.y,l2=vx*vx+vy*vy;if(l2>1e-9){const t=Math.max(0,Math.min(1,((endpoint.x-target.start.x)*vx+(endpoint.y-target.start.y)*vy)/l2));if(t>.025&&t<.975)points.push({point:{x:target.start.x+t*vx,y:target.start.y+t*vy},kind:"nearest"})}}else if(target.type==="column")points.push({point:target.position,kind:"center"});else if(target.type==="slab")(target.boundary||[]).forEach(point=>points.push({point,kind:"endpoint"}));for(const candidate of points){if(!candidate.point)continue;const sx=candidate.point.x-endpoint.x,sy=candidate.point.y-endpoint.y;if(g.axisLock==="x"&&Math.abs(sy)>threshold)continue;if(g.axisLock==="y"&&Math.abs(sx)>threshold)continue;const d=Math.hypot(g.axisLock==="x"?sx:g.axisLock==="y"?0:sx,g.axisLock==="y"?sy:g.axisLock==="x"?0:sy);if(d<threshold&&d<snapDistance){snapDistance=d;snapCandidate={...candidate.point,kind:candidate.kind,from:endpoint}}}}}}if(snapCandidate){const sx=snapCandidate.x-snapCandidate.from.x,sy=snapCandidate.y-snapCandidate.from.y;dx+=sx;dy+=sy;nextStart={x:g.start.start.x+dx,y:g.start.start.y+dy};nextEnd={x:g.start.end.x+dx,y:g.start.end.y+dy};activeSnapPoint={x:snapCandidate.x,y:snapCandidate.y,kind:snapCandidate.kind}}else activeSnapPoint=null;if(g.groupStarts){for(const original of g.groupStarts){const member=els().find(v=>v.id===original.id);if(!member)continue;if(original.start&&original.end){member.start={x:original.start.x+dx,y:original.start.y+dy};member.end={x:original.end.x+dx,y:original.end.y+dy}}if(original.position)member.position={x:original.position.x+dx,y:original.position.y+dy};if(original.boundary)member.boundary=original.boundary.map(pt=>({x:pt.x+dx,y:pt.y+dy}));if(original.witnessStart)member.witnessStart={x:original.witnessStart.x+dx,y:original.witnessStart.y+dy};if(original.witnessEnd)member.witnessEnd={x:original.witnessEnd.x+dx,y:original.witnessEnd.y+dy}}}else{el.start=nextStart;el.end=nextEnd}g.didMove=true;$("status").textContent="Moving Gridline "+(el.label||"")+(g.axisLock?" · "+g.axisLock.toUpperCase()+" axis locked":"")+(activeSnapPoint?" · snapped to "+activeSnapPoint.kind:"")+" · release to place";redraw()}}return}if(view==="floor"&&openingMoveGesture?.elementIds?.length>1&&openingMoveGesture.pointerId===e.pointerId){const g=openingMoveGesture,current=wpos({x:e.clientX-r.left,y:e.clientY-r.top});if(Math.hypot(e.clientX-g.startClient.x,e.clientY-g.startClient.y)>3){if(!g.historyStarted){hist("Move "+g.elementIds.length+" openings");g.historyStarted=true}const dx=current.x-g.startWorld.x,dy=current.y-g.startWorld.y;for(const start of g.startOpenings){const element=els().find(v=>v.id===start.id),wall=els().find(v=>v.id===start.hostWallId&&v.type==="wall");if(!element||!wall)continue;const len=wallLength(wall);if(len<=1e-8)continue;const ux=(wall.end.x-wall.start.x)/len,uy=(wall.end.y-wall.start.y)/len;const delta=dx*ux+dy*uy;const next=Math.max(0,Math.min(len-(Number(element.width)||0),start.offset+delta));element.offset=next;element.anchorPosition=next+(String(element.alignment||"center").toLowerCase()==="left"?0:String(element.alignment||"center").toLowerCase()==="right"?(Number(element.width)||0):(Number(element.width)||0)/2);const opening=wall.openings?.find(o=>o.id===element.id);if(opening)opening.offset=next}g.didMove=true;$("status").textContent="Moving "+g.elementIds.length+" openings · release to place";redraw()}return}if(view==="floor"&&openingMoveGesture&&openingMoveGesture.pointerId===e.pointerId){const gesture=openingMoveGesture;if(Math.hypot(e.clientX-gesture.startClient.x,e.clientY-gesture.startClient.y)>3){const wall=els().find(v=>v.id===gesture.hostWallId&&v.type==="wall"),element=els().find(v=>v.id===gesture.elementId);if(wall&&element){if(!gesture.historyStarted){hist("Move "+(element.type==="door"?"Door":"Window"));gesture.historyStarted=true}const len=wallLength(wall);if(len>1e-8){const dx=(wall.end.x-wall.start.x)/len,dy=(wall.end.y-wall.start.y)/len;const current=wpos({x:e.clientX-r.left,y:e.clientY-r.top});const delta=(current.x-gesture.startWorld.x)*dx+(current.y-gesture.startWorld.y)*dy;const next=Math.max(0,Math.min(len-(Number(element.width)||0),gesture.startOffset+delta));element.offset=next;const anchorMode=String(element.alignment||"center").toLowerCase();element.anchorPosition=next+(anchorMode==="left"?0:anchorMode==="right"?(Number(element.width)||0):(Number(element.width)||0)/2);const opening=wall.openings?.find(o=>o.id===element.id);if(opening)Object.assign(opening,{offset:next,anchorPosition:element.anchorPosition,alignment:element.alignment||"center"});gesture.didMove=true;$("status").textContent="Moving "+(element.type==="door"?"Door":"Window")+" · release to place";redraw()}}}return}mouse={x:e.clientX-r.left,y:e.clientY-r.top};const q=view==="3d"?screenToWorld3d(mouse,story().elevation||0):wpos(mouse);if(view==="floor")snapPoint(q);if(tool==="select"&&!activeEditGesture()&&view==="floor"){const nextCandidates=selectionCandidatesAt(q);const same=nextCandidates.map(el=>el.id).join("|")===tabSelectionCandidates.map(el=>el.id).join("|");if(!same){tabSelectionCandidates=nextCandidates;tabSelectionIndex=-1}const nextHover=tabSelectionIndex>=0?tabSelectionCandidates[tabSelectionIndex]?.id||null:nextCandidates[0]?.id||null;if(nextHover!==hoveredElementId){hoveredElementId=nextHover;redraw()}}if(pendingOpeningPlacement&&view==="floor")updatePendingOpening(q);if(shiftHeld&&draft.length&&shiftAngleLock===null&&view==="floor"){const anchor=draft[draft.length-1],reference=shiftReferencePoint(q,anchor);shiftAngleLock=lockCursorAxis(reference,q)}$("coords").textContent="X "+q.x.toFixed(2)+" · Y "+q.y.toFixed(2);redraw()});
c.addEventListener("pointerdown",e=>{if(e.button===2)return;/* Right-click is context-menu only: never run selection or edit-gesture logic from this pointerdown. */if(view==="floor"&&activeEditGesture()&&e.button===0&&e.isPrimary===false){e.preventDefault();return}if(!releasedTouchEditPending){releasedTouchEditSnapshot=JSON.stringify(p);}if(view==="3d"&&e.pointerType==="touch"){threeTouchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(threeTouchPointers.size>=2){const pts=[...threeTouchPointers.values()],distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));threeTouchGesture={distance,zoom:camera3d.zoom};pending3dPointer=null;orbiting=false;lastCameraPointer=null;e.preventDefault();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};return}if(threeTouchGesture){pending3dPointer=null;orbiting=false;lastCameraPointer=null;e.preventDefault();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};return}}if(view==="floor"&&e.pointerType==="touch"){floorTouchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(floorTouchPointers.size>=2){const pts=[...floorTouchPointers.values()],rect=c.getBoundingClientRect(),mid={x:(pts[0].x+pts[1].x)/2-rect.left,y:(pts[0].y+pts[1].y)/2-rect.top},world=wpos(mid),distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));floorTouchGesture={distance,scale,zoom:viewportZoom,world,mid,origin:{...origin}};draft=[];floorDrawGesture=null;openingMoveGesture=null;isPanning=false;panStart=null;$("status").textContent="Two-finger pan / zoom";e.preventDefault();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};return}}if(view==="3d"&&e.pointerType==="touch"){e.preventDefault();pending3dPointer={x:e.clientX,y:e.clientY,pointerId:e.pointerId,orbitGesture:true,touchGesture:true};orbiting=false;lastCameraPointer={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grab";return}if(view==="3d"&&e.button===1){e.preventDefault();pending3dPointer={x:e.clientX,y:e.clientY,pointerId:e.pointerId,orbitGesture:!(e.shiftKey||shiftHeld),panGesture:e.shiftKey||shiftHeld};orbiting=false;lastCameraPointer={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grab";return}if(view==="3d"&&e.button===0&&(e.shiftKey||shiftHeld)){pending3dPointer={x:e.clientX,y:e.clientY,pointerId:e.pointerId,orbitGesture:true};orbiting=false;lastCameraPointer={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grab";return}if(view==="3d"&&e.button===0){const rect=c.getBoundingClientRect(),q=screenToWorld3d({x:e.clientX-rect.left,y:e.clientY-rect.top},story().elevation||0);drawClick3d(q,e);return}if(view==="3d"&&e.button===1&&e.shiftKey){e.preventDefault();pending3dPointer={x:e.clientX,y:e.clientY,pointerId:e.pointerId,orbitGesture:true};orbiting=false;lastCameraPointer={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grab";return}if(e.button===1||spaceHeld){e.preventDefault();if(view==="floor"&&draft.length){$("status").textContent="Finish or cancel the active drawing before panning (Esc cancels)";return}isPanning=true;panStart={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grabbing";return}if(view!=="floor")return;const r=c.getBoundingClientRect();if(tool==="select"&&!e.shiftKey){const pointer={x:e.clientX-r.left,y:e.clientY-r.top};for(const room of els().filter(v=>v.type==="room"&&v.storyId===story().id&&isLayerVisible(v))){const anchor=spos(room.labelPosition||room.center||room.boundary[0]),zoneNumber=String(room.zoneNumber||"").trim(),name=String(room.roomName||room.name||"").trim(),area=(Number(room.area)||polygonArea(room.boundary)).toFixed(2)+" m²",width=Math.max(zoneNumber.length*6,name?name.length*7.2:0,area.length*6.8),height=name?44:28;if(Math.abs(pointer.x-anchor.x)<=Math.max(24,width/2+8)&&Math.abs(pointer.y-anchor.y)<=height/2+7){roomLabelMoveGesture={pointerId:e.pointerId,roomId:room.id,startClient:{x:e.clientX,y:e.clientY},startLabel:{...(room.labelPosition||room.center||room.boundary[0])},didMove:false,historyStarted:false};selectOnly(room.id);renderProperties();redraw();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};e.preventDefault();return}}}if(tool==="marquee"){const start={x:e.clientX-r.left,y:e.clientY-r.top},world=wpos(start);if(marqueeGeometryMethod==="rectangle"){selectionBoxGesture={pointerId:e.pointerId,startScreen:start,currentScreen:{...start},startWorld:world,didDrag:false,clickHitId:null};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};e.preventDefault();$("status").textContent="Rectangle Marquee · drag between opposite corners";redraw();return}if(marqueeGeometryMethod==="polygonal"){if(marqueeDraftPoints.length>=3&&Math.hypot(start.x-spos(marqueeDraftPoints[0]).x,start.y-spos(marqueeDraftPoints[0]).y)<12){finishMarqueePolygon();e.preventDefault();return}marqueeDraftPoints.push(world);marqueePreviewPoint=world;$("status").textContent="Polygonal Marquee · point "+marqueeDraftPoints.length+" set · close at first point or press Enter";redraw();e.preventDefault();return}if(marqueeGeometryMethod==="rotated-rectangle"){marqueeDraftPoints.push(world);marqueePreviewPoint=world;if(marqueeDraftPoints.length===1)$("status").textContent="Rotated Rectangle · click second point for first side";else if(marqueeDraftPoints.length===2)$("status").textContent="Rotated Rectangle · click third point for width";else finishRotatedMarquee();redraw();e.preventDefault();return}}let screenPoint={x:e.clientX-r.left,y:e.clientY-r.top};let q=wpos(screenPoint),rawPointerWorld={x:q.x,y:q.y},g=Math.max(.1,+$("grid").value||.5);
if(transformInteraction&&e.button===0){
 const state=transformInteraction;let rawPoint=wpos(screenPoint),pt=snapPoint(rawPoint);if(e.shiftKey||shiftHeld){const ref=state.points[0];if(ref){if(state.mode==="rotate"&&state.points.length>=1){const center=state.points[0],base=state.points[1]||rawPoint,baseAngle=Math.atan2(base.y-center.y,base.x-center.x),rawAngle=Math.atan2(rawPoint.y-center.y,rawPoint.x-center.x),step=Math.PI/12,locked=baseAngle+Math.round((rawAngle-baseAngle)/step)*step,radius=Math.hypot(rawPoint.x-center.x,rawPoint.y-center.y);pt={x:center.x+Math.cos(locked)*radius,y:center.y+Math.sin(locked)*radius}}else{const locked=constrain(ref,rawPoint,{shiftKey:true});pt=locked}}}state.points.push({...pt});
 const needed=state.mode==="rotate"?3:state.mode==="mirror"?2:2;
 if(state.points.length<needed){$("status").textContent=state.mode==="rotate"?(state.points.length===1?"Rotate · centre set; click reference point":"Rotate · reference set; click target angle"):(state.mode==="mirror"?"Mirror · first axis point set; click second axis point":"Move / Multiply · reference point set; click destination");redraw();e.preventDefault();return}
 transformInteraction=null;
 const pts=state.points;let args={};
 if(state.mode==="move"||state.mode==="copy")args={dx:pts[1].x-pts[0].x,dy:pts[1].y-pts[0].y};
 else if(state.mode==="rotate"){const a=Math.atan2(pts[1].y-pts[0].y,pts[1].x-pts[0].x),b=Math.atan2(pts[2].y-pts[0].y,pts[2].x-pts[0].x);args={pivot:pts[0],angle:b-a}}
 else args={axisStart:pts[0],axisEnd:pts[1]};
 transformSelected(state.mode,args);e.preventDefault();return;
}if(!draft.length&&["wall","beam","dimension","slab","column"].includes(tool)&&(!Number.isFinite(q.x)||!Number.isFinite(q.y)||Math.abs(q.x)>25||Math.abs(q.y)>25)){origin={x:0,y:0};viewportZoom=1;applyViewportZoom();q=wpos(screenPoint);$("status").textContent="Reset drawing viewport to a usable origin before starting a new element"}const cursorWorld={x:q.x,y:q.y};const magneticPoint=snapPoint(cursorWorld,shiftHeld?0:undefined);q=shiftHeld?{x:Math.round(cursorWorld.x/g)*g,y:Math.round(cursorWorld.y/g)*g}:(activeSnapPoint?magneticPoint:{x:Math.round(cursorWorld.x/g)*g,y:Math.round(cursorWorld.y/g)*g});if(tool==="text"){textBoxGesture={pointerId:e.pointerId,startScreen:{x:e.clientX-r.left,y:e.clientY-r.top},currentScreen:{x:e.clientX-r.left,y:e.clientY-r.top},startWorld:{x:q.x,y:q.y},currentWorld:{x:q.x,y:q.y},didResize:false};window.__arqenvoTextGestureDebug={phase:"pointerdown",pointerId:e.pointerId,pointerType:e.pointerType,isTrusted:e.isTrusted,view,tool,target:e.target?.id||e.target?.tagName||"",canvasRect:{left:r.left,top:r.top,width:r.width,height:r.height},elementCount:els().length,at:new Date().toISOString()};console.info("[Arqenvo Text Tool] pointerdown",window.__arqenvoTextGestureDebug);try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{}e.preventDefault();$("status").textContent="Drag to size the text box, then release to type";redraw();return}if(pendingGridSystem){if(!pendingGridSystem.origin){pendingGridSystem.origin={x:q.x,y:q.y};$("status").textContent="Grid System origin set · click to define X-axis direction";redraw();return}const gs=pendingGridSystem,dx=q.x-gs.origin.x,dy=q.y-gs.origin.y,angle=Math.atan2(dy,dx);if(Math.hypot(dx,dy)<.1){$("status").textContent="Choose an X-axis direction at least 0.1 m from the origin";return}const ux=Math.cos(angle),uy=Math.sin(angle),vx=-uy,vy=ux,corner=gs.startCorner||"bottom-left",xSign=corner.endsWith("right")?-1:1,ySign=corner.startsWith("top")?-1:1,xPositions=[0],yPositions=[0];gs.xSpacing.forEach(v=>xPositions.push(xPositions[xPositions.length-1]+v));gs.ySpacing.forEach(v=>yPositions.push(yPositions[yPositions.length-1]+v));const totalX=xPositions[xPositions.length-1],totalY=yPositions[yPositions.length-1],pointAt=(a,b)=>({x:gs.origin.x+ux*a*xSign+vx*b*ySign,y:gs.origin.y+uy*a*xSign+vy*b*ySign}),letters=n=>{let out="";for(n=Math.max(0,n);n>=0;n=Math.floor(n/26)-1)out=String.fromCharCode(65+n%26)+out;return out},axisLabel=(base,index)=>{if(/^\d+$/.test(base))return String(Number(base)+index);let start=0;for(const ch of base.toUpperCase())start=start*26+(ch.charCodeAt(0)-64);return letters(Math.max(0,start-1+index))};if(xPositions.length+yPositions.length>60){pendingGridSystem=null;$("status").textContent="Grid System limited to 60 axes";return}hist("Create Grid System");const groupId=crypto.randomUUID(),ext=gs.extension;for(let i=0;i<xPositions.length;i++){const pos=xPositions[i];els().push({id:crypto.randomUUID(),type:"gridline",start:pointAt(pos,-ext),end:pointAt(pos,totalY+ext),label:gs.verticalLabels?.[i]??axisLabel(gs.yLabel,i),storyId:story().id,gridSystemId:groupId,gridSystemAxis:"vertical",gridSystemIndex:i,markerSides:{start:ySign>0?!!gs.markerSides.bottom:!!gs.markerSides.top,end:ySign>0?!!gs.markerSides.top:!!gs.markerSides.bottom},markerRadius:gs.markerRadius})}for(let i=0;i<yPositions.length;i++){const pos=yPositions[i];els().push({id:crypto.randomUUID(),type:"gridline",start:pointAt(-ext,pos),end:pointAt(totalX+ext,pos),label:gs.horizontalLabels?.[i]??axisLabel(gs.xLabel,i),storyId:story().id,gridSystemId:groupId,gridSystemAxis:"horizontal",gridSystemIndex:i,markerSides:{start:xSign>0?!!gs.markerSides.left:!!gs.markerSides.right,end:xSign>0?!!gs.markerSides.right:!!gs.markerSides.left},markerRadius:gs.markerRadius})}let columnCount=0,beamCount=0,dimensionCount=0;if(gs.createDimensions){const chainOffset=Math.max(0,Number(gs.chainDimensionOffset??1000)/1000),totalOffset=Math.max(0,Number(gs.totalDimensionOffset??1500)/1000),topMarkerY=(totalY+ext)*ySign,leftMarkerX=-ext*xSign,chainY=topMarkerY-chainOffset*ySign,totalYDim=topMarkerY-totalOffset*ySign,chainX=leftMarkerX+chainOffset*xSign,totalXDim=leftMarkerX+totalOffset*xSign;for(let i=0;i<gs.xSpacing.length;i++){const dim={id:crypto.randomUUID(),type:"dimension",start:pointAt(xPositions[i],chainY),end:pointAt(xPositions[i+1],chainY),witnessStart:pointAt(xPositions[i],topMarkerY),witnessEnd:pointAt(xPositions[i+1],topMarkerY),storyId:story().id,gridSystemId:groupId,gridDimension:"chain",gridDimensionAxis:"vertical",gridDimensionIndex:i,gridDimensionOffset:Number(gs.chainDimensionOffset??1000)};els().push(dim);dimensionCount++}if(gs.totalDimension){const dim={id:crypto.randomUUID(),type:"dimension",start:pointAt(0,totalYDim),end:pointAt(totalX,totalYDim),witnessStart:pointAt(0,topMarkerY),witnessEnd:pointAt(totalX,topMarkerY),storyId:story().id,gridSystemId:groupId,gridDimension:"total",gridDimensionAxis:"vertical",gridDimensionOffset:Number(gs.totalDimensionOffset??1500)};els().push(dim);dimensionCount++}for(let i=0;i<gs.ySpacing.length;i++){const dim={id:crypto.randomUUID(),type:"dimension",start:pointAt(chainX,yPositions[i]),end:pointAt(chainX,yPositions[i+1]),witnessStart:pointAt(leftMarkerX,yPositions[i]),witnessEnd:pointAt(leftMarkerX,yPositions[i+1]),storyId:story().id,gridSystemId:groupId,gridDimension:"chain",gridDimensionAxis:"horizontal",gridDimensionIndex:i,gridDimensionOffset:Number(gs.chainDimensionOffset??1500)};els().push(dim);dimensionCount++}if(gs.totalDimension){const dim={id:crypto.randomUUID(),type:"dimension",start:pointAt(totalXDim,0),end:pointAt(totalXDim,totalY),witnessStart:pointAt(leftMarkerX,0),witnessEnd:pointAt(leftMarkerX,totalY),storyId:story().id,gridSystemId:groupId,gridDimension:"total",gridDimensionAxis:"horizontal",gridDimensionOffset:Number(gs.totalDimensionOffset??1000)};els().push(dim);dimensionCount++}}if(gs.placeColumns){for(const px of xPositions)for(const py of yPositions){const column=createColumn(pointAt(px,py),{storyId:story().id});column.gridSystemId=groupId;column.properties={...column.properties,gridIntersection:true};els().push(column);columnCount++}}if(gs.createBeams){for(const py of yPositions)for(let i=0;i<xPositions.length-1;i++){const beam=createBeam(pointAt(xPositions[i],py),pointAt(xPositions[i+1],py),{storyId:story().id});beam.gridSystemId=groupId;els().push(beam);beamCount++}for(const px of xPositions)for(let i=0;i<yPositions.length-1;i++){const beam=createBeam(pointAt(px,yPositions[i]),pointAt(px,yPositions[i+1]),{storyId:story().id});beam.gridSystemId=groupId;els().push(beam);beamCount++}}pendingGridSystem=null;selected=new Set(els().filter(el=>el.gridSystemId===groupId&&el.type==="gridline").map(el=>el.id));scheduleAutoSave();renderProperties();redraw();$("status").textContent="Grid System created · "+xPositions.length+" X-axis, "+yPositions.length+" Y-axis"+(columnCount?" · "+columnCount+" columns":"")+(beamCount?" · "+beamCount+" beams":"")+(dimensionCount?" · "+dimensionCount+" dimensions":"");return}if(draft.length&&["wall","beam","dimension","slab"].includes(tool)){if(trackerDistanceOverride!==null||trackerAngleOverride!==null){q=trackerEndpoint(draft[draft.length-1],q);trackerDistanceOverride=null;trackerAngleOverride=null}}/* Unified node/edge hit-testing for editable element geometry.
 * A pointer-down on geometry must not become a node edit merely because the
 * current selection has a nearby endpoint; only a real hit within tolerance
 * is accepted. A lone selected node edits only its owner. Shared nodes join
 * only explicitly selected elements when selection has more than one member.
 */
if(tool==="select"&&view==="floor"&&!(e.shiftKey||shiftHeld)){
 const selectedElements=els().filter(v=>selected.has(v.id)&&isLayerVisible(v)&&v.storyId===story().id);
 const nodeHits=[];
 for(const el of selectedElements){
  for(const point of elementEditablePoints(el)){
   const sp=spos(point.point),dist=Math.hypot(sp.x-screenPoint.x,sp.y-screenPoint.y);
   if(dist<=14)nodeHits.push({el,...point,dist});
  }
 }
 nodeHits.sort((a,b)=>a.dist-b.dist);
 if(nodeHits.length){
  const h=nodeHits[0];
  const connectedPoints=captureConnectedNode(h.point,selected.size>1?undefined:h.el.id)
   .filter(rec=>selected.size>1?selected.has(rec.id):rec.id===h.el.id);
  genericNodeMoveGesture={pointerId:e.pointerId,elementId:h.el.id,key:h.key,index:h.index,role:h.role,startPoint:{...h.point},connectedPoints,startClient:{x:e.clientX,y:e.clientY},didMove:false,historyStarted:false,axisLock:null,modelBefore:structuredClone(p)};
  try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{}
  $("status").textContent=selected.size>1?"Selected node · selected connected elements move together":"Selected node · only this element will change";
  renderProperties();redraw();e.preventDefault();return;
 }
 const edgeHits=[];
 for(const el of selectedElements){
  for(const edge of elementEditableEdges(el)){
   const dist=pointSegmentDistance(q,edge.a.point,edge.b.point);
   if(dist<=12/Math.max(1,scale))edgeHits.push({el,edge,dist});
  }
 }
 edgeHits.sort((a,b)=>a.dist-b.dist);
 if(edgeHits.length){
  const h=edgeHits[0];
  const pointRecords=selected.size>1
   ?captureConnectedNodes([h.edge.a.point,h.edge.b.point]).filter(rec=>selected.has(rec.id))
   :[];
  const wallEdge=h.el.type==="wall"?beginConnectedWallEdgeGesture(h.el,h.edge):null;
  genericEdgeMoveGesture={pointerId:e.pointerId,elementId:h.el.id,elementType:h.el.type,edge:{a:{...h.edge.a.point},b:{...h.edge.b.point}},wallEdge,pointRecords,startWorld:{...wpos(screenPoint)},startClient:{x:e.clientX,y:e.clientY},didMove:false,historyStarted:false,axisLock:null,modelBefore:structuredClone(p)};
  try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{}
  $("status").textContent=selected.size>1?"Selected edge · selected connected elements move together":"Selected edge · only this element will change";
  renderProperties();redraw();e.preventDefault();return;
 }
}if(tool==="wall"){if(!draft.length){draft=[q];wallChainStart=wallGeometryMethod==="continuous"?{x:q.x,y:q.y}:null;wallChainPoints=wallChainStart?[{x:q.x,y:q.y}]:[];wallChainHasSegment=false;floorDrawGesture={pointerId:e.pointerId,tool,startScreen:{x:e.clientX,y:e.clientY},anchor:q,isStart:true,pointerWorld:{x:q.x,y:q.y}};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};$("status").textContent=wallGeometryMethod==="rectangle"?"Rectangle start point set — click opposite corner":"Wall start point set — click next point; click the first point to close or press Enter to finish";redraw();return}completeWallGeometry(draft[draft.length-1],q,e);return}
if(tool==="select"){q=rawPointerWorld;let hit=nearestElement(q);if(tabSelectionIndex>=0){const cycled=tabSelectionCandidates[tabSelectionIndex];if(cycled&&selectionCandidatesAt(q).some(el=>el.id===cycled.id))hit=cycled;else{tabSelectionIndex=-1;tabSelectionCandidates=[]}}
 // Hosted openings are queried first in their saved wall interval. Keep hit testing independent from snap/grid movement.
 const rect=c.getBoundingClientRect();let openingCandidateOnClick=null;
 if(view==="floor"){const pointer={x:e.clientX-rect.left,y:e.clientY-rect.top},pixelTolerance=16;const openingHits=[];for(const w of els().filter(el=>el.type==="wall"&&isLayerVisible(el)&&el.storyId===story().id)){const dx=w.end.x-w.start.x,dy=w.end.y-w.start.y,len=Math.hypot(dx,dy)||1;const a=spos(w.start),b=spos(w.end),sx=b.x-a.x,sy=b.y-a.y,pixelLength=Math.hypot(sx,sy)||1;const along=((pointer.x-a.x)*sx+(pointer.y-a.y)*sy)/(pixelLength*pixelLength)*len;const perpendicular=pointSegmentDistance(pointer,a,b);for(const o of els().filter(el=>(el.type==="door"||el.type==="window")&&el.hostWallId===w.id)){const start=Math.max(0,Number(o.offset)||0),width=Math.max(0,Number(o.width)||0);if(width<=0)continue;const margin=pixelTolerance/Math.max(1,scale);if(along>=start-margin&&along<=start+width+margin&&perpendicular<=Math.max(pixelTolerance,(Number(w.thickness)||.15)*scale/2+pixelTolerance)){openingHits.push({opening:o,distance:perpendicular})}}}openingHits.sort((a,b)=>a.distance-b.distance);openingCandidateOnClick=openingHits[0]?.opening||null;/* A click inside an opening may select its hosted element; pointer-up decides whether it was a click or a marquee drag. */if(openingCandidateOnClick&&hit&&!["door","window"].includes(hit.type))hit=null;lastFloorSelectionDebug={pointer,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},q:{...q},nearest:nearestElement(q)?.id||null,openingHits:openingHits.map(v=>({id:v.opening.id,type:v.opening.type,distance:v.distance,offset:v.opening.offset,width:v.opening.width,hostWallId:v.opening.hostWallId})),hostedOpenings:els().filter(el=>el.type==="door"||el.type==="window").map(o=>({id:o.id,type:o.type,hostWallId:o.hostWallId,storyId:o.storyId,offset:o.offset,width:o.width,hostExists:els().some(w=>w.type==="wall"&&w.id===o.hostWallId)})),walls:els().filter(el=>el.type==="wall"&&isLayerVisible(el)&&el.storyId===story().id).map(w=>({id:w.id,a:spos(w.start),b:spos(w.end),thickness:w.thickness,openings:(w.openings||[]).map(o=>({id:o.id,type:o.type,offset:o.offset,width:o.width}))}))}}

 // A click on an element is an intentional selection action, not blank-paper confirmation.
 const openingHit=hit&&["door","window"].includes(hit.type);if(openingHit)selectionBoxGesture=null;const marqueeEligible=!(e.shiftKey||shiftHeld)&&!releasedTouchEditPending&&!activeEditGesture()&&!pendingOpeningPlacement&&!hasActiveDrawing();if(marqueeEligible&&!hit){selectionBoxGesture={pointerId:e.pointerId,startScreen:{x:e.clientX-rect.left,y:e.clientY-rect.top},currentScreen:{x:e.clientX-rect.left,y:e.clientY-rect.top},startWorld:{...q},didDrag:false,clickHitId:hit?.id||null,openingCandidateId:openingCandidateOnClick?.id||null};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{}}if(hit&&(releasedTouchEditPending||activeEditGesture()))commitAndDeselect("Selection change");
 else if(!hit&&(releasedTouchEditPending||activeEditGesture()||pendingOpeningPlacement||hasActiveDrawing())){e.preventDefault();commitAndDeselect("Outside click");return}if((e.shiftKey||shiftHeld)&&hit){const ids=groupMembers(hit).map(v=>v.id),remove=ids.every(id=>selected.has(id));for(const id of ids){if(remove)selected.delete(id);else selected.add(id)}}else if(hit||!selectionBoxGesture){if(!(hit&&selected.has(hit.id)))selectOnly(hit?.id)}if(hit&&!selectionBoxGesture&&!(e.shiftKey||shiftHeld)&&!["gridline","door","window"].includes(hit.type)){
 const starts=groupMembers(hit).map(el=>({id:el.id,geometry:{start:el.start?{...el.start}:null,end:el.end?{...el.end}:null,witnessStart:el.witnessStart?{...el.witnessStart}:null,witnessEnd:el.witnessEnd?{...el.witnessEnd}:null,position:el.position?{...el.position}:null,boundary:el.boundary?el.boundary.map(pt=>({...pt})):null,offset:Number.isFinite(el.offset)?el.offset:null,openings:el.openings?el.openings.map(o=>({...o})):null}}));
 genericMoveGesture={pointerId:e.pointerId,elementIds:starts.map(el=>el.id),startElements:starts,startWorld:{x:q.x,y:q.y},startClient:{x:e.clientX,y:e.clientY},didMove:false,historyStarted:false,axisLock:null,modelBefore:structuredClone(p)};
 try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};updateEditActions();
 }else if(hit&&hit.type==="gridline"&&!(e.shiftKey||shiftHeld)){gridlineMoveGesture={pointerId:e.pointerId,elementId:hit.id,startWorld:{x:q.x,y:q.y},startClient:{x:e.clientX,y:e.clientY},start:{start:{...hit.start},end:{...hit.end}},groupStarts:groupKey(hit)&&!groupsSuspended?els().filter(v=>groupKey(v)===groupKey(hit)).map(v=>({id:v.id,start:v.start?{...v.start}:null,end:v.end?{...v.end}:null,position:v.position?{...v.position}:null,boundary:v.boundary?v.boundary.map(pt=>({...pt})):null,witnessStart:v.witnessStart?{...v.witnessStart}:null,witnessEnd:v.witnessEnd?{...v.witnessEnd}:null})):null,didMove:false,historyStarted:false,axisLock:null,modelBefore:structuredClone(p)};updateEditActions();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};$("status").textContent="Gridline selected · drag the line to move it"}else if(hit&&["door","window"].includes(hit.type)&&!(e.shiftKey||shiftHeld)){selectionBoxGesture=null;const openingSelection=selected.has(hit.id)?els().filter(v=>selected.has(v.id)&&["door","window"].includes(v.type)&&v.storyId===story().id):[hit];const canMoveTogether=openingSelection.length>1&&openingSelection.every(v=>openingSelection.every(w=>v.type===w.type));openingMoveGesture={pointerId:e.pointerId,elementId:hit.id,hostWallId:hit.hostWallId,startWorld:{x:q.x,y:q.y},startClient:{x:e.clientX,y:e.clientY},startOffset:Number(hit.offset)||0,...(canMoveTogether?{elementIds:openingSelection.map(v=>v.id),startOpenings:openingSelection.map(v=>({id:v.id,hostWallId:v.hostWallId,offset:Number(v.offset)||0}))}:{}),didMove:false,historyStarted:false,modelBefore:structuredClone(p)};updateEditActions();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{}}renderProperties();redraw();return}
if(tool==="magicwand"){createRoofFromMagicWand(q);if(spaceMagicWandActive){const returnTool=spaceMagicWandReturnTool||"select";spaceMagicWandActive=false;spaceMagicWandReturnTool=null;spaceHeld=false;setTool(returnTool);updateZoomReadout()}return}if(tool==="column"){hist();const element=createColumn(q,{storyId:story().id});Object.assign(element,structuredClone(arqenvoCreationDefaults?.column||{}));els().push(element);redraw();return}
if(tool==="door"||tool==="window"){if(pendingOpeningPlacement){commitPendingOpening();selected.clear();renderProperties();redraw();return}beginOpeningPlacement(q);return}
if(tool==="slab"||tool==="roof"||tool==="zone"){if(draft.length)q=constrain(draft[draft.length-1],q,e);draft.push(q);$("status").textContent=(tool==="zone"?"Zone":tool==="roof"?"Roof":"Slab")+" boundary point "+draft.length+" set · click next point, then press Enter to finish";redraw();return}
if(["wall","beam","dimension","gridline"].includes(tool)){if(tool==="dimension"){draft.push({x:q.x,y:q.y});floorDrawGesture=null;$("status").textContent="Dimension point "+draft.length+" set · click more points, then press Enter";redraw();return}if(draft.length){const a=draft[0],length=Math.hypot(q.x-a.x,q.y-a.y);if(length<.01){$("status").textContent="Line too short — choose a farther endpoint";return}if(length>30){$("status").textContent="Drawing cancelled: segment exceeds 30 m";draft=[];redraw();return}hist();if(tool==="wall")els().push(createWall(a,q,{storyId:story().id,height:+$("height").value||3,thickness:+$("thickness").value||.15}));else if(tool==="beam")els().push(createBeam(a,q,{storyId:story().id}));else if(tool==="gridline"){const n=els().filter(v=>v.type==="gridline").length;els().push({id:crypto.randomUUID(),type:"gridline",start:a,end:q,label:String.fromCharCode(65+(n%26)),storyId:story().id})}else els().push({id:crypto.randomUUID(),type:"dimension",start:a,end:q,storyId:story().id});draft=[];floorDrawGesture=null;$("status").textContent=tool.charAt(0).toUpperCase()+tool.slice(1)+" created";renderProperties();redraw();return}floorDrawGesture={pointerId:e.pointerId,tool,startScreen:{x:e.clientX,y:e.clientY},anchor:q,isStart:true,pointerWorld:{x:q.x,y:q.y}};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};draft=[q];$("status").textContent=(tool==="wall"?"Wall":tool==="beam"?"Beam":"Dimension")+" start point set — click endpoint or drag";redraw();return}});

function commitTextBoxGesture(source,event){
 if(!textBoxGesture||(event?.pointerId!==undefined&&textBoxGesture.pointerId!==event.pointerId))return false;
 const g=textBoxGesture;
 window.__arqenvoTextGestureDebug={phase:"release-received",source,pointerId:g.pointerId,eventPointerId:event?.pointerId??null,eventType:event?.type||"synthetic",eventTrusted:!!event?.isTrusted,view,tool,didResize:g.didResize,startScreen:g.startScreen,currentScreen:g.currentScreen,elementCount:els().length,at:new Date().toISOString()};
 console.info("[Arqenvo Text Tool] release",window.__arqenvoTextGestureDebug);
 textBoxGesture=null;
 if(!g.didResize){$("status").textContent="Text box not created · drag to define its width and height";window.__arqenvoLastTextDiagnostic={source,at:new Date().toISOString(),reason:"gesture-too-small",elementCount:els().length};redraw();return true}
 const left=Math.min(g.startWorld.x,g.currentWorld.x),top=Math.max(g.startWorld.y,g.currentWorld.y),right=Math.max(g.startWorld.x,g.currentWorld.x),bottom=Math.min(g.startWorld.y,g.currentWorld.y),width=Math.max(.08,right-left),height=Math.max(.04,top-bottom);
 const element={id:crypto.randomUUID(),type:"text",position:{x:left,y:top},text:"",textWidthMm:Math.max(2,width*1000/drawingScaleDenominator),textBoxHeightMm:Math.max(2,height*1000/drawingScaleDenominator),textSizeMm:Number(arqenvoTextDefaults?.textSizeMm)||2.5,color:arqenvoTextDefaults?.color||"#263640",storyId:story().id};
 hist("Create Text Box");els().push(element);selected=new Set([element.id]);renderProperties();scheduleAutoSave();redraw();$("status").textContent="Text box sized · opening text editor…";
 window.__arqenvoPendingTextEditorId=element.id;
 requestAnimationFrame(()=>{
  const exists=els().some(item=>item.id===element.id);
  const opened=exists?openInlineTextEditorWithDiagnostics(element,source):false;
  if(!exists||!opened)$("status").textContent=exists?"Text box created but editor refused to open · diagnostic saved":"Text box was replaced before editor opened · diagnostic saved";
  if(window.__arqenvoPendingTextEditorId===element.id)window.__arqenvoPendingTextEditorId=null;
 });
 return true;
}
