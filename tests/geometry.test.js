import test from "node:test";
import assert from "node:assert/strict";
import { lineIntersection, segmentIntersection, signedPolygonArea, validatePolygon, wallFootprint, normalizeIntervals, wallSolidIntervals, wallEndJoin, selectWallJunctionCandidate, wallHostFaceSide, resolveWallEndCorner } from "../src/core/geometry.js";

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

test("segment intersection detects T-junctions and marks endpoint membership",()=>{
 const hit=segmentIntersection({x:0,y:0},{x:4,y:0},{x:2,y:0},{x:2,y:2});
 assert.ok(hit);
 assert.deepEqual(hit.point,{x:2,y:0});
 assert.equal(hit.endpointA,false);
 assert.equal(hit.endpointB,true);
});
test("segment intersection detects crossings and ignores disjoint or parallel segments",()=>{
 const cross=segmentIntersection({x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0});
 assert.ok(cross);
 assert.ok(Math.abs(cross.point.x-1)<1e-9&&Math.abs(cross.point.y-1)<1e-9);
 assert.equal(cross.endpointA,false);
 assert.equal(cross.endpointB,false);
 assert.equal(segmentIntersection({x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}),null);
 assert.equal(segmentIntersection({x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}),null);
});
test("segment intersection rejects zero-length segments and invalid tolerance",()=>{
 assert.throws(()=>segmentIntersection({x:0,y:0},{x:0,y:0},{x:0,y:0},{x:1,y:0}),/non-zero/);
 assert.throws(()=>segmentIntersection({x:0,y:0},{x:1,y:0},{x:0,y:0},{x:0,y:1},{tolerance:-1}),/non-negative/);
});

test("wall junction candidate resolution is deterministic and geometry-ranked",()=>{
 const parallel={neighbor:{id:"parallel"},distance:0,alignment:0,isT:false};
 const transverse={neighbor:{id:"transverse"},distance:0,alignment:1,isT:false};
 assert.equal(selectWallJunctionCandidate([parallel,transverse]).neighbor.id,"transverse");
 assert.equal(selectWallJunctionCandidate([transverse,parallel]).neighbor.id,"transverse");
 const endpoint={neighbor:{id:"endpoint"},distance:0.001,alignment:0.5,isT:false};
 const side={neighbor:{id:"side"},distance:0,alignment:1,isT:true};
 assert.equal(selectWallJunctionCandidate([side,endpoint]).neighbor.id,"endpoint");
 assert.equal(selectWallJunctionCandidate([]),null);
 assert.throws(()=>selectWallJunctionCandidate([{distance:NaN,alignment:1}]),/finite/);
});


test("T-junction host face follows the branch approach side, not the branch side normal",()=>{
 assert.equal(wallHostFaceSide({x:0,y:-1},{x:0,y:1}),-1,"branch below a horizontal host meets its lower face");
 assert.equal(wallHostFaceSide({x:0,y:1},{x:0,y:1}),1,"branch above a horizontal host meets its upper face");
 assert.equal(wallHostFaceSide({x:-1,y:0},{x:0,y:1}),1,"parallel dot fallback is deterministic");
 assert.throws(()=>wallHostFaceSide({x:0,y:0},{x:0,y:1}),/non-zero/);
});


// Orthogonal and oblique junction regression cases: side endpoints must stay finite,
// bounded to the local wall half-thickness, and stable regardless of candidate order.
test("wall junction offsets stay bounded for L corners and reversed wall directions",()=>{
 const cases=[
  [{start:{x:-2,y:0},end:{x:0,y:0}},{start:{x:0,y:0},end:{x:0,y:2}}],
  [{start:{x:2,y:0},end:{x:0,y:0}},{start:{x:0,y:0},end:{x:0,y:2}}],
  [{start:{x:-2,y:-1},end:{x:0,y:0}},{start:{x:0,y:0},end:{x:1,y:2}}],
  [{start:{x:0,y:0},end:{x:2,y:0}},{start:{x:2,y:0},end:{x:2,y:2}}],
 ];
 for(const [a,b] of cases){
  const j=wallEndJoin(a,b,.2,.2);
  for(const side of [j.left,j.right]){
   for(const p of side.points){
    assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
    assert.ok(Math.hypot(p.x-j.junction.x,p.y-j.junction.y)<=2.001,
      "miter regression must remain bounded");
   }
  }
 }
});


test("renderer wall-end resolver builds both external L-corner vertices without diagonal fallback strips",()=>{
 const horizontal={id:"horizontal",start:{x:-2,y:0},end:{x:0,y:0},thickness:.2};
 const vertical={id:"vertical",start:{x:0,y:0},end:{x:0,y:2},thickness:.2};
 const candidate={neighbor:vertical,neighborT:0,closest:{x:0,y:0},isT:false,distance:0,alignment:1};
 const upper=resolveWallEndCorner(horizontal,false,1,[candidate]);
 const lower=resolveWallEndCorner(horizontal,false,-1,[candidate]);
 assert.equal(upper.resolved,true);
 assert.equal(lower.resolved,true);
 assert.ok(Math.abs(upper.point.x-.1)<1e-8&&Math.abs(upper.point.y-.1)<1e-8);
 assert.ok(Math.abs(lower.point.x+.1)<1e-8&&Math.abs(lower.point.y+.1)<1e-8);
});

test("renderer wall-end resolver joins a T branch to the approached host face",()=>{
 const branch={id:"branch",start:{x:0,y:2},end:{x:0,y:0},thickness:.2};
 const host={id:"host",start:{x:-2,y:0},end:{x:2,y:0},thickness:.2};
 const candidate={neighbor:host,neighborT:.5,closest:{x:0,y:0},isT:true,distance:0,alignment:0};
 const left=resolveWallEndCorner(branch,false,1,[candidate]);
 const right=resolveWallEndCorner(branch,false,-1,[candidate]);
 assert.equal(left.resolved,true);
 assert.equal(right.resolved,true);
 assert.ok(Math.abs(left.point.y-.1)<1e-8);
 assert.ok(Math.abs(right.point.y-.1)<1e-8);
 assert.ok(Math.abs(left.point.x-.1)<1e-8);
 assert.ok(Math.abs(right.point.x+.1)<1e-8);
});

test("renderer wall-end resolver stays bounded at acute corners and handles continuous wall chains",()=>{
 const acuteA={id:"a",start:{x:-2,y:0},end:{x:0,y:0},thickness:.2};
 const acuteB={id:"b",start:{x:0,y:0},end:{x:-2,y:.01},thickness:.2};
 const acute=resolveWallEndCorner(acuteA,false,1,[{neighbor:acuteB,neighborT:0,closest:{x:0,y:0},isT:false,distance:0,alignment:.005}],{maxMiterRatio:2});
 assert.equal(acute.resolved,false,"overlong acute miter must fall back instead of producing a spike");
 const first={id:"first",start:{x:-2,y:0},end:{x:0,y:0},thickness:.2};
 const second={id:"second",start:{x:0,y:0},end:{x:2,y:0},thickness:.2};
 const chain=resolveWallEndCorner(first,false,1,[{neighbor:second,neighborT:0,closest:{x:0,y:0},isT:false,distance:0,alignment:1}]);
 assert.equal(chain.resolved,true);
 assert.ok(Math.abs(chain.point.y-.1)<1e-8);
});
