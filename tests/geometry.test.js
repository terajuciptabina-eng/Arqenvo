import test from "node:test";
import assert from "node:assert/strict";
import { lineIntersection, signedPolygonArea, validatePolygon, wallFootprint, normalizeIntervals, wallSolidIntervals, wallEndJoin } from "../src/core/geometry.js";

test("line intersection returns parameters and point",()=>{
 const hit=lineIntersection({x:0,y:0},{x:1,y:0},{x:2,y:-1},{x:0,y:1});
 assert.deepEqual(hit.point,{x:2,y:0}); assert.equal(hit.t,2); assert.equal(hit.s,1);
 assert.equal(lineIntersection({x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:0}),null);
});
test("signed polygon area preserves winding and polygon validator catches crossings",()=>{
 const ccw=[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}];
 assert.equal(signedPolygonArea(ccw),12); assert.equal(signedPolygonArea([...ccw].reverse()),-12);
 assert.equal(validatePolygon(ccw).valid,true);
 assert.equal(validatePolygon([{x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0}]).valid,false);
});
test("wall footprint is correctly oriented and has exact plan area",()=>{
 const wall=wallFootprint({x:0,y:0},{x:4,y:0},.2);
 assert.deepEqual(wall.boundary,[{x:0,y:.1},{x:4,y:.1},{x:4,y:-.1},{x:0,y:-.1}]);
 assert.equal(wall.area,.8); assert.equal(wall.length,4);
 assert.equal(wallFootprint({x:0,y:0},{x:0,y:2},.3).area,.6);
 assert.throws(()=>wallFootprint({x:1,y:1},{x:1,y:1},.2));
});
test("opening interval normalization detects overlap and clips small tolerance overshoot",()=>{
 assert.equal(normalizeIntervals([{start:1,end:2},{start:1.5,end:2.5}],4).valid,false);
 assert.equal(normalizeIntervals([{start:1,end:2},{start:2,end:3}],4).valid,true);
 assert.equal(normalizeIntervals([{start:3,end:4.000000001}],4).valid,true);
 assert.throws(()=>normalizeIntervals([{start:-1,end:1}],4));
});
test("wall solid intervals subtract openings without gaps or overlap",()=>{
 assert.deepEqual(wallSolidIntervals(5,[{start:1,end:2},{start:3,end:4}]),[{start:0,end:1},{start:2,end:3},{start:4,end:5}]);
 assert.deepEqual(wallSolidIntervals(4,[{start:0,end:4}]),[]);
 assert.throws(()=>wallSolidIntervals(4,[{start:1,end:2},{start:1.5,end:3}]));
});


test("wall end join resolves a right-angle corner with bounded miters",()=>{
 const join=wallEndJoin({start:{x:-2,y:0},end:{x:0,y:0}},{start:{x:0,y:0},end:{x:0,y:2}},.2,.2);
 assert.equal(join.type,"miter");
 assert.equal(join.left.type,"miter");
 assert.equal(join.right.type,"miter");
 assert.ok(join.left.points[0].x<0);
 assert.ok(join.right.points[0].x>0);
});
test("wall end join bevels excessive acute miters and rejects disconnected walls",()=>{
 const join=wallEndJoin({start:{x:-2,y:0},end:{x:0,y:0}},{start:{x:0,y:0},end:{x:-2,y:.01}},.2,.2,{miterLimit:2});
 assert.equal(join.type,"bevel");
 assert.equal(join.left.type,"bevel");
 assert.equal(join.right.type,"bevel");
 assert.throws(()=>wallEndJoin({start:{x:0,y:0},end:{x:1,y:0}},{start:{x:1.1,y:0},end:{x:2,y:0}},.2));
});

test("wall end join handles reversed wall direction and unequal thicknesses",()=>{
 const join=wallEndJoin({start:{x:0,y:0},end:{x:2,y:0}},{start:{x:2,y:0},end:{x:2,y:2}},.2,.3);
 assert.equal(join.type,"miter");
 assert.ok(join.left.points[0].x<2);
 assert.ok(join.right.points[0].x>2);
 assert.throws(()=>wallEndJoin({start:{x:0,y:0},end:{x:0,y:0}},{start:{x:0,y:0},end:{x:1,y:0}},.2));
});
