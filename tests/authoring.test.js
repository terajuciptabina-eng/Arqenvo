import test from "node:test";
import assert from "node:assert/strict";
import { createRoof } from "../src/core/model.js";
import { createOpeningPlacement, doorSwingGeometry, hostedOpening3dGeometry, hostedDoorLeaf3dGeometry, openingPlacementDirection, findClosedWallLoops, mergeHostedOpeningRecords, openingOffsetForAnchor, resolveHostedOpeningEdit } from "../src/core/authoring.js";

test("door swing geometry pivots at the hinge and uses opening width as radius", () => {
  const g = doorSwingGeometry({x:10,y:20},{x:11,y:20},{hingeSide:"left",swingDirection:"inside"});
  assert.deepEqual(g.hinge,{x:10,y:20});
  assert.deepEqual(g.closedFree,{x:11,y:20});
  assert.ok(Math.abs(Math.hypot(g.openFree.x-g.hinge.x,g.openFree.y-g.hinge.y)-1)<1e-9);
  assert.ok(Math.abs(Math.hypot(g.closedFree.x-g.hinge.x,g.closedFree.y-g.hinge.y)-1)<1e-9);
  assert.ok(Math.abs(Math.abs(g.sweep)-Math.PI/2)<1e-9);
});

test("door swing supports right hinge and opposite opening side", () => {
  const left = doorSwingGeometry({x:0,y:0},{x:0,y:0.9},{hingeSide:"left",swingDirection:"inside"});
  const right = doorSwingGeometry({x:0,y:0},{x:0,y:0.9},{hingeSide:"right",swingDirection:"inside"});
  assert.deepEqual(left.hinge,{x:0,y:0});
  assert.deepEqual(right.hinge,{x:0,y:0.9});
  assert.ok(Math.abs(Math.hypot(right.openFree.x-right.hinge.x,right.openFree.y-right.hinge.y)-0.9)<1e-9);
  assert.ok(left.sweep * right.sweep < 0);
});

test("cursor side follows wall direction consistently for horizontal and vertical walls", () => {
  assert.equal(openingPlacementDirection({x:0,y:0},{x:4,y:0},{x:2,y:1}),"inside");
  assert.equal(openingPlacementDirection({x:0,y:0},{x:4,y:0},{x:2,y:-1}),"outside");
  assert.equal(openingPlacementDirection({x:0,y:0},{x:0,y:4},{x:1,y:2}),"outside");
  assert.equal(openingPlacementDirection({x:0,y:0},{x:0,y:4},{x:-1,y:2}),"inside");
});

test("opening placement does not commit until Enter/confirm and can be cancelled", () => {
  const placement = createOpeningPlacement();
  placement.begin({wallId:"w1",type:"door",offset:1,width:.9,hingeSide:"left"});
  placement.aim({x:2,y:1},{x:0,y:0},{x:4,y:0});
  assert.equal(placement.pending.phase,"aiming");
  assert.equal(placement.pending.swingDirection,"inside");
  const result = placement.confirm();
  assert.equal(result.wallId,"w1");
  assert.equal(result.phase,undefined);
  assert.equal(placement.pending,null);
  placement.begin({wallId:"w1",type:"window",offset:2,width:1.2});
  assert.equal(placement.cancel(),true);
  assert.equal(placement.confirm(),null);
});

test("placement rejects invalid starts and zero-width door symbols", () => {
  const placement = createOpeningPlacement();
  assert.throws(()=>placement.begin({type:"door"}),/host wall/);
  assert.throws(()=>doorSwingGeometry({x:0,y:0},{x:0,y:0}),/width/);
});

test("hosted door 3D leaf footprint pivots at selected hinge and follows swing side", () => {
  const wall = { start:{x:0,y:0}, end:{x:4,y:0}, thickness:.15 };
  const door = { type:"door", offset:1, width:.9, height:2.1, sill:0, hingeSide:"left", swingDirection:"inside" };
  const g = hostedOpening3dGeometry(wall,door);
  assert.equal(g.boundary.length,4);
  assert.equal(g.height,2.1);
  const hinge = {x:1,y:0};
  assert.ok(g.boundary.some(p=>Math.hypot(p.x-hinge.x,p.y-hinge.y)<.02));
  assert.ok(g.boundary.some(p=>p.y>.85));
  const outside = hostedOpening3dGeometry(wall,{...door,swingDirection:"outside"});
  assert.ok(outside.boundary.some(p=>p.y<-.85));
});

test("hosted window pane is centred on wall thickness and keeps sill height", () => {
  const wall = { start:{x:0,y:0}, end:{x:0,y:5}, thickness:.2 };
  const window = { type:"window", offset:1, width:1.2, height:1.1, sill:.9 };
  const g = hostedOpening3dGeometry(wall,window);
  assert.equal(g.zOffset,.9);
  assert.equal(g.height,1.1);
  const xs=g.boundary.map(p=>p.x);
  assert.ok(Math.min(...xs)<0&&Math.max(...xs)>0);
  assert.ok(Math.abs((Math.max(...xs)-Math.min(...xs))-.225)<1e-9);
});

test("hosted 3D opening rejects a component outside its wall", () => {
  assert.throws(()=>hostedOpening3dGeometry({start:{x:0,y:0},end:{x:2,y:0},thickness:.15},{type:"door",offset:1.8,width:.9,height:2,sill:0}),/fit/);
});

test("Magic Wand finds closed wall references and ignores open or branched networks",()=>{
 const loop=[{id:"a",type:"wall",start:{x:0,y:0},end:{x:4,y:0}},{id:"b",type:"wall",start:{x:4,y:0},end:{x:4,y:3}},{id:"c",type:"wall",start:{x:4,y:3},end:{x:0,y:3}},{id:"d",type:"wall",start:{x:0,y:3},end:{x:0,y:0}}];
 const found=findClosedWallLoops([...loop,{id:"open",type:"wall",start:{x:6,y:0},end:{x:7,y:0}}]);
 assert.equal(found.length,1);assert.equal(found[0].area,12);assert.equal(found[0].boundary.length,4);assert.deepEqual([...found[0].wallIds].sort(),["a","b","c","d"]);
 const withBranch=findClosedWallLoops([...loop,{id:"branch",type:"wall",start:{x:2,y:0},end:{x:2,y:-2}}]);
 assert.equal(withBranch.length,1,"A branch should not erase the valid closed wall perimeter");
 assert.equal(withBranch[0].area,12);
});


test("roof model preserves editable pitch, eaves elevation, thickness and wall references", () => {
 const roof=createRoof([{x:0,y:0},{x:5,y:0},{x:5,y:4},{x:0,y:4}],{elevation:3.2,pitch:25,thickness:.22,sourceWallIds:["w1","w2","w3","w4"]});
 assert.equal(roof.elevation,3.2);
 assert.equal(roof.pitch,25);
 assert.equal(roof.thickness,.22);
 assert.deepEqual(roof.sourceWallIds,["w1","w2","w3","w4"]);
});


test("hosted 3D opening rejects non-finite offsets, dimensions and invalid sill", () => {
  const wall = { start:{x:0,y:0}, end:{x:4,y:0}, thickness:.15 };
  const valid = { type:"door", offset:1, width:.9, height:2.1, sill:0 };
  for (const changes of [
    {offset:NaN},{offset:Infinity},{width:NaN},{width:Infinity},
    {height:NaN},{height:Infinity},{sill:NaN},{sill:-.1},
    {offset:-.01},{width:0},{height:0},{offset:3.2,width:1}
  ]) assert.throws(() => hostedOpening3dGeometry(wall,{...valid,...changes}), /Opening must fit/);
  assert.throws(() => hostedOpening3dGeometry({...wall,start:{x:NaN,y:0}},valid), /finite/);
  assert.throws(() => hostedOpening3dGeometry(wall,valid,{leafThickness:0}), /thicknesses/);
});


test("authoritative hosted openings replace stale cached wall opening geometry",()=>{
 const cached=[{id:"d1",type:"door",offset:1,width:.8,height:2,sill:0},{id:"legacy",type:"window",offset:3,width:1,height:1,sill:1}];
 const hosted=[{id:"d1",type:"door",offset:2,width:1,height:2.1,sill:0,hostWallId:"w1"}];
 const merged=mergeHostedOpeningRecords(cached,hosted);
 assert.equal(merged.length,2);
 assert.deepEqual(merged.filter(o=>o.id==="d1"),hosted);
 assert.deepEqual(merged.find(o=>o.id==="legacy"),cached[1]);
});


test("3D door leaf remains closed in the host wall plane while plan swing stays separate",()=>{
 const wall={start:{x:0,y:0},end:{x:4,y:0},thickness:.15};
 const door={type:"door",offset:1,width:.9,height:2.1,sill:0,hingeSide:"left",swingDirection:"inside"};
 const leaf=hostedDoorLeaf3dGeometry(wall,door);
 assert.equal(leaf.isClosedLeaf,true);
 assert.ok(leaf.boundary.every(p=>Math.abs(p.y)<=.02),"closed leaf must stay within the host wall thickness");
 assert.ok(Math.min(...leaf.boundary.map(p=>p.x))>=door.offset);
 assert.ok(Math.max(...leaf.boundary.map(p=>p.x))<=door.offset+door.width);
 const rotatedWall={start:{x:1,y:2},end:{x:1,y:6},thickness:.2};
 const rotated=hostedDoorLeaf3dGeometry(rotatedWall,door);
 assert.ok(rotated.boundary.every(p=>p.x>=.95&&p.x<=1.05),"rotated host leaf remains in wall plane");
 const open=hostedDoorLeaf3dGeometry(wall,{...door,model3dState:"open"});
 assert.equal(open.model3dState,"open");
 assert.equal(open.isClosedLeaf,false);
 assert.ok(Math.abs(open.boundary[0].x-open.boundary[1].x)<1e-8,"open leaf rotates out of the wall plane");
 const defaultState=hostedDoorLeaf3dGeometry(wall,{...door,model3dState:undefined});
 assert.equal(defaultState.model3dState,"closed","missing/legacy state defaults to closed in 3D");
});


test("door/window hosting rejects openings that cross the wall end",()=>{
 const host={id:"wall",start:{x:0,y:0},end:{x:4,y:0},thickness:.15};
 for(const type of ["door","window"]){
  assert.throws(()=>hostedOpening3dGeometry(host,{type,offset:3.2,width:1,height:1.2,sill:type==="window"?.9:0}),/fit/);
 }
});


test("double-leaf 3D door leaves meet with only a small centre clearance",()=>{
 const wall={start:{x:0,y:0},end:{x:4,y:0},thickness:.15};
 const door={type:"door",offset:1,width:.8,height:2.1,sill:0,hingeSide:"left",swingDirection:"inside"};
 const half=door.width/2,meetingGap=.003;
 const first=hostedDoorLeaf3dGeometry(wall,{...door,width:half,hingeSide:"left"},{startInset:.065,endInset:meetingGap/2});
 const second=hostedDoorLeaf3dGeometry(wall,{...door,offset:door.offset+half,width:half,hingeSide:"right"},{startInset:meetingGap/2,endInset:.065});
 const firstEnd=Math.max(...first.boundary.map(p=>p.x));
 const secondStart=Math.min(...second.boundary.map(p=>p.x));
 assert.ok(Math.abs((secondStart-firstEnd)-meetingGap)<1e-9,"meeting edges should have only the designed 3 mm clearance");
 assert.ok(Math.min(...first.boundary.map(p=>p.x))>=door.offset);
 assert.ok(Math.max(...second.boundary.map(p=>p.x))<=door.offset+door.width);
});

test("door leaf remains on wall plane for reversed and vertical hosts",()=>{
 const hosts=[
  {start:{x:4,y:0},end:{x:0,y:0},thickness:.15},
  {start:{x:0,y:0},end:{x:0,y:4},thickness:.15},
  {start:{x:2,y:4},end:{x:2,y:0},thickness:.15}
 ];
 for(const host of hosts){
  const leaf=hostedDoorLeaf3dGeometry(host,{type:"door",offset:1,width:.9,height:2.1,sill:0,hingeSide:"left"});
  const dx=host.end.x-host.start.x,dy=host.end.y-host.start.y,len=Math.hypot(dx,dy);
  for(const p of leaf.boundary){
   const signed=((p.x-host.start.x)*(-dy/len)+(p.y-host.start.y)*(dx/len));
   assert.ok(Math.abs(signed)<=.04,"closed door thickness must remain close to the wall centreline");
  }
 }
});


test("opening anchor calculation preserves the requested reference coordinate during resizing",()=>{
 assert.equal(openingOffsetForAnchor(4,1,"center",2),1.5);
 assert.equal(openingOffsetForAnchor(4,1.5,"center",2),1.25);
 assert.equal(1.25+1.5/2,2,"center anchor coordinate remains fixed");
 assert.equal(openingOffsetForAnchor(4,1.5,"left",1),1);
 assert.equal(openingOffsetForAnchor(4,1.5,"right",3),1.5);
});


test("existing hosted opening edits preserve anchor geometry and apply height and sill",()=>{
 const current={offset:1,width:1,height:2,sill:0,alignment:"center"};
 const resized=resolveHostedOpeningEdit({hostLength:5,hostHeight:3,current,changes:{offset:1,width:1.4,height:2.1,sill:.2,alignment:"center"},changedKey:"width"});
 assert.equal(resized.width,1.4);assert.equal(resized.height,2.1);assert.equal(resized.sill,.2);
 assert.ok(Math.abs(resized.anchorPosition-1.5)<1e-9,"resizing preserves the old centre anchor");
 const alignedLeft=resolveHostedOpeningEdit({hostLength:5,hostHeight:3,current,changes:{offset:1,width:1,height:2,sill:0,alignment:"left"},changedKey:"propAlignment"});
 assert.equal(alignedLeft.offset,0,"Left positions the opening at the host wall start");assert.equal(alignedLeft.alignment,"left");
 const alignedCenter=resolveHostedOpeningEdit({hostLength:5,hostHeight:3,current,changes:{offset:1,width:1,height:2,sill:0,alignment:"center"},changedKey:"propAlignment"});
 assert.equal(alignedCenter.offset,2,"Center positions the opening at the host wall centre");
 const alignedRight=resolveHostedOpeningEdit({hostLength:5,hostHeight:3,current,changes:{offset:1,width:1,height:2,sill:0,alignment:"right"},changedKey:"propAlignment"});
 assert.equal(alignedRight.offset,4,"Right positions the opening at the host wall end");
 const moved=resolveHostedOpeningEdit({hostLength:5,hostHeight:3,current,changes:{offset:2,width:1,height:2.2,sill:.3,alignment:"center"},changedKey:"offset"});
 assert.equal(moved.offset,2);assert.equal(moved.height,2.2);assert.equal(moved.sill,.3);
 assert.throws(()=>resolveHostedOpeningEdit({hostLength:5,hostHeight:3,current,changes:{offset:4.5,width:1,height:2,sill:0,alignment:"center"},changedKey:"offset"}),/fit/);
 assert.throws(()=>resolveHostedOpeningEdit({hostLength:5,hostHeight:3,current,changes:{offset:1,width:1,height:2.8,sill:.3,alignment:"center"},changedKey:"height"}),/exceed/);
});
