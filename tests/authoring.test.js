import test from "node:test";
import assert from "node:assert/strict";
import { createOpeningPlacement, doorSwingGeometry, hostedOpening3dGeometry, openingPlacementDirection } from "../src/core/authoring.js";

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
