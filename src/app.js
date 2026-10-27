import {createProject,createWall,createSlab,createColumn,createBeam,createRoof,addOpening,wallLength,serializeProject,deserializeProject,pointSegmentDistance,polygonArea,elementSchedule,validateProject} from "./core/model.js";
import {detectRooms as detectClosedRooms} from "./core/rooms.js";
import {serializeScheduleCsv} from "./core/csv.js";
import {extractSection} from "./core/section.js";
import {exportFloorPlanDxf} from "./core/dxf.js";
import {createOpeningPlacement, openingOffsetForAnchor, openingPlacementDirection, doorSwingGeometry, hostedOpening3dGeometry, findClosedWallLoops} from "./core/authoring.js";
import {ModelHistory, transactModel} from "./core/transactions.js";
import {wallEndJoin, segmentIntersection} from "./core/geometry.js";
import {normalizeUnitSystem,formatLength,formatArea} from "./core/units.js";
const $=id=>document.getElementById(id), c=$("canvas"), x=c.getContext("2d");
let gridVisible=true,hiddenLayers=new Set(),groupsSuspended=false;
const modelHistory=new ModelHistory({limit:80});
let pendingHistorySnapshot=null,historyCommitQueued=false;
const escapeHtml=value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("\\'","&#39;");
let p=createProject(), tool="select", view="floor", layoutMode=false, activeLayoutId=null, draft=[], floorDrawGesture=null, selected=new Set(), scale=36, drawingScaleDenominator=100, viewportZoom=1, origin={x:0,y:0}, mouse=null, activeStoryId=p.stories[0].id, isPanning=false, panStart=null, spaceHeld=false, wallGeometryMethod="continuous", wallChainStart=null, wallChainPoints=[], wallChainHasSegment=false, trackerDistanceOverride=null, trackerAngleOverride=null, activeSnapPoint=null, openingHingeSide="left", openingSwingDirection="inside", openingAlignment="center", pendingOpeningPlacement=null, openingMoveGesture=null;
let gridlineMoveGesture=null, genericMoveGesture=null, genericNodeMoveGesture=null, genericEdgeMoveGesture=null, roomLabelMoveGesture=null, pendingGridSystem=null;
let spaceMagicWandActive=false,spaceMagicWandReturnTool=null;
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
function updateUnitButton(){const b=$("unitSettingsButton");if(b)b.textContent="Units: "+(unitSystem()==="imperial"?"Imperial":"Metric")}
let autosaveTimer=null;
// 3D navigation camera: orbit (left-drag), pan (middle/space-drag), zoom (wheel/pinch).
let camera3d={yaw:-Math.PI/4,pitch:Math.PI/5,zoom:1,panX:0,panY:0,targetZ:1.5};
let orbiting=false,lastCameraPointer=null,pending3dPointer=null,hitPolys3d=[],shiftHeld=false,shiftAngleLock=null;
// Floor-plan touch navigation: two fingers pan/zoom without creating geometry.
const floorTouchPointers=new Map();let floorTouchGesture=null;const threeTouchPointers=new Map();let threeTouchGesture=null;
function scheduleAutoSave(){if(autosaveTimer)clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>{try{localStorage.setItem(AUTOSAVE_KEY,serializeProject(p))}catch(error){$("status").textContent="Autosave unavailable: "+error.message}},700)}
function hist(label="Edit model"){if(!pendingHistorySnapshot)pendingHistorySnapshot=structuredClone(p);if(historyCommitQueued)return;historyCommitQueued=true;queueMicrotask(()=>{const before=pendingHistorySnapshot;pendingHistorySnapshot=null;historyCommitQueued=false;if(!before)return;try{if(JSON.stringify(before)===JSON.stringify(p)){updateHistoryButtons();return}const transaction=transactModel(before,{label,mutate:draft=>{for(const key of Object.keys(draft))delete draft[key];Object.assign(draft,structuredClone(p));return {changedNodes:["model"]}},validate:draft=>validateProject(draft),history:modelHistory});p=transaction.model;updateHistoryButtons();scheduleAutoSave()}catch(error){p=before;activeStoryId=p.stories.some(s=>s.id===activeStoryId)?activeStoryId:p.stories[0].id;selected=new Set([...selected].filter(id=>els().some(e=>e.id===id)));refreshStories();redraw();renderProperties();updateHistoryButtons();$("status").textContent="Edit rejected: "+error.message}})}
function restore(json){p=deserializeProject(json);selected=new Set([...selected].filter(id=>els().some(e=>e.id===id)));redraw();renderProperties();updateHistoryButtons()}
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
   const g=doorSwingGeometry(a,b,{hingeSide:el.hingeSide,swingDirection:el.swingDirection});
   const radial=Math.abs(Math.hypot(screenQ.x-g.hinge.x,screenQ.y-g.hinge.y)-g.radius);
   const angle=Math.atan2(screenQ.y-g.hinge.y,screenQ.x-g.hinge.x);
   const sweepContains=angleInArc(angle,g.startAngle,g.endAngle,g.anticlockwise);
   symbolDistance=Math.min(pointSegmentDistance(screenQ,g.hinge,g.openFree),sweepContains?radial:Infinity);
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
function snapPoint(q,radius){activeSnapPoint=null;if(p.settings?.snap===false)return q;const threshold=radius??(10/Math.max(1,scale));let best=null,bestDistance=threshold,bestKind="";const consider=(point,kind)=>{if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return;const d=Math.hypot(q.x-point.x,q.y-point.y);if(d<bestDistance){best={x:point.x,y:point.y};bestDistance=d;bestKind=kind}};for(const el of els()){if(!isLayerVisible(el)||(view==="floor"&&el.storyId!==story().id))continue;if(el.type==="wall"||el.type==="beam"){consider(el.start,"endpoint");consider(el.end,"endpoint");consider({x:(el.start.x+el.end.x)/2,y:(el.start.y+el.end.y)/2},"midpoint");const dx=el.end.x-el.start.x,dy=el.end.y-el.start.y,len2=dx*dx+dy*dy;if(len2>1e-9){const t=Math.max(0,Math.min(1,((q.x-el.start.x)*dx+(q.y-el.start.y)*dy)/len2));if(t>0.025&&t<0.975)consider({x:el.start.x+t*dx,y:el.start.y+t*dy},"nearest")}}if(el.type==="column")consider(el.position,"center");if(el.type==="slab")for(const v of el.boundary)consider(v,"endpoint")}if(view==="floor"&&gridVisible){const step=Math.max(.1,Number($("grid")?.value)||.5),gp={x:Math.round(q.x/step)*step,y:Math.round(q.y/step)*step};consider(gp,"grid")}if(best)activeSnapPoint={...best,kind:bestKind};return best||q}
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
function render3DScene(ctx,items,project3d,options={}){
 const faces3d=[];
 
const prism=(e,footprint,z0,height)=>{if(!Array.isArray(footprint)||footprint.length<3||!(height>0))return;const base=footprint.map(pt=>project3d(pt,z0)),top=footprint.map(pt=>project3d(pt,z0+height));const chosenElement=(!!options.interactive&&selected.has(e.id));
for(let i=0;i<base.length;i++){const j=(i+1)%base.length;const poly=[base[i],base[j],top[j],top[i]];faces3d.push({id:e.id,poly,depth:poly.reduce((sum,pt)=>sum+pt.depth,0)/poly.length,fill:chosenElement?"#9acbd0":(i%2?"#cbd4da":"#b8c4cc"),selected:chosenElement})}
faces3d.push({id:e.id,poly:top,depth:top.reduce((sum,pt)=>sum+pt.depth,0)/top.length,fill:chosenElement?"#bce3e6":"#e4e9ed",selected:chosenElement})};
for(const e of items){if(!isLayerVisible(e)||!["wall","beam","column","slab","door","window","roof"].includes(e.type))continue;const level=p.stories.find(v=>v.id===e.storyId),storyElevation=level?.elevation||0;if(e.type==="roof"){const center={x:e.boundary.reduce((s,v)=>s+v.x,0)/e.boundary.length,y:e.boundary.reduce((s,v)=>s+v.y,0)/e.boundary.length},radius=Math.min(...e.boundary.map(v=>Math.hypot(v.x-center.x,v.y-center.y))),baseZ=storyElevation+(e.elevation||0)+(e.offset||0),rise=Math.tan((e.pitch||30)*Math.PI/180)*radius,base=e.boundary.map(v=>project3d(v,baseZ)),inner=e.boundary.map(v=>project3d(v,baseZ-(e.thickness||.18))),peak=project3d(center,baseZ+rise),chosenElement=(!!options.interactive&&selected.has(e.id));for(let i=0;i<base.length;i++){const j=(i+1)%base.length,poly=[base[i],base[j],peak];faces3d.push({id:e.id,poly,depth:poly.reduce((sum,pt)=>sum+pt.depth,0)/poly.length,fill:chosenElement?"#d2a47f":"#b98760",selected:chosenElement});faces3d.push({id:e.id,poly:[base[j],base[i],inner[i],inner[j]],depth:(base[i].depth+base[j].depth)/2,fill:"#795640",selected:chosenElement})}continue}if(e.type==="door"||e.type==="window"){
 const host=items.find(v=>v.id===e.hostWallId&&v.type==="wall");if(!host)continue;
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
  for(const [u,v,lo,hi] of frameRects){const poly=[{x:u.x+nx,y:u.y+ny},{x:v.x+nx,y:v.y+ny},{x:v.x-nx,y:v.y-ny},{x:u.x-nx,y:u.y-ny}];prism(e,poly,zBottom+lo,Math.max(.015,hi-lo))}
  const jambs=[a,b];
  for(const jamb of jambs){const poly=[{x:jamb.x+nx,y:jamb.y+ny},{x:jamb.x+nx+dx/len*frame,y:jamb.y+ny+dy/len*frame},{x:jamb.x-nx+dx/len*frame,y:jamb.y-ny+dy/len*frame},{x:jamb.x-nx,y:jamb.y-ny}];prism(e,poly,zBottom, g.height)}
  prism(e,g.boundary,baseZ,g.height);
 }else prism(e,g.boundary,baseZ,g.height);
 continue
}let footprint=[],z0=storyElevation,height=0;
if(e.type==="wall"){const dx=e.end.x-e.start.x,dy=e.end.y-e.start.y,len=Math.hypot(dx,dy);if(len<1e-6)continue;const nx=-dy/len*e.thickness/2,ny=dx/len*e.thickness/2,base=storyElevation+(e.baseOffset||0),openings=e.openings||[],cuts=[0,len];for(const o of openings){cuts.push(Math.max(0,Math.min(len,o.offset)),Math.max(0,Math.min(len,o.offset+o.width)))}const positions=[...new Set(cuts.filter(Number.isFinite).sort((u,v)=>u-v).map(v=>Number(v.toFixed(6))))];for(let i=0;i<positions.length-1;i++){const lo=positions[i],hi=positions[i+1];if(hi-lo<1e-5)continue;const mid=(lo+hi)/2,holes=openings.filter(o=>o.offset<mid&&o.offset+o.width>mid).map(o=>[Math.max(0,o.sill||0),Math.min(e.height,(o.sill||0)+o.height)]).filter(v=>v[1]>v[0]).sort((u,v)=>u[0]-v[0]);const merged=[];for(const hole of holes){const last=merged[merged.length-1];if(last&&hole[0]<=last[1])last[1]=Math.max(last[1],hole[1]);else merged.push([...hole])}const solids=[];let z=0;for(const hole of merged){if(hole[0]>z)solids.push([z,hole[0]]);z=Math.max(z,hole[1])}if(z<e.height)solids.push([z,e.height]);const at=t=>({x:e.start.x+dx*t/len,y:e.start.y+dy*t/len});for(const [low,high] of solids){const u=at(lo),v=at(hi),poly=[{x:u.x+nx,y:u.y+ny},{x:v.x+nx,y:v.y+ny},{x:v.x-nx,y:v.y-ny},{x:u.x-nx,y:u.y-ny}];prism(e,poly,base+low,high-low)} }continue}else if(e.type==="beam"){const dx=e.end.x-e.start.x,dy=e.end.y-e.start.y,len=Math.hypot(dx,dy);if(len<1e-6)continue;const nx=-dy/len*e.width/2,ny=dx/len*e.width/2;footprint=[{x:e.start.x+nx,y:e.start.y+ny},{x:e.end.x+nx,y:e.end.y+ny},{x:e.end.x-nx,y:e.end.y-ny},{x:e.start.x-nx,y:e.start.y-ny}];z0+=e.elevation||0;height=e.depth}
else if(e.type==="column"){const angle=e.rotation||0,cos=Math.cos(angle),sin=Math.sin(angle),hx=e.width/2,hy=e.depth/2;footprint=[[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy]].map(([u,v])=>({x:e.position.x+u*cos-v*sin,y:e.position.y+u*sin+v*cos}));height=e.height}
else{footprint=e.boundary;z0+=e.elevation||0;height=e.thickness}
prism(e,footprint,z0,height)
}for(const face of faces3d.sort((a,b)=>a.depth-b.depth)){ctx.fillStyle=face.fill;ctx.strokeStyle=face.selected?"#087e8b":"#52616b";ctx.lineWidth=face.selected?1.5:1;ctx.beginPath();face.poly.forEach((pt,i)=>i?ctx.lineTo(pt.x,pt.y):ctx.moveTo(pt.x,pt.y));ctx.closePath();ctx.fill();ctx.stroke()}hitPolys3d=faces3d.map(({id,poly,depth})=>({id,poly,depth}));
}
function renderFloorPlanElements(ctx,items,pointAt,scaleFactor,options={}){
for(const e of items){const isSel=!!options.interactive&&selected.has(e.id),isHover=!!options.interactive&&hoveredElementId===e.id&&!isSel;ctx.strokeStyle=isSel?"#087e8b":isHover?"#d97706":e.type==="room"?"#6aa5a8":"#4b5660";ctx.fillStyle=e.type==="room"?"rgba(217,240,242,.28)":"#e9eef0";ctx.lineWidth=isSel?2:isHover?1.8:1;
if(e.type==="gridline"){const a=pointAt(e.start),b=pointAt(e.end);ctx.save();ctx.strokeStyle=isSel?"#087e8b":"#6d8296";ctx.fillStyle="#fff";ctx.lineWidth=isSel?2:1.2;ctx.setLineDash([7,4]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);const markerFlags=e.markerSides||{start:true,end:false};const markerPoints=[];if(markerFlags.start)markerPoints.push([a,e.label||"A"]);if(markerFlags.end)markerPoints.push([b,e.label||"A"]);for(const [pt,label] of markerPoints){const markerRadius=10;ctx.beginPath();ctx.arc(pt.x,pt.y,markerRadius,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle=isSel?"#087e8b":"#526779";ctx.font="bold 11px Arial";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(String(label),pt.x,pt.y);ctx.fillStyle="#fff"}ctx.restore()}
else if(e.type==="wall"||e.type==="beam"){const a=pointAt(e.start),b=pointAt(e.end),dx=b.x-a.x,dy=b.y-a.y,screenLen=Math.hypot(dx,dy),ux=dx/(screenLen||1),uy=dy/(screenLen||1),nx=-uy,ny=ux,thick=Math.max(1,(e.type==="wall"?e.thickness:e.width)*scaleFactor);ctx.lineWidth=thick;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();if(e.type==="wall"){for(const o of[...(e.openings||[]),...(options.includePending&&pendingOpeningPlacement?.wallId===e.id?[pendingOpeningPlacement]:[])]){const len=wallLength(e),startT=Math.max(0,Math.min(1,o.offset/(len||1))),endT=Math.max(startT,Math.min(1,(o.offset+o.width)/(len||1))),p1={x:a.x+dx*startT,y:a.y+dy*startT},p2={x:a.x+dx*endT,y:a.y+dy*endT},mid={x:(p1.x+p2.x)/2,y:(p1.y+p2.y)/2},radius=Math.hypot(p2.x-p1.x,p2.y-p1.y);ctx.save();ctx.lineCap="butt";ctx.strokeStyle="#fff";ctx.lineWidth=thick+3;ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.stroke();ctx.lineWidth=1.5;ctx.strokeStyle=o.type==="door"?"#a86f42":"#2796aa";if(o.type==="window"){ctx.beginPath();ctx.moveTo(p1.x+nx*(thick*.28),p1.y+ny*(thick*.28));ctx.lineTo(p2.x+nx*(thick*.28),p2.y+ny*(thick*.28));ctx.moveTo(p1.x-nx*(thick*.28),p1.y-ny*(thick*.28));ctx.lineTo(p2.x-nx*(thick*.28),p2.y-ny*(thick*.28));ctx.stroke()}else{const g=doorSwingGeometry(p1,p2,{hingeSide:o.hingeSide,swingDirection:o.swingDirection});ctx.beginPath();ctx.moveTo(g.hinge.x,g.hinge.y);ctx.lineTo(g.openFree.x,g.openFree.y);ctx.stroke();ctx.beginPath();ctx.arc(g.hinge.x,g.hinge.y,g.radius,g.startAngle,g.endAngle,g.anticlockwise);ctx.stroke()}ctx.restore()}}ctx.lineWidth=1}
else if(e.type==="slab"||e.type==="room"||e.type==="roof"){ctx.beginPath();e.boundary.forEach((v,i)=>{const q=pointAt(v);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y)});ctx.closePath();ctx.fillStyle=e.type==="roof"?"rgba(181,121,76,.2)":e.type==="room"?"rgba(217,240,242,.28)":"#e9eef0";ctx.fill();ctx.stroke();if(e.type==="roof"&&e.boundary.length>=3){const center={x:e.boundary.reduce((s,v)=>s+v.x,0)/e.boundary.length,y:e.boundary.reduce((s,v)=>s+v.y,0)/e.boundary.length},peak=pointAt(center);ctx.save();ctx.strokeStyle=isSel?"#087e8b":"#a86f42";ctx.setLineDash([5,3]);ctx.beginPath();for(const v of e.boundary){const q=pointAt(v);ctx.moveTo(q.x,q.y);ctx.lineTo(peak.x,peak.y)}ctx.stroke();ctx.setLineDash([]);ctx.restore()}if(e.type==="room"){const q=pointAt(e.labelPosition||e.center||e.boundary[0]),areaText=(Number(e.area)||polygonArea(e.boundary)).toFixed(2)+" m²",name=String(e.roomName||e.name||"").trim();ctx.save();ctx.fillStyle="#315e64";ctx.font="bold 12px Arial";ctx.textAlign="center";ctx.textBaseline="middle";const zoneNumber=String(e.zoneNumber||"").trim();const annotationScale=options.annotationScale||((scale*drawingScaleDenominator)/1000),zoneFont=2.5*annotationScale,nameFont=3*annotationScale,areaFont=2.5*annotationScale,labelGap=3.5*annotationScale;if(zoneNumber){ctx.font=zoneFont+"px Arial";ctx.fillStyle="#647b80";ctx.fillText(zoneNumber,q.x,q.y-labelGap*1.35)}if(name){ctx.font="bold "+nameFont+"px Arial";ctx.fillStyle="#315e64";ctx.fillText(name,q.x,q.y-labelGap*.45)}ctx.font=areaFont+"px Arial";ctx.fillStyle="#315e64";ctx.fillText(areaText,q.x,q.y+(name?labelGap*.65:0));ctx.textAlign="start";ctx.textBaseline="alphabetic";ctx.restore()}}
else if(e.type==="column"){const q=pointAt(e.position);ctx.fillRect(q.x-e.width*scaleFactor/2,q.y-e.depth*scaleFactor/2,e.width*scaleFactor,e.depth*scaleFactor);ctx.strokeRect(q.x-e.width*scaleFactor/2,q.y-e.depth*scaleFactor/2,e.width*scaleFactor,e.depth*scaleFactor)}
else if(e.type==="dimension"){const a=pointAt(e.start),b=pointAt(e.end),wa=e.witnessStart?pointAt(e.witnessStart):a,wb=e.witnessEnd?pointAt(e.witnessEnd):b,dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len,nx=-uy,ny=ux,vertical=Math.abs(dy)>Math.abs(dx),label=formatLength(Math.hypot(e.end.x-e.start.x,e.end.y-e.start.y),unitSystem());ctx.save();ctx.strokeStyle=isSel?"#087e8b":"#69747e";ctx.fillStyle="#39444e";ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(wa.x,wa.y);ctx.lineTo(a.x,a.y);ctx.moveTo(wb.x,wb.y);ctx.lineTo(b.x,b.y);ctx.moveTo(a.x-nx*4,a.y-ny*4);ctx.lineTo(a.x+nx*4,a.y+ny*4);ctx.moveTo(b.x-nx*4,b.y-ny*4);ctx.lineTo(b.x+nx*4,b.y+ny*4);ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();const annotationScale=options.annotationScale||((scale*drawingScaleDenominator)/1000),dimensionFont=Math.max(.5,Number(e.textSizeMm)||2.5)*annotationScale,dimensionTextWidth=Math.max(12*annotationScale,label.length*dimensionFont*.58),dimensionTextHeight=1.25*dimensionFont;ctx.font=dimensionFont+"px Arial";ctx.textAlign="center";ctx.textBaseline="middle";const midX=(a.x+b.x)/2,midY=(a.y+b.y)/2,labelOffset=3.5*annotationScale,labelX=midX+nx*labelOffset,labelY=midY+ny*labelOffset;if(vertical){ctx.translate(labelX,labelY);ctx.rotate(Math.atan2(dy,dx));ctx.fillStyle="#fff";ctx.fillRect(-dimensionTextWidth/2,-dimensionTextHeight/2,dimensionTextWidth,dimensionTextHeight);ctx.fillStyle="#39444e";ctx.fillText(label,0,0)}else{ctx.fillStyle="#fff";ctx.fillRect(labelX-dimensionTextWidth/2,labelY-dimensionTextHeight/2,dimensionTextWidth,dimensionTextHeight);ctx.fillStyle="#39444e";ctx.fillText(label,labelX,labelY)}ctx.restore()}
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
if(view==="floor"&&activeSnapPoint&&p.settings?.snap!==false){const q=spos(activeSnapPoint);x.save();x.strokeStyle="#00a6b5";x.fillStyle="rgba(0,166,181,.13)";x.lineWidth=1.5;x.beginPath();if(activeSnapPoint.kind==="midpoint"){x.moveTo(q.x,q.y-6);x.lineTo(q.x+6,q.y);x.lineTo(q.x,q.y+6);x.lineTo(q.x-6,q.y);x.closePath()}else if(activeSnapPoint.kind==="center"){x.arc(q.x,q.y,5,0,Math.PI*2);x.moveTo(q.x-8,q.y);x.lineTo(q.x+8,q.y);x.moveTo(q.x,q.y-8);x.lineTo(q.x,q.y+8)}else if(activeSnapPoint.kind==="nearest"){x.arc(q.x,q.y,4,0,Math.PI*2);x.moveTo(q.x-7,q.y);x.lineTo(q.x+7,q.y)}else{x.rect(q.x-4,q.y-4,8,8)}x.fill();x.stroke();x.restore()}
updateTrackerUI();
}else{
const project3d=(pt,z)=>{
const yaw=camera3d.yaw,pitch=camera3d.pitch,cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
const wx=pt.x,wy=pt.y,wz=z;
const rx=wx*cy-wy*sy,ry=wx*sy+wy*cy;
const px=(rx-camera3d.panX)*scale*.72*camera3d.zoom;
const py=((ry-camera3d.panY)*sp-(wz-camera3d.targetZ)*cp)*scale*.72*camera3d.zoom;
return{x:c.clientWidth/2+origin.x+px,y:c.clientHeight*.58+origin.y+py,depth:ry*cp+wz*sp};
};
render3DScene(x,els(),project3d,{interactive:true});if(draft.length&&tool!=="select"){const anchor=draft[draft.length-1],cursor=mouse?screenToWorld3d(mouse,story().elevation||0):anchor,points=[...draft,cursor].map(pt=>project3d(pt,story().elevation||0));x.save();x.strokeStyle="#087e8b";x.fillStyle="rgba(8,126,139,.12)";x.lineWidth=2;x.setLineDash([5,4]);x.beginPath();points.forEach((pt,i)=>i?x.lineTo(pt.x,pt.y):x.moveTo(pt.x,pt.y));if(tool==="slab"&&draft.length>1){x.closePath();x.fill()}x.stroke();x.setLineDash([]);x.restore()}
$("selectionInfo").textContent=selected.size?selected.size+" selected · "+chosen().map(e=>e.type).join(", "):"No selection";updateHistoryButtons()}}
function renderProperties(){updateContextUI();const host=$("elementProperties"),info=$("selectionInfo");if(!host)return;const list=chosen();host.innerHTML="";if(info)info.textContent=list.length?list.length+" element"+(list.length===1?"":"s")+" selected":"";if(!list.length){host.replaceChildren();return}if(list.length>1||(list.length===1&&list[0].type==="gridline"&&!!list[0].gridSystemId)){
const type=list.every(e=>e.type===list[0].type)?list[0].type:"mixed";
const multiFields={wall:[["height","Height (m)",.1],["thickness","Thickness (m)",.01],["baseOffset","Base offset (m)",.01]],beam:[["width","Width (m)",.01],["depth","Depth (m)",.01],["elevation","Elevation (m)",.01]],column:[["width","Width (m)",.01],["depth","Depth (m)",.01],["height","Height (m)",.01],["rotation","Rotation (rad)",.01]],slab:[["thickness","Thickness (m)",.01],["elevation","Elevation (m)",.01]],dimension:[["textSizeMm","Text size on paper (mm)",.1]]};
const safeFields=(multiFields[type]||[]).filter(([key])=>key==="textSizeMm"?list.every(e=>e.type==="dimension"):list.every(e=>Number.isFinite(e[key])));
const gridSystemId=list[0]?.gridSystemId;
const isGridSystemSelection=!!gridSystemId&&list.every(e=>e.type==="gridline"&&e.gridSystemId===gridSystemId&&["vertical","horizontal"].includes(e.gridSystemAxis)&&Number.isInteger(e.gridSystemIndex));
const gridMembers=isGridSystemSelection?els().filter(e=>e.gridSystemId===gridSystemId):[];
const getGridSpacing=axis=>{const lines=gridMembers.filter(e=>e.type==="gridline"&&e.gridSystemAxis===axis).sort((a,b)=>a.gridSystemIndex-b.gridSystemIndex);return lines.slice(1).map((line,i)=>unitSystem()==="imperial"?formatLength(Math.hypot(line.start.x-lines[i].start.x,line.start.y-lines[i].start.y),"imperial"):(Math.hypot(line.start.x-lines[i].start.x,line.start.y-lines[i].start.y)*1000).toFixed(0)).join(", ")};
const esc=value=>String(value??"").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;").replaceAll(">","&gt;");
host.innerHTML='<p style="color:var(--muted);font-size:11px">'+list.length+' elements selected · '+type+'</p>'+(isGridSystemSelection?'<div class="field grid-interval-field"><label>Vertical intervals · '+(unitSystem()==="imperial"?"ft + in":"mm")+'</label><input id="editGridVertical" aria-label="Vertical grid intervals in millimetres" value="'+getGridSpacing("vertical")+'" style="width:112px;min-width:112px;max-width:112px"></div><div class="field grid-interval-field"><label>Horizontal intervals · '+(unitSystem()==="imperial"?"ft + in":"mm")+'</label><input id="editGridHorizontal" aria-label="Horizontal grid intervals in millimetres" value="'+getGridSpacing("horizontal")+'" style="width:112px;min-width:112px;max-width:112px"></div><button id="applyGridSpacing" type="button" style="align-self:center;white-space:nowrap">Apply</button>':'')+'<div class="field"><label>Building material (applies to all)</label><input id="multiMaterial" placeholder="Leave blank to keep current materials"></div>'+safeFields.map(([key,label,step])=>{const values=list.map(e=>key==="textSizeMm"?(Number(e[key])||2.5):e[key]);const same=values.every(v=>v===values[0]);return '<div class="field"><label>'+label+'</label><input data-multi-prop="'+key+'" type="number" step="'+step+'" value="'+(same?values[0]:"")+'" placeholder="'+(same?"":"Mixed values — enter to apply")+'"></div>'}).join("")+'<button id="applyMultiProps">Apply to selected</button>';
const applyMultiProps=()=>{const inputs=[...host.querySelectorAll("[data-multi-prop]")],values={};for(const input of inputs){if(input.value.trim()==="")continue;const key=input.dataset.multiProp,val=parsePropertyInput(input.value,key,input),positive=["height","thickness","width","depth"].includes(key);if(!Number.isFinite(val)||val<0||(positive&&val===0)){$("status").textContent="Invalid parameter: "+key;return}values[key]=val}const material=$("multiMaterial").value.trim();let spacing=null;if(isGridSystemSelection){const parse=id=>$(id).value.split(",").map(v=>v.trim()).filter(v=>v!=="").map(v=>unitSystem()==="imperial"?parseLength(v,"imperial"):Number(v)/1000),vertical=parse("editGridVertical"),horizontal=parse("editGridHorizontal"),verticalLines=gridMembers.filter(e=>e.type==="gridline"&&e.gridSystemAxis==="vertical").sort((a,b)=>a.gridSystemIndex-b.gridSystemIndex),horizontalLines=gridMembers.filter(e=>e.type==="gridline"&&e.gridSystemAxis==="horizontal").sort((a,b)=>a.gridSystemIndex-b.gridSystemIndex);if([...vertical,...horizontal].some(v=>!Number.isFinite(v)||v<=0)||vertical.length!==verticalLines.length-1||horizontal.length!==horizontalLines.length-1){$("status").textContent="Grid distance count mismatch: vertical needs "+Math.max(0,verticalLines.length-1)+" values; horizontal needs "+Math.max(0,horizontalLines.length-1)+" values. All values must be positive.";return}spacing={vertical,horizontal,verticalLines,horizontalLines}}if(!material&&!Object.keys(values).length&&!spacing){$("status").textContent="Enter at least one parameter to apply";return}hist("Edit selected elements");for(const element of list){Object.assign(element,values);if(material)element.buildingMaterial=material}if(spacing){
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
}scheduleAutoSave();$("status").textContent=spacing?"Grid System spacing updated":"Parameters applied to "+list.length+" elements";redraw();renderProperties()};$("applyMultiProps").onclick=applyMultiProps;$("applyGridSpacing")?.addEventListener("click",applyMultiProps);for(const id of ["editGridVertical","editGridHorizontal"]){const input=$(id);if(input)input.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();applyMultiProps()}})}
return}
const e=list[0];const fields={wall:[["height","Height (m)",.1],["thickness","Thickness (m)",.01],["baseOffset","Base offset (m)",.01]],beam:[["width","Width (m)",.01],["depth","Depth (m)",.01],["elevation","Elevation (m)",.01]],column:[["width","Width (m)",.01],["depth","Depth (m)",.01],["height","Height (m)",.01],["rotation","Rotation (rad)",.01]],slab:[["thickness","Thickness (m)",.01],["elevation","Elevation (m)",.01]],roof:[["thickness","Thickness (m)",.01],["elevation","Eaves Height (m)",.01],["offset","Offset (m)",.01],["pitch","Pitch (degrees)",1]],door:[["offset","Offset along wall (m)",.01],["width","Width (m)",.01],["height","Height (m)",.01],["sill","Sill (m)",.01]],window:[["offset","Offset along wall (m)",.01],["width","Width (m)",.01],["height","Height (m)",.01],["sill","Sill (m)",.01]],dimension:[["textSizeMm","Text size on paper (mm)",.1]],room:[]}[e.type]||[];
host.innerHTML='<div class="field"><label>Element type / ID</label><input value="'+escapeHtml((e.type==="room"?"Zone":e.type)+' · '+e.id)+'" readonly></div>'+'<div class="field"><label>Classification</label><select id="propClassification"><option value="">Unclassified</option>'+["Architectural","Structural","Mechanical","Electrical","Plumbing","Fire Protection","Landscape","Zone / Space"].map(v=>'<option value="'+v+'"'+((e.classification||"")===v?" selected":"")+'>'+v+'</option>').join("")+'</select></div>'+(e.type==="room"?'<div class="field"><label>Zone Number</label><input id="propZoneNumber" value="'+escapeHtml(e.zoneNumber||"")+'" placeholder="e.g. Z-01"></div><div class="field"><label>Room name</label><input id="propRoomName" value="'+escapeHtml(e.roomName||e.name||"")+'" placeholder="e.g. Living Room"></div><div class="field"><label>Zone Category</label><input id="propZoneCategory" value="'+escapeHtml(e.zoneCategory||"")+'" placeholder="e.g. Living, Bedroom, Wet Area"></div><p style="font-size:11px;color:var(--muted)">Zone stamp: number, name and area. Drag the stamp on the floor plan to move all labels together.</p>':"")+'<div class="field"><label>Building material</label><input id="propMaterial" value="'+escapeHtml(e.buildingMaterial||"")+'"></div>'+fields.map(([key,label,step])=>'<div class="field"><label>'+label+'</label><input data-prop="'+key+'" type="number" step="'+step+'" value="'+(key==="gridDimensionValue"?Math.hypot(e.end.x-e.start.x,e.end.y-e.start.y):Number.isFinite(e[key])?e[key]:(key==="textSizeMm"?2.5:""))+'"></div>').join("")+(['door','window'].includes(e.type)?'<div class="field"><label>Position on host wall</label><select id="propAlignment"><option value="left"'+((e.alignment||"custom")==="left"?" selected":"")+'>Left</option><option value="center"'+((e.alignment||"custom")==="center"?" selected":"")+'>Center</option><option value="right"'+((e.alignment||"custom")==="right"?" selected":"")+'>Right</option><option value="custom"'+((e.alignment||"custom")==="custom"?" selected":"")+'>Custom position</option></select></div><div class="field"><label>Hinge / Side</label><select id="propHinge"><option value="left"'+((e.hingeSide||"left")==="left"?" selected":"")+'>Left</option><option value="right"'+(e.hingeSide==="right"?" selected":"")+'>Right</option></select></div><div class="field"><label>Opening Direction</label><select id="propSwing"><option value="inside"'+((e.swingDirection||"inside")==="inside"?" selected":"")+'>Inside</option><option value="outside"'+(e.swingDirection==="outside"?" selected":"")+'>Outside</option></select></div>':"");
if(e.type==="gridline"){const field=document.createElement("div");field.className="field";field.innerHTML='<label>Grid axis label</label><input id="propGridLabel" maxlength="8" value="'+escapeHtml(e.label||"A")+'">';host.insertBefore(field,host.querySelector("#applyProps"));const pointFields=document.createElement("div");pointFields.innerHTML='<p style="font-size:11px;font-weight:600">Start point (m)</p><div class="field"><label>X</label><input id="gridStartX" type="number" step="0.1" value="'+e.start.x+'"></div><div class="field"><label>Y</label><input id="gridStartY" type="number" step="0.1" value="'+e.start.y+'"></div><p style="font-size:11px;font-weight:600">End point (m)</p><div class="field"><label>X</label><input id="gridEndX" type="number" step="0.1" value="'+e.end.x+'"></div><div class="field"><label>Y</label><input id="gridEndY" type="number" step="0.1" value="'+e.end.y+'"></div>';host.insertBefore(pointFields,host.querySelector("#applyProps"))}if(e.type==="room"){$("propRoomName")?.addEventListener("input",event=>{const target=els().find(v=>v.id===e.id&&v.type==="room");if(!target)return;target.roomName=event.target.value;target.name=event.target.value;redraw();scheduleAutoSave()})}const applyPropsNow=()=>{const target=els().find(v=>v.id===e.id);if(!target)return;const edits=[...host.querySelectorAll("[data-prop]")],values={};let gridPoints=null;if(target.type==="gridline"){const label=$("propGridLabel")?.value.trim();if(!label){$("status").textContent="Grid axis label is required";return}gridPoints={start:{x:unitSystem()==="imperial"?($("gridStartX").dataset.unitEdited==="true"?parseLength($("gridStartX").value,"imperial"):Number($("gridStartX").dataset.originalMetres??$("gridStartX").value)):Number($("gridStartX").value),y:unitSystem()==="imperial"?($("gridStartY").dataset.unitEdited==="true"?parseLength($("gridStartY").value,"imperial"):Number($("gridStartY").dataset.originalMetres??$("gridStartY").value)):Number($("gridStartY").value)},end:{x:unitSystem()==="imperial"?($("gridEndX").dataset.unitEdited==="true"?parseLength($("gridEndX").value,"imperial"):Number($("gridEndX").dataset.originalMetres??$("gridEndX").value)):Number($("gridEndX").value),y:unitSystem()==="imperial"?($("gridEndY").dataset.unitEdited==="true"?parseLength($("gridEndY").value,"imperial"):Number($("gridEndY").dataset.originalMetres??$("gridEndY").value)):Number($("gridEndY").value)}};if(Object.values(gridPoints).some(pt=>!Number.isFinite(pt.x)||!Number.isFinite(pt.y))||Math.hypot(gridPoints.end.x-gridPoints.start.x,gridPoints.end.y-gridPoints.start.y)<0.01){$("status").textContent="Gridline points must be valid and at least 0.01 m apart";return}target.label=label}for(const input of edits){const key=input.dataset.prop,val=parsePropertyInput(input.value,key,input);const positive=["height","thickness","width","depth"].includes(key);if(input.value.trim()===""||!Number.isFinite(val)||(key!=="offset"&&val<0)||(positive&&val===0)){ $("status").textContent="Invalid parameter: "+key;return}values[key]=val}if(["door","window"].includes(target.type)){const wall=els().find(v=>v.id===target.hostWallId);if(!wall){$("status").textContent="Host wall not found";return}const alignment=$("propAlignment")?.value||target.alignment||"custom",len=wallLength(wall);if(alignment==="left")values.offset=0;else if(alignment==="center")values.offset=(len-(values.width??target.width))/2;else if(alignment==="right")values.offset=len-(values.width??target.width);if(!(values.width??target.width>0)||!Number.isFinite(values.offset??target.offset)||(values.offset??target.offset)<0||(values.offset??target.offset)+(values.width??target.width)>len+1e-8||(values.sill??target.sill)+(values.height??target.height)>wall.height){$("status").textContent="Opening must fit within its host wall and wall height";return}values.alignment=alignment}hist();Object.assign(target,values);target.classification=$("propClassification")?.value||"";if(target.type==="room"){target.roomName=$("propRoomName")?.value.trim()||"";target.name=target.roomName;target.zoneNumber=$("propZoneNumber")?.value.trim()||target.zoneNumber||"";target.zoneCategory=$("propZoneCategory")?.value.trim()||""}if(target.type==="dimension"&&Number.isFinite(values.gridDimensionValue)){const wanted=values.gridDimensionValue;if(wanted<=0){$("status").textContent="Dimension must be greater than zero";return}const members=target.gridSystemId?els().filter(v=>v.gridSystemId===target.gridSystemId):[],axis=target.gridDimensionAxis,index=target.gridDimensionIndex,lines=members.filter(v=>v.type==="gridline"&&v.gridSystemAxis===axis).sort((a,b)=>a.gridSystemIndex-b.gridSystemIndex),lineA=lines[index],lineB=lines[index+1];if(!lineA||!lineB){$("status").textContent="Grid axes for this dimension could not be found";return}const oldDistance=Math.hypot(lineB.start.x-lineA.start.x,lineB.start.y-lineA.start.y),deltaDistance=wanted-oldDistance,dx=lineB.start.x-lineA.start.x,dy=lineB.start.y-lineA.start.y,len=Math.hypot(dx,dy)||1,shift={x:dx/len*deltaDistance,y:dy/len*deltaDistance};for(const line of lines){if(line.gridSystemIndex>index){line.start.x+=shift.x;line.start.y+=shift.y;line.end.x+=shift.x;line.end.y+=shift.y}}for(const member of members){if(member.type!=="dimension")continue;const shiftPoint=pt=>{if(!pt)return;const projection=(pt.x-lineA.start.x)*(dx/len)+(pt.y-lineA.start.y)*(dy/len);if(projection>oldDistance-0.001){pt.x+=shift.x;pt.y+=shift.y}};if(axis==="vertical"&&Math.abs(member.end.y-member.start.y)<Math.abs(member.end.x-member.start.x)){shiftPoint(member.start);shiftPoint(member.end);shiftPoint(member.witnessStart);shiftPoint(member.witnessEnd)}else if(axis==="horizontal"&&Math.abs(member.end.y-member.start.y)>=Math.abs(member.end.x-member.start.x)){shiftPoint(member.start);shiftPoint(member.end);shiftPoint(member.witnessStart);shiftPoint(member.witnessEnd)}}}if(target.type==="gridline"&&gridPoints){target.start=gridPoints.start;target.end=gridPoints.end}if(["door","window"].includes(target.type)){const wall=els().find(v=>v.id===target.hostWallId),opening=wall?.openings?.find(o=>o.id===target.id);if(opening)Object.assign(opening,values)}if(["door","window"].includes(target.type)){target.hingeSide=$("propHinge")?.value||"left";target.swingDirection=$("propSwing")?.value||"inside";const hostWall=els().find(v=>v.id===target.hostWallId);const opening=hostWall?.openings?.find(o=>o.id===target.id);if(opening){opening.hingeSide=target.hingeSide;opening.swingDirection=target.swingDirection}}const mat=$("propMaterial").value.trim();if(mat)target.buildingMaterial=mat;if(target.type==="wall"){for(const o of target.openings||[])if(o.sill+o.height>target.height){$("status").textContent="Wall updated; check hosted opening heights";break}}$("status").textContent="Element parameters updated";redraw();scheduleAutoSave();renderProperties()};for(const control of host.querySelectorAll("[data-prop],#propClassification,#propMaterial,#propGridLabel,#gridStartX,#gridStartY,#gridEndX,#gridEndY,#propZoneNumber,#propZoneCategory")){control.addEventListener("change",applyPropsNow)}$("propClassification")?.addEventListener("change",()=>{const target=els().find(v=>v.id===e.id);if(target){target.classification=$("propClassification").value||"";redraw();scheduleAutoSave()}});$("propMaterial")?.addEventListener("change",()=>{const target=els().find(v=>v.id===e.id);if(target){target.buildingMaterial=$("propMaterial").value.trim();redraw();scheduleAutoSave()}});const applyOpeningEdit=()=>{const target=els().find(v=>v.id===e.id);if(!target||!["door","window"].includes(target.type))return;const wall=els().find(v=>v.id===target.hostWallId);if(!wall)return;const alignment=$("propAlignment")?.value||target.alignment||"custom",hinge=$("propHinge")?.value||target.hingeSide||"left",swing=$("propSwing")?.value||target.swingDirection||"inside",len=wallLength(wall),width=Number(host.querySelector('[data-prop="width"]')?.value??target.width),offsetInput=host.querySelector('[data-prop="offset"]');let offset=Number(offsetInput?.value??target.offset);if(alignment==="left")offset=0;else if(alignment==="center")offset=(len-width)/2;else if(alignment==="right")offset=len-width;else if(Number.isFinite(width)&&width>0&&Number.isFinite(offset))offset=Math.min(Math.max(0,offset),Math.max(0,len-width));if(!Number.isFinite(offset)||offset<0||!(width>0)||width>len+1e-8||offset+width>len+1e-8){$("status").textContent="Opening width/position must fit within its host wall";renderProperties();return}hist("Edit hosted opening");target.offset=offset;target.width=width;target.alignment=alignment;target.hingeSide=hinge;target.swingDirection=swing;const opening=wall.openings?.find(o=>o.id===target.id);if(opening)Object.assign(opening,{offset,width,alignment,hingeSide:hinge,swingDirection:swing});$("status").textContent="Opening updated";redraw();renderProperties()};for(const id of ["propAlignment","propHinge","propSwing"])$(id)?.addEventListener("change",applyOpeningEdit);for(const input of host.querySelectorAll('[data-prop]'))input.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();applyOpeningEdit()}})}
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
function transformSelected(mode){
const list=chosen();if(!list.length){$("status").textContent="Select one or more elements first";return}
const number=(label,def=0)=>{const raw=prompt(label,String(def));if(raw===null)return null;const v=Number(raw);return Number.isFinite(v)?v:null};
let dx=0,dy=0,angle=0,axis="x";
if(mode==="move"||mode==="copy"){dx=number(mode==="copy"?"Duplicate offset X (m)":"Move distance X (m)",1);if(dx===null)return;dy=number(mode==="copy"?"Duplicate offset Y (m)":"Move distance Y (m)",0);if(dy===null)return}
if(mode==="rotate"){angle=number("Rotation angle (degrees)",90);if(angle===null)return;angle=angle*Math.PI/180}
if(mode==="mirror"){const a=prompt("Mirror axis: type x for horizontal axis or y for vertical axis","y");if(a===null)return;axis=a.toLowerCase();if(!["x","y"].includes(axis)){ $("status").textContent="Mirror axis must be x or y";return}}
const anchor=e=>{if((e.type==="door"||e.type==="window")&&Number.isFinite(e.offset)&&Number.isFinite(e.width)){const wall=els().find(v=>v.id===e.hostWallId&&v.type==="wall"),len=wall?wallLength(wall):0;if(wall&&len>1e-8)return{x:wall.start.x+(wall.end.x-wall.start.x)*(e.offset+e.width/2)/len,y:wall.start.y+(wall.end.y-wall.start.y)*(e.offset+e.width/2)/len}}return e.position||e.labelPosition||e.center||e.start||e.boundary?.[0]||{x:0,y:0}};
const cx=list.reduce((sum,e)=>sum+anchor(e).x,0)/list.length;
const cy=list.reduce((sum,e)=>sum+anchor(e).y,0)/list.length;
const point=q=>{let x=q.x,y=q.y;if(mode==="move"||mode==="copy"){x+=dx;y+=dy}else if(mode==="rotate"){const a=x-cx,b=y-cy;x=cx+a*Math.cos(angle)-b*Math.sin(angle);y=cy+a*Math.sin(angle)+b*Math.cos(angle)}else if(mode==="mirror"){if(axis==="y")x=2*cx-x;else y=2*cy-y}return{x,y}};
const transform=(e,skipHostedOpening=false)=>{
 if(e.start)e.start=point(e.start);if(e.end)e.end=point(e.end);
 for(const key of ["position","center","witnessStart","witnessEnd","labelPosition"])if(e[key])e[key]=point(e[key]);
 for(const key of ["boundary","points","vertices","nodes"])if(Array.isArray(e[key]))e[key]=e[key].map(point);
 if(!skipHostedOpening&&(e.type==="door"||e.type==="window")&&Number.isFinite(e.offset)&&Number.isFinite(e.width)){
  const host=els().find(v=>v.id===e.hostWallId&&v.type==="wall");
  if(host){const len=wallLength(host);if(len>1e-8){const center={x:host.start.x+(host.end.x-host.start.x)*(e.offset+e.width/2)/len,y:host.start.y+(host.end.y-host.start.y)*(e.offset+e.width/2)/len},target=point(center),ux=(host.end.x-host.start.x)/len,uy=(host.end.y-host.start.y)/len;e.offset=Math.max(0,Math.min(len-e.width,(target.x-host.start.x)*ux+(target.y-host.start.y)*uy-e.width/2))}}
 }
 if(mode==="rotate"&&Number.isFinite(e.rotation))e.rotation+=angle;if(mode==="mirror"&&Number.isFinite(e.rotation))e.rotation=-e.rotation;
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
function ensureOpeningControls(){const toolbar=$("contextToolbar");if(!toolbar||$("openingHingeControl"))return;const geometry=$("wallGeometryControl");const make=(id,label,opts)=>{const wrap=document.createElement("div");wrap.className="context-control";wrap.id=id+"Control";wrap.hidden=true;wrap.style.display="none";const lab=document.createElement("label");lab.htmlFor=id;lab.textContent=label;const sel=document.createElement("select");sel.id=id;sel.setAttribute("aria-label",label);for(const [value,text] of opts){const opt=document.createElement("option");opt.value=value;opt.textContent=text;sel.append(opt)}wrap.append(lab,sel);geometry?.after(wrap);sel.addEventListener("change",()=>{if(id==="openingHinge"){openingHingeSide=sel.value;if(pendingOpeningPlacement)pendingOpeningPlacement=openingPlacement.update({hingeSide:openingHingeSide})}else if(id==="openingSwing"){openingSwingDirection=sel.value;if(pendingOpeningPlacement)pendingOpeningPlacement=openingPlacement.update({swingDirection:openingSwingDirection})}else if(id==="openingAlignment"){openingAlignment=sel.value;if(pendingOpeningPlacement){const w=els().find(v=>v.id===pendingOpeningPlacement.wallId);if(w)pendingOpeningPlacement=openingPlacement.update({anchor:openingAlignment,offset:openingOffsetForAnchor(wallLength(w),pendingOpeningPlacement.width,openingAlignment,pendingOpeningPlacement.anchorPosition)})}redraw();$("status").textContent="Door / Window anchor: "+sel.options[sel.selectedIndex].text}});return wrap};make("openingHinge","Hinge / Side",[["left","Left"],["right","Right"]]);make("openingSwing","Opening Direction",[["inside","Inside"],["outside","Outside"]]);make("openingAlignment","Anchor",[["center","Center (default)"],["left","Left edge"],["right","Right edge"]]);const pitch=document.createElement("div");pitch.className="context-control";pitch.id="roofPitchControl";pitch.hidden=true;pitch.style.display="none";const label=document.createElement("label");label.htmlFor="roofPitch";label.textContent="Roof Pitch (degrees)";const offsetLabel=document.createElement("label");offsetLabel.htmlFor="roofOffset";offsetLabel.textContent="Roof Offset (m)";const offsetInput=document.createElement("input");offsetInput.id="roofOffset";offsetInput.type="number";offsetInput.step="0.1";offsetInput.min="0";offsetInput.value="0";offsetInput.setAttribute("aria-label","Roof offset (m)");const offsetWrap=document.createElement("div");offsetWrap.className="context-control";offsetWrap.id="roofOffsetControl";offsetWrap.hidden=true;offsetWrap.style.display="none";offsetWrap.append(offsetLabel,offsetInput);geometry?.after(offsetWrap);const select=document.createElement("select");select.id="roofPitch";select.setAttribute("aria-label","Roof pitch");for(const value of [15,20,25,30,35,40,45]){const option=document.createElement("option");option.value=String(value);option.textContent=value+"°";if(value===30)option.selected=true;select.append(option)}pitch.append(label,select);geometry?.after(pitch);select.addEventListener("change",()=>{select.dataset.current=select.value})}
function updateContextUI(){
 ensureOpeningControls();
 const names={select: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 3 19 15l-6 1-3 5z\"/></svg>","Select Tool","Select, inspect and edit model elements"],marquee: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"4\" y=\"5\" width=\"16\" height=\"14\" stroke-dasharray=\"2 2\"/></svg>","Marquee Tool","Drag a rectangular marquee, then use Ctrl/Cmd+A to select elements inside it"],wall: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 7h18v10H3zM8 7v10M16 7v10\"/></svg>","Wall Tool","Click start and end points to draw a wall"],slab: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m3 8 14-4 4 4-14 4zM3 8v8l4 4V12M7 20l14-4V8\"/></svg>","Slab Tool","Click at least three boundary points; double-click to finish"],zone: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 5h14v14H5z\"/><path d=\"M5 10h14M10 5v14\"/></svg>","Zone Tool","Click three or more boundary points to create a room zone; press Enter to finish"],roof: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m2 11 10-8 10 8M5 9v12h14V9M9 21v-7h6v7\"/></svg>","Roof Tool","Draw a roof footprint with three or more points; Enter to finish"],magicwand: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m4 20 11-11 4 4L8 24zM14 4V1M20 8h3M18 2l1-2M22 14l2 1\"/></svg>","Magic Wand","Click inside a closed wall loop to generate a roof from its reference lines"],column: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"7\" y=\"3\" width=\"10\" height=\"18\"/><path d=\"M4 3h16M4 21h16\"/></svg>","Column Tool","Click in the plan to place a column"],beam: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 6h18M3 18h18M8 6v12M16 6v12\"/></svg>","Beam Tool","Click start and end points to draw a beam"],door: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 21V3h11v18M5 3l11 3v15M13 12h.1\"/></svg>","Door Tool","Click close to a host wall to place a door"],window: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"14\"/><path d=\"M3 9h18M3 15h18M9 5v14M15 5v14\"/></svg>","Window Tool","Click close to a host wall to place a window"],dimension: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 12h18M3 12l5-5M3 12l5 5M21 12l-5-5M21 12l-5 5M6 5v14M18 5v14\"/></svg>","Dimension Tool","Click two points to create a dimension"],gridline: ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M12 1v22M1 12h22\"/></svg>","Gridline Tool","Click two points to create a structural grid axis"]};
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
 show("openingSwingControl",tool==="door"||tool==="window");show("openingAlignmentControl",tool==="door"||tool==="window");if($("openingHinge")&&document.activeElement!==$("openingHinge"))$("openingHinge").value=openingHingeSide;if($("openingSwing")&&document.activeElement!==$("openingSwing"))$("openingSwing").value=openingSwingDirection;if($("openingAlignment")&&document.activeElement!==$("openingAlignment"))$("openingAlignment").value=openingAlignment;
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
function updateTrackerUI(){const box=$("dynamicTracker");if(!box)return;const active=view==="floor"&&draft.length&&mouse&&["wall","beam","dimension","slab"].includes(tool);box.hidden=!active;if(!active)return;const anchor=draft[draft.length-1],raw=wpos(mouse),endpoint=trackerEndpoint(anchor,(tool==="wall"||tool==="beam"||tool==="dimension"||tool==="slab")?constrain(anchor,raw,{shiftKey:shiftHeld}):raw),distance=Math.hypot(endpoint.x-anchor.x,endpoint.y-anchor.y)*1000,angle=((Math.atan2(endpoint.y-anchor.y,endpoint.x-anchor.x)*180/Math.PI)%360+360)%360;const wrap=$("canvas").parentElement,left=Math.max(6,Math.min(wrap.clientWidth-box.offsetWidth-6,mouse.x+16)),top=Math.max(6,Math.min(wrap.clientHeight-box.offsetHeight-6,mouse.y-box.offsetHeight-12));box.style.left=left+"px";box.style.top=top+"px";const di=$("trackerDistance"),ai=$("trackerAngle");if(document.activeElement!==di)di.value=(trackerDistanceOverride===null?distance:trackerDistanceOverride).toFixed(0);if(document.activeElement!==ai)ai.value=(trackerAngleOverride===null?angle:trackerAngleOverride).toFixed(1)}
function shiftReferencePoint(cursor,fallback){snapPoint(cursor);return activeSnapPoint?{x:activeSnapPoint.x,y:activeSnapPoint.y}:{x:fallback.x,y:fallback.y}}
 function lockCursorAxis(a,q){const dx=q.x-a.x,dy=q.y-a.y;return Math.abs(dx)>=Math.abs(dy)?(dx>=0?0:Math.PI):(dy>=0?Math.PI/2:-Math.PI/2)}
function constrain(a,b,e){if(!(e?.shiftKey||shiftHeld))return b;const angle=shiftAngleLock??lockCursorAxis(a,b);if(Math.abs(Math.sin(angle))<.5)return{x:b.x,y:a.y};return{x:a.x,y:b.y}}
function addWallSegment(a,b){const len=Math.hypot(b.x-a.x,b.y-a.y);if(!Number.isFinite(len)||len<.01||len>30)return false;els().push(createWall(a,b,{storyId:story().id,height:+$("height").value||3,thickness:+$("thickness").value||.15}));return true}
function completeWallGeometry(a,b,e){const end=constrain(a,b,e),len=Math.hypot(end.x-a.x,end.y-a.y);if(len<.01){$("status").textContent="Line too short — choose a farther endpoint";return false}if(wallGeometryMethod==="rectangle"){const p1=a,p2={x:end.x,y:a.y},p3=end,p4={x:a.x,y:end.y},sides=[[p1,p2],[p2,p3],[p3,p4],[p4,p1]];if(sides.some(([u,v])=>{const d=Math.hypot(v.x-u.x,v.y-u.y);return d<.01||d>30})){$("status").textContent="Rectangle sides must each be between 0.01 m and 30 m";return false}beginProvisionalDrawing();hist();for(const [u,v] of sides)addWallSegment(u,v);draft=[];floorDrawGesture=null;$("status").textContent="Wall rectangle pending · press Enter to commit or Esc to cancel";renderProperties();redraw();return true}if(len>30){$("status").textContent="Drawing cancelled: segment exceeds 30 m";draft=[];floorDrawGesture=null;wallChainStart=null;wallChainHasSegment=false;redraw();return false}beginProvisionalDrawing();hist();addWallSegment(a,end);if(wallGeometryMethod==="continuous"){wallChainStart??={x:a.x,y:a.y};if(!wallChainPoints.length)wallChainPoints.push({x:a.x,y:a.y});wallChainPoints.push({x:end.x,y:end.y});wallChainHasSegment=true;draft=[{x:end.x,y:end.y}]}else{wallChainStart=null;wallChainHasSegment=false;draft=[]}floorDrawGesture=null;$("status").textContent=wallGeometryMethod==="continuous"?"Wall segment created · continue clicking or press Esc":"Wall created";renderProperties();redraw();return true}

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
 const w=candidate.w,width=tool==="door"?.9:1.2,len=wallLength(w),anchor=$("openingAlignment")?.value||openingAlignment||"center";
 if(len+1e-8<width){$("status").textContent="Host wall is too short for this "+tool+" ("+width.toFixed(2)+" m required)";return false}
 openingAlignment=anchor;
 const dx=w.end.x-w.start.x,dy=w.end.y-w.start.y,position=((q.x-w.start.x)*dx+(q.y-w.start.y)*dy)/(len||1),anchorPosition=Math.max(0,Math.min(len,position));
 const offset=openingOffsetForAnchor(len,width,anchor,anchorPosition);
 const anchorPoint={x:w.start.x+dx*anchorPosition/(len||1),y:w.start.y+dy*anchorPosition/(len||1)};
 const cross=dx*(q.y-w.start.y)-dy*(q.x-w.start.x),revealSide=cross>=0?"left":"right";
 pendingOpeningPlacement=openingPlacement.begin({wallId:w.id,storyId:w.storyId,type:tool,offset,width,height:tool==="door"?2.1:1.2,sill:tool==="door"?0:.9,hingeSide:openingHingeSide,swingDirection:openingSwingDirection,revealSide,anchor,anchorPosition,anchorPoint,cursor:{x:q.x,y:q.y}});
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
function commitPendingOpening(){if(!pendingOpeningPlacement)return false;const w0=els().find(v=>v.id===pendingOpeningPlacement.wallId);if(!w0){openingPlacement.cancel();pendingOpeningPlacement=null;redraw();return false}try{const expected=openingOffsetForAnchor(wallLength(w0),pendingOpeningPlacement.width,pendingOpeningPlacement.anchor||"center",pendingOpeningPlacement.anchorPosition);if(Math.abs(expected-pendingOpeningPlacement.offset)>1e-7||pendingOpeningPlacement.offset<0||pendingOpeningPlacement.offset+pendingOpeningPlacement.width>wallLength(w0)+1e-8)throw new RangeError("Opening anchor falls outside its host wall");const d=openingPlacement.confirm(),w=d&&els().find(v=>v.id===d.wallId);pendingOpeningPlacement=null;if(!w){redraw();return false}hist();const o=addOpening(w,d.type,d.offset,d.width,d.height,d.sill);o.hingeSide=d.hingeSide;o.swingDirection=d.swingDirection;o.revealSide=d.revealSide||"left";o.alignment=d.anchor||"center";els().push({...o,hostWallId:w.id,storyId:w.storyId,alignment:d.anchor||"center",revealSide:d.revealSide||"left"});$("status").textContent=(d.type==="door"?"Door":"Window")+" placed · opening direction confirmed";renderProperties();redraw();return true}catch(err){$("status").textContent=err.message;redraw();return false}}

function createRoofFromMagicWand(q){
 const loops=findClosedWallLoops(els().filter(e=>e.type==="wall"&&e.storyId===story().id&&isLayerVisible(e)),{tolerance:.06,minArea:.25}).filter(loop=>pointInPolygon(q,loop.boundary)).sort((a,b)=>a.area-b.area);
 if(!loops.length){$("status").textContent="Magic Wand: no closed wall reference at this point";return false}
 const loop=loops[0];
 if(els().some(e=>e.type==="roof"&&e.storyId===story().id&&e.sourceWallIds?.length===loop.wallIds.length&&loop.wallIds.every(id=>e.sourceWallIds.includes(id)))){$("status").textContent="Magic Wand: a roof already follows this wall loop";return false}
 try{hist("Magic Wand · Roof from walls");els().push(createRoof(loop.boundary,{storyId:story().id,elevation:Number($("roofElevation")?.value??3),pitch:Number($("roofPitch")?.value??$("roofPitch")?.dataset.current??30),offset:Number($("roofOffset")?.value??0),sourceWallIds:loop.wallIds}));selected.clear();scheduleAutoSave();renderProperties();redraw();$("status").textContent="Magic Wand created Roof from "+loop.wallIds.length+" reference walls";return true}catch(error){$("status").textContent="Magic Wand failed: "+error.message;return false}
}
function drawClick3d(q,e){const g=Math.max(.1,+$("grid").value||.5);q={x:Math.round(q.x/g)*g,y:Math.round(q.y/g)*g};q=snapPoint(q);if(tool==="select"){let hit=null;const rect=c.getBoundingClientRect(),px=e.clientX-rect.left,py=e.clientY-rect.top,screenPoint={x:px,y:py};const openingIds=new Set(els().filter(el=>el.type==="door"||el.type==="window").map(el=>el.id));const hitOpening=hitPolys3d.filter(item=>openingIds.has(item.id)).slice().reverse().find(item=>pointInPolygon(screenPoint,item.poly));if(hitOpening)hit=hitOpening.id;else for(let i=hitPolys3d.length-1;i>=0;i--){const item=hitPolys3d[i];if(openingIds.has(item.id))continue;if(pointInPolygon(screenPoint,item.poly)){hit=item.id;break}}if(e.shiftKey&&hit){selected.has(hit)?selected.delete(hit):selected.add(hit)}else selectOnly(hit);renderProperties();redraw();$("status").textContent=hit?"3D element selected":"No element at clicked position";return}if(tool==="column"){beginProvisionalDrawing();hist();els().push(createColumn(q,{storyId:story().id}));$("status").textContent="Column pending · press Enter to commit or Esc to cancel";redraw();return}if(tool==="door"||tool==="window"){if(pendingOpeningPlacement){if(view==="floor"){commitAndDeselect("Paper-space confirmation")}else $("status").textContent="Press Enter to confirm opening";return}beginOpeningPlacement(q);return}if(tool==="slab"||tool==="roof"){if(draft.length)q=constrain(draft[draft.length-1],q,e);draft.push(q);redraw();return}if(["wall","beam","dimension"].includes(tool)){if(draft.length){const a=draft[draft.length-1];if(tool==="wall"){completeWallGeometry(a,q,e);return}const b=constrain(a,q,e),len=Math.hypot(b.x-a.x,b.y-a.y);if(len<.01){$("status").textContent="Line too short — choose a farther endpoint";return}if(len>30){$("status").textContent="Drawing cancelled: segment exceeds 30 m";draft=[];floorDrawGesture=null;redraw();return}beginProvisionalDrawing();hist();if(tool==="beam")els().push(createBeam(a,b,{storyId:story().id}));else els().push({id:crypto.randomUUID(),type:"dimension",start:a,end:b,storyId:story().id});draft=[];floorDrawGesture=null;$("status").textContent=tool.charAt(0).toUpperCase()+tool.slice(1)+" pending · press Enter to commit or Esc to cancel";renderProperties();redraw();return}draft=[q];floorDrawGesture={pointerId:e.pointerId,tool,startScreen:{x:e.clientX,y:e.clientY},anchor:q,isStart:true,pointerWorld:{x:q.x,y:q.y}};$("status").textContent="Start point set — click endpoint or drag";redraw();return}}
c.addEventListener("pointermove",e=>{const r=c.getBoundingClientRect();if(roomLabelMoveGesture&&roomLabelMoveGesture.pointerId===e.pointerId){const g=roomLabelMoveGesture,dx=e.clientX-g.startClient.x,dy=e.clientY-g.startClient.y;if(Math.hypot(dx,dy)>3){if(!g.historyStarted){hist("Move Room Label");g.historyStarted=true}const room=els().find(v=>v.id===g.roomId&&v.type==="room");if(room){room.labelPosition={x:g.startLabel.x+dx/scale,y:g.startLabel.y-dy/scale};g.didMove=true;$("status").textContent="Moving room name and area together";redraw()}}return}if(genericNodeMoveGesture&&genericNodeMoveGesture.pointerId===e.pointerId){
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
}if(selectionBoxGesture&&selectionBoxGesture.pointerId===e.pointerId){const p={x:e.clientX-r.left,y:e.clientY-r.top};selectionBoxGesture.currentScreen=p;selectionBoxGesture.didDrag=Math.hypot(p.x-selectionBoxGesture.startScreen.x,p.y-selectionBoxGesture.startScreen.y)>4;redraw();return}if(tool==="marquee"&&marqueeDraftPoints.length){marqueePreviewPoint=wpos({x:e.clientX-r.left,y:e.clientY-r.top});redraw();return}if(view==="3d"&&e.pointerType==="touch"&&threeTouchPointers.has(e.pointerId)){threeTouchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(threeTouchGesture&&threeTouchPointers.size>=2){const pts=[...threeTouchPointers.values()],distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y)),next=Math.max(.2,Math.min(5,threeTouchGesture.zoom*distance/threeTouchGesture.distance));if(next!==camera3d.zoom){camera3d.zoom=next;redraw();updateZoomReadout()}e.preventDefault();return}}if(view==="floor"&&e.pointerType==="touch"&&floorTouchPointers.has(e.pointerId)){floorTouchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(floorTouchGesture&&floorTouchPointers.size>=2){const pts=[...floorTouchPointers.values()],mid={x:(pts[0].x+pts[1].x)/2-r.left,y:(pts[0].y+pts[1].y)/2-r.top},distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y)),nextScale=Math.max(1,Math.min(180,baseScaleForDrawing()*Math.max(.05,Math.min(5,floorTouchGesture.zoom*distance/floorTouchGesture.distance))));viewportZoom=Math.max(.05,Math.min(5,floorTouchGesture.zoom*distance/floorTouchGesture.distance));scale=nextScale;origin.x=mid.x-c.clientWidth/2-floorTouchGesture.world.x*scale;origin.y=mid.y-c.clientHeight/2+floorTouchGesture.world.y*scale;redraw();e.preventDefault();return}}if(view==="3d"&&pending3dPointer&&!threeTouchGesture&&threeTouchPointers.size<2){const dx=e.clientX-(lastCameraPointer?.x??pending3dPointer.x),dy=e.clientY-(lastCameraPointer?.y??pending3dPointer.y);if(!orbiting&&Math.hypot(e.clientX-pending3dPointer.x,e.clientY-pending3dPointer.y)>2){orbiting=true;c.style.cursor="grabbing"}if(orbiting){if(pending3dPointer.panGesture){const f=scale*.72*camera3d.zoom,sp=Math.sin(camera3d.pitch),cp=Math.cos(camera3d.pitch),safeSp=Math.max(.12,Math.abs(sp))*(sp<0?-1:1);camera3d.panX-=dx/f;camera3d.panY-=dy*safeSp/f;camera3d.targetZ+=dy*cp/f}else if(pending3dPointer.orbitGesture){orbitCameraBy(dx*.0055,dy*.0045)}lastCameraPointer={x:e.clientX,y:e.clientY};redraw()}return}if(isPanning&&panStart){if(view==="3d"){const dx=e.clientX-panStart.x,dy=e.clientY-panStart.y,f=scale*.72*camera3d.zoom,sp=Math.sin(camera3d.pitch),cp=Math.cos(camera3d.pitch),safeSp=Math.max(.12,Math.abs(sp))*(sp<0?-1:1);camera3d.panX-=dx/f;camera3d.panY-=dy*safeSp/f;camera3d.targetZ+=dy*cp/f}else{origin.x+=e.clientX-panStart.x;origin.y+=e.clientY-panStart.y}panStart={x:e.clientX,y:e.clientY};redraw();return}if(view==="floor"&&genericMoveGesture&&genericMoveGesture.pointerId===e.pointerId){
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
if(view==="floor"&&gridlineMoveGesture&&gridlineMoveGesture.pointerId===e.pointerId){const g=gridlineMoveGesture,el=els().find(v=>v.id===g.elementId&&v.type==="gridline");if(el){const current=wpos({x:e.clientX-r.left,y:e.clientY-r.top});if(Math.hypot(e.clientX-g.startClient.x,e.clientY-g.startClient.y)>3){if(!g.historyStarted){hist("Move Gridline");g.historyStarted=true}let dx=current.x-g.startWorld.x,dy=current.y-g.startWorld.y;if(e.shiftKey||shiftHeld){if(!g.axisLock)g.axisLock=Math.abs(dx)>=Math.abs(dy)?"x":"y"}else if(!g.axisLockByKey)g.axisLock=null;if(g.axisLock==="x")dy=0;else if(g.axisLock==="y")dx=0;let nextStart={x:g.start.start.x+dx,y:g.start.start.y+dy},nextEnd={x:g.start.end.x+dx,y:g.start.end.y+dy};let snapCandidate=null,snapDistance=Infinity;if(p.settings?.snap!==false){const threshold=14/Math.max(1,scale),gridStep=Math.max(.1,Number($("grid")?.value)||.5);for(const endpoint of [nextStart,nextEnd]){const gridPoint={x:g.axisLock==="y"?endpoint.x:Math.round(endpoint.x/gridStep)*gridStep,y:g.axisLock==="x"?endpoint.y:Math.round(endpoint.y/gridStep)*gridStep};const gridDx=gridPoint.x-endpoint.x,gridDy=gridPoint.y-endpoint.y,gridDistance=Math.hypot(gridDx,gridDy);if(gridDistance<threshold&&gridDistance<snapDistance){snapDistance=gridDistance;snapCandidate={...gridPoint,kind:"grid",from:endpoint}}for(const target of els()){if(target.id===el.id||(groupKey(el)&&!groupsSuspended&&groupKey(target)===groupKey(el))||!isLayerVisible(target)||(view==="floor"&&target.storyId!==story().id))continue;const points=[];if(target.type==="wall"||target.type==="beam"){points.push({point:target.start,kind:"endpoint"},{point:target.end,kind:"endpoint"},{point:{x:(target.start.x+target.end.x)/2,y:(target.start.y+target.end.y)/2},kind:"midpoint"});const vx=target.end.x-target.start.x,vy=target.end.y-target.start.y,l2=vx*vx+vy*vy;if(l2>1e-9){const t=Math.max(0,Math.min(1,((endpoint.x-target.start.x)*vx+(endpoint.y-target.start.y)*vy)/l2));if(t>.025&&t<.975)points.push({point:{x:target.start.x+t*vx,y:target.start.y+t*vy},kind:"nearest"})}}else if(target.type==="column")points.push({point:target.position,kind:"center"});else if(target.type==="slab")(target.boundary||[]).forEach(point=>points.push({point,kind:"endpoint"}));for(const candidate of points){if(!candidate.point)continue;const sx=candidate.point.x-endpoint.x,sy=candidate.point.y-endpoint.y;if(g.axisLock==="x"&&Math.abs(sy)>threshold)continue;if(g.axisLock==="y"&&Math.abs(sx)>threshold)continue;const d=Math.hypot(g.axisLock==="x"?sx:g.axisLock==="y"?0:sx,g.axisLock==="y"?sy:g.axisLock==="x"?0:sy);if(d<threshold&&d<snapDistance){snapDistance=d;snapCandidate={...candidate.point,kind:candidate.kind,from:endpoint}}}}}}if(snapCandidate){const sx=snapCandidate.x-snapCandidate.from.x,sy=snapCandidate.y-snapCandidate.from.y;dx+=sx;dy+=sy;nextStart={x:g.start.start.x+dx,y:g.start.start.y+dy};nextEnd={x:g.start.end.x+dx,y:g.start.end.y+dy};activeSnapPoint={x:snapCandidate.x,y:snapCandidate.y,kind:snapCandidate.kind}}else activeSnapPoint=null;if(g.groupStarts){for(const original of g.groupStarts){const member=els().find(v=>v.id===original.id);if(!member)continue;if(original.start&&original.end){member.start={x:original.start.x+dx,y:original.start.y+dy};member.end={x:original.end.x+dx,y:original.end.y+dy}}if(original.position)member.position={x:original.position.x+dx,y:original.position.y+dy};if(original.boundary)member.boundary=original.boundary.map(pt=>({x:pt.x+dx,y:pt.y+dy}));if(original.witnessStart)member.witnessStart={x:original.witnessStart.x+dx,y:original.witnessStart.y+dy};if(original.witnessEnd)member.witnessEnd={x:original.witnessEnd.x+dx,y:original.witnessEnd.y+dy}}}else{el.start=nextStart;el.end=nextEnd}g.didMove=true;$("status").textContent="Moving Gridline "+(el.label||"")+(g.axisLock?" · "+g.axisLock.toUpperCase()+" axis locked":"")+(activeSnapPoint?" · snapped to "+activeSnapPoint.kind:"")+" · release to place";redraw()}}return}if(view==="floor"&&openingMoveGesture&&openingMoveGesture.pointerId===e.pointerId){const gesture=openingMoveGesture;if(Math.hypot(e.clientX-gesture.startClient.x,e.clientY-gesture.startClient.y)>3){const wall=els().find(v=>v.id===gesture.hostWallId&&v.type==="wall"),element=els().find(v=>v.id===gesture.elementId);if(wall&&element){if(!gesture.historyStarted){hist("Move "+(element.type==="door"?"Door":"Window"));gesture.historyStarted=true}const len=wallLength(wall);if(len>1e-8){const dx=(wall.end.x-wall.start.x)/len,dy=(wall.end.y-wall.start.y)/len;const current=wpos({x:e.clientX-r.left,y:e.clientY-r.top});const delta=(current.x-gesture.startWorld.x)*dx+(current.y-gesture.startWorld.y)*dy;const next=Math.max(0,Math.min(len-(Number(element.width)||0),gesture.startOffset+delta));element.offset=next;const opening=wall.openings?.find(o=>o.id===element.id);if(opening)opening.offset=next;gesture.didMove=true;$("status").textContent="Moving "+(element.type==="door"?"Door":"Window")+" · release to place";redraw()}}}return}mouse={x:e.clientX-r.left,y:e.clientY-r.top};const q=view==="3d"?screenToWorld3d(mouse,story().elevation||0):wpos(mouse);if(tool==="select"&&!activeEditGesture()&&view==="floor"){const nextCandidates=selectionCandidatesAt(q);const same=nextCandidates.map(el=>el.id).join("|")===tabSelectionCandidates.map(el=>el.id).join("|");if(!same){tabSelectionCandidates=nextCandidates;tabSelectionIndex=-1}const nextHover=tabSelectionIndex>=0?tabSelectionCandidates[tabSelectionIndex]?.id||null:nextCandidates[0]?.id||null;if(nextHover!==hoveredElementId){hoveredElementId=nextHover;redraw()}}if(pendingOpeningPlacement&&view==="floor")updatePendingOpening(q);if(shiftHeld&&draft.length&&shiftAngleLock===null&&view==="floor"){const anchor=draft[draft.length-1],reference=shiftReferencePoint(q,anchor);shiftAngleLock=lockCursorAxis(reference,q)}$("coords").textContent="X "+q.x.toFixed(2)+" · Y "+q.y.toFixed(2);redraw()});
c.addEventListener("pointerdown",e=>{if(e.button===2)return;/* Right-click is context-menu only: never run selection or edit-gesture logic from this pointerdown. */if(view==="floor"&&activeEditGesture()&&e.button===0&&e.isPrimary===false){e.preventDefault();return}if(!releasedTouchEditPending){releasedTouchEditSnapshot=JSON.stringify(p);}if(view==="3d"&&e.pointerType==="touch"){threeTouchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(threeTouchPointers.size>=2){const pts=[...threeTouchPointers.values()],distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));threeTouchGesture={distance,zoom:camera3d.zoom};pending3dPointer=null;orbiting=false;lastCameraPointer=null;e.preventDefault();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};return}if(threeTouchGesture){pending3dPointer=null;orbiting=false;lastCameraPointer=null;e.preventDefault();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};return}}if(view==="floor"&&e.pointerType==="touch"){floorTouchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(floorTouchPointers.size>=2){const pts=[...floorTouchPointers.values()],rect=c.getBoundingClientRect(),mid={x:(pts[0].x+pts[1].x)/2-rect.left,y:(pts[0].y+pts[1].y)/2-rect.top},world=wpos(mid),distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));floorTouchGesture={distance,scale,zoom:viewportZoom,world,mid,origin:{...origin}};draft=[];floorDrawGesture=null;openingMoveGesture=null;isPanning=false;panStart=null;$("status").textContent="Two-finger pan / zoom";e.preventDefault();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};return}}if(view==="3d"&&e.pointerType==="touch"){e.preventDefault();pending3dPointer={x:e.clientX,y:e.clientY,pointerId:e.pointerId,orbitGesture:true,touchGesture:true};orbiting=false;lastCameraPointer={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grab";return}if(view==="3d"&&e.button===1){e.preventDefault();pending3dPointer={x:e.clientX,y:e.clientY,pointerId:e.pointerId,orbitGesture:!(e.shiftKey||shiftHeld),panGesture:e.shiftKey||shiftHeld};orbiting=false;lastCameraPointer={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grab";return}if(view==="3d"&&e.button===0&&(e.shiftKey||shiftHeld)){pending3dPointer={x:e.clientX,y:e.clientY,pointerId:e.pointerId,orbitGesture:true};orbiting=false;lastCameraPointer={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grab";return}if(view==="3d"&&e.button===0){const rect=c.getBoundingClientRect(),q=screenToWorld3d({x:e.clientX-rect.left,y:e.clientY-rect.top},story().elevation||0);drawClick3d(q,e);return}if(view==="3d"&&e.button===1&&e.shiftKey){e.preventDefault();pending3dPointer={x:e.clientX,y:e.clientY,pointerId:e.pointerId,orbitGesture:true};orbiting=false;lastCameraPointer={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grab";return}if(e.button===1||spaceHeld){e.preventDefault();if(view==="floor"&&draft.length){$("status").textContent="Finish or cancel the active drawing before panning (Esc cancels)";return}isPanning=true;panStart={x:e.clientX,y:e.clientY};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};c.style.cursor="grabbing";return}if(view!=="floor")return;const r=c.getBoundingClientRect();if(tool==="select"&&!e.shiftKey){const pointer={x:e.clientX-r.left,y:e.clientY-r.top};for(const room of els().filter(v=>v.type==="room"&&v.storyId===story().id&&isLayerVisible(v))){const anchor=spos(room.labelPosition||room.center||room.boundary[0]),zoneNumber=String(room.zoneNumber||"").trim(),name=String(room.roomName||room.name||"").trim(),area=(Number(room.area)||polygonArea(room.boundary)).toFixed(2)+" m²",width=Math.max(zoneNumber.length*6,name?name.length*7.2:0,area.length*6.8),height=name?44:28;if(Math.abs(pointer.x-anchor.x)<=Math.max(24,width/2+8)&&Math.abs(pointer.y-anchor.y)<=height/2+7){roomLabelMoveGesture={pointerId:e.pointerId,roomId:room.id,startClient:{x:e.clientX,y:e.clientY},startLabel:{...(room.labelPosition||room.center||room.boundary[0])},didMove:false,historyStarted:false};selectOnly(room.id);renderProperties();redraw();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};e.preventDefault();return}}}if(tool==="marquee"){const start={x:e.clientX-r.left,y:e.clientY-r.top},world=wpos(start);if(marqueeGeometryMethod==="rectangle"){selectionBoxGesture={pointerId:e.pointerId,startScreen:start,currentScreen:{...start},startWorld:world,didDrag:false,clickHitId:null};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};e.preventDefault();$("status").textContent="Rectangle Marquee · drag between opposite corners";redraw();return}if(marqueeGeometryMethod==="polygonal"){if(marqueeDraftPoints.length>=3&&Math.hypot(start.x-spos(marqueeDraftPoints[0]).x,start.y-spos(marqueeDraftPoints[0]).y)<12){finishMarqueePolygon();e.preventDefault();return}marqueeDraftPoints.push(world);marqueePreviewPoint=world;$("status").textContent="Polygonal Marquee · point "+marqueeDraftPoints.length+" set · close at first point or press Enter";redraw();e.preventDefault();return}if(marqueeGeometryMethod==="rotated-rectangle"){marqueeDraftPoints.push(world);marqueePreviewPoint=world;if(marqueeDraftPoints.length===1)$("status").textContent="Rotated Rectangle · click second point for first side";else if(marqueeDraftPoints.length===2)$("status").textContent="Rotated Rectangle · click third point for width";else finishRotatedMarquee();redraw();e.preventDefault();return}}let screenPoint={x:e.clientX-r.left,y:e.clientY-r.top};let q=wpos(screenPoint),rawPointerWorld={x:q.x,y:q.y},g=Math.max(.1,+$("grid").value||.5);if(!draft.length&&["wall","beam","dimension","slab","column"].includes(tool)&&(!Number.isFinite(q.x)||!Number.isFinite(q.y)||Math.abs(q.x)>25||Math.abs(q.y)>25)){origin={x:0,y:0};viewportZoom=1;applyViewportZoom();q=wpos(screenPoint);$("status").textContent="Reset drawing viewport to a usable origin before starting a new element"}const cursorWorld={x:q.x,y:q.y};const magneticPoint=snapPoint(cursorWorld,shiftHeld?0:undefined);q=shiftHeld?{x:Math.round(cursorWorld.x/g)*g,y:Math.round(cursorWorld.y/g)*g}:(activeSnapPoint?magneticPoint:{x:Math.round(cursorWorld.x/g)*g,y:Math.round(cursorWorld.y/g)*g});if(pendingGridSystem){if(!pendingGridSystem.origin){pendingGridSystem.origin={x:q.x,y:q.y};$("status").textContent="Grid System origin set · click to define X-axis direction";redraw();return}const gs=pendingGridSystem,dx=q.x-gs.origin.x,dy=q.y-gs.origin.y,angle=Math.atan2(dy,dx);if(Math.hypot(dx,dy)<.1){$("status").textContent="Choose an X-axis direction at least 0.1 m from the origin";return}const ux=Math.cos(angle),uy=Math.sin(angle),vx=-uy,vy=ux,corner=gs.startCorner||"bottom-left",xSign=corner.endsWith("right")?-1:1,ySign=corner.startsWith("top")?-1:1,xPositions=[0],yPositions=[0];gs.xSpacing.forEach(v=>xPositions.push(xPositions[xPositions.length-1]+v));gs.ySpacing.forEach(v=>yPositions.push(yPositions[yPositions.length-1]+v));const totalX=xPositions[xPositions.length-1],totalY=yPositions[yPositions.length-1],pointAt=(a,b)=>({x:gs.origin.x+ux*a*xSign+vx*b*ySign,y:gs.origin.y+uy*a*xSign+vy*b*ySign}),letters=n=>{let out="";for(n=Math.max(0,n);n>=0;n=Math.floor(n/26)-1)out=String.fromCharCode(65+n%26)+out;return out},axisLabel=(base,index)=>{if(/^\d+$/.test(base))return String(Number(base)+index);let start=0;for(const ch of base.toUpperCase())start=start*26+(ch.charCodeAt(0)-64);return letters(Math.max(0,start-1+index))};if(xPositions.length+yPositions.length>60){pendingGridSystem=null;$("status").textContent="Grid System limited to 60 axes";return}hist("Create Grid System");const groupId=crypto.randomUUID(),ext=gs.extension;for(let i=0;i<xPositions.length;i++){const pos=xPositions[i];els().push({id:crypto.randomUUID(),type:"gridline",start:pointAt(pos,-ext),end:pointAt(pos,totalY+ext),label:gs.verticalLabels?.[i]??axisLabel(gs.yLabel,i),storyId:story().id,gridSystemId:groupId,gridSystemAxis:"vertical",gridSystemIndex:i,markerSides:{start:ySign>0?!!gs.markerSides.bottom:!!gs.markerSides.top,end:ySign>0?!!gs.markerSides.top:!!gs.markerSides.bottom},markerRadius:gs.markerRadius})}for(let i=0;i<yPositions.length;i++){const pos=yPositions[i];els().push({id:crypto.randomUUID(),type:"gridline",start:pointAt(-ext,pos),end:pointAt(totalX+ext,pos),label:gs.horizontalLabels?.[i]??axisLabel(gs.xLabel,i),storyId:story().id,gridSystemId:groupId,gridSystemAxis:"horizontal",gridSystemIndex:i,markerSides:{start:xSign>0?!!gs.markerSides.left:!!gs.markerSides.right,end:xSign>0?!!gs.markerSides.right:!!gs.markerSides.left},markerRadius:gs.markerRadius})}let columnCount=0,beamCount=0,dimensionCount=0;if(gs.createDimensions){const chainOffset=Math.max(0,Number(gs.chainDimensionOffset??1000)/1000),totalOffset=Math.max(0,Number(gs.totalDimensionOffset??1500)/1000),topMarkerY=(totalY+ext)*ySign,leftMarkerX=-ext*xSign,chainY=topMarkerY-chainOffset*ySign,totalYDim=topMarkerY-totalOffset*ySign,chainX=leftMarkerX+chainOffset*xSign,totalXDim=leftMarkerX+totalOffset*xSign;for(let i=0;i<gs.xSpacing.length;i++){const dim={id:crypto.randomUUID(),type:"dimension",start:pointAt(xPositions[i],chainY),end:pointAt(xPositions[i+1],chainY),witnessStart:pointAt(xPositions[i],topMarkerY),witnessEnd:pointAt(xPositions[i+1],topMarkerY),storyId:story().id,gridSystemId:groupId,gridDimension:"chain",gridDimensionAxis:"vertical",gridDimensionIndex:i,gridDimensionOffset:Number(gs.chainDimensionOffset??1000)};els().push(dim);dimensionCount++}if(gs.totalDimension){const dim={id:crypto.randomUUID(),type:"dimension",start:pointAt(0,totalYDim),end:pointAt(totalX,totalYDim),witnessStart:pointAt(0,topMarkerY),witnessEnd:pointAt(totalX,topMarkerY),storyId:story().id,gridSystemId:groupId,gridDimension:"total",gridDimensionAxis:"vertical",gridDimensionOffset:Number(gs.totalDimensionOffset??1500)};els().push(dim);dimensionCount++}for(let i=0;i<gs.ySpacing.length;i++){const dim={id:crypto.randomUUID(),type:"dimension",start:pointAt(chainX,yPositions[i]),end:pointAt(chainX,yPositions[i+1]),witnessStart:pointAt(leftMarkerX,yPositions[i]),witnessEnd:pointAt(leftMarkerX,yPositions[i+1]),storyId:story().id,gridSystemId:groupId,gridDimension:"chain",gridDimensionAxis:"horizontal",gridDimensionIndex:i,gridDimensionOffset:Number(gs.chainDimensionOffset??1500)};els().push(dim);dimensionCount++}if(gs.totalDimension){const dim={id:crypto.randomUUID(),type:"dimension",start:pointAt(totalXDim,0),end:pointAt(totalXDim,totalY),witnessStart:pointAt(leftMarkerX,0),witnessEnd:pointAt(leftMarkerX,totalY),storyId:story().id,gridSystemId:groupId,gridDimension:"total",gridDimensionAxis:"horizontal",gridDimensionOffset:Number(gs.totalDimensionOffset??1000)};els().push(dim);dimensionCount++}}if(gs.placeColumns){for(const px of xPositions)for(const py of yPositions){const column=createColumn(pointAt(px,py),{storyId:story().id});column.gridSystemId=groupId;column.properties={...column.properties,gridIntersection:true};els().push(column);columnCount++}}if(gs.createBeams){for(const py of yPositions)for(let i=0;i<xPositions.length-1;i++){const beam=createBeam(pointAt(xPositions[i],py),pointAt(xPositions[i+1],py),{storyId:story().id});beam.gridSystemId=groupId;els().push(beam);beamCount++}for(const px of xPositions)for(let i=0;i<yPositions.length-1;i++){const beam=createBeam(pointAt(px,yPositions[i]),pointAt(px,yPositions[i+1]),{storyId:story().id});beam.gridSystemId=groupId;els().push(beam);beamCount++}}pendingGridSystem=null;selected=new Set(els().filter(el=>el.gridSystemId===groupId&&el.type==="gridline").map(el=>el.id));scheduleAutoSave();renderProperties();redraw();$("status").textContent="Grid System created · "+xPositions.length+" X-axis, "+yPositions.length+" Y-axis"+(columnCount?" · "+columnCount+" columns":"")+(beamCount?" · "+beamCount+" beams":"")+(dimensionCount?" · "+dimensionCount+" dimensions":"");return}if(draft.length&&["wall","beam","dimension","slab"].includes(tool)){if(trackerDistanceOverride!==null||trackerAngleOverride!==null){q=trackerEndpoint(draft[draft.length-1],q);trackerDistanceOverride=null;trackerAngleOverride=null}}/* Unified node/edge hit-testing for editable element geometry.
 * A pointer-down on geometry must not become a node edit merely because the
 * current selection has a nearby endpoint; only a real hit within tolerance
 * is accepted. A lone selected node edits only its owner. Shared nodes join
 * only explicitly selected elements when selection has more than one member.
 */
if(tool==="select"&&view==="floor"&&!e.shiftKey){
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
 if(view==="floor"){const rect=c.getBoundingClientRect(),pointer={x:e.clientX-rect.left,y:e.clientY-rect.top},pixelTolerance=16;const openingHits=[];for(const w of els().filter(el=>el.type==="wall"&&isLayerVisible(el)&&el.storyId===story().id)){const dx=w.end.x-w.start.x,dy=w.end.y-w.start.y,len=Math.hypot(dx,dy)||1;const a=spos(w.start),b=spos(w.end),sx=b.x-a.x,sy=b.y-a.y,pixelLength=Math.hypot(sx,sy)||1;const along=((pointer.x-a.x)*sx+(pointer.y-a.y)*sy)/pixelLength*len;const perpendicular=pointSegmentDistance(pointer,a,b);for(const o of els().filter(el=>(el.type==="door"||el.type==="window")&&el.hostWallId===w.id&&(el.storyId===w.storyId||!el.storyId))){const start=Math.max(0,Number(o.offset)||0),width=Math.max(0,Number(o.width)||0);if(width<=0)continue;const margin=pixelTolerance/Math.max(1,scale);if(along>=start-margin&&along<=start+width+margin&&perpendicular<=Math.max(pixelTolerance,(Number(w.thickness)||.15)*scale/2+pixelTolerance)){openingHits.push({opening:o,distance:perpendicular})}}}openingHits.sort((a,b)=>a.distance-b.distance);/* Opening selection is handled by nearestElement using the visible symbol geometry. Do not promote an entire wall interval to a hit here, or blank-space marquee drags get hijacked. */lastFloorSelectionDebug={pointer,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},q:{...q},nearest:nearestElement(q)?.id||null,openingHits:openingHits.map(v=>({id:v.opening.id,type:v.opening.type,distance:v.distance,offset:v.opening.offset,width:v.opening.width,hostWallId:v.opening.hostWallId})),walls:els().filter(el=>el.type==="wall"&&isLayerVisible(el)&&el.storyId===story().id).map(w=>({id:w.id,a:spos(w.start),b:spos(w.end),thickness:w.thickness}))}}

 // A click on an element is an intentional selection action, not blank-paper confirmation.
 const openingHit=hit&&["door","window"].includes(hit.type);if(openingHit)selectionBoxGesture=null;const marqueeEligible=!e.shiftKey&&!releasedTouchEditPending&&!activeEditGesture()&&!pendingOpeningPlacement&&!hasActiveDrawing();if(marqueeEligible&&!hit){selectionBoxGesture={pointerId:e.pointerId,startScreen:{x:e.clientX-rect.left,y:e.clientY-rect.top},currentScreen:{x:e.clientX-rect.left,y:e.clientY-rect.top},startWorld:{...q},didDrag:false,clickHitId:hit?.id||null};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{}}if(hit&&(releasedTouchEditPending||activeEditGesture()))commitAndDeselect("Selection change");
 else if(!hit&&(releasedTouchEditPending||activeEditGesture()||pendingOpeningPlacement||hasActiveDrawing())){e.preventDefault();commitAndDeselect("Outside click");return}if(e.shiftKey&&hit){const ids=groupMembers(hit).map(v=>v.id),remove=ids.every(id=>selected.has(id));for(const id of ids){if(remove)selected.delete(id);else selected.add(id)}}else if(hit||!selectionBoxGesture)selectOnly(hit?.id);if(hit&&!selectionBoxGesture&&!e.shiftKey&&!["gridline","door","window"].includes(hit.type)){
 const starts=groupMembers(hit).map(el=>({id:el.id,geometry:{start:el.start?{...el.start}:null,end:el.end?{...el.end}:null,witnessStart:el.witnessStart?{...el.witnessStart}:null,witnessEnd:el.witnessEnd?{...el.witnessEnd}:null,position:el.position?{...el.position}:null,boundary:el.boundary?el.boundary.map(pt=>({...pt})):null,offset:Number.isFinite(el.offset)?el.offset:null,openings:el.openings?el.openings.map(o=>({...o})):null}}));
 genericMoveGesture={pointerId:e.pointerId,elementIds:starts.map(el=>el.id),startElements:starts,startWorld:{x:q.x,y:q.y},startClient:{x:e.clientX,y:e.clientY},didMove:false,historyStarted:false,axisLock:null,modelBefore:structuredClone(p)};
 try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};updateEditActions();
 }else if(hit&&hit.type==="gridline"&&!e.shiftKey){gridlineMoveGesture={pointerId:e.pointerId,elementId:hit.id,startWorld:{x:q.x,y:q.y},startClient:{x:e.clientX,y:e.clientY},start:{start:{...hit.start},end:{...hit.end}},groupStarts:groupKey(hit)&&!groupsSuspended?els().filter(v=>groupKey(v)===groupKey(hit)).map(v=>({id:v.id,start:v.start?{...v.start}:null,end:v.end?{...v.end}:null,position:v.position?{...v.position}:null,boundary:v.boundary?v.boundary.map(pt=>({...pt})):null,witnessStart:v.witnessStart?{...v.witnessStart}:null,witnessEnd:v.witnessEnd?{...v.witnessEnd}:null})):null,didMove:false,historyStarted:false,axisLock:null,modelBefore:structuredClone(p)};updateEditActions();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};$("status").textContent="Gridline selected · drag the line to move it"}else if(hit&&["door","window"].includes(hit.type)&&!e.shiftKey){selectionBoxGesture=null;openingMoveGesture={pointerId:e.pointerId,elementId:hit.id,hostWallId:hit.hostWallId,startWorld:{x:q.x,y:q.y},startClient:{x:e.clientX,y:e.clientY},startOffset:Number(hit.offset)||0,didMove:false,historyStarted:false,modelBefore:structuredClone(p)};updateEditActions();try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{}}renderProperties();redraw();return}
if(tool==="magicwand"){createRoofFromMagicWand(q);if(spaceMagicWandActive){const returnTool=spaceMagicWandReturnTool||"select";spaceMagicWandActive=false;spaceMagicWandReturnTool=null;spaceHeld=false;setTool(returnTool);updateZoomReadout()}return}if(tool==="column"){hist();els().push(createColumn(q,{storyId:story().id}));redraw();return}
if(tool==="door"||tool==="window"){if(pendingOpeningPlacement){commitPendingOpening();selected.clear();renderProperties();redraw();return}beginOpeningPlacement(q);return}
if(tool==="slab"||tool==="roof"||tool==="zone"){if(draft.length)q=constrain(draft[draft.length-1],q,e);draft.push(q);$("status").textContent=(tool==="zone"?"Zone":tool==="roof"?"Roof":"Slab")+" boundary point "+draft.length+" set · click next point, then press Enter to finish";redraw();return}
if(["wall","beam","dimension","gridline"].includes(tool)){if(tool==="dimension"){draft.push({x:q.x,y:q.y});floorDrawGesture=null;$("status").textContent="Dimension point "+draft.length+" set · click more points, then press Enter";redraw();return}if(draft.length){const a=draft[0],length=Math.hypot(q.x-a.x,q.y-a.y);if(length<.01){$("status").textContent="Line too short — choose a farther endpoint";return}if(length>30){$("status").textContent="Drawing cancelled: segment exceeds 30 m";draft=[];redraw();return}hist();if(tool==="wall")els().push(createWall(a,q,{storyId:story().id,height:+$("height").value||3,thickness:+$("thickness").value||.15}));else if(tool==="beam")els().push(createBeam(a,q,{storyId:story().id}));else if(tool==="gridline"){const n=els().filter(v=>v.type==="gridline").length;els().push({id:crypto.randomUUID(),type:"gridline",start:a,end:q,label:String.fromCharCode(65+(n%26)),storyId:story().id})}else els().push({id:crypto.randomUUID(),type:"dimension",start:a,end:q,storyId:story().id});draft=[];floorDrawGesture=null;$("status").textContent=tool.charAt(0).toUpperCase()+tool.slice(1)+" created";renderProperties();redraw();return}floorDrawGesture={pointerId:e.pointerId,tool,startScreen:{x:e.clientX,y:e.clientY},anchor:q,isStart:true,pointerWorld:{x:q.x,y:q.y}};try{if(e.isTrusted&&c.setPointerCapture)c.setPointerCapture(e.pointerId)}catch{};draft=[q];$("status").textContent=(tool==="wall"?"Wall":tool==="beam"?"Beam":"Dimension")+" start point set — click endpoint or drag";redraw();return}});

c.addEventListener("pointerup",e=>{if(roomLabelMoveGesture&&roomLabelMoveGesture.pointerId===e.pointerId){const g=roomLabelMoveGesture;roomLabelMoveGesture=null;if(g.didMove){scheduleAutoSave();renderProperties();$("status").textContent="Room name and area repositioned together";updateEditActions()}redraw();return}});
c.addEventListener("pointerup",e=>{if(genericNodeMoveGesture&&genericNodeMoveGesture.pointerId===e.pointerId){
 const g=genericNodeMoveGesture,touch=e.pointerType==="touch";
 if(g.didMove){scheduleAutoSave();renderProperties();$("status").textContent="Connected node edit committed"}
 if(touch&&g.didMove){releasedTouchEditPending=true;releasedTouchEditSnapshot=JSON.stringify(p);releasedTouchEditKind="generic-node"}
 else{genericNodeMoveGesture=null;releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null}
 updateEditActions();redraw();return
}
if(genericEdgeMoveGesture&&genericEdgeMoveGesture.pointerId===e.pointerId){
 const g=genericEdgeMoveGesture,touch=e.pointerType==="touch";
 if(g.didMove){scheduleAutoSave();renderProperties();$("status").textContent="Connected edge edit committed"}
 if(touch&&g.didMove){releasedTouchEditPending=true;releasedTouchEditSnapshot=JSON.stringify(p);releasedTouchEditKind="generic-edge"}
 else{genericEdgeMoveGesture=null;releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null}
 updateEditActions();redraw();return
}if(selectionBoxGesture&&selectionBoxGesture.pointerId===e.pointerId){const g=selectionBoxGesture;selectionBoxGesture=null;if(g.didDrag&&view==="floor"){lastMarqueeRect={left:Math.min(g.startScreen.x,g.currentScreen.x),top:Math.min(g.startScreen.y,g.currentScreen.y),right:Math.max(g.startScreen.x,g.currentScreen.x),bottom:Math.max(g.startScreen.y,g.currentScreen.y)};lastMarqueePolygon=[{x:g.startWorld.x,y:g.startWorld.y},{x:wpos(g.currentScreen).x,y:g.startWorld.y},{x:wpos(g.currentScreen).x,y:wpos(g.currentScreen).y},{x:g.startWorld.x,y:wpos(g.currentScreen).y}];$("status").textContent="Marquee area defined · choose an element tool and press Ctrl/Cmd+A to select within area";redraw()}return}if(e.isTrusted&&e.pointerType!=="touch"){const active=activeEditGesture();if(active&&active!==genericMoveGesture&&active!==openingMoveGesture&&active!==gridlineMoveGesture&&active.pointerId===e.pointerId){if(active.didMove){scheduleAutoSave();$("status").textContent="Element edit committed"}releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null;finishElementEditGesture("commit");clearSelection();renderProperties();updateEditActions();redraw();return}}if(genericMoveGesture&&genericMoveGesture.pointerId===e.pointerId){const g=genericMoveGesture;genericMoveGesture=null;if(g.didMove){scheduleAutoSave();$("status").textContent="Moved "+g.elementIds.length+" element"+(g.elementIds.length===1?"":"s");renderProperties();redraw()}releasedTouchEditPending=e.pointerType==="touch"||g.didMove;if(!releasedTouchEditPending)releasedTouchEditSnapshot=null;releasedTouchEditKind="generic";if(e.pointerType!=="touch"&&g.didMove){releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null;renderProperties();$("status").textContent="Element moved · selection retained"}updateEditActions();return}if(gridlineMoveGesture&&gridlineMoveGesture.pointerId===e.pointerId){const g=gridlineMoveGesture;gridlineMoveGesture=null;const gridline=els().find(el=>el.id===g.elementId&&el.type==="gridline");if(gridline){selectOnly(gridline.id);renderProperties()}if(g.didMove){scheduleAutoSave();$("status").textContent="Gridline moved";redraw()}else if(gridline){$("status").textContent="Gridline selected"}releasedTouchEditPending=e.pointerType==="touch"||g.didMove;if(!releasedTouchEditPending)releasedTouchEditSnapshot=null;releasedTouchEditKind="gridline";updateEditActions();return}if(e.pointerType==="touch"&&threeTouchPointers.has(e.pointerId)){threeTouchPointers.delete(e.pointerId);threeTouchGesture=null;pending3dPointer=null;orbiting=false;lastCameraPointer=null;return}if(e.pointerType==="touch"&&floorTouchPointers.has(e.pointerId)){const wasGesture=!!floorTouchGesture;floorTouchPointers.delete(e.pointerId);if(wasGesture){if(floorTouchPointers.size>=2){const pts=[...floorTouchPointers.values()],rect=c.getBoundingClientRect(),mid={x:(pts[0].x+pts[1].x)/2-rect.left,y:(pts[0].y+pts[1].y)/2-rect.top},world=wpos(mid),distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));floorTouchGesture={distance,scale,world,mid,origin:{...origin}}}else{floorTouchGesture=null;floorTouchPointers.clear()}return}}if(view==="floor"&&openingMoveGesture&&openingMoveGesture.pointerId===e.pointerId){const gesture=openingMoveGesture;openingMoveGesture=null;if(gesture.didMove){const element=els().find(v=>v.id===gesture.elementId);if(element){const wall=els().find(v=>v.id===gesture.hostWallId&&v.type==="wall"),opening=wall?.openings?.find(o=>o.id===element.id);if(opening)opening.offset=element.offset;scheduleAutoSave();$("status").textContent=(element.type==="door"?"Door":"Window")+" moved · "+Number(element.offset).toFixed(2)+" m along wall";renderProperties();redraw()}}releasedTouchEditPending=e.pointerType==="touch"||gesture.didMove;if(!releasedTouchEditPending)releasedTouchEditSnapshot=null;releasedTouchEditKind="opening";updateEditActions();return}if(view==="floor"&&floorDrawGesture&&floorDrawGesture.pointerId===e.pointerId){const gesture=floorDrawGesture;floorDrawGesture=null;const moved=Math.hypot(e.clientX-gesture.startScreen.x,e.clientY-gesture.startScreen.y);if(gesture.tool===tool&&["wall","beam","dimension","gridline"].includes(gesture.tool)&&moved>4){const rect=c.getBoundingClientRect(),g=Math.max(.1,+$("grid").value||.5);let endPoint=wpos({x:e.clientX-rect.left,y:e.clientY-rect.top});endPoint={x:Math.round(endPoint.x/g)*g,y:Math.round(endPoint.y/g)*g};endPoint=snapPoint(endPoint,(e.shiftKey||shiftHeld)?0:undefined);const a=gesture.anchor,end=constrain(a,endPoint,e),length=Math.hypot(end.x-a.x,end.y-a.y);if(length<.01){$("status").textContent="Line too short — choose a farther endpoint";draft=[]}else if(length>30){$("status").textContent="Drawing cancelled: segment exceeds 30 m";draft=[]}else{hist();if(gesture.tool==="wall")els().push(createWall(a,end,{storyId:story().id,height:+$("height").value||3,thickness:+$("thickness").value||.15}));else if(gesture.tool==="beam")els().push(createBeam(a,end,{storyId:story().id}));else if(gesture.tool==="gridline"){const n=els().filter(v=>v.type==="gridline").length;els().push({id:crypto.randomUUID(),type:"gridline",start:a,end,label:String.fromCharCode(65+(n%26)),storyId:story().id})}else els().push({id:crypto.randomUUID(),type:"dimension",start:a,end,storyId:story().id});draft=[];$("status").textContent=gesture.tool.charAt(0).toUpperCase()+gesture.tool.slice(1)+" created";renderProperties()}redraw()}}if(view==="3d"&&pending3dPointer&&!orbiting){const rect=c.getBoundingClientRect(),px=e.clientX-rect.left,py=e.clientY-rect.top;let hit=null;for(let i=hitPolys3d.length-1;i>=0;i--){const item=hitPolys3d[i],poly=item.poly;let inside=false;for(let j=0,k=poly.length-1;j<poly.length;k=j++){const A=poly[j],B=poly[k];if(((A.y>py)!==(B.y>py))&&(px<(B.x-A.x)*(py-A.y)/(B.y-A.y)+A.x))inside=!inside}if(inside){hit=item.id;break}}if(e.shiftKey&&hit){selected.has(hit)?selected.delete(hit):selected.add(hit)}else selectOnly(hit);renderProperties();redraw();$("status").textContent=hit?"3D element selected":"No element at clicked position"}pending3dPointer=null;if(isPanning){isPanning=false;panStart=null}orbiting=false;lastCameraPointer=null;c.style.cursor=""});c.addEventListener("pointercancel",e=>{
 const gesture=activeEditGesture();
 if(gesture&&gesture.pointerId===e.pointerId){
  const touch=e.pointerType==="touch";
  const didMove=!!gesture.didMove;
  if(touch){
   releasedTouchEditPending=true;
   releasedTouchEditSnapshot=JSON.stringify(els());
   releasedTouchEditKind=gesture===genericMoveGesture?"generic":gesture===gridlineMoveGesture?"gridline":gesture===genericNodeMoveGesture?"generic-node":gesture===genericEdgeMoveGesture?"generic-edge":"opening";
   const pointerEnd=new PointerEvent("pointerup",{pointerId:e.pointerId,pointerType:"touch",clientX:e.clientX,clientY:e.clientY,button:0,buttons:0,bubbles:true});
   c.dispatchEvent(pointerEnd);
   if(didMove){scheduleAutoSave();renderProperties()}
  }else finishElementEditGesture("cancel");
 }
 threeTouchPointers.delete(e.pointerId);threeTouchGesture=null;pending3dPointer=null;orbiting=false;lastCameraPointer=null;floorTouchPointers.delete(e.pointerId);floorTouchGesture=null;floorTouchPointers.clear();
 if(!releasedTouchEditPending){floorDrawGesture=null;isPanning=false;panStart=null}
 orbiting=false;lastCameraPointer=null;pending3dPointer=null;c.style.cursor="";redraw();updateEditActions()
});
// Safari can deliver the release outside the canvas when pointer capture is interrupted.
window.addEventListener("pointerup",e=>{if(view!=="floor"||!floorDrawGesture||floorDrawGesture.pointerId!==e.pointerId||e.target===c)return;c.dispatchEvent(new PointerEvent("pointerup",{pointerId:e.pointerId,clientX:e.clientX,clientY:e.clientY,button:e.button,buttons:e.buttons,shiftKey:e.shiftKey,bubbles:true}))});
function finish(){if(tool==="slab"&&draft.length>=3){try{hist();els().push(createSlab(draft,{storyId:story().id}));$("status").textContent="Slab created"}catch(err){$("status").textContent=err.message}}draft=[];redraw()}
c.addEventListener("dblclick",e=>{if(tool==="wall"&&wallGeometryMethod==="continuous"){e.preventDefault();draft=[];floorDrawGesture=null;wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;redraw();$("status").textContent="Continuous wall drawing finished";return}finish()});
const unitSettingsButton=document.createElement("button");unitSettingsButton.id="unitSettingsButton";unitSettingsButton.type="button";unitSettingsButton.style.cssText="margin-left:6px;white-space:nowrap";unitSettingsButton.title="Set project measurement units";unitSettingsButton.onclick=()=>{const choice=prompt("Project Units\\nEnter Metric or Imperial (feet + whole inches):",unitSystem()==="imperial"?"Imperial":"Metric");if(choice===null)return;const value=choice.trim().toLowerCase();if(["metric","m","mm"].includes(value))applyUnitSystem("metric");else if(["imperial","ft","feet"].includes(value))applyUnitSystem("imperial");else $("status").textContent="Choose Metric or Imperial"};document.querySelector(".top")?.appendChild(unitSettingsButton);updateUnitButton();const settingsPopup=document.createElement("div");settingsPopup.id="arqContextMenu";settingsPopup.style.cssText="position:fixed;z-index:99999;display:none;min-width:190px;padding:5px;background:var(--panel,#fff);border:1px solid var(--border,#cbd5dc);border-radius:7px;box-shadow:0 8px 28px #0003;color:var(--text,#27323a);font:13px Arial,sans-serif";settingsPopup.innerHTML='<button type="button" data-context-action="settings" style="display:block;width:100%;padding:9px 12px;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:4px">Element Settings <span style="float:right;opacity:.65">↗</span></button>';document.body.appendChild(settingsPopup);
const elementSettingsModal=document.createElement("div");elementSettingsModal.id="arqElementSettingsModal";elementSettingsModal.style.cssText="position:fixed;inset:0;z-index:99998;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(22,29,35,.38)";elementSettingsModal.innerHTML='<section role="dialog" aria-modal="true" aria-labelledby="arqElementSettingsTitle" style="display:flex;flex-direction:column;width:min(520px,calc(100vw - 28px));height:min(900px,90dvh);max-height:90dvh;background:#f3f5f7;color:#202a35;border:1px solid #aab5c0;border-radius:10px;box-shadow:0 24px 80px #10182045;overflow:hidden"><header style="display:flex;align-items:center;gap:12px;padding:15px 18px;background:linear-gradient(180deg,#ffffff,#e8eef2);border-bottom:1px solid #d4dde3;color:#263844"><strong id="arqElementSettingsTitle" style="flex:1;font-size:15px;letter-spacing:.01em">Element Settings</strong><span id="arqElementSettingsType" style="font-size:11px;color:#c4d3dc"></span><button type="button" data-settings-close aria-label="Close Element Settings" style="padding:6px 10px;border-radius:6px;background:#fff;border:1px solid #c4cfd7;color:#263844">✕</button></header><div data-settings-body style="display:block;flex:1 1 auto;min-height:0;padding:16px 18px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;background:#edf1f4"></div><footer style="display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #d2dae1;background:#f7f9fa"><button type="button" data-settings-close>Close</button></footer></section>';document.body.appendChild(elementSettingsModal);
const settingsDialog=elementSettingsModal.querySelector('[role="dialog"]');
const settingsHeader=elementSettingsModal.querySelector("header");
settingsDialog.style.position="absolute";
settingsDialog.style.left="50%";
settingsDialog.style.top="50%";
settingsDialog.style.transform="translate(-50%,-50%)";
settingsHeader.style.cursor="move";
settingsHeader.style.touchAction="none";
settingsHeader.title="Drag to move Element Settings";
let settingsDrag=null;
settingsHeader.addEventListener("pointerdown",event=>{
 if(event.target.closest("button"))return;
 if(event.button!==undefined&&event.button!==0)return;
 const rect=settingsDialog.getBoundingClientRect();
 settingsDrag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:rect.left,top:rect.top};
 settingsDialog.style.left=rect.left+"px";
 settingsDialog.style.top=rect.top+"px";
 settingsDialog.style.transform="none";
 try{settingsHeader.setPointerCapture(event.pointerId)}catch(_){}
 event.preventDefault();
});
settingsHeader.addEventListener("pointermove",event=>{
 if(!settingsDrag||settingsDrag.pointerId!==event.pointerId)return;
 const margin=8,rect=settingsDialog.getBoundingClientRect();
 const left=Math.max(margin,Math.min(window.innerWidth-rect.width-margin,settingsDrag.left+event.clientX-settingsDrag.startX));
 const top=Math.max(margin,Math.min(window.innerHeight-rect.height-margin,settingsDrag.top+event.clientY-settingsDrag.startY));
 settingsDialog.style.left=left+"px";settingsDialog.style.top=top+"px";
});
const stopSettingsDrag=event=>{if(settingsDrag&&(!event||event.pointerId===settingsDrag.pointerId))settingsDrag=null};
settingsHeader.addEventListener("pointerup",stopSettingsDrag);
settingsHeader.addEventListener("pointercancel",stopSettingsDrag);
window.addEventListener("resize",()=>{if(elementSettingsModal.style.display!=="flex")return;const rect=settingsDialog.getBoundingClientRect(),margin=8;settingsDialog.style.left=Math.max(margin,Math.min(window.innerWidth-rect.width-margin,rect.left))+"px";settingsDialog.style.top=Math.max(margin,Math.min(window.innerHeight-rect.height-margin,rect.top))+"px";settingsDialog.style.transform="none"});
const settingsBody=elementSettingsModal.querySelector("[data-settings-body]");
const settingsStyle=document.createElement("style");
settingsStyle.textContent=`
#arqElementSettingsModal [role="dialog"]{width:520px!important;max-width:calc(100vw - 28px)!important;height:min(900px,90dvh)!important;max-height:90dvh!important}
#arqElementSettingsModal [data-settings-body]{padding:16px!important;background:#edf1f4;overscroll-behavior:contain}
#arqElementSettingsModal #elementProperties{display:block!important;width:100%!important;min-width:0!important;box-sizing:border-box!important}
#arqElementSettingsModal #elementProperties .field{display:flex;flex-direction:column;gap:4px;margin:0;padding:11px 10px;border-bottom:1px solid #e5eaee;min-width:0}
#arqElementSettingsModal #elementProperties .field label{display:block;margin:0;color:#5d6974;font-size:10px;font-weight:750;letter-spacing:.045em;text-transform:uppercase;line-height:1.4}
#arqElementSettingsModal #elementProperties .field input,#arqElementSettingsModal #elementProperties .field select{display:block;box-sizing:border-box;width:100%;min-width:0;min-height:35px;padding:7px 10px;border:1px solid #c4cfd7;border-radius:6px;background:#fbfcfd;color:#26313b;font:12px Inter,Arial,sans-serif;box-shadow:inset 0 1px 2px #172b3a08}
#arqElementSettingsModal #elementProperties .field input:focus,#arqElementSettingsModal #elementProperties .field select:focus{outline:2px solid #b9e1e4;border-color:#078895;box-shadow:0 0 0 3px #07889512}
#arqElementSettingsModal .arq-setting-panel{margin:0 0 12px;border:1px solid #d3dce3;border-radius:8px;background:#fff;overflow:hidden;box-shadow:0 2px 7px #2637460a}
#arqElementSettingsModal .arq-setting-panel>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:13px 15px;background:linear-gradient(180deg,#f8fafb,#e8eef2);color:#344553;font-size:11px;font-weight:750;letter-spacing:.07em;text-transform:uppercase;border-bottom:1px solid #dce4e9}
#arqElementSettingsModal .arq-setting-panel>summary::-webkit-details-marker{display:none}
#arqElementSettingsModal .arq-setting-panel>summary:before{content:"▸";color:#078895;font-size:14px}
#arqElementSettingsModal .arq-setting-panel[open]>summary:before{content:"▾"}
#arqElementSettingsModal .arq-setting-panel-content{padding:5px 10px 10px}
#arqElementSettingsModal #elementProperties>p{margin:8px 2px;color:#66727c;font-size:11px;line-height:1.45}
#arqElementSettingsModal #elementProperties>button{margin:8px 0;padding:8px 11px;border:1px solid #b9c4cc;border-radius:4px;background:#edf2f4;color:#26313b;font-weight:600;cursor:pointer}
@media(max-width:520px){#arqElementSettingsModal{padding:8px!important}#arqElementSettingsModal [role="dialog"]{max-width:calc(100vw - 16px)!important;height:92dvh!important;max-height:92dvh!important}}
`;
document.head.appendChild(settingsStyle);
let settingsHostPlaceholder=null,settingsHostParent=null,settingsHostNext=null;
function organizeElementSettings(){
 const host=$("elementProperties");if(!host||elementSettingsModal.style.display!=="flex")return;
 if(host.querySelector(".arq-setting-panel"))return;
 const children=[...host.children];if(!children.length)return;
 const groups=[
  {title:"Identification",match:l=>/element type|zone number|room name|grid axis label/i.test(l)},
  {title:"Classification & Properties",match:l=>/classification|building material|category/i.test(l)},
  {title:"Geometry & Positioning",match:l=>/height|thickness|width|depth|elevation|offset|pitch|sill|rotation|position|start point|end point|\b[xy]\b|vertical grid intervals|horizontal grid intervals/i.test(l)},
  {title:"Display & Annotation",match:l=>/text size|hinge|opening direction|position on host wall/i.test(l)},
  {title:"Additional Settings",match:()=>true}
 ];
 const panels=groups.map((g,i)=>{const d=document.createElement("details");d.className="arq-setting-panel";d.open=i<3;const summary=document.createElement("summary");summary.textContent=g.title;const body=document.createElement("div");body.className="arq-setting-panel-content";d.append(summary,body);return{...g,node:d,body}});
 for(const child of children){
  const label=(child.querySelector("label")?.textContent||child.textContent||"").trim();
  const group=panels.find(g=>g.match(label))||panels[panels.length-1];
  group.body.appendChild(child);
 }
 host.replaceChildren(...panels.filter(g=>g.body.childNodes.length).map(g=>g.node));
}
function closeElementSettings(){elementSettingsModal.style.display="none";if(settingsHostPlaceholder?.parentNode){settingsHostPlaceholder.parentNode.insertBefore($("elementProperties"),settingsHostPlaceholder);settingsHostPlaceholder.remove()}else if(settingsHostParent){settingsHostParent.insertBefore($("elementProperties"),settingsHostNext&&settingsHostNext.parentNode===settingsHostParent?settingsHostNext:null)}settingsHostPlaceholder=null;settingsHostParent=null;settingsHostNext=null;renderProperties()}
function openElementSettings(){const list=chosen();if(!list.length){$("status").textContent="Select an element first";return false}settingsPopup.style.display="none";const host=$("elementProperties");if(!host)return false;settingsHostParent=host.parentNode;settingsHostNext=host.nextSibling;settingsHostPlaceholder=document.createComment("elementProperties original position");settingsHostParent.insertBefore(settingsHostPlaceholder,host);settingsBody.appendChild(host);host.style.width="100%";host.style.minWidth="0";host.style.boxSizing="border-box";renderProperties();elementSettingsModal.style.display="flex";organizeElementSettings();elementSettingsModal.querySelector("#arqElementSettingsType").textContent=list.length===1?(list[0].type.charAt(0).toUpperCase()+list[0].type.slice(1)):list.length+" elements selected";elementSettingsModal.style.display="flex";organizeElementSettings();$("status").textContent=list.length===1?"Element Settings":"Settings · "+list.length+" selected elements";return true}
settingsPopup.querySelector('[data-context-action="settings"]').addEventListener("click",openElementSettings);
elementSettingsModal.querySelectorAll("[data-settings-close]").forEach(button=>button.addEventListener("click",closeElementSettings));elementSettingsModal.addEventListener("pointerdown",e=>{if(e.target===elementSettingsModal)closeElementSettings()});
document.addEventListener("pointerdown",e=>{if(!settingsPopup.contains(e.target))settingsPopup.style.display="none"},true);
document.addEventListener("keydown",e=>{if(e.key==="Escape"){settingsPopup.style.display="none";if(elementSettingsModal.style.display==="flex")closeElementSettings()}},true);
c.addEventListener("contextmenu",e=>{e.preventDefault();if(draft.length){finish();return}const list=chosen();if(!list.length){settingsPopup.style.display="none";$("status").textContent="Select an element first, then right-click to open its settings";return}/* Context settings belong to the current selection. Do not hit-test again here: overlapping elements (for example a gridline over a wall) must not replace the element selected by the preceding left-click. */settingsPopup.style.left=Math.max(6,Math.min(window.innerWidth-220,e.clientX))+"px";settingsPopup.style.top=Math.max(6,Math.min(window.innerHeight-60,e.clientY))+"px";settingsPopup.style.display="block"});
function zoomAt(clientX,clientY,factor){
 const rect=c.getBoundingClientRect(),mx=clientX-rect.left,my=clientY-rect.top;
 if(view==="3d"){const next=Math.max(.2,Math.min(5,camera3d.zoom*factor));if(next!==camera3d.zoom){const anchor=screenToWorld3d({x:mx,y:my},camera3d.targetZ),cyaw=Math.cos(camera3d.yaw),syaw=Math.sin(camera3d.yaw),rx=anchor.x*cyaw-anchor.y*syaw,ry=anchor.x*syaw+anchor.y*cyaw,screenX=mx-c.clientWidth/2-origin.x,screenY=my-c.clientHeight*.58-origin.y,sp=Math.sin(camera3d.pitch),safeSp=Math.max(.12,Math.abs(sp))*(sp<0?-1:1);camera3d.zoom=next;const f=scale*.72*next;camera3d.panX=rx-screenX/f;camera3d.panY=ry-screenY/(f*safeSp)}}
 else{const nextZoom=Math.max(.05,Math.min(5,viewportZoom*factor)),next=baseScaleForDrawing()*nextZoom,actual=next/scale,cx=mx-c.clientWidth/2,cy=my-c.clientHeight/2;origin.x=cx-(cx-origin.x)*actual;origin.y=cy-(cy-origin.y)*actual;viewportZoom=nextZoom;applyViewportZoom()}
 redraw();updateZoomReadout?.();
}
function panBy(dx,dy){
 if(view==="3d"){const f=scale*.72*camera3d.zoom,sp=Math.sin(camera3d.pitch),cp=Math.cos(camera3d.pitch),safeSp=Math.max(.12,Math.abs(sp))*(sp<0?-1:1);camera3d.panX-=dx/f;camera3d.panY-=dy*safeSp/f;camera3d.targetZ+=dy*cp/f}
 else{origin.x+=dx;origin.y+=dy}
 redraw();
}
// macOS trackpad: two-finger pan emits deltaX/deltaY; pinch emits ctrlKey+wheel in Safari/Chromium.
c.addEventListener("wheel",e=>{
 e.preventDefault();
 // Mac trackpad pinch is commonly reported as Ctrl/Meta+wheel. Shift+wheel/trackpad orbits in 3D.
 if(view==="floor"&&draft.length){$("status").textContent="Finish the current element or press Esc before panning/zooming";return}
 // Give Shift-orbit priority over browser-modified trackpad events.
 if(view==="3d"&&(e.shiftKey||shiftHeld)){
  orbitCameraBy(((Math.abs(e.deltaX)>0?e.deltaX:0)+e.deltaY*.25)*.0045,e.deltaY*.004);
  redraw();return;
 }
 if(e.ctrlKey||e.metaKey){zoomAt(e.clientX,e.clientY,Math.exp(-e.deltaY*.012));return}
 // Do not use deltaMode===0 as a trackpad test: normal mouse wheels also report pixel deltas.
 const trackpadLike=Math.abs(e.deltaX)>0||Math.abs(e.deltaY)<45;
 if(trackpadLike){panBy(-e.deltaX,-e.deltaY);return}
 zoomAt(e.clientX,e.clientY,e.deltaY<0?1.1:.9);
},{passive:false});
// Trackpad: two-finger pan, pinch to zoom, and Shift + two-finger scroll or mouse wheel to orbit in 3D.
document.querySelectorAll("[data-tool]").forEach(b=>b.onclick=()=>setTool(b.dataset.tool));$("moveSelection").onclick=()=>transformSelected("move");$("rotateSelection").onclick=()=>transformSelected("rotate");$("mirrorSelection").onclick=()=>transformSelected("mirror");$("copySelection").onclick=()=>transformSelected("copy");
const roomButton=document.createElement("button");roomButton.className="tree";roomButton.textContent="▦ Detect Zones / Areas";roomButton.onclick=()=>{const rooms=detectClosedRooms(els().filter(e=>e.type==="wall"&&e.storyId===story().id));hist();$("status").textContent=rooms.length?rooms.length+" room(s) · "+formatArea(rooms.reduce((sum,r)=>sum+r.area,0),unitSystem())+" detected":"No closed rooms found (walls must connect at endpoints)";const oldRooms=els().filter(e=>e.type==="room"&&e.storyId===story().id);p.elements=els().filter(e=>e.type!=="room"||e.storyId!==story().id);p.elements.push(...rooms.map((r,index)=>{const prior=oldRooms.find(v=>v.id===r.id)||oldRooms[index];return {...r,roomName:prior?.roomName||prior?.name||"",name:prior?.roomName||prior?.name||"",zoneNumber:prior?.zoneNumber||("Z-"+String(index+1).padStart(2,"0")),zoneCategory:prior?.zoneCategory||"",buildingMaterial:prior?.buildingMaterial||"",labelPosition:prior?.labelPosition?{...prior.labelPosition}:undefined,storyId:story().id,layer:"A-ROOM"}}));selected.clear();redraw();renderProperties()};document.querySelector(".navigator").appendChild(roomButton);const zoneScheduleButton=document.createElement("button");zoneScheduleButton.className="tree";zoneScheduleButton.textContent="▤ Zone Schedule / Export CSV";zoneScheduleButton.title="Export zone number, room name, category, story, area, perimeter and material";zoneScheduleButton.onclick=()=>{try{const rooms=els().filter(e=>e.type==="room").sort((a,b)=>{const sa=p.stories.findIndex(v=>v.id===a.storyId),sb=p.stories.findIndex(v=>v.id===b.storyId);return sa-sb||String(a.zoneNumber||"").localeCompare(String(b.zoneNumber||""))});const quote=v=>{const value=String(v??"");return /[",\n\r]/.test(value)?'"'+value.replace(/"/g,'""')+'"':value};const rows=[["Zone Number","Room Name","Category","Story","Area (m²)","Perimeter (m)","Building Material"],...rooms.map(e=>[e.zoneNumber||"",e.roomName||e.name||"",e.zoneCategory||"",p.stories.find(v=>v.id===e.storyId)?.name||"Unassigned",Number((Number(e.area)||polygonArea(e.boundary)).toFixed(2)),Number((Number(e.perimeter)||e.boundary.reduce((sum,pt,i)=>{const next=e.boundary[(i+1)%e.boundary.length];return sum+Math.hypot(next.x-pt.x,next.y-pt.y)},0)).toFixed(2)),e.buildingMaterial||""])];const csv="\ufeff"+rows.map(row=>row.map(quote).join(",")).join("\r\n");const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const link=document.createElement("a");link.href=url;link.download=((p.project.name||"arqenvo")+"-zone-schedule.csv").replace(/[^a-z0-9._-]+/gi,"-");link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$("status").textContent="Zone schedule exported · "+rooms.length+" zone(s)"}catch(error){$("status").textContent="Zone schedule export failed: "+error.message}};document.querySelector(".navigator").appendChild(zoneScheduleButton);
function refreshStories(){const select=$("storySelect");if(!select)return;select.innerHTML="";for(const s of p.stories){const option=document.createElement("option");option.value=s.id;option.textContent=s.name;select.appendChild(option)}if(!p.stories.some(s=>s.id===activeStoryId))activeStoryId=p.stories[0]?.id;select.value=activeStoryId;const active=story();$("viewLabel").textContent=view==="floor"?active.name+" · 1:"+drawingScaleDenominator:"3D Window · conceptual preview";updateContextUI()}
function setView(v){layoutMode=false;$("layoutControls")?.classList.remove("active");$("layoutInspector")?.classList.remove("active");$("elementProperties")?.style.removeProperty("display");if(v!=="floor"&&v!=="3d"){ $("status").textContent="This view type is not implemented yet";return}if(provisionalDrawingActive){cancelProvisionalDrawing();$("status").textContent="Uncommitted drawing cancelled when changing view"}view=v;draft=[];refreshStories();$("viewLabel").textContent=v==="floor"?story().name+" · 1:"+drawingScaleDenominator:"3D Window · orbit / pan / zoom";$("floorTab").classList.toggle("active",v==="floor");$("threeTab").classList.toggle("active",v==="3d");$("cameraControls").style.display=v==="3d"?"inline-flex":"none";$("hint").textContent=v==="3d"?"Touch: drag to orbit · tap to select · Desktop: middle-drag to orbit · Shift + middle-drag to pan · scroll to zoom · space-drag to pan":"Select a tool · click start/end or drag to draw · Esc to finish · Shift constrains axis";redraw();updateZoomReadout()}
function fit3d(){const items=[];for(const e of els()){if(!isLayerVisible(e))continue;const z0=p.stories.find(v=>v.id===e.storyId)?.elevation??0;if(e.type==="wall"){items.push({p:e.start,z:z0},{p:e.end,z:z0},{p:e.start,z:z0+(e.height||3)},{p:e.end,z:z0+(e.height||3)})}else if(e.type==="beam"){items.push({p:e.start,z:z0},{p:e.end,z:z0},{p:e.start,z:z0+(e.height||.2)},{p:e.end,z:z0+(e.height||.2)})}else if(e.type==="column"){items.push({p:e.position,z:z0},{p:e.position,z:z0+(e.height||3)})}else if(e.type==="slab"||e.type==="room"){for(const p0 of(e.boundary||[])){items.push({p:p0,z:z0},{p:p0,z:z0+(e.thickness||.15)})}}}if(!items.length){camera3d={yaw:-Math.PI/4,pitch:Math.PI/5,zoom:1,panX:0,panY:0,targetZ:1.5};redraw();return}const cy=Math.cos(camera3d.yaw),sy=Math.sin(camera3d.yaw),sp=Math.sin(camera3d.pitch),cp=Math.cos(camera3d.pitch);const projected=items.map(v=>({rx:v.p.x*cy-v.p.y*sy,ry:v.p.x*sy+v.p.y*cy,vertical:(v.p.x*sy+v.p.y*cy)*sp-v.z*cp}));const minX=Math.min(...projected.map(v=>v.rx)),maxX=Math.max(...projected.map(v=>v.rx)),minY=Math.min(...projected.map(v=>v.vertical)),maxY=Math.max(...projected.map(v=>v.vertical)),minR=Math.min(...projected.map(v=>v.ry)),maxR=Math.max(...projected.map(v=>v.ry));camera3d.panX=(minX+maxX)/2;camera3d.panY=(minR+maxR)/2;camera3d.targetZ=(Math.min(...items.map(v=>v.z))+Math.max(...items.map(v=>v.z)))/2;const spanX=Math.max(maxX-minX,.5),spanY=Math.max(maxY-minY,.5),factor=Math.min((c.clientWidth-100)/(spanX*scale*.72),(c.clientHeight-100)/(spanY*scale*.72));camera3d.zoom=Math.max(.1,Math.min(3,factor));origin.x=0;origin.y=0;redraw();updateZoomReadout?.()}
$("orbitLeft").onclick=()=>{orbitCameraBy(-Math.PI/12,0);redraw()};
$("orbitRight").onclick=()=>{orbitCameraBy(Math.PI/12,0);redraw()};
$("viewTop").onclick=()=>{orbitCameraBy(-camera3d.yaw,1.35-camera3d.pitch);redraw()};
$("viewFront").onclick=()=>{orbitCameraBy(-camera3d.yaw,.05-camera3d.pitch);redraw()};
$("viewHome").onclick=()=>{camera3d={yaw:-Math.PI/4,pitch:Math.PI/5,zoom:1,panX:0,panY:0,targetZ:1.5};redraw()};
$("fitModel").onclick=fit3d;
$("floorTab").onclick=()=>setView("floor");$("threeTab").onclick=()=>setView("3d");
$("storySelect").onchange=()=>{activeStoryId=$("storySelect").value;selected.clear();draft=[];refreshStories();redraw();renderProperties()};
$("addStory").onclick=()=>{const name=prompt("New story name (e.g. First Floor):");if(!name?.trim())return;const elevationRaw=prompt("Story elevation ("+(unitSystem()==="imperial"?"ft + whole in":"m")+ "):",unitSystem()==="imperial"?formatLength(Math.max(...p.stories.map(s=>s.elevation+s.height)),"imperial"):String(Math.max(...p.stories.map(s=>s.elevation+s.height))));if(elevationRaw===null)return;const elevation=unitSystem()==="imperial"?parseLength(elevationRaw,"imperial"):Number(elevationRaw);if(!Number.isFinite(elevation)){ $("status").textContent="Elevation must be a valid number";return}if(p.stories.some(s=>s.name.toLowerCase()===name.trim().toLowerCase())){$("status").textContent="Story name already exists";return}hist();p.stories.push({id:crypto.randomUUID(),name:name.trim(),elevation,height:3});p.views.push({id:"view-floor-"+p.stories[p.stories.length-1].id,name:name.trim(),type:"floor-plan",storyId:p.stories[p.stories.length-1].id,scale:100});activeStoryId=p.stories[p.stories.length-1].id;refreshStories();redraw();renderProperties();$("status").textContent="Story added"};document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>setView(b.dataset.view));
$("undo").onclick=()=>{const previous=modelHistory.undo(p);if(previous){p=previous;activeStoryId=p.stories.some(s=>s.id===activeStoryId)?activeStoryId:p.stories[0].id;selected.clear();refreshStories();redraw();renderProperties();scheduleAutoSave()}updateHistoryButtons()};
$("redo").onclick=()=>{const next=modelHistory.redo(p);if(next){p=next;activeStoryId=p.stories.some(s=>s.id===activeStoryId)?activeStoryId:p.stories[0].id;selected.clear();refreshStories();redraw();renderProperties();scheduleAutoSave()}updateHistoryButtons()};
$("delete").onclick=()=>{if(selected.size){hist();const ids=new Set(selected);p.elements=els().filter(e=>!ids.has(e.id)&&!(["door","window"].includes(e.type)&&ids.has(e.hostWallId)));for(const e of els())if(e.type==="wall")e.openings=(e.openings||[]).filter(o=>!ids.has(o.id));selected.clear();$("status").textContent="Selected elements deleted";redraw();renderProperties()}};
$("clear").onclick=()=>{if(confirm("Clear all elements?")){hist();p.elements=[];selected.clear();redraw();renderProperties()}};
$("new").onclick=()=>{if(confirm("Start new project?")){hist();p=createProject();activeStoryId=p.stories[0].id;activeLayoutId=null;activeLayoutDrawingId=null;layoutMode=false;$("layoutControls")?.classList.remove("active");$("layoutInspector")?.classList.remove("active");selected.clear();refreshStories();renderLayoutList();redraw();renderProperties()}};
$("save").onclick=()=>{try{const a=document.createElement("a"),u=URL.createObjectURL(new Blob([serializeProject(p)],{type:"application/json"}));a.href=u;a.download=(p.project.name||"arqenvo-project").replace(/[^a-z0-9-_]+/gi,"-")+".arq";a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);$("status").textContent="Project exported"}catch(err){$("status").textContent=err.message}};
$("open").onclick=()=>$("file").click();$("file").onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const next=deserializeProject(await f.text());hist();p=next;activeStoryId=p.stories[0].id;activeLayoutId=p.layouts?.[0]?.id||null;activeLayoutDrawingId=null;layoutMode=false;$("layoutControls")?.classList.remove("active");$("layoutInspector")?.classList.remove("active");selected.clear();refreshStories();renderLayoutList();redraw();renderProperties();scheduleAutoSave();$("status").textContent="Project opened: "+f.name}catch(err){alert(err.message)}finally{e.target.value=""}};
$("propsToggle").onclick=()=>{$("inspector").style.display=$("inspector").style.display==="block"?"none":"block"};
function commitAndDeselect(reason="Enter"){
 let committed=false;
 if(releasedTouchEditPending){
  releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null;
  scheduleAutoSave();$("status").textContent="Element edit committed";committed=true;
 }else if(activeEditGesture())committed=finishElementEditGesture("commit");
 else if(pendingOpeningPlacement)committed=commitPendingOpening();
 else if(view==="3d"&&(provisionalDrawingActive||draft.length>0)){
  const elementTool=provisionalDrawingTool||tool;
  draft=[];floorDrawGesture=null;wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;
  trackerDistanceOverride=null;trackerAngleOverride=null;commitProvisionalDrawing();scheduleAutoSave();
  $("status").textContent=elementTool.charAt(0).toUpperCase()+elementTool.slice(1)+" drawing committed";committed=true;
 }else committed=finishActiveDrawing(reason);
 if(!committed)return false;
 releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null;
 clearSelection();renderProperties();
 const info=$("selectionInfo");if(info)info.textContent="No selection";
 const count=$("contextSelectionCount");if(count)count.textContent="0 elements";
 redraw();updateEditActions();return true;
}
function finishMarqueePolygon(){if(marqueeDraftPoints.length<3){$("status").textContent="Polygonal Marquee needs at least 3 points";return false}lastMarqueePolygon=marqueeDraftPoints.map(p=>({x:p.x,y:p.y}));const pts=lastMarqueePolygon.map(spos),xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);lastMarqueeRect={left:Math.min(...xs),top:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys)};marqueeDraftPoints=[];marqueePreviewPoint=null;$("status").textContent="Polygonal Marquee defined · Ctrl/Cmd+A selects elements inside the polygon";redraw();return true}
function finishRotatedMarquee(){if(marqueeDraftPoints.length!==3)return false;const [a,b,q]=marqueeDraftPoints,dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);if(len<.01){marqueeDraftPoints=[];marqueePreviewPoint=null;$("status").textContent="Rotated Rectangle cancelled · side too short";redraw();return false}const px=-dy/len,py=dx/len,off=(q.x-b.x)*px+(q.y-b.y)*py,d={x:b.x+px*off,y:b.y+py*off},e={x:a.x+px*off,y:a.y+py*off};lastMarqueePolygon=[a,b,d,e].map(p=>({x:p.x,y:p.y}));const pts=lastMarqueePolygon.map(spos),xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);lastMarqueeRect={left:Math.min(...xs),top:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys)};marqueeDraftPoints=[];marqueePreviewPoint=null;$("status").textContent="Rotated Rectangle Marquee defined · Ctrl/Cmd+A selects elements inside the rotated rectangle";redraw();return true}
/* Keep Escape inside the CAD workspace instead of letting Safari handle it as a browser-level command. Cmd+Escape follows the same app action where the platform delivers it to the page. */
document.addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault()}},true);
window.addEventListener("keydown",e=>{
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="a"&&!/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName||"")&&!e.target?.isContentEditable){
  e.preventDefault();
  if(lastMarqueeRect&&view==="floor"){
   const type=tool==="select"||tool==="marquee"?"all":tool;
   const hits=els().filter(el=>el.storyId===story().id&&isLayerVisible(el)&&(type==="all"||el.type===type)&&(lastMarqueePolygon?elementIntersectsScreenPolygon(el,lastMarqueePolygon.map(spos)):elementIntersectsScreenRect(el,lastMarqueeRect)));
   selected=new Set(hits.flatMap(el=>groupMembers(el).map(v=>v.id)));
   renderProperties();redraw();updateEditActions();
   $("status").textContent=selected.size+" element"+(selected.size===1?"":"s")+" selected in marquee"+(type==="all"?"":" · "+type);
  }else if(tool==="select"){
   selected=new Set(els().filter(el=>el.storyId===story().id&&isLayerVisible(el)).flatMap(el=>groupMembers(el).map(v=>v.id)));
   renderProperties();redraw();updateEditActions();$("status").textContent=selected.size+" visible elements selected";
  }
  return;
 }
 if(e.key==="Enter"&&!/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName||"")&&!e.target?.isContentEditable&&tool==="marquee"&&marqueeDraftPoints.length){e.preventDefault();if(marqueeGeometryMethod==="polygonal")finishMarqueePolygon();else if(marqueeGeometryMethod==="rotated-rectangle"&&marqueeDraftPoints.length===3)finishRotatedMarquee();else $("status").textContent="Complete the marquee points before finishing";return}
 if(e.key==="Enter"&&!/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName||"")&&!e.target?.isContentEditable&&!pendingGridSystem&&tool==="dimension"&&view==="floor"&&draft.length>=2){e.preventDefault();finishDimensionChain();return}
 if(e.key==="Enter"&&!/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName||"")&&!e.target?.isContentEditable&&!pendingGridSystem&&(activeEditGesture()||releasedTouchEditPending||pendingOpeningPlacement||hasActiveDrawing()||provisionalDrawingActive||(view==="3d"&&draft.length>0))){
  e.preventDefault();commitAndDeselect("Enter");return;
 }
 if(pendingGridSystem&&e.key==="Escape"){pendingGridSystem=null;$("status").textContent="Grid System placement cancelled";redraw();e.preventDefault();return}
 if((activeEditGesture()||releasedTouchEditPending)&&view==="floor"&&e.key==="Escape"){e.preventDefault();finishElementEditGesture("cancel");return}
 if((genericNodeMoveGesture||genericEdgeMoveGesture||gridlineMoveGesture||genericMoveGesture)&&view==="floor"&&["x","y"].includes(e.key.toLowerCase())){const g=genericNodeMoveGesture||genericEdgeMoveGesture||gridlineMoveGesture||genericMoveGesture;g.axisLock=e.key.toLowerCase();g.axisLockByKey=true;$("status").textContent="Editing geometry · "+g.axisLock.toUpperCase()+" axis locked";e.preventDefault();redraw();return}
 if(e.key==="Shift"&&!shiftHeld){shiftHeld=true;shiftAngleLock=null;if(view==="floor"&&draft.length&&mouse){const cursor=wpos(mouse),anchor=draft[draft.length-1],reference=shiftReferencePoint(cursor,anchor);shiftAngleLock=lockCursorAxis(reference,cursor)}if(draft.length&&view==="floor")redraw()}
 if(e.key==="Tab"&&tool==="select"&&view==="floor"&&!/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName||"")&&mouse){
  const q=wpos(mouse),candidates=selectionCandidatesAt(q);
  if(candidates.length>1){e.preventDefault();tabSelectionCandidates=candidates;tabSelectionIndex=(tabSelectionIndex+1)%candidates.length;hoveredElementId=tabSelectionCandidates[tabSelectionIndex].id;redraw();$("status").textContent="Preselection "+(tabSelectionIndex+1)+"/"+candidates.length+" · "+tabSelectionCandidates[tabSelectionIndex].type+" · click to select";return}
 }
 if(e.key==="Escape"){
  lastMarqueeRect=null;lastMarqueePolygon=null;selectionBoxGesture=null;marqueeDraftPoints=[];marqueePreviewPoint=null;selected.clear();hoveredElementId=null;
  if(pendingOpeningPlacement){openingPlacement.cancel();pendingOpeningPlacement=null;updateEditActions();redraw();$("status").textContent="Opening placement cancelled";return}
  if(cancelProvisionalDrawing()){$("status").textContent="Drawing cancelled · provisional elements removed";return}
  draft=[];floorDrawGesture=null;wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;trackerDistanceOverride=null;trackerAngleOverride=null;releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null;selected.clear();updateEditActions();redraw();renderProperties();$("status").textContent="Command cancelled";
 }
 if(e.key==="F2"){e.preventDefault();setView("floor")}if(e.key==="F3"){e.preventDefault();setView("3d")}if(view==="3d"&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();if(e.key==="ArrowLeft")orbitCameraBy(-.08,0);if(e.key==="ArrowRight")orbitCameraBy(.08,0);if(e.key==="ArrowUp")orbitCameraBy(0,.06);if(e.key==="ArrowDown")orbitCameraBy(0,-.06);redraw()}if(e.code==="Space"&&!/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName||"")){spaceHeld=true;if(!spaceMagicWandActive&&view==="floor"&&!pendingGridSystem&&!pendingOpeningPlacement&&!hasActiveDrawing()){spaceMagicWandReturnTool=tool;spaceMagicWandActive=true;document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool==="magicwand"));$("toolName").value="magicwand";$("contextToolName").textContent="Magic Wand (temporary)";$("contextToolHint").textContent="Release Space to return to "+(spaceMagicWandReturnTool||"previous tool");}e.preventDefault();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();$("save").click()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();$("undo").click()}if((e.ctrlKey||e.metaKey)&&(e.key.toLowerCase()==="y"||(e.shiftKey&&e.key.toLowerCase()==="z"))){e.preventDefault();$("redo").click()}const isBackspace=e.key==="Backspace"||e.key==="Delete"||e.keyCode===8||e.keyCode===46||e.which===8||e.which===46;const isForwardDelete=e.key==="Delete"||e.keyCode===46||e.which===46;if(isBackspace&&view==="floor"&&draft.length&&["wall","beam","dimension","slab"].includes(tool)&&!(tool==="wall"&&wallGeometryMethod==="continuous"&&wallChainHasSegment&&wallChainPoints.length>=2)){e.preventDefault();e.stopImmediatePropagation();draft.pop();floorDrawGesture=null;trackerDistanceOverride=null;trackerAngleOverride=null;if(tool==="wall"&&draft.length===0){wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;provisionalWallClosed=false}redraw();$("status").textContent=draft.length?"Last point removed · continue drawing or press Enter":"Drawing points cleared";return}const activeWallChain=view==="floor"&&tool==="wall"&&wallGeometryMethod==="continuous"&&wallChainHasSegment&&wallChainPoints.length>=2;if(isBackspace&&activeWallChain){e.preventDefault();e.stopImmediatePropagation();const end=wallChainPoints[wallChainPoints.length-1],start=wallChainPoints[wallChainPoints.length-2];const index=els().findLastIndex(el=>el.type==="wall"&&el.storyId===story().id&&((Math.hypot(el.start.x-start.x,el.start.y-start.y)<1e-6&&Math.hypot(el.end.x-end.x,el.end.y-end.y)<1e-6)||(Math.hypot(el.start.x-end.x,el.start.y-end.y)<1e-6&&Math.hypot(el.end.x-start.x,el.end.y-start.y)<1e-6)));if(index<0){$("status").textContent="Could not find the last wall segment to undo";return}hist("Undo last wall-chain segment");els().splice(index,1);wallChainPoints.pop();wallChainHasSegment=wallChainPoints.length>1;draft=[{x:start.x,y:start.y}];shiftAngleLock=null;floorDrawGesture=null;trackerDistanceOverride=null;trackerAngleOverride=null;renderProperties();redraw();$("status").textContent="Last wall-chain segment undone";return}if(isForwardDelete||e.key==="Backspace"){if(activeWallChain&&isBackspace){e.preventDefault();e.stopImmediatePropagation();return}if(e.target?.tagName!=="INPUT"&&e.target?.tagName!=="TEXTAREA")$("delete").click()}});
$("exportSchedule").onclick=()=>{try{const rows=elementSchedule(p);const csv=serializeScheduleCsv(rows);const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const link=document.createElement("a");link.href=url;link.download=((p.project.name||"arqenvo")+"-schedule.csv").replace(/[^a-z0-9._-]+/gi,"-");link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$("status").textContent="Element schedule exported ("+rows.length+" rows)"}catch(error){$("status").textContent="Schedule export failed: "+error.message}};
$("validateModel").onclick=()=>{const result=validateProject(p);if(result.valid){$("status").textContent="Model validation passed · "+els().length+" elements · "+p.stories.length+" stories";alert("Model validation passed.\\n"+els().length+" elements across "+p.stories.length+" stories.")}else{$("status").textContent="Model validation found "+result.errors.length+" issue(s)";alert("Model validation issues ("+result.errors.length+"):\\n\\n"+result.errors.join("\\n"))}};
$("exportDxf").onclick=()=>{try{const content=exportFloorPlanDxf(p,{storyId:story().id});const url=URL.createObjectURL(new Blob([content],{type:"application/dxf"}));const link=document.createElement("a");link.href=url;link.download=((p.project.name||"arqenvo")+"-"+story().name+"-plan.dxf").replace(/[^a-z0-9._-]+/gi,"-");link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$("status").textContent="Floor plan DXF exported"}catch(error){$("status").textContent="DXF export failed: "+error.message}};
$("exportSection").onclick=()=>{try{const read=(label,initial)=>{const raw=prompt(label,String(initial));if(raw===null)throw new Error("Section export cancelled");const value=Number(raw);if(!Number.isFinite(value))throw new Error(label+" must be numeric");return value};const start={x:read("Section start X (m)",0),y:read("Section start Y (m)",0)},end={x:read("Section end X (m)",10),y:read("Section end Y (m)",0)};const rows=extractSection(p,{start,end,storyId:story().id}).map(row=>({...row,story:story().name}));if(!rows.length){$("status").textContent="No model elements intersect this section line";return}const columns=["elementId","type","story","stationStart","stationEnd","elevationStart","elevationEnd","material"];const csv=serializeScheduleCsv(rows,columns);const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const link=document.createElement("a");link.href=url;link.download=((p.project.name||"arqenvo")+"-section.csv").replace(/[^a-z0-9._-]+/gi,"-");link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$("status").textContent="Section extracted · "+rows.length+" cut element(s)"}catch(error){if(error.message!=="Section export cancelled")$("status").textContent="Section extraction failed: "+error.message}};
// Restore the latest local recovery snapshot before the first render.
try{const recovery=localStorage.getItem(AUTOSAVE_KEY);if(recovery){const recovered=deserializeProject(recovery);const walls=recovered.elements.filter(e=>e.type==="wall"&&e.start&&e.end);const lengths=walls.map(e=>Math.hypot(e.end.x-e.start.x,e.end.y-e.start.y)).filter(Number.isFinite).sort((a,b)=>a-b);const median=lengths.length?lengths[Math.floor(lengths.length/2)]:0;const suspicious=walls.filter(e=>{const len=Math.hypot(e.end.x-e.start.x,e.end.y-e.start.y);return !Number.isFinite(len)||len>30||(len>12&&median>0&&len>median*8)});if(suspicious.length){const badIds=new Set(suspicious.map(e=>e.id));const choice=confirm("ARQENVO found "+suspicious.length+" abnormal wall(s) in your autosave. OK = recover the project while quarantining these walls; the full original autosave will be backed up in this browser. Cancel = start a clean drawing while preserving the original autosave backup.");if(choice){try{localStorage.setItem(AUTOSAVE_KEY+".before-geometry-repair",recovery)}catch(storageError){}recovered.elements=recovered.elements.filter(e=>!badIds.has(e.id)&&!(["door","window"].includes(e.type)&&badIds.has(e.hostWallId)));p=recovered;activeStoryId=p.stories[0]?.id;try{localStorage.setItem(AUTOSAVE_KEY,serializeProject(p))}catch(storageError){}$("status").textContent="Recovered with "+suspicious.length+" abnormal wall(s) quarantined; original autosave backup preserved"}else{$("status").textContent="Started clean drawing. Original autosave preserved in this browser."}}else if(confirm("Recover the most recent locally autosaved ARQENVO project?")){p=recovered;activeStoryId=p.stories[0]?.id;$("status").textContent="Recovered local autosave"}else{$("status").textContent="Started clean drawing. Original autosave preserved in this browser."}}}catch(error){$("status").textContent="Recovery snapshot could not be loaded: "+error.message}

document.querySelectorAll("[data-command]").forEach(b=>b.addEventListener("click",()=>{const id=b.dataset.command;if(id==="zoomFit"){fitFloorPlan();return}if(id==="groupSelection"){groupSelected()}else if(id==="ungroupSelection"){ungroupSelected()}else if(id==="suspendGroups"){toggleSuspendGroups()}else $(id)?.click();b.closest("details")?.removeAttribute("open")}));
document.querySelectorAll("[data-view-command]").forEach(b=>b.addEventListener("click",()=>{setView(b.dataset.viewCommand);document.querySelectorAll(".menu-group[open]").forEach(m=>m.open=false)}));
document.querySelectorAll("[data-tool-command]").forEach(b=>b.addEventListener("click",()=>{setTool(b.dataset.toolCommand);document.querySelectorAll(".menu-group[open]").forEach(m=>m.open=false)}));
document.querySelectorAll("[data-panel-command]").forEach(b=>b.addEventListener("click",()=>{const panel=b.dataset.panelCommand;if(panel==="navigator"){const toggle=$("navigatorToggle");if(toggle)toggle.click();else{const work=document.querySelector(".work");if(work)work.classList.toggle(matchMedia("(max-width:600px)").matches?"navigator-open":"navigator-hidden")}}else{const target=$(panel);if(target)target.style.display=target.style.display==="none"?(target.id==="toolbox"?"flex":"block"):"none"}document.querySelectorAll(".menu-group[open]").forEach(m=>m.open=false)}));
document.querySelectorAll("[data-navtab]").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll("[data-navtab]").forEach(t=>t.classList.toggle("active",t===b));document.querySelectorAll("[data-navpanel]").forEach(panel=>panel.hidden=panel.dataset.navpanel!==b.dataset.navtab);if(b.dataset.navtab==="layouts"){renderLayoutList();if(!layoutMode&&layoutSheet())openLayoutBook()}if(b.dataset.navtab==="publisher")renderPublisherList();if(b.dataset.navtab==="layers")renderLayerPanel()}));
const LAYOUT_PAPER_MM={A0:[1189,841],A1:[841,594],A2:[594,420],A3:[420,297],A4:[297,210]};
let activeLayoutDrawingId=null,layoutPointerGesture=null;
const layoutSheet=()=> (p.layouts||[]).find(s=>s.id===activeLayoutId)||null;
const layoutDrawing=()=>{const s=layoutSheet();return s?.drawings?.find(d=>d.id===activeLayoutDrawingId)||s?.drawings?.[0]||null};
function ensureLayoutDefaults(sheet){
 if(!sheet)return;
 sheet.name ||= "Layout";sheet.number ||= "A-101";sheet.paper=LAYOUT_PAPER_MM[sheet.paper]?sheet.paper:"A3";
 sheet.orientation=sheet.orientation==="portrait"?"portrait":"landscape";sheet.scale=Math.max(1,Number(sheet.scale)||100);
 sheet.drawings=Array.isArray(sheet.drawings)?sheet.drawings:[];sheet.titleBlock=sheet.titleBlock||{};
 for(const d of sheet.drawings){d.id ||= "drawing-"+Date.now().toString(36);d.source=d.source==="3d"?"3d":"floor";d.storyId ||= d.source==="floor"?(sheet.storyId||story().id):undefined;d.scale=Math.max(1,Number(d.scale)||100);d.x=Number.isFinite(d.x)?d.x:25;d.y=Number.isFinite(d.y)?d.y:25;d.width=Math.max(10,Number(d.width)||200);d.height=Math.max(10,Number(d.height)||140);d.frame=d.frame!==false;d.title ||= d.source==="3d"?"3D View":("Floor Plan · "+(p.stories.find(s=>s.id===d.storyId)?.name||story().name));}
}
function layoutDimensions(sheet){ensureLayoutDefaults(sheet);const base=LAYOUT_PAPER_MM[sheet.paper],portrait=sheet.orientation==="portrait";return {width:portrait?base[1]:base[0],height:portrait?base[0]:base[1]}}
function layoutDrawingBounds(sheet,d){const {width,height}=layoutDimensions(sheet);return {x:Math.max(0,Math.min(width-10,d.x)),y:Math.max(0,Math.min(height-10,d.y)),width:Math.max(10,Math.min(width-Math.max(0,d.x)-5,d.width)),height:Math.max(10,Math.min(height-Math.max(0,d.y)-5,d.height))}}
function layoutDrawingLevelCode(d){const st=p.stories.find(v=>v.id===(d.storyId||story().id));if(!st)return "0.";const idx=p.stories.findIndex(v=>v.id===st.id);const elev=Number(st.elevation);return Number.isFinite(elev)&&Math.abs(elev)>0.001?String(Number(elev.toFixed(2)))+".":(idx>0?String(idx)+".":"0.");}
function layoutDrawingDisplayTitle(d){const st=p.stories.find(v=>v.id===(d.storyId||story().id)),raw=String(d.title||"");if(d.source==="3d")return raw&&raw!=="3D View"?raw:"3D View";if(/^Floor Plan\s*[·-]\s*Ground Floor$/i.test(raw)||(!raw&&st?.name==="Ground Floor"))return "Aras Lantai Bawah";if(/^Floor Plan\s*[·-]\s*/i.test(raw))return "Aras "+String(st?.name||raw.replace(/^Floor Plan\s*[·-]\s*/i,""));return raw||("Aras "+String(st?.name||"Lantai Bawah"));}
function drawArchitecturalDrawingTitle(ctx,r,d,mm,{pdf=false,index=0}={}){
 const radius=mm(4.5),cx=r.x+radius,cy=r.y+r.height+mm(9),ruleY=cy,tx=cx+radius+mm(2.2),fontSize=Math.max(pdf?10:7,mm(2.5)),number=String(d.drawingNumber||("A."+String(index+1).padStart(2,"0"))),level=layoutDrawingLevelCode(d),title=layoutDrawingDisplayTitle(d),scaleLabel="Scale 1:"+String(d.scale||100);
 ctx.save();ctx.strokeStyle="#17212b";ctx.fillStyle="#17212b";ctx.lineWidth=Math.max(pdf?1:.6,mm(.2));ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.moveTo(cx-radius,cy);ctx.lineTo(cx+radius,cy);ctx.stroke();
 ctx.fillStyle="#17212b";ctx.font=Math.max(pdf?9:6,mm(2.3))+"px Arial";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(level,cx,cy-radius*.48);ctx.fillText(number,cx,cy+radius*.49);
 ctx.textAlign="left";ctx.textBaseline="alphabetic";ctx.font=Math.max(pdf?11:7,mm(2.8))+"px Arial";ctx.fillText(title,tx,cy+mm(.7));ctx.font=Math.max(pdf?10:6,mm(2.4))+"px Arial";ctx.fillText(scaleLabel,tx,cy+mm(4.5));ctx.restore();
}
function renderModelSnapshot(ctx,rect,source,storyId,scaleDenominator=100,frameWidthMm=200){
 const items=els().filter(e=>isLayerVisible(e)&&(source==="3d"||e.storyId===(storyId||story().id)));
 const points=[];for(const el of items){if(el.start&&el.end)points.push(el.start,el.end);if(el.position)points.push(el.position);if(el.boundary)points.push(...el.boundary)}
 ctx.save();ctx.beginPath();ctx.rect(rect.x,rect.y,rect.width,rect.height);ctx.clip();
 if(!items.length){ctx.fillStyle="#7a8188";ctx.font="12px Arial";ctx.fillText(source==="3d"?"No 3D model elements yet":"No elements in this story",rect.x+10,rect.y+20);ctx.restore();return}
 if(!points.length){ctx.restore();return}
 const minX=Math.min(...points.map(v=>v.x)),maxX=Math.max(...points.map(v=>v.x)),minY=Math.min(...points.map(v=>v.y)),maxY=Math.max(...points.map(v=>v.y)),ex=Math.max(1,maxX-minX),ey=Math.max(1,maxY-minY);
 const scaleFactor=Math.max(.0001,rect.width/Math.max(1,frameWidthMm)*1000/Math.max(1,scaleDenominator)),ox=rect.x+rect.width/2-(minX+maxX)*scaleFactor/2,oy=rect.y+rect.height/2+(minY+maxY)*scaleFactor/2,pt=v=>({x:ox+v.x*scaleFactor,y:oy-v.y*scaleFactor});
 if(source==="3d"){
  const cx=(minX+maxX)/2,cy=(minY+maxY)/2,projected=points.map(q=>({x:(q.x-cx)-(q.y-cy)*.55,y:(q.x-cx)+(q.y-cy)*.45})),pMinX=Math.min(...projected.map(q=>q.x)),pMaxX=Math.max(...projected.map(q=>q.x)),pMinY=Math.min(...projected.map(q=>q.y)),pMaxY=Math.max(...projected.map(q=>q.y)),maxWallHeight=Math.max(2,...items.filter(el=>el.type==="wall"||el.type==="column").map(el=>Number(el.height)||3))*.34,projectedWidth=Math.max(1,pMaxX-pMinX),projectedHeight=Math.max(1,pMaxY-pMinY)*.34+maxWallHeight,factor=Math.max(.001,rect.width/Math.max(1,frameWidthMm)*1000/Math.max(1,scaleDenominator)),baseY=rect.y+rect.height/2-(pMinY+pMaxY)*factor*.34/2+maxWallHeight*factor/2,iso3d=(q,z=0)=>({x:rect.x+rect.width/2+((q.x-cx)-(q.y-cy)*.55)*factor,y:baseY+((q.x-cx)+(q.y-cy)*.45)*factor*.34-z*factor*.34,depth:q.y});
  render3DScene(ctx,items,iso3d,{interactive:false});ctx.restore();return
 }
 renderFloorPlanElements(ctx,items,pt,scaleFactor,{interactive:false,includePending:false,annotationScale:rect.width/Math.max(1,frameWidthMm)});
 ctx.restore()
}
function renderLayoutCanvas(w,h){
 const sheet=layoutSheet();const canvasRect=c.getBoundingClientRect();w=Math.max(1,canvasRect.width);h=Math.max(1,canvasRect.height);const ratio=window.devicePixelRatio||1;x.setTransform(ratio,0,0,ratio,0,0);x.save();x.fillStyle="#303139";x.fillRect(0,0,w,h);
 if(!sheet){x.fillStyle="#e9ecef";x.fillRect(0,0,w,h);x.fillStyle="#303943";x.font="bold 16px Arial";x.fillText("LAYOUT BOOK",22,30);x.font="12px Arial";x.fillText("Create a layout sheet to start documenting the project.",22,52);x.restore();return}
 ensureLayoutDefaults(sheet);const {width:pw,height:ph}=layoutDimensions(sheet);const fit=Math.max(.01,Math.min((w-42)/pw,(h-42)/ph)),sw=pw*fit,sh=ph*fit,left=(w-sw)/2,top=(h-sh)/2,mm=v=>v*fit;
 x.fillStyle="#00000022";x.fillRect(left+5,top+5,sw,sh);x.fillStyle="#fff";x.strokeStyle="#747b84";x.lineWidth=1;x.fillRect(left,top,sw,sh);x.strokeRect(left,top,sw,sh);
 const margin=mm(12);x.strokeStyle="#b7bec6";x.strokeRect(left+margin,top+margin,sw-margin*2,sh-margin*2);
 for(const d of sheet.drawings){const b=layoutDrawingBounds(sheet,d),r={x:left+mm(b.x),y:top+mm(b.y),width:mm(b.width),height:mm(b.height)};x.save();x.beginPath();x.rect(r.x,r.y,r.width,r.height);x.clip();renderModelSnapshot(x,r,d.source,d.storyId,d.scale,d.width);x.restore();if(d.frame){x.strokeStyle=d.id===activeLayoutDrawingId?"#087e8b":"#565e67";x.lineWidth=d.id===activeLayoutDrawingId?1.7:.7;x.strokeRect(r.x,r.y,r.width,r.height);if(d.id===activeLayoutDrawingId){const hs=5;x.fillStyle="#fff";x.strokeStyle="#087e8b";x.lineWidth=1;for(const hp of [{x:r.x,y:r.y},{x:r.x+r.width/2,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x,y:r.y+r.height/2},{x:r.x+r.width,y:r.y+r.height/2},{x:r.x,y:r.y+r.height},{x:r.x+r.width/2,y:r.y+r.height},{x:r.x+r.width,y:r.y+r.height}]){x.fillRect(hp.x-hs/2,hp.y-hs/2,hs,hs);x.strokeRect(hp.x-hs/2,hp.y-hs/2,hs,hs)}}}drawArchitecturalDrawingTitle(x,r,d,mm,{index:sheet.drawings.indexOf(d)});if(d.id===activeLayoutDrawingId){x.strokeStyle="#087e8b";x.setLineDash([4,3]);x.strokeRect(r.x-2,r.y-2,r.width+4,r.height+4);x.setLineDash([])}}
 const tx=left+sw-mm(190),ty=top+sh-mm(36),tw=mm(178),th=mm(29),meta=sheet.titleBlock||{};
 x.strokeStyle="#26313b";x.lineWidth=.8;x.strokeRect(tx,ty,tw,th);x.beginPath();x.moveTo(tx,ty+th*.5);x.lineTo(tx+tw,ty+th*.5);x.moveTo(tx+tw*.66,ty+th*.5);x.lineTo(tx+tw*.66,ty+th);x.stroke();
 x.fillStyle="#202a33";x.font="bold "+Math.max(7,mm(3.1))+"px Arial";x.fillText(String(meta.projectTitle||p.project.name||"ARQENVO").slice(0,45),tx+mm(3),ty+mm(6));
 x.font=Math.max(6,mm(2.5))+"px Arial";x.fillText(String(sheet.name).slice(0,50),tx+mm(3),ty+mm(12));x.fillText(String(sheet.drawings.find(d=>d.id===activeLayoutDrawingId)?.title||sheet.drawings[0]?.title||"GENERAL ARRANGEMENT").slice(0,45),tx+mm(3),ty+mm(18));x.fillText("SCALE 1:"+String(sheet.drawings.find(d=>d.id===activeLayoutDrawingId)?.scale||100)+" · "+String(meta.issueDate||meta.date||new Date().toISOString().slice(0,10)),tx+mm(3),ty+mm(24));x.font="bold "+Math.max(7,mm(4))+"px Arial";x.fillText(String(sheet.number||"A-101"),tx+tw*.68,ty+th*.79);
 x.fillStyle="#303943";x.font="10px Arial";x.fillText("LAYOUT BOOK  /  "+sheet.name+"  /  "+sheet.paper+" "+sheet.orientation,12,16);x.restore();
}
function renderPublisherList(){
 const host=$("publisherList");if(!host)return;host.replaceChildren();
 if(!(p.layouts||[]).length){const msg=document.createElement("p");msg.className="nav-note";msg.textContent="No layout sheets to publish. Create sheets in Layout Book.";host.appendChild(msg);return}
 for(const sheet of p.layouts){ensureLayoutDefaults(sheet);const row=document.createElement("label");row.className="publisher-row";const checkbox=document.createElement("input");checkbox.type="checkbox";checkbox.checked=sheet.publish!==false;checkbox.addEventListener("change",()=>{sheet.publish=checkbox.checked;scheduleAutoSave()});const title=document.createElement("span");title.textContent=sheet.number+" · "+sheet.name;row.append(checkbox,title);host.appendChild(row)}
}
function publishSelectedLayouts(){const sheets=(p.layouts||[]).filter(sheet=>sheet.publish!==false);if(!sheets.length){$("status").textContent="Select at least one sheet in Publisher";return}prepareLayoutPrint(sheets)}
function makeLayoutSheet(){
 p.layouts ||= [];const n=p.layouts.length+1;const numberIndex=p.layouts.reduce((max,s)=>Math.max(max,Number(String(s.number||"").match(/([0-9]+)$/)?.[1])||0),100)+1;
 const sheet={id:"layout-"+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)),name:"Layout "+String(n).padStart(2,"0"),number:"A-"+numberIndex,paper:"A3",orientation:"landscape",scale:100,storyId:story().id,drawings:[],titleBlock:{projectTitle:p.project.name||"",date:new Date().toISOString().slice(0,10)}};
 p.layouts.push(sheet);activeLayoutId=sheet.id;activeLayoutDrawingId=null;openLayoutBook();renderLayoutList();renderLayoutInspector();redraw();scheduleAutoSave();$("status").textContent="Created "+sheet.name+" · "+sheet.paper+" landscape";
}
function openLayoutBook(){
 // A model-drawing command must not remain active above the Layout Book canvas.
 if(provisionalDrawingActive)cancelProvisionalDrawing();
 if(pendingOpeningPlacement){openingPlacement.cancel();pendingOpeningPlacement=null}
 draft=[];floorDrawGesture=null;wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;
 gridlineMoveGesture=null;openingMoveGesture=null;genericMoveGesture=null;genericNodeMoveGesture=null;genericEdgeMoveGesture=null;
 releasedTouchEditPending=false;releasedTouchEditSnapshot=null;releasedTouchEditKind=null;
 layoutMode=true;view="layout";selected.clear();layoutPointerGesture=null;updateEditActions();
 document.querySelectorAll("[data-navtab]").forEach(t=>t.classList.toggle("active",t.dataset.navtab==="layouts"));
 document.querySelectorAll("[data-navpanel]").forEach(panel=>panel.hidden=panel.dataset.navpanel!=="layouts");
 $("layoutControls")?.classList.add("active");$("layoutInspector")?.classList.add("active");$("elementProperties")?.style.setProperty("display","none");$("selectionInfo").textContent="";
 const sheet=layoutSheet();if(sheet){$("viewLabel").textContent=sheet.name+" · "+sheet.paper+" "+sheet.orientation;$("hint").textContent="Layout Book · select a drawing frame then drag to reposition; use Drawing settings for precise sizing";}renderLayoutControls();renderLayoutInspector();renderLayoutList();redraw();
}
function activateLayout(sheetId){activeLayoutId=sheetId;const s=layoutSheet();ensureLayoutDefaults(s);activeLayoutDrawingId=s.drawings[0]?.id||null;openLayoutBook();scheduleAutoSave()}
function renderLayoutList(){
 const host=$("layoutList");if(!host)return;host.replaceChildren();const sheets=p.layouts||[];
 if(!sheets.length){const empty=document.createElement("div");empty.className="layout-empty";empty.textContent="No sheets yet. Create a layout to begin.";host.appendChild(empty);return}
 sheets.forEach(sheet=>{ensureLayoutDefaults(sheet);const row=document.createElement("div");row.className="layout-sheet-row";const b=document.createElement("button");b.type="button";b.className="tree"+(sheet.id===activeLayoutId?" active":"");b.textContent="▤ "+sheet.number+" · "+sheet.name;b.title=sheet.name;b.addEventListener("click",()=>activateLayout(sheet.id));const menu=document.createElement("button");menu.type="button";menu.className="layout-row-menu";menu.textContent="⋯";menu.title="Sheet actions";menu.addEventListener("click",()=>{activateLayout(sheet.id);const action=prompt("Sheet action: rename, duplicate, up, down, delete","rename");if(action===null)return;const v=action.trim().toLowerCase();if(v==="rename")renameActiveLayout();else if(v==="duplicate")duplicateActiveLayout();else if(v==="up")moveActiveLayout(-1);else if(v==="down")moveActiveLayout(1);else if(v==="delete")deleteActiveLayout()});row.append(b,menu);host.appendChild(row)});
}
function renderLayoutControls(){
 const s=layoutSheet();if(!s)return;ensureLayoutDefaults(s);const select=$("layoutControlSheet");select.replaceChildren();for(const sheet of p.layouts){const o=document.createElement("option");o.value=sheet.id;o.textContent=sheet.number+" · "+sheet.name;select.appendChild(o)}select.value=s.id;$("layoutPaper").value=s.paper;$("layoutOrientation").value=s.orientation;$("layoutDrawingSource").value=layoutDrawing()?.source||"floor";$("layoutDrawingScale").value=String(layoutDrawing()?.scale||100);
}
function renderLayoutInspector(){
 const s=layoutSheet(),d=layoutDrawing();if(!s)return;ensureLayoutDefaults(s);const meta=s.titleBlock||{};
 $("layoutProjectTitle").value=meta.projectTitle??p.project.name??"";$("layoutSheetName").value=s.name;$("layoutSheetNumber").value=s.number;$("layoutSheetDate").value=meta.issueDate||meta.date||new Date().toISOString().slice(0,10);$("layoutAuthor").value=meta.author||"";$("layoutCompany").value=meta.company||"";
 $("layoutDrawingTitle").value=d?.title||"";$("layoutDrawingScaleEdit").value=d?.scale||100;$("layoutDrawingFrame").value=String(d?.frame!==false);
 for(const [id,key,def] of [["layoutDrawingX","x",25],["layoutDrawingY","y",25],["layoutDrawingW","width",200],["layoutDrawingH","height",140]])$(id).value=d?.[key]??def;
 $("layoutDeleteDrawing").disabled=!d;
}
function renameActiveLayout(){const s=layoutSheet();if(!s)return;const name=prompt("Layout sheet name",s.name);if(name===null)return;if(!name.trim()){$("status").textContent="Sheet name cannot be empty";return}s.name=name.trim();renderLayoutList();renderLayoutControls();renderLayoutInspector();redraw();scheduleAutoSave()}
function duplicateActiveLayout(){const s=layoutSheet();if(!s)return;const copy=structuredClone(s);copy.id="layout-"+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36));copy.name=s.name+" Copy";copy.number=makeNextLayoutNumber();copy.drawings=(copy.drawings||[]).map(d=>({...d,id:"drawing-"+(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2))}));const i=p.layouts.findIndex(v=>v.id===s.id);p.layouts.splice(i+1,0,copy);activateLayout(copy.id);$("status").textContent="Duplicated layout sheet"}
function makeNextLayoutNumber(){const used=new Set((p.layouts||[]).map(s=>s.number));let i=101;while(used.has("A-"+i))i++;return "A-"+i}
function moveActiveLayout(delta){const i=p.layouts.findIndex(s=>s.id===activeLayoutId),j=i+delta;if(i<0||j<0||j>=p.layouts.length)return;[p.layouts[i],p.layouts[j]]=[p.layouts[j],p.layouts[i]];renderLayoutList();renderLayoutControls();redraw();scheduleAutoSave()}
function deleteActiveLayout(){const s=layoutSheet();if(!s)return;if(!confirm("Delete layout "+s.number+" · "+s.name+"?"))return;const i=p.layouts.findIndex(v=>v.id===s.id);p.layouts.splice(i,1);activeLayoutId=p.layouts[Math.min(i,p.layouts.length-1)]?.id||null;activeLayoutDrawingId=layoutSheet()?.drawings?.[0]?.id||null;if(activeLayoutId)openLayoutBook();else{layoutMode=true;view="layout";renderLayoutList();$("layoutInspector").classList.add("active");$("layoutControls").classList.add("active");redraw()}scheduleAutoSave();$("status").textContent="Layout sheet deleted"}
function addLayoutDrawing(){
 const s=layoutSheet();if(!s)return;ensureLayoutDefaults(s);
 const source=$("layoutDrawingSource").value,scaleDenominator=Number($("layoutDrawingScale").value)||100,paper=layoutDimensions(s);
 const preferredWidth=Math.min(source==="3d"?150:220,Math.max(80,paper.width-40)),preferredHeight=Math.min(source==="3d"?115:150,Math.max(60,paper.height-70));
 // Try progressively smaller frames so compact sheets can accept another drawing when the default frame no longer fits.
 const sizes=[[preferredWidth,preferredHeight],[Math.min(preferredWidth,180),Math.min(preferredHeight,120)],[Math.min(preferredWidth,150),Math.min(preferredHeight,100)],[Math.min(preferredWidth,120),Math.min(preferredHeight,85)],[Math.min(preferredWidth,100),Math.min(preferredHeight,70)]];
 let slot=null;
 for(const [frameWidth,frameHeight] of sizes){
  const cols=Math.max(1,Math.floor((paper.width-30)/(frameWidth+10))),maxY=paper.height-frameHeight-45;
  for(let row=0;row<=Math.floor((maxY-15)/(frameHeight+12))&&!slot;row++){
   for(let col=0;col<cols;col++){
    const candidate={x:15+col*(frameWidth+10),y:15+row*(frameHeight+12),width:frameWidth,height:frameHeight};
    if(candidate.x+candidate.width>paper.width-10||candidate.y>maxY)continue;
    const overlaps=s.drawings.some(d=>{const b=layoutDrawingBounds(s,d);return candidate.x<b.x+b.width&&candidate.x+candidate.width>b.x&&candidate.y<b.y+b.height&&candidate.y+candidate.height>b.y});
    if(!overlaps){slot=candidate;break}
   }
  }
  if(slot)break;
 }
 if(!slot){$("status").textContent="No free drawing frame space on this sheet. Move or resize existing drawings, or choose a larger paper size.";return}
 const d={id:"drawing-"+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)),source,storyId:source==="floor"?story().id:undefined,scale:scaleDenominator,...slot,frame:true,title:source==="3d"?"3D View":"Floor Plan · "+story().name,updatedAt:new Date().toISOString()};
 s.drawings.push(d);activeLayoutDrawingId=d.id;renderLayoutControls();renderLayoutInspector();redraw();scheduleAutoSave();$("status").textContent="Added live "+(source==="3d"?"3D":"Floor Plan")+" drawing to "+s.name;
}
function removeLayoutDrawing(){const s=layoutSheet();if(!s)return;const d=layoutDrawing();if(!d)return;s.drawings=s.drawings.filter(v=>v.id!==d.id);activeLayoutDrawingId=s.drawings[0]?.id||null;renderLayoutInspector();redraw();scheduleAutoSave();$("status").textContent="Drawing removed from layout"}
function applyLayoutDrawing(){
 const s=layoutSheet(),d=layoutDrawing();if(!s||!d)return;const size=layoutDimensions(s);const read=(id,min,max,def)=>{const raw=$(id).value.trim(),v=raw===""?def:Number(raw);return Number.isFinite(v)?Math.max(min,Math.min(max,v)):def};
 d.title=$("layoutDrawingTitle").value.trim()||"Drawing";d.scale=read("layoutDrawingScaleEdit",1,5000,d.scale);d.x=read("layoutDrawingX",0,size.width-10,d.x);d.y=read("layoutDrawingY",0,size.height-10,d.y);d.width=read("layoutDrawingW",10,size.width,d.width);d.height=read("layoutDrawingH",10,size.height,d.height);d.frame=$("layoutDrawingFrame").value==="true";if(d.source==="floor")d.storyId=d.storyId||story().id;d.updatedAt=new Date().toISOString();renderLayoutInspector();redraw();scheduleAutoSave();$("status").textContent="Drawing settings applied";
}
function applyLayoutMeta(){const s=layoutSheet();if(!s)return;const name=$("layoutSheetName").value.trim(),number=$("layoutSheetNumber").value.trim();if(!name||!number){$("status").textContent="Sheet name and number are required";return}if((p.layouts||[]).some(o=>o.id!==s.id&&String(o.number).toLowerCase()===number.toLowerCase())){$("status").textContent="Sheet number already exists";return}s.name=name;s.number=number;s.titleBlock=s.titleBlock||{};s.titleBlock.projectTitle=$("layoutProjectTitle").value.trim();s.titleBlock.date=$("layoutSheetDate").value||new Date().toISOString().slice(0,10);s.titleBlock.issueDate=s.titleBlock.date;s.titleBlock.author=$("layoutAuthor").value.trim();s.titleBlock.company=$("layoutCompany").value.trim();renderLayoutList();renderLayoutControls();renderLayoutInspector();redraw();scheduleAutoSave();$("status").textContent="Layout title block saved"}
function enterModelView(source){layoutMode=false;$("layoutControls")?.classList.remove("active");$("layoutInspector")?.classList.remove("active");$("elementProperties")?.style.removeProperty("display");setView(source)}
function prepareLayoutPrint(sheetOverride=null){
 const scope=$("publisherScope")?.value||"all";
 const sheets=Array.isArray(sheetOverride)?sheetOverride:(scope==="active"&&layoutSheet()?[layoutSheet()]:(p.layouts||[]));
 if(!sheets.length){$("status").textContent="Create a layout sheet before saving PDF";return}
 const dpi=150,pxPerMm=dpi/25.4,encoder=new TextEncoder(),pdfPages=[];
 const drawText=(ctx,text,x,y,size=8,bold=false,color="#202a33")=>{ctx.fillStyle=color;ctx.font=(bold?"bold ":"")+size+"px Arial";ctx.fillText(String(text??""),x,y)};
 for(const sheet of sheets){
  ensureLayoutDefaults(sheet);
  const dim=layoutDimensions(sheet),width=Math.max(1,Math.round(dim.width*pxPerMm)),height=Math.max(1,Math.round(dim.height*pxPerMm)),cv=document.createElement("canvas");cv.width=width;cv.height=height;
  const ctx=cv.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,width,height);const mm=v=>v*pxPerMm;
  if(sheet.showFrame!==false){ctx.strokeStyle="#aeb5bd";ctx.lineWidth=Math.max(1,mm(.6));ctx.strokeRect(mm(5),mm(5),width-mm(10),height-mm(10))}
  for(const d of sheet.drawings||[]){
   const b=layoutDrawingBounds(sheet,d),r={x:mm(b.x),y:mm(b.y),width:mm(b.width),height:mm(b.height)};
   ctx.save();ctx.beginPath();ctx.rect(r.x,r.y,r.width,r.height);ctx.clip();renderModelSnapshot(ctx,r,d.source,d.storyId,d.scale,d.width);ctx.restore();
   if(d.frame!==false){ctx.strokeStyle="#444";ctx.lineWidth=Math.max(1,mm(.25));ctx.strokeRect(r.x,r.y,r.width,r.height)}
   drawArchitecturalDrawingTitle(ctx,r,d,mm,{pdf:true,index:sheet.drawings.indexOf(d)});
  }
  const meta=sheet.titleBlock||{},tx=width-mm(190),ty=height-mm(36),tw=mm(178),th=mm(29);
  ctx.strokeStyle="#26313b";ctx.lineWidth=Math.max(1,mm(.25));ctx.strokeRect(tx,ty,tw,th);ctx.beginPath();ctx.moveTo(tx,ty+th*.5);ctx.lineTo(tx+tw,ty+th*.5);ctx.moveTo(tx+tw*.66,ty+th*.5);ctx.lineTo(tx+tw*.66,ty+th);ctx.stroke();
  drawText(ctx,meta.projectTitle||p.project.name||"ARQENVO",tx+mm(3),ty+mm(6),Math.max(12,mm(3.1)),true);
  drawText(ctx,sheet.name,tx+mm(3),ty+mm(12),Math.max(10,mm(2.5)));
  drawText(ctx,(sheet.drawings.map(d=>d.title||"").filter(Boolean).join(" · ")||"GENERAL ARRANGEMENT").slice(0,90),tx+mm(3),ty+mm(18),Math.max(9,mm(2.2)));
  const metaLine=[meta.author?"PREPARED BY "+meta.author:"",meta.company||"","SCALE "+((sheet.drawings||[]).map(d=>"1:"+d.scale).join(" / ")||"—"),"DATE "+(meta.issueDate||meta.date||new Date().toISOString().slice(0,10))].filter(Boolean).join(" · ");
  drawText(ctx,metaLine,tx+mm(3),ty+mm(24),Math.max(8,mm(1.8)));drawText(ctx,sheet.number,tx+tw*.68,ty+th*.78,Math.max(13,mm(4)),true);
  const data=cv.toDataURL("image/jpeg",.94).split(",")[1],binary=atob(data),jpg=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)jpg[i]=binary.charCodeAt(i);
  pdfPages.push({width,height,pageWidth:dim.width*72/25.4,pageHeight:dim.height*72/25.4,jpg});
 }
 const objects=[],addObject=value=>{objects.push(value);return objects.length};const catalogId=addObject(""),pagesId=addObject(""),pageIds=[];
 for(const page of pdfPages){
  const imageId=addObject({dict:"<< /Type /XObject /Subtype /Image /Width "+page.width+" /Height "+page.height+" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length "+page.jpg.length+" >>",stream:page.jpg});
  const contentBytes=encoder.encode("q\n"+page.pageWidth.toFixed(3)+" 0 0 "+page.pageHeight.toFixed(3)+" 0 0 cm\n/Im0 Do\nQ\n");
  const contentId=addObject({dict:"<< /Length "+contentBytes.length+" >>",stream:contentBytes});
  pageIds.push(addObject("<< /Type /Page /Parent "+pagesId+" 0 R /MediaBox [0 0 "+page.pageWidth.toFixed(3)+" "+page.pageHeight.toFixed(3)+"] /Resources << /XObject << /Im0 "+imageId+" 0 R >> >> /Contents "+contentId+" 0 R >>"));
 }
 objects[catalogId-1]="<< /Type /Catalog /Pages "+pagesId+" 0 R >>";objects[pagesId-1]="<< /Type /Pages /Kids ["+pageIds.map(id=>id+" 0 R").join(" ")+"] /Count "+pageIds.length+" >>";
 const chunks=[],offsets=[0];let byteLength=0;const pushBytes=bytes=>{chunks.push(bytes);byteLength+=bytes.length};pushBytes(encoder.encode("%PDF-1.4\n%âãÏÓ\n"));
 for(let i=0;i<objects.length;i++){offsets.push(byteLength);pushBytes(encoder.encode((i+1)+" 0 obj\n"));const obj=objects[i];if(typeof obj==="string")pushBytes(encoder.encode(obj+"\n"));else{pushBytes(encoder.encode(obj.dict+"\nstream\n"));pushBytes(obj.stream);pushBytes(encoder.encode("\nendstream\n"))}pushBytes(encoder.encode("endobj\n"))}
 const xrefOffset=byteLength;let xref="xref\n0 "+(objects.length+1)+"\n0000000000 65535 f \n";for(let i=1;i<offsets.length;i++)xref+=String(offsets[i]).padStart(10,"0")+" 00000 n \n";
 pushBytes(encoder.encode(xref+"trailer\n<< /Size "+(objects.length+1)+" /Root "+catalogId+" 0 R >>\nstartxref\n"+xrefOffset+"\n%%EOF"));
 const blob=new Blob(chunks,{type:"application/pdf"}),url=URL.createObjectURL(blob),link=document.createElement("a"),safeName=String(sheets.length===1?(sheets[0].titleBlock?.projectTitle||sheets[0].name||"ARQENVO"):((p.project.name||"ARQENVO")+" - Layout Book")).replace(/[^a-z0-9 _-]/gi,"").trim().replace(/\s+/g,"-")||"ARQENVO";
 link.href=url;link.download=safeName+".pdf";link.style.display="none";document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 $("status").textContent="PDF saved · "+sheets.length+" sheet(s) · "+safeName+".pdf";
}
$("createLayoutSheet")?.addEventListener("click",makeLayoutSheet);
$("layoutDuplicate")?.addEventListener("click",duplicateActiveLayout);$("layoutMoveUp")?.addEventListener("click",()=>moveActiveLayout(-1));$("layoutMoveDown")?.addEventListener("click",()=>moveActiveLayout(1));$("layoutDelete")?.addEventListener("click",deleteActiveLayout);
$("layoutReturnPlan")?.addEventListener("click",()=>enterModelView("floor"));
$("layoutPrint")?.addEventListener("click",()=>prepareLayoutPrint(layoutSheet()?[layoutSheet()]:[]));$("layoutPreviewPdf")?.addEventListener("click",()=>prepareLayoutPrint());$("publisherPreview")?.addEventListener("click",publishSelectedLayouts);$("publishAllLayouts")?.addEventListener("click",publishSelectedLayouts);
$("layoutApplyDrawing")?.addEventListener("click",applyLayoutDrawing);$("layoutApplyMeta")?.addEventListener("click",applyLayoutMeta);$("layoutAddDrawing")?.addEventListener("click",addLayoutDrawing);$("layoutDeleteDrawing")?.addEventListener("click",removeLayoutDrawing);
 // Keep title-block edits in sync when the user leaves a field, not only after clicking Apply.
 ["layoutProjectTitle","layoutSheetName","layoutSheetNumber","layoutSheetDate","layoutAuthor","layoutCompany"].forEach(id=>$(id)?.addEventListener("change",applyLayoutMeta));
$("layoutControlSheet")?.addEventListener("change",e=>activateLayout(e.target.value));
$("layoutPaper")?.addEventListener("change",e=>{const s=layoutSheet();if(!s)return;s.paper=e.target.value;renderLayoutControls();renderLayoutInspector();redraw();scheduleAutoSave()});
$("layoutOrientation")?.addEventListener("change",e=>{const s=layoutSheet();if(!s)return;s.orientation=e.target.value;renderLayoutControls();redraw();scheduleAutoSave()});
$("layoutDrawingScale")?.addEventListener("change",e=>{const d=layoutDrawing();if(!d)return;d.scale=Number(e.target.value)||100;renderLayoutInspector();redraw();scheduleAutoSave()});
$("layoutDrawingSource")?.addEventListener("change",()=>{const d=layoutDrawing();if(d){const source=$("layoutDrawingSource").value;d.source=source;d.storyId=source==="floor"?story().id:undefined;d.title=source==="3d"?"3D View":"Floor Plan · "+story().name;renderLayoutInspector();redraw();scheduleAutoSave()}});
c.addEventListener("pointerdown",e=>{if(!layoutMode||!layoutSheet())return;const s=layoutSheet(),dims=layoutDimensions(s),fit=Math.min((c.clientWidth-42)/dims.width,(c.clientHeight-42)/dims.height),sw=dims.width*fit,sh=dims.height*fit,left=(c.clientWidth-sw)/2,top=(c.clientHeight-sh)/2,pt={x:e.offsetX,y:e.offsetY},ordered=[...s.drawings].reverse();let hit=null,handle=null;for(const d of ordered){const b=layoutDrawingBounds(s,d),r={x:left+b.x*fit,y:top+b.y*fit,width:b.width*fit,height:b.height*fit};if(d.id===activeLayoutDrawingId&&d.frame){const hs=9,handles=[["nw",r.x,r.y],["n",r.x+r.width/2,r.y],["ne",r.x+r.width,r.y],["w",r.x,r.y+r.height/2],["e",r.x+r.width,r.y+r.height/2],["sw",r.x,r.y+r.height],["s",r.x+r.width/2,r.y+r.height],["se",r.x+r.width,r.y+r.height]];const found=handles.find(v=>Math.abs(pt.x-v[1])<=hs&&Math.abs(pt.y-v[2])<=hs);if(found){hit=d;handle=found[0];break}}if(pt.x>=r.x&&pt.x<=r.x+r.width&&pt.y>=r.y&&pt.y<=r.y+r.height){hit=d;break}}if(hit){activeLayoutDrawingId=hit.id;layoutPointerGesture={id:hit.id,mode:handle?"resize":"move",handle,startX:pt.x,startY:pt.y,x:hit.x,y:hit.y,width:hit.width,height:hit.height,fit,changed:false};renderLayoutInspector();redraw();c.setPointerCapture?.(e.pointerId);e.preventDefault()}});
c.addEventListener("pointermove",e=>{if(!layoutPointerGesture||!layoutMode)return;const s=layoutSheet(),d=s?.drawings.find(v=>v.id===layoutPointerGesture.id);if(!s||!d)return;const g=layoutPointerGesture,dx=(e.offsetX-g.startX)/g.fit,dy=(e.offsetY-g.startY)/g.fit;if(Math.hypot(dx,dy)<1&&!g.changed)return;g.changed=true;const paper=layoutDimensions(s);if(g.mode==="resize"){let left=g.x,top=g.y,right=g.x+g.width,bottom=g.y+g.height;if(g.handle.includes("w"))left=Math.min(g.x+g.width-10,g.x+dx);if(g.handle.includes("e"))right=Math.max(g.x+10,g.x+g.width+dx);if(g.handle.includes("n"))top=Math.min(g.y+g.height-10,g.y+dy);if(g.handle.includes("s"))bottom=Math.max(g.y+10,g.y+g.height+dy);left=Math.max(0,left);top=Math.max(0,top);right=Math.min(paper.width-5,right);bottom=Math.min(paper.height-5,bottom);d.x=left;d.y=top;d.width=Math.max(10,right-left);d.height=Math.max(10,bottom-top)}else{d.x=Math.max(0,Math.min(paper.width-d.width,g.x+dx));d.y=Math.max(0,Math.min(paper.height-d.height,g.y+dy))}redraw()});
function finishLayoutDrag(){if(!layoutPointerGesture)return;const changed=layoutPointerGesture.changed;layoutPointerGesture=null;if(changed){renderLayoutInspector();scheduleAutoSave();$("status").textContent="Drawing repositioned"}}
c.addEventListener("pointerup",finishLayoutDrag);c.addEventListener("pointercancel",finishLayoutDrag);
$("gridSystemOpen").addEventListener("click",()=>{if(view!=="floor")setView("floor");initGridPositionEditors();const info=["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\"/><path d=\"M3 9h18M3 15h18M9 3v18M15 3v18\"/></svg>","Grid System","Configure grid positions, labels, markers and optional structural helpers"];if($("contextToolIcon"))$("contextToolIcon").innerHTML=info[0];if($("contextToolName"))$("contextToolName").textContent=info[1];if($("contextToolHint"))$("contextToolHint").textContent=info[2];$("gridSystemDialog").showModal()});
$("gridSystemClose").addEventListener("click",()=>$("gridSystemDialog").close());

const gridSystemDialog=$("gridSystemDialog");
const gridSystemHeader=gridSystemDialog.querySelector("form>header");
gridSystemDialog.style.position="fixed";
gridSystemDialog.style.left="50%";
gridSystemDialog.style.top="50%";
gridSystemDialog.style.transform="translate(-50%,-50%)";
gridSystemDialog.style.margin="0";
gridSystemHeader.style.cursor="move";
gridSystemHeader.title="Drag to move Grid System Settings";
let gridSystemDrag=null;
gridSystemHeader.addEventListener("pointerdown",event=>{
 if(event.target.closest("button, input, select, label"))return;
 if(event.button!==undefined&&event.button!==0)return;
 const rect=gridSystemDialog.getBoundingClientRect();
 gridSystemDrag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:rect.left,top:rect.top};
 gridSystemDialog.style.left=rect.left+"px";
 gridSystemDialog.style.top=rect.top+"px";
 gridSystemDialog.style.transform="none";
 try{gridSystemHeader.setPointerCapture(event.pointerId)}catch(_){}
 event.preventDefault();
});
gridSystemHeader.addEventListener("pointermove",event=>{
 if(!gridSystemDrag||gridSystemDrag.pointerId!==event.pointerId)return;
 const margin=8,rect=gridSystemDialog.getBoundingClientRect();
 const left=Math.max(margin,Math.min(window.innerWidth-rect.width-margin,gridSystemDrag.left+event.clientX-gridSystemDrag.startX));
 const top=Math.max(margin,Math.min(window.innerHeight-rect.height-margin,gridSystemDrag.top+event.clientY-gridSystemDrag.startY));
 gridSystemDialog.style.left=left+"px";gridSystemDialog.style.top=top+"px";
});
const stopGridSystemDrag=event=>{if(gridSystemDrag&&(!event||event.pointerId===gridSystemDrag.pointerId))gridSystemDrag=null};
gridSystemHeader.addEventListener("pointerup",stopGridSystemDrag);
gridSystemHeader.addEventListener("pointercancel",stopGridSystemDrag);
gridSystemDialog.addEventListener("close",()=>{gridSystemDrag=null;gridSystemDialog.style.left="50%";gridSystemDialog.style.top="50%";gridSystemDialog.style.transform="translate(-50%,-50%)"});
window.addEventListener("resize",()=>{
 if(!gridSystemDialog.open)return;
 const rect=gridSystemDialog.getBoundingClientRect(),margin=8;
 gridSystemDialog.style.left=Math.max(margin,Math.min(window.innerWidth-rect.width-margin,rect.left))+"px";
 gridSystemDialog.style.top=Math.max(margin,Math.min(window.innerHeight-rect.height-margin,rect.top))+"px";
 gridSystemDialog.style.transform="none";
});

const gridPositionState={horizontal:[],vertical:[]};
const gridLetters=n=>{let out="";for(n=Math.max(0,n);n>=0;n=Math.floor(n/26)-1)out=String.fromCharCode(65+n%26)+out;return out};
function gridDefaultPositions(id){
 const values=$(id).value.split(",").map(v=>Number(v.trim())).filter(v=>Number.isFinite(v)&&v>0);
 const out=[{label:id==="gridSystemX"?"A":"1",distance:0}];
 for(const v of values)out.push({label:id==="gridSystemX"?gridLetters(out.length):String(out.length+1),distance:v});
 return out;
}
function renderGridPositionRows(axis){
 const rows=$(axis==="horizontal"?"gridHorizontalRows":"gridVerticalRows");
 const items=gridPositionState[axis];rows.replaceChildren();
 items.forEach((item,index)=>{
  const row=document.createElement("div");row.style.cssText="display:grid;grid-template-columns:24px minmax(28px,.65fr) minmax(90px,1.35fr);align-items:center;gap:7px;padding:5px 4px;border-bottom:1px solid #edf0f2";
  const move=document.createElement("span");move.textContent=index===0?"◆":"↕";move.style.cssText="color:#65717d;text-align:center;font-size:11px";
  const label=document.createElement("input");label.value=item.label;label.setAttribute("aria-label",axis+" grid line label "+(index+1));label.style.cssText="min-width:0;width:100%;padding:6px;border:1px solid #c4cfd7;border-radius:4px;background:#fbfcfd;color:#26313b;font-weight:600";
  label.addEventListener("change",()=>{const v=label.value.trim();if(v){item.label=v;syncGridPositionSpacing()}else label.value=item.label});
  const distanceWrap=document.createElement("label");distanceWrap.style.cssText="display:flex;align-items:center;gap:5px;min-width:0;font-size:11px;color:#65717d";
  const caption=document.createElement("span");caption.textContent="Distance:";caption.style.whiteSpace="nowrap";
  const distance=document.createElement("input");distance.type="number";distance.min="0";distance.step="1";distance.value=String(Math.round(item.distance));distance.setAttribute("aria-label",axis+" grid line distance in mm");distance.style.cssText="min-width:0;width:100%;padding:6px;border:1px solid #c4cfd7;border-radius:4px;background:"+(index===0?"#eef1f3":"#fbfcfd")+";color:#26313b";distance.disabled=index===0;
  distance.addEventListener("change",()=>{if(index===0){item.distance=0;distance.value="0";return}const next=Math.max(1,Number(distance.value)||1);item.distance=next;distance.value=String(Math.round(next));syncGridPositionSpacing()});
  distanceWrap.append(caption,distance);row.append(move,label,distanceWrap);rows.append(row);
 });
 const add=$(axis==="horizontal"?"gridHorizontalAdd":"gridVerticalAdd"),remove=$(axis==="horizontal"?"gridHorizontalRemove":"gridVerticalRemove");
 add.disabled=items.length>=30;remove.disabled=items.length<=2;
}
function syncGridPositionSpacing(){
 for(const [axis,hiddenId,labelId] of [["horizontal","gridSystemY","gridSystemXLabel"],["vertical","gridSystemX","gridSystemYLabel"]]){
  const items=gridPositionState[axis];
  $(hiddenId).value=items.slice(1).map(item=>Math.max(1,Math.round(item.distance))).join(", ");
  $(labelId).value=items[0]?.label||(axis==="horizontal"?"A":"1");
 }
}
function distributeGridPositions(axis){
 const items=gridPositionState[axis],count=Math.max(2,Math.min(30,Number($(axis==="horizontal"?"gridHorizontalCount":"gridVerticalCount").value)||items.length));
 if(items.length<2)return;
 const total=items.slice(1).reduce((sum,item)=>sum+Math.max(1,Number(item.distance)||1),0);
 const interval=Math.max(1,Math.round(total/(count-1)));
 const labels=items.map(x=>x.label),next=[{label:labels[0]||(axis==="horizontal"?"A":"1"),distance:0}];
 for(let i=1;i<count;i++)next.push({label:labels[i]||(axis==="horizontal"?gridLetters(i):String(i+1)),distance:interval});
 gridPositionState[axis]=next;renderGridPositionRows(axis);syncGridPositionSpacing();
}
function initGridPositionEditors(){
 gridPositionState.horizontal=gridDefaultPositions("gridSystemY");
 gridPositionState.vertical=gridDefaultPositions("gridSystemX");
 // Archicad convention: horizontal axes use letters, vertical axes use numbers.
 gridPositionState.horizontal.forEach((v,i)=>v.label=i===0?"A":gridLetters(i));
 gridPositionState.vertical.forEach((v,i)=>v.label=String(i+1));
 renderGridPositionRows("horizontal");renderGridPositionRows("vertical");syncGridPositionSpacing();
}
$("gridHorizontalAdd").addEventListener("click",()=>{const a=gridPositionState.horizontal;if(a.length>=30)return;const last=a[a.length-1];a.push({label:gridLetters(a.length),distance:Math.max(1000,Number(last.distance)||4000)});renderGridPositionRows("horizontal");syncGridPositionSpacing()});
$("gridVerticalAdd").addEventListener("click",()=>{const a=gridPositionState.vertical;if(a.length>=30)return;const last=a[a.length-1];a.push({label:String(a.length+1),distance:Math.max(1000,Number(last.distance)||4000)});renderGridPositionRows("vertical");syncGridPositionSpacing()});
$("gridHorizontalRemove").addEventListener("click",()=>{if(gridPositionState.horizontal.length<=2)return;gridPositionState.horizontal.pop();renderGridPositionRows("horizontal");syncGridPositionSpacing()});
$("gridVerticalRemove").addEventListener("click",()=>{if(gridPositionState.vertical.length<=2)return;gridPositionState.vertical.pop();renderGridPositionRows("vertical");syncGridPositionSpacing()});
for(const axis of ["horizontal","vertical"]){const check=$(axis==="horizontal"?"gridHorizontalDistribute":"gridVerticalDistribute"),count=$(axis==="horizontal"?"gridHorizontalCount":"gridVerticalCount");check.addEventListener("change",()=>{count.disabled=!check.checked;if(check.checked)distributeGridPositions(axis)});count.addEventListener("change",()=>{if(check.checked)distributeGridPositions(axis)})}
gridSystemDialog.addEventListener("close",()=>{if(!pendingGridSystem)initGridPositionEditors()});
gridSystemDialog.addEventListener("close",()=>{gridSystemDialog.style.left="50%";gridSystemDialog.style.top="50%";gridSystemDialog.style.transform="translate(-50%,-50%)"});

$("gridSystemCancel").addEventListener("click",()=>$("gridSystemDialog").close());
$("gridSystemForm").addEventListener("submit",e=>{e.preventDefault();const parseSpacing=id=>$(id).value.split(",").map(v=>Number(v.trim())/1000).filter(v=>Number.isFinite(v));const xSpacing=parseSpacing("gridSystemX"),ySpacing=parseSpacing("gridSystemY");if(!xSpacing.length||!ySpacing.length||xSpacing.length>29||ySpacing.length>29||[...xSpacing,...ySpacing].some(v=>v<=0||v>100)){ $("status").textContent="Enter positive axis spacings in metres (maximum 29 intervals per direction)";return}const xLabel=$("gridSystemXLabel").value.trim()||"A",yLabel=$("gridSystemYLabel").value.trim()||"1";if(!/^[A-Za-z]+$/.test(xLabel)&&!/^[0-9]+$/.test(xLabel)){$("status").textContent="X-axis label must start with letters or numbers";return}if(!/^[A-Za-z]+$/.test(yLabel)&&!/^[0-9]+$/.test(yLabel)){$("status").textContent="Y-axis label must start with letters or numbers";return}pendingGridSystem={xSpacing,ySpacing,xLabel,yLabel,horizontalLabels:gridPositionState.horizontal.map(v=>v.label),verticalLabels:gridPositionState.vertical.map(v=>v.label),markerRadius:Math.max(4,Math.min(20,Number($("gridSystemMarker").value)||10)),extension:Math.max(0,Math.min(5,(Number($("gridSystemExtension").value)||4000)/1000)),markerSides:{top:$("gridMarkerTop").checked,bottom:$("gridMarkerBottom").checked,left:$("gridMarkerLeft").checked,right:$("gridMarkerRight").checked,start:$("gridMarkerLeft").checked||$("gridMarkerTop").checked,end:$("gridMarkerRight").checked||$("gridMarkerBottom").checked},placeColumns:$("gridSystemColumns").checked,createBeams:$("gridSystemBeams").checked,createDimensions:$("gridSystemDimensions").checked,totalDimension:$("gridSystemTotalDimension").checked,chainDimensionOffset:Math.max(0,Number($("gridSystemChainDimensionOffset").value)||0),totalDimensionOffset:Math.max(0,Number($("gridSystemTotalDimensionOffset").value)||0),startCorner:$("gridSystemStartCorner").value,origin:null};$("gridSystemDialog").close();setTool("select");$("status").textContent="Grid System ready · click origin, then click to define X-axis direction";redraw()});
$("newProjectRibbon").addEventListener("click",()=>$("new").click());
$("contextHeight").addEventListener("input",e=>{$("height").value=e.target.value});
$("contextThickness").addEventListener("input",e=>{$("thickness").value=e.target.value});
$("trackerDistance").addEventListener("input",e=>{trackerDistanceOverride=e.target.value===""?null:Math.max(0,Number(e.target.value)||0);redraw()});
$("trackerAngle").addEventListener("input",e=>{trackerAngleOverride=e.target.value===""?null:Number(e.target.value)||0;redraw()});
for(const id of ["trackerDistance","trackerAngle"]){$(id).addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();e.stopPropagation();const created=confirmTrackerAndDraw();if(created)e.target.blur()} });$(id).addEventListener("focus",()=>{$(id).select()})}
// Keep keyboard navigation inside the Dynamic Tracker while drawing.


document.addEventListener("keydown",e=>{const distance=$("trackerDistance"),angle=$("trackerAngle"),tracker=$("dynamicTracker");if(tracker.hidden||view!=="floor"||!draft.length||!["wall","beam","dimension","slab"].includes(tool))return;const inTracker=e.target===distance||e.target===angle;if(e.key==="Tab"&&e.shiftKey&&!inTracker){e.preventDefault();e.stopPropagation();distance.focus();return}if(e.key==="Tab"&&inTracker){e.preventDefault();e.stopPropagation();(e.shiftKey?(e.target===angle?distance:angle):(e.target===distance?angle:distance)).focus()}},true);
$("wallGeometryMethod").addEventListener("change",e=>{wallGeometryMethod=e.target.value;updateContextUI();redraw();$("status").textContent="Wall geometry method: "+e.target.options[e.target.selectedIndex].text});
$("height").addEventListener("input",()=>{if(document.activeElement!==$("contextHeight"))$("contextHeight").value=$("height").value});
$("thickness").addEventListener("input",()=>{if(document.activeElement!==$("contextThickness"))$("contextThickness").value=$("thickness").value});
$("scaleSelect").addEventListener("change",e=>{drawingScaleDenominator=Math.max(1,Number(e.target.value)||100);applyViewportZoom();$("viewLabel").textContent=story().name+" · 1:"+drawingScaleDenominator;redraw();updateZoomReadout()});
$("gridQuick").addEventListener("change",e=>{$("grid").value=e.target.value;redraw()});
$("grid").addEventListener("change",syncGridOptions);
$("snapToggle").addEventListener("click",e=>{p.settings=p.settings||{};p.settings.snap=p.settings.snap===false;const on=p.settings.snap!==false;e.currentTarget.classList.toggle("active",on);e.currentTarget.setAttribute("aria-pressed",String(on));$("status").textContent=on?"Endpoint snapping enabled":"Endpoint snapping disabled"});
$("gridToggle").addEventListener("click",e=>{gridVisible=!gridVisible;e.currentTarget.classList.toggle("active",gridVisible);e.currentTarget.setAttribute("aria-pressed",String(gridVisible));redraw()});
$("zoomIn").addEventListener("click",()=>{if(view==="floor"&&draft.length){$("status").textContent="Finish the current element or press Esc before zooming";return}if(view==="3d")camera3d.zoom=Math.min(5,camera3d.zoom*1.15);else{viewportZoom=Math.min(5,viewportZoom*1.15);applyViewportZoom()}redraw();updateZoomReadout()});
$("mobileZoomIn")?.addEventListener("click",()=>{if(view!=="3d")setView("3d");camera3d.zoom=Math.min(5,camera3d.zoom*1.2);redraw();updateZoomReadout()});
$("zoomOut").addEventListener("click",()=>{if(view==="floor"&&draft.length){$("status").textContent="Finish the current element or press Esc before zooming";return}if(view==="3d")camera3d.zoom=Math.max(.2,camera3d.zoom/1.15);else{viewportZoom=Math.max(.05,viewportZoom/1.15);applyViewportZoom()}redraw();updateZoomReadout()});
$("mobileZoomOut")?.addEventListener("click",()=>{if(view!=="3d")setView("3d");camera3d.zoom=Math.max(.2,camera3d.zoom/1.2);redraw();updateZoomReadout()});
$("zoomFit").addEventListener("click",()=>{if(view==="3d")fit3d();else fitFloorPlan()});
const mobileWandButton=$("mobileMagicWand");if(mobileWandButton)mobileWandButton.addEventListener("click",()=>{const previous=tool==="magicwand"?"select":tool;setTool("magicwand");spaceMagicWandReturnTool=previous;spaceMagicWandActive=true;spaceHeld=false;$("contextToolName").textContent="Magic Wand (tap once)";$("contextToolHint").textContent="Tap inside a closed wall loop to create a Roof; then return to "+previous;updateZoomReadout()});
$("mobile3dZoomIn")?.addEventListener("click",()=>{camera3d.zoom=Math.min(5,camera3d.zoom*1.2);redraw();updateZoomReadout()});$("mobile3dZoomOut")?.addEventListener("click",()=>{camera3d.zoom=Math.max(.2,camera3d.zoom/1.2);redraw();updateZoomReadout()});$("mobile3dFit")?.addEventListener("click",()=>{fit3d();updateZoomReadout()});
try{Object.defineProperty(window,"__arqenvoDebug",{configurable:true,value:{getView:()=>view,getTool:()=>tool,getZoom:()=>camera3d.zoom,getOpeningAlignment:()=>openingAlignment,getOpeningPlacement:()=>pendingOpeningPlacement?{...pendingOpeningPlacement}:null,getSettings:()=>({...p.settings}),getViewport:()=>({scale,origin:{...origin},width:c.clientWidth,height:c.clientHeight}),getLastFloorSelectionDebug:()=>lastFloorSelectionDebug?structuredClone(lastFloorSelectionDebug):null}})}catch{}
$("scaleSelect").value=String(drawingScaleDenominator);syncGridOptions();updateZoomReadout();
window.addEventListener("beforeunload",()=>{try{localStorage.setItem(AUTOSAVE_KEY,serializeProject(p))}catch{}});
$("editCommit")?.addEventListener("click",()=>{
 if(commitAndDeselect("Finish")){if(!$("status").textContent.includes("committed"))$("status").textContent="Edit committed"}
 else{$("status").textContent="No active edit to finish"}
});
$("editBackspace")?.addEventListener("click",()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",keyCode:8,which:8,bubbles:true,cancelable:true}));});
$("editCancel")?.addEventListener("click",()=>{lastMarqueeRect=null;selectionBoxGesture=null;selected.clear();if(releasedTouchEditPending){releasedTouchEditPending=false;if(releasedTouchEditSnapshot){try{const snapshot=JSON.parse(releasedTouchEditSnapshot);if(snapshot&&Array.isArray(snapshot.elements)){modelHistory.discardLast(snapshot);p=snapshot;activeStoryId=p.stories.some(v=>v.id===activeStoryId)?activeStoryId:p.stories[0].id}else{const current=els();current.splice(0,current.length,...snapshot)}}catch(error){console.error("Could not restore touch edit snapshot",error)}}releasedTouchEditSnapshot=null;updateEditActions();scheduleAutoSave();renderProperties();redraw();$("status").textContent="Element edit cancelled";return}if(finishElementEditGesture("cancel")){releasedTouchEditPending=false;updateEditActions();return}if(pendingOpeningPlacement){openingPlacement.cancel();pendingOpeningPlacement=null;releasedTouchEditPending=false;updateEditActions();redraw();$("status").textContent="Opening placement cancelled";return}if(cancelProvisionalDrawing()){$("status").textContent="Drawing cancelled · provisional elements removed";releasedTouchEditPending=false;updateEditActions();return}draft=[];floorDrawGesture=null;wallChainStart=null;wallChainPoints=[];wallChainHasSegment=false;trackerDistanceOverride=null;trackerAngleOverride=null;releasedTouchEditPending=false;updateEditActions();redraw();$("status").textContent="Command cancelled"});
window.addEventListener("keyup",e=>{if(e.key==="Shift"){shiftHeld=false;shiftAngleLock=null;if(draft.length&&view==="floor")redraw()}if(e.code==="Space"){spaceHeld=false;if(spaceMagicWandActive){spaceMagicWandActive=false;tool=spaceMagicWandReturnTool||"select";spaceMagicWandReturnTool=null;document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool===tool));$("toolName").value=tool;updateContextUI();redraw();}}});window.addEventListener("blur",()=>{spaceHeld=false;if(spaceMagicWandActive){spaceMagicWandActive=false;tool=spaceMagicWandReturnTool||"select";spaceMagicWandReturnTool=null;document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool===tool));$("toolName").value=tool;updateContextUI();redraw();}isPanning=false;panStart=null;orbiting=false;lastCameraPointer=null;c.style.cursor=""});window.addEventListener("resize",resize);// Mount live element settings inside the horizontal Info Box, matching Archicad's contextual palette.
(()=>{const ribbon=$("contextToolbar"),info=$("selectionInfo"),props=$("elementProperties");if(!ribbon||!info||!props)return;const group=document.createElement("div");group.className="context-selection-settings";group.id="contextSelectionSettings";const count=document.createElement("div");count.className="context-selection-count";count.id="contextSelectionCountLive";group.append(count,info,props);const fill=ribbon.querySelector(".context-fill");ribbon.insertBefore(group,fill||null);info.classList.add("context-selection-count-source");props.classList.add("context-properties");const sync=()=>{count.textContent=info.textContent||"No selection";count.hidden=!info.textContent;};new MutationObserver(sync).observe(info,{childList:true,characterData:true,subtree:true});sync()})();

/* ARQENVO contextual Pet Palette: actions follow the current selection and never alter selection just by opening. */
(()=>{
 const canvas=$("canvas");if(!canvas)return;
 const style=document.createElement("style");
 style.textContent=`
 #arqPetPalette{position:fixed;z-index:99970;display:none;align-items:center;gap:4px;padding:6px;background:linear-gradient(180deg,#ffffff,#f1f5f7);border:1px solid #c5d0d8;border-radius:9px;box-shadow:0 8px 24px #24374620;color:#344653;max-width:min(94vw,560px);overflow-x:auto;white-space:nowrap;cursor:default;touch-action:none}
 #arqPetPalette .pet-drag-handle{display:flex;align-items:center;justify-content:center;width:14px;align-self:stretch;flex:none;color:#738795;cursor:grab;font-size:17px;touch-action:none;user-select:none}
 #arqPetPalette .pet-separator{background:#d3dce2}
 #arqPetPalette button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-width:43px;height:46px;padding:4px 5px;border:1px solid transparent;border-radius:6px;background:transparent;color:#455967;font:10px/1.1 Inter,Arial,sans-serif;pointer-events:auto;touch-action:manipulation;position:relative;z-index:1}
 #arqPetPalette button svg{width:19px;height:19px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
 #arqPetPalette button svg rect,#arqPetPalette button svg circle{fill:none;stroke:currentColor}
 #arqPetPalette button:hover,#arqPetPalette button:focus-visible{background:#e3f3f4;border-color:#acd8dc;color:#087e8b;outline:none}
 #arqElementSettingsModal{background:rgba(31,45,56,.28)!important;color:#273640!important}
 #arqElementSettingsModal>div{background:#f5f7f8!important;color:#273640!important;border:1px solid #cbd5dc!important;box-shadow:0 22px 64px #24374630!important}
 #arqElementSettingsModal [data-settings-header]{background:linear-gradient(180deg,#ffffff,#edf2f5)!important;color:#263844!important;border-color:#d4dde3!important}
 #arqElementSettingsModal [data-settings-footer]{background:#f0f4f6!important;color:#344653!important;border-color:#d4dde3!important}
 #arqElementSettingsModal button{background:#ffffff!important;color:#344653!important;border-color:#c6d1d9!important}
 #arqElementSettingsModal button:hover{background:#e8f5f5!important;border-color:#8fcbd0!important}
 #arqElementSettingsModal input,#arqElementSettingsModal select,#arqElementSettingsModal textarea{background:#ffffff!important;color:#273640!important;border:1px solid #c5d0d8!important;color-scheme:light}
 #arqElementSettingsModal label,#arqElementSettingsModal p,#arqElementSettingsModal small,#arqElementSettingsModal span{color:#455967}
 #arqElementSettingsModal [style*="background:#fff"],#arqElementSettingsModal [style*="background: #fff"],#arqElementSettingsModal [style*="background:#f"],#arqElementSettingsModal [style*="background: #f"]{background:#f8fafb!important}
 #arqElementSettingsModal [style*="border-bottom"],#arqElementSettingsModal [style*="border-top"]{border-color:#dbe3e8!important}
 #arqElementSettingsModal input:focus,#arqElementSettingsModal select:focus,#arqElementSettingsModal textarea:focus{outline:2px solid #6dbfc5!important;outline-offset:1px}
`;
 document.head.appendChild(style);
 const palette=document.createElement("div");palette.id="arqPetPalette";palette.setAttribute("role","toolbar");palette.setAttribute("aria-label","Contextual element actions");document.body.appendChild(palette);
 const icons={
 move:'<svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20M12 2 9 5m3-3 3 3M22 12l-3-3m3 3-3 3M12 22l-3-3m3 3 3-3M2 12l3-3m-3 3 3 3"/></svg>',
 rotate:'<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0 1 4M20 4v7h-7"/></svg>',
 mirror:'<svg viewBox="0 0 24 24"><path d="M12 2v20M4 6h5v12H4zM15 6h5v12h-5z"/></svg>',
 multiply:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="11" height="11" rx="1"/><rect x="10" y="10" width="11" height="11" rx="1"/></svg>',
 settings:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="m19 13 2 1-2 4-2-1-2 2v2H9v-2l-2-2-2 1-2-4 2-1v-2l-2-1 2-4 2 1 2-2V3h6v2l2 2 2-1 2 4-2 1z"/></svg>',
 stretch:'<svg viewBox="0 0 24 24"><path d="M3 12h18M3 12l4-4m-4 4 4 4M21 12l-4-4m4 4-4 4"/></svg>',
 offset:'<svg viewBox="0 0 24 24"><path d="M4 19 19 4M5 5h6M5 5v6M19 19h-6M19 19v-6"/></svg>',
 insertNode:'<svg viewBox="0 0 24 24"><path d="M3 12h18M12 3v18"/><circle cx="12" cy="12" r="3"/></svg>'
 };
 const actions=[
  {key:"stretchWall",label:"Stretch",icon:"stretch",types:["wall"],single:true,context:["node"]},
  {key:"offsetWall",label:"Offset",icon:"offset",types:["wall"],single:true,context:["edge"]},
  {key:"insertWallNode",label:"Insert Node",icon:"insertNode",types:["wall"],single:true,context:["edge"]},
  {key:"moveSelection",label:"Move",icon:"move",types:["wall","slab","zone","column","beam","roof","door","window","gridline","dimension","room"]},
  {key:"rotateSelection",label:"Rotate",icon:"rotate",types:["wall","slab","zone","column","beam","roof","gridline","dimension","room"]},
  {key:"mirrorSelection",label:"Mirror",icon:"mirror",types:["wall","slab","zone","column","beam","roof","gridline","dimension","room"]},
  {key:"copySelection",label:"Multiply",icon:"multiply",types:["wall","slab","zone","column","beam","roof","door","window","gridline","dimension","room"]},
  {key:"settings",label:"Settings",icon:"settings",types:["wall","slab","zone","column","beam","roof","door","window","gridline","dimension","room"],context:["node","edge"]}
 ];
 const hide=()=>{palette.style.display="none";palette.dataset.forSelection="";palette.dataset.context="";palette.dataset.kind="";lastContextKey="";};
 const selectionKey=list=>list.map(el=>el.id).sort().join("|");
 let renderQueued=false,lastContextKey="",lastValidContext=null;
 const currentContext=()=>{
  const list=chosen(),sel=selectionKey(list);
  if(!list.length||view!=="floor"||tool!=="select"||elementSettingsModal?.style.display==="flex")return {key:"",list,kind:"none"};
  const pointer=mouse&&Number.isFinite(mouse.x)&&Number.isFinite(mouse.y)?mouse:null,candidates=[];
  if(pointer)for(const el of list){
   for(const point of elementEditablePoints(el)){const screen=spos(point.point),dist=Math.hypot(screen.x-pointer.x,screen.y-pointer.y);if(dist<=15)candidates.push({el,key:point.key,index:point.index,dist})}
  }
  candidates.sort((a,b)=>a.dist-b.dist);
  const node=candidates[0]||null;
  let edge=null;
  if(pointer&&!node)for(const el of list)for(const segment of elementEditableEdges(el)){const world=wpos(pointer),dist=pointSegmentDistance(world,segment.a.point,segment.b.point);if(dist<=12/Math.max(1,scale)&&(!edge||dist<edge.dist)){const a=segment.a.point,b=segment.b.point,dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((world.x-a.x)*dx+(world.y-a.y)*dy)/den)):0;edge={el,segment,dist,point:{x:a.x+t*dx,y:a.y+t*dy}}}}
  const context=node?"node":edge?"edge":"none";
  if(context==="none"){
   // Keep the last valid node/edge context while the pointer travels from the
   // drawing to the floating palette. This prevents the palette actions from
   // disappearing or changing underneath the pointer before a button is clicked.
   if(palette.style.display==="flex"&&palette.dataset.forSelection===sel&&lastValidContext)return {...lastValidContext,list};
   return {key:"",list:[],kind:"none"};
  }
  const result={key:sel+"|"+context+"|"+(node?node.el.id+":"+node.key+":"+node.index:edge.el.id+":"+edge.segment.a.key+":"+edge.segment.a.index),list,kind:context,edge};
  lastValidContext=result;
  return result;
 };
 const positionPalette=()=>{
  const rect=canvas.getBoundingClientRect(),anchor=mouse&&Number.isFinite(mouse.x)&&Number.isFinite(mouse.y)?{x:rect.left+mouse.x,y:rect.top+mouse.y}:{x:rect.left+rect.width/2,y:rect.top+rect.height/2},w=palette.offsetWidth,h=palette.offsetHeight;
  const left=Math.max(6,Math.min(window.innerWidth-w-6,anchor.x+14));
  const top=Math.max(6,Math.min(window.innerHeight-h-6,anchor.y+h+16<window.innerHeight?anchor.y+16:anchor.y-h-14));
  palette.style.left=left+"px";palette.style.top=top+"px";
 };
 const render=()=>{
  const context=currentContext();
  if(!context.list.length){
   // Once opened for a selection, keep the palette reachable while the pointer travels
   // from the geometry to the floating toolbar. Hide only when selection/mode changes.
   const sameSelection=palette.style.display==="flex"&&palette.dataset.forSelection===selectionKey(chosen())&&view==="floor"&&tool==="select"&&elementSettingsModal?.style.display!=="flex";
   if(sameSelection)return;
   hide();lastContextKey="";lastValidContext=null;palette.dataset.positioned="";palette.dataset.userMoved="";return;
  }
  if(context.key===lastContextKey&&palette.style.display==="flex")return;
  const {list}=context,types=[...new Set(list.map(el=>el.type))],relevant=actions.filter(action=>types.every(type=>action.types.includes(type))&&(!action.single||list.length===1)&&(!action.context||action.context.includes(context.kind)));
  // Geometry-specific edits must never silently fall through to whole-selection transforms.
  const contextActions=context.kind==="node"||context.kind==="edge";
  const safeActions=contextActions?relevant.filter(action=>!action.context||action.context.includes(context.kind)):relevant;
  palette.replaceChildren();
  const handle=document.createElement("span");handle.className="pet-drag-handle";handle.title="Drag palette";handle.setAttribute("aria-label","Drag palette");handle.textContent="⠿";palette.append(handle);
  safeActions.forEach((action,index)=>{
   if(index===4){const sep=document.createElement("span");sep.className="pet-separator";palette.append(sep)}
   const button=document.createElement("button");button.type="button";button.dataset.action=action.key;button.innerHTML=icons[action.icon]+'<span>'+action.label+'</span>';button.title=action.label;button.setAttribute("aria-label",action.label);
   button.addEventListener("pointerdown",event=>event.stopPropagation());
   button.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();if(action.key==="settings"){hide();openElementSettings();return}if(action.key==="stretchWall"){hide();stretchSelectedWall();return}if(action.key==="offsetWall"){hide();offsetSelectedWall();return}if(action.key==="insertWallNode"){const ctx=currentContext(),edge=ctx.kind==="edge"?ctx.edge:null;hide();insertNodeIntoSelectedWall(edge?.point);return}const command=$(action.key);if(command){hide();command.click();return}$("status").textContent=action.label+" is not available for this selection yet"});
   palette.append(button);
  });
  palette.dataset.context=context.key;palette.dataset.forSelection=selectionKey(list);palette.dataset.kind=context.kind;lastContextKey=context.key;
  palette.style.display="flex";if(!palette.dataset.positioned){positionPalette();palette.dataset.positioned="true"}
 };

 let drag=null;
 palette.addEventListener("pointerdown",e=>{if(e.target.closest("button")||e.target.closest(".pet-drag-handle")===null)return;const r=palette.getBoundingClientRect();drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:r.left,top:r.top};palette.setPointerCapture?.(e.pointerId);palette.style.cursor="grabbing";e.preventDefault();e.stopPropagation()});
 palette.addEventListener("pointermove",e=>{if(!drag||drag.id!==e.pointerId)return;const left=Math.max(4,Math.min(innerWidth-palette.offsetWidth-4,drag.left+e.clientX-drag.x)),top=Math.max(4,Math.min(innerHeight-palette.offsetHeight-4,drag.top+e.clientY-drag.y));palette.style.left=left+"px";palette.style.top=top+"px";palette.dataset.userMoved="true"});
 const finishDrag=e=>{if(!drag||drag.id!==e.pointerId)return;drag=null;palette.style.cursor="default"};palette.addEventListener("pointerup",finishDrag);palette.addEventListener("pointercancel",finishDrag);
 // Treat the floating palette as an interactive surface, not as part of the canvas
 // hit-test. Pointer travel over its controls must never clear the geometry context.
 palette.addEventListener("pointerenter",()=>{palette.dataset.pointerInside="true"});
 palette.addEventListener("pointerleave",()=>{delete palette.dataset.pointerInside});
 document.addEventListener("pointermove",e=>{
  if(e.target===canvas){const r=canvas.getBoundingClientRect();mouse={x:e.clientX-r.left,y:e.clientY-r.top};queueRenderContext()}
 },{passive:true});
 function queueRenderContext(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;render()})}
 window.addEventListener("resize",()=>{if(palette.style.display==="flex")positionPalette()});
 document.addEventListener("keydown",e=>{if(e.key==="Escape")hide()});
 const originalRenderProperties=renderProperties;
 renderProperties=function(){originalRenderProperties();render()};
 const drawEditHandles=()=>{
  if(view!=="floor"||layoutMode||tool!=="select"||!chosen().length)return;
  x.save();x.lineWidth=1.4;
  for(const el of chosen()){
   if(!isLayerVisible(el)||el.storyId!==story().id)continue;
   for(const point of elementEditablePoints(el)){
    const sp=spos(point.point);x.beginPath();x.arc(sp.x,sp.y,4.2,0,Math.PI*2);x.fillStyle="#ffffff";x.fill();x.strokeStyle="#087e8b";x.stroke();
   }
   for(const edge of elementEditableEdges(el)){
    const mid={x:(edge.a.point.x+edge.b.point.x)/2,y:(edge.a.point.y+edge.b.point.y)/2},sp=spos(mid);x.fillStyle="#087e8b";x.fillRect(sp.x-2.5,sp.y-2.5,5,5);
   }
  }
  x.restore();
 };
 const originalRedraw=redraw;
 redraw=function(){originalRedraw();drawEditHandles();render()};
 render();
})();

setTool("select");refreshStories();renderProperties();for(const sheet of p.layouts||[])ensureLayoutDefaults(sheet);activeLayoutId=p.layouts?.some(s=>s.id===activeLayoutId)?activeLayoutId:(p.layouts?.[0]?.id||null);activeLayoutDrawingId=layoutSheet()?.drawings?.[0]?.id||null;renderLayoutList();resize();updateEditActions();

/* Canonical palette manager — one bounded state model for docked and floating panels. */
(()=>{
 const work=document.querySelector('.work'),toolbox=document.getElementById('toolbox'),nav=work?.querySelector(':scope > .navigator');
 if(!work||!toolbox||!nav)return;
 const panels={toolbox,navigator:nav},coarse=()=>matchMedia('(pointer:coarse)').matches,desktop=()=>matchMedia('(min-width:901px) and (pointer:fine)').matches;
 const clamp=(n,min,max)=>Math.max(min,Math.min(Math.max(min,max),Number.isFinite(n)?n:min));
 const read=(key,fallback,min,max)=>{try{const n=Number(localStorage.getItem('arqenvo-'+key));return Number.isFinite(n)&&n>=min&&n<=max?n:fallback}catch{return fallback}};
 const dims={toolbox:{w:read('toolbox-width',coarse()?48:156,48,420),h:read('toolbox-height',220,140,1200)},navigator:{w:read('navigator-width',coarse()?220:238,180,520),h:read('navigator-height',240,140,1000)},inspector:{w:read('inspector-width',238,200,420),h:read('inspector-height',240,140,1000)}};
 const defaults={toolbox:{mode:'dock',side:'left'},navigator:{mode:'dock',side:'right'}},state={},layoutVersion=2;
 for(const key of Object.keys(panels)){
  let saved=null;try{saved=JSON.parse(localStorage.getItem('arqenvo-palette-'+key)||'null')}catch{}
  const d=defaults[key],sz=dims[key],valid=saved?.version===layoutVersion;
  state[key]={version:layoutVersion,mode:valid&&saved?.mode==='float'?'float':'dock',side:valid&&['left','right','top','bottom'].includes(saved?.side)?saved.side:d.side,x:valid&&Number.isFinite(saved?.x)?saved.x:(key==='toolbox'?4:Math.max(4,work.clientWidth-sz.w-4)),y:valid&&Number.isFinite(saved?.y)?saved.y:4,w:valid&&Number.isFinite(saved?.w)?saved.w:sz.w,h:valid&&Number.isFinite(saved?.h)?saved.h:sz.h,dockRect:null};
 }
 const save=key=>{try{const {dockRect,...persisted}=state[key];localStorage.setItem('arqenvo-palette-'+key,JSON.stringify({...persisted,version:layoutVersion}))}catch{}};
 const saveDims=key=>{try{localStorage.setItem('arqenvo-'+key+'-width',String(dims[key].w));localStorage.setItem('arqenvo-'+key+'-height',String(dims[key].h))}catch{}};
 function bounds(key){const s=state[key],minW=key==='toolbox'?124:180;s.w=clamp(s.w,minW,Math.max(minW,work.clientWidth-8));s.h=clamp(s.h,140,Math.max(140,work.clientHeight-8));s.x=clamp(s.x,4,Math.max(4,work.clientWidth-s.w-4));s.y=clamp(s.y,4,Math.max(4,work.clientHeight-s.h-4))}
 function applyFloatBounds(key){const s=state[key],p=panels[key];bounds(key);p.style.setProperty('--arq-float-left',s.x+'px');p.style.setProperty('--arq-float-top',s.y+'px');p.style.setProperty('--arq-float-width',s.w+'px');p.style.setProperty('--arq-float-height',s.h+'px')}
 function clearFloatStyles(p){p.classList.remove('arq-palette-floating');['left','top','right','bottom','width','height','max-height','max-width','min-width','min-height'].forEach(x=>p.style.removeProperty(x));['--arq-float-left','--arq-float-top','--arq-float-width','--arq-float-height'].forEach(x=>p.style.removeProperty(x))}
 function positionDockGrip(key){
  const panel=panels[key],grip=work.querySelector('.arq-dock-resize[data-palette="'+key+'"]');
  if(!panel||!grip)return;
  const s=state[key],wr=work.getBoundingClientRect(),pr=panel.getBoundingClientRect(),canvas=work.querySelector('.workspace')?.getBoundingClientRect();
  if(s.mode!=='dock'||!wr.width||!wr.height||getComputedStyle(panel).display==='none'||pr.width<1||pr.height<1){grip.style.display='none';return}
  grip.style.display='block';grip.style.position='absolute';grip.style.right='auto';grip.style.bottom='auto';
  const horizontalDock=s.side==='top'||s.side==='bottom';
  if(horizontalDock){
   const above=canvas?pr.bottom<=canvas.top+2:s.side==='top';
   const edgeY=(above?pr.bottom:pr.top)-wr.top;
   grip.style.left=Math.max(0,pr.left-wr.left)+'px';grip.style.top=(edgeY-6)+'px';
   grip.style.width=Math.max(0,pr.width)+'px';grip.style.height='12px';grip.style.cursor='ns-resize';
  }else{
   const leftOfCanvas=canvas?pr.right<=canvas.left+2:s.side!=='right';
   const edgeX=(leftOfCanvas?pr.right:pr.left)-wr.left;
   grip.style.left=(edgeX-6)+'px';grip.style.top=Math.max(0,pr.top-wr.top)+'px';
   grip.style.width='12px';grip.style.height=Math.max(0,pr.height)+'px';grip.style.cursor='ew-resize';
  }
 }
 function applyGrid(){
  for(const c of [...work.classList])if(/^dock-(toolbox|navigator)-(left|right|top|bottom)$/.test(c))work.classList.remove(c);
  work.classList.toggle('toolbox-floating',state.toolbox.mode==='float');work.classList.toggle('navigator-floating',state.navigator.mode==='float');
  work.style.setProperty('--toolbox-width',dims.toolbox.w+'px');work.style.setProperty('--navigator-width',dims.navigator.w+'px');work.style.setProperty('--inspector-width',dims.inspector.w+'px');
  work.style.setProperty('--palette-toolbox-w',dims.toolbox.w+'px');work.style.setProperty('--palette-nav-w',dims.navigator.w+'px');work.style.setProperty('--palette-inspector-w',dims.inspector.w+'px');work.style.setProperty('--palette-toolbox-h',dims.toolbox.h+'px');work.style.setProperty('--palette-nav-h',dims.navigator.h+'px');
  for(const key of Object.keys(panels)){const s=state[key],p=panels[key];if(s.mode==='float'){p.classList.add('arq-palette-floating');applyFloatBounds(key)}else{clearFloatStyles(p);if(s.side!==(key==='toolbox'?'left':'right'))work.classList.add('dock-'+key+'-'+s.side)}positionDockGrip(key)}
  work.classList.toggle('toolbox-expanded',coarse()&&(dims.toolbox.w>72||state.toolbox.mode==='float'));
 }
 function setMode(key,mode,side,x,y){const s=state[key],p=panels[key];if(mode==='dock'&&s.mode==='float'){const r=p.getBoundingClientRect();if(r.width>0&&r.height>0){s.w=r.width;s.h=r.height;dims[key].w=r.width;dims[key].h=r.height;saveDims(key)}}s.mode=mode;if(side)s.side=side;if(Number.isFinite(x))s.x=x;if(Number.isFinite(y))s.y=y;if(mode==='float')bounds(key);else{dims[key].w=s.w;dims[key].h=s.h}applyGrid();save(key);saveDims(key)}
 function dockSideAt(clientX,clientY,key){const r=work.getBoundingClientRect(),x=clientX-r.left,y=clientY-r.top,edge=Math.max(28,Math.min(48,Math.round(Math.min(r.width,r.height)*.045)));if(y<=edge)return'top';if(y>=r.height-edge)return'bottom';if(x<=edge)return'left';if(x>=r.width-edge)return'right';return null}
 function addDrag(key,panel,handle){
  if(!handle)return;
  handle.classList.add('arq-palette-drag-handle');
  handle.setAttribute('data-arq-drag-handle',key);
  handle.title='Drag to move. Drop near any workspace edge to dock';
  let drag=null,active=false;
  const remove=()=>{if(!active)return;active=false;document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',finish,true);document.removeEventListener('pointercancel',cancel,true)};
  const move=e=>{
   if(!drag||drag.id!==e.pointerId)return;
   if(!drag.moved&&Math.hypot(e.clientX-drag.sx,e.clientY-drag.sy)<5)return;
   if(!drag.moved){
    drag.moved=true;
    const s=state[key],r=panel.getBoundingClientRect(),wr=work.getBoundingClientRect();
    const minW=key==='toolbox'?220:280,preferredW=key==='toolbox'?280:320,preferredH=key==='toolbox'?480:560;
    // Capture the real dock slot exactly once, before the panel/layout reflows.
    if(drag.originMode==='dock')s.dockRect=drag.dockRect||{left:r.left,top:r.top,right:r.right,bottom:r.bottom};
    s.mode='float';s.x=r.left-wr.left;s.y=r.top-wr.top;
    s.w=clamp(Math.max(minW,preferredW),minW,Math.max(minW,work.clientWidth-8));
    s.h=clamp(preferredH,220,Math.max(220,work.clientHeight-8));
    applyGrid();
   }
   const wr=work.getBoundingClientRect(),s=state[key];
   s.x=e.clientX-wr.left-drag.ox;s.y=e.clientY-wr.top-drag.oy;
   applyFloatBounds(key);
  };
  const finish=e=>{
   if(!drag||drag.id!==e.pointerId)return;
   const d=drag;drag=null;remove();
   if(!d.moved)return;
   const wr=work.getBoundingClientRect(),edge=Math.max(28,Math.min(48,Math.round(Math.min(wr.width,wr.height)*.045)));
   const side=dockSideAt(e.clientX,e.clientY,key);
   if(side){setMode(key,'dock',side);return}
   const origin=d.dockRect;
   const returnedToOrigin=!!origin&&e.clientX>=origin.left-24&&e.clientX<=origin.right+24&&e.clientY>=origin.top-24&&e.clientY<=origin.bottom+24;
   const originalSide=d.dockSide||d.originSide||state[key].side||(key==='toolbox'?'left':'right');
   // The docked pane occupies a full-height track while floating panes use
   // their own bounded rectangle. If the user releases over the remembered
   // dock slot (or the original side strip), restore the dock directly.
   const edgePad=24;
   const sideStrip=originalSide==='left'?e.clientX<=wr.left+edge+edgePad:originalSide==='right'?e.clientX>=wr.right-edge-edgePad:originalSide==='top'?e.clientY<=wr.top+edge+edgePad:e.clientY>=wr.bottom-edge-edgePad;
   if(returnedToOrigin||sideStrip){setMode(key,'dock',originalSide);return}
   const r=panel.getBoundingClientRect(),s=state[key];
   s.w=r.width;s.h=r.height;bounds(key);applyGrid();save(key);saveDims(key);
  };
  const cancel=e=>{if(!drag||drag.id!==e.pointerId)return;drag=null;remove();applyGrid();save(key)};
  handle.addEventListener('pointerdown',e=>{
   if(e.pointerType==='mouse'&&e.button!==0)return;
   if(e.target.closest('input,select,a')||e.target.closest('#navigatorToggle')||(key==='toolbox'&&e.target.closest('button')))return;
   const r=panel.getBoundingClientRect();
   const dockRect=state[key].mode==='dock'?{left:r.left,top:r.top,right:r.right,bottom:r.bottom}:(state[key].dockRect?{...state[key].dockRect}:null);
   if(state[key].mode==='dock')state[key].dockRect={...dockRect};
   drag={id:e.pointerId,sx:e.clientX,sy:e.clientY,ox:e.clientX-r.left,oy:e.clientY-r.top,moved:false,originMode:state[key].mode,originSide:state[key].side,originRect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},dockRect,dockSide:state[key].side};
   active=true;
   document.addEventListener('pointermove',move,true);
   document.addEventListener('pointerup',finish,true);
   document.addEventListener('pointercancel',cancel,true);
   if(key==='toolbox')e.preventDefault();
  },true);
 } function addFloatingResize(key,panel){
  const edges=['n','e','s','w','ne','nw','se','sw'];
  for(const edge of edges){
   const grip=document.createElement('div');grip.className='arq-floating-resize edge-'+edge;grip.dataset.edge=edge;grip.setAttribute('role','separator');grip.setAttribute('aria-orientation',edge==='e'||edge==='w'?'vertical':'horizontal');grip.setAttribute('aria-label','Resize '+key+' '+edge+' edge');grip.title='Drag to resize this edge';panel.append(grip);
   let drag=null;
   const move=e=>{
    if(!drag||drag.id!==e.pointerId)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y,s=state[key];
    if(edge.includes('e'))s.w=drag.w+dx;
    if(edge.includes('s'))s.h=drag.h+dy;
    if(edge.includes('w')){s.w=drag.w-dx;s.x=drag.left+dx}
    if(edge.includes('n')){s.h=drag.h-dy;s.y=drag.top+dy}
    applyFloatBounds(key);
   };
   const done=e=>{if(!drag||drag.id!==e.pointerId)return;drag=null;grip.classList.remove('is-resizing');document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',done,true);document.removeEventListener('pointercancel',done,true);save(key);saveDims(key)};
   grip.addEventListener('pointerdown',e=>{
    if(state[key].mode!=='float'||(e.pointerType==='mouse'&&e.button!==0))return;
    const r=panel.getBoundingClientRect();drag={id:e.pointerId,x:e.clientX,y:e.clientY,w:r.width,h:r.height,left:state[key].x,top:state[key].y};
    grip.classList.add('is-resizing');document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',done,true);document.addEventListener('pointercancel',done,true);e.preventDefault();e.stopPropagation();
   });
  }
 }
 function addDockResize(key,panel){
  /* The splitter is a sibling of the scrollable palette, never a child that overflow:auto can clip or cover. */
  const grip=document.createElement('div');grip.className='arq-dock-resize '+key+'-resize';grip.dataset.palette=key;grip.setAttribute('role','separator');grip.setAttribute('aria-label','Resize docked '+key);grip.title='Drag to resize docked panel';grip.style.position='absolute';grip.style.zIndex='2000';grip.style.touchAction='none';work.append(grip);
  let drag=null;
  const remove=()=>{document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',done,true);document.removeEventListener('pointercancel',cancel,true)};
  const move=e=>{
   if(!drag||drag.id!==e.pointerId)return;
   const s=state[key],dx=e.clientX-drag.x,dy=e.clientY-drag.y;
   if(drag.axis==='x'){
    const minW=key==='toolbox'?124:180,maxW=Math.max(minW,work.clientWidth-250);
    dims[key].w=clamp(drag.w+dx*drag.sign,minW,maxW);s.w=dims[key].w;
   }else{
    const minH=140,maxH=Math.max(minH,work.clientHeight-100);
    dims[key].h=clamp(drag.h+dy*drag.sign,minH,maxH);s.h=dims[key].h;
   }
   applyGrid();
  };
  const done=e=>{if(!drag||drag.id!==e.pointerId)return;drag=null;remove();save(key);saveDims(key);applyGrid()};
  const cancel=e=>{if(!drag||drag.id!==e.pointerId)return;drag=null;remove();applyGrid()};
  grip.addEventListener('pointerdown',e=>{
   if(state[key].mode!=='dock'||(e.pointerType==='mouse'&&e.button!==0))return;
   const r=panel.getBoundingClientRect(),canvas=work.querySelector('.workspace')?.getBoundingClientRect(),vertical=state[key].side==='top'||state[key].side==='bottom';
   const sign=vertical?(canvas?(r.bottom<=canvas.top+2?1:r.top>=canvas.bottom-2?-1:(state[key].side==='bottom'?-1:1)):(state[key].side==='bottom'?-1:1)):(canvas?(r.right<=canvas.left+2?1:r.left>=canvas.right-2?-1:(state[key].side==='right'?-1:1)):(state[key].side==='right'?-1:1));
   drag={id:e.pointerId,x:e.clientX,y:e.clientY,axis:vertical?'y':'x',sign,w:r.width,h:r.height};
   try{grip.setPointerCapture(e.pointerId)}catch{}
   document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',done,true);document.addEventListener('pointercancel',cancel,true);
   e.preventDefault();e.stopPropagation();
  });
 }
 /* Docked resizing is handled only by each palette's active .arq-dock-resize splitter. */
 addDrag('toolbox',toolbox,toolbox.querySelector('.toolbox-title'));
 const navDragHandle=nav.querySelector('.section');
 if(navDragHandle){
  navDragHandle.style.touchAction='none';
  navDragHandle.style.cursor='grab';
  navDragHandle.style.pointerEvents='auto';
  addDrag('navigator',nav,navDragHandle);
 }
 for(const key of Object.keys(panels)){addFloatingResize(key,panels[key]);addDockResize(key,panels[key])}
 applyGrid();window.addEventListener('resize',()=>{for(const key of Object.keys(panels))if(state[key].mode==='float')applyFloatBounds(key);applyGrid()});
})();

// Keep the model's metre geometry precise while presenting editable lengths in the selected unit system.
const renderPropertiesWithProjectUnits=renderProperties;
renderProperties=function(){
 renderPropertiesWithProjectUnits();
 if(unitSystem()!=="imperial")return;
 const host=$("elementProperties");if(!host)return;
 for(const input of host.querySelectorAll("[data-prop],[data-multi-prop]")){
  const key=input.dataset.prop||input.dataset.multiProp;
  if(!imperialLengthKeys.has(key)||input.value.trim()==="")continue;
  const metres=Number(input.value);if(!Number.isFinite(metres))continue;
  input.dataset.originalMetres=String(metres);input.dataset.unitsFormatted="imperial";
  input.type="text";input.value=formatLength(metres,"imperial");
  const label=input.previousElementSibling;if(label?.tagName==="LABEL")label.textContent=label.textContent.replace(/\(m\)|mm/g,"(ft + in)");
  input.addEventListener("input",()=>{input.dataset.unitEdited="true"});
 }
 for(const id of ["gridStartX","gridStartY","gridEndX","gridEndY"]){
  const input=$(id);if(!input||input.dataset.unitsFormatted==="imperial")continue;
  const metres=Number(input.value);if(!Number.isFinite(metres))continue;
  input.dataset.originalMetres=String(metres);input.dataset.unitsFormatted="imperial";input.type="text";input.value=formatLength(metres,"imperial");
  const label=input.previousElementSibling;if(label?.tagName==="LABEL")label.textContent+=" (ft + in)";
  input.addEventListener("input",()=>{input.dataset.unitEdited="true"});
 }
};
