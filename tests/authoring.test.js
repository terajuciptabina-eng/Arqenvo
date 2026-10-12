import test from "node:test";
import assert from "node:assert/strict";
import { createOpeningPlacement, doorSwingGeometry, openingPlacementDirection } from "../src/core/authoring.js";

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
  const right = doorSwingGeometry({x:0,y:0},{x:0,y:0.9},{hingeSide:"right",swingDirection:"outside"});
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
