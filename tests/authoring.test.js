import test from "node:test";
import assert from "node:assert/strict";
import { createRoof } from "../src/core/model.js";
import { createOpeningPlacement, doorSwingGeometry, hostedOpening3dGeometry, openingPlacementDirection, findClosedWallLoops, mergeHostedOpeningRecords } from "../src/core/authoring.js";

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
 assert.deepEqual(merged.find(o=>o.id==="d1"),hosted);
 assert.deepEqual(merged.find(o=>o.id==="legacy"),cached[1]);
});
