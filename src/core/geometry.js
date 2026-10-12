/**
 * ARQENVO 2D geometry kernel primitives.
 * Coordinates are metres. This module is pure and deterministic.
 * It generates plan footprints, not a full boolean/solid modelling kernel.
 */
const EPS = 1e-9;
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const sub = (a,b) => ({x:a.x-b.x,y:a.y-b.y});
const add = (a,b) => ({x:a.x+b.x,y:a.y+b.y});
const mul = (a,s) => ({x:a.x*s,y:a.y*s});
const cross = (a,b) => a.x*b.y-a.y*b.x;
const dot = (a,b) => a.x*b.x+a.y*b.y;
const norm = a => Math.hypot(a.x,a.y);
const unit = a => { const n=norm(a); if(n<EPS) throw new RangeError("Geometry segment must have non-zero length"); return mul(a,1/n); };

/** Intersection of infinite lines a+t*u and b+s*v; null when parallel. */
export function lineIntersection(a,u,b,v,tolerance=EPS) {
  if (![a,u,b,v].every(finitePoint)) throw new TypeError("Line coordinates must be finite points");
  const den=cross(u,v);
  if(Math.abs(den)<=tolerance) return null;
  const t=cross(sub(b,a),v)/den;
  const point=add(a,mul(u,t));
  return {point,t,s:cross(sub(b,a),u)/den};
}

/** Signed area preserves orientation; positive means counter-clockwise. */
export function signedPolygonArea(points) {
  if(!Array.isArray(points)||points.length<3) return 0;
  let sum=0;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];
    if(!finitePoint(a)||!finitePoint(b)) throw new TypeError("Polygon points must be finite");
    sum+=cross(a,b);
  }
  return sum/2;
}

export function validatePolygon(points,{tolerance=1e-8}={}) {
  const errors=[];
  if(!Array.isArray(points)||points.length<3) return {valid:false,errors:["Polygon needs at least three vertices"]};
  if(points.some(p=>!finitePoint(p))) return {valid:false,errors:["Polygon coordinates must be finite"]};
  if(Math.abs(signedPolygonArea(points))<=tolerance) errors.push("Polygon area is zero or below tolerance");
  for(let i=0;i<points.length;i++) {
    if(norm(sub(points[(i+1)%points.length],points[i]))<=tolerance) errors.push(`Edge ${i} has zero length`);
  }
  // Non-adjacent proper crossings and collinear overlaps are rejected.
  const orient=(a,b,c)=>cross(sub(b,a),sub(c,a));
  const onSegment=(a,b,p)=>Math.abs(orient(a,b,p))<=tolerance&&p.x>=Math.min(a.x,b.x)-tolerance&&p.x<=Math.max(a.x,b.x)+tolerance&&p.y>=Math.min(a.y,b.y)-tolerance&&p.y<=Math.max(a.y,b.y)+tolerance;
  const intersects=(a,b,c,d)=>{
    const o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b);
    if(((o1>tolerance&&o2< -tolerance)||(o1< -tolerance&&o2>tolerance))&&((o3>tolerance&&o4< -tolerance)||(o3< -tolerance&&o4>tolerance))) return true;
    return onSegment(a,b,c)||onSegment(a,b,d)||onSegment(c,d,a)||onSegment(c,d,b);
  };
  for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) {
    if(j===i||j===(i+1)%points.length||i===(j+1)%points.length) continue;
    if(intersects(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length])) {
      errors.push(`Non-adjacent edges ${i} and ${j} intersect`);
    }
  }
  return {valid:errors.length===0,errors:[...new Set(errors)]};
}

/**
 * Creates a constant-thickness wall footprint with mitered ends.
 * For a straight wall this is a rectangle; endpoint order is stable:
 * left-start, left-end, right-end, right-start.
 */
export function wallFootprint(start,end,thickness,{miterLimit=10}={}) {
  if(!finitePoint(start)||!finitePoint(end)) throw new TypeError("Wall endpoints must be finite points");
  if(!Number.isFinite(thickness)||thickness<=0) throw new RangeError("Wall thickness must be positive");
  if(!Number.isFinite(miterLimit)||miterLimit<1) throw new RangeError("Miter limit must be at least 1");
  const direction=unit(sub(end,start));
  const normal={x:-direction.y,y:direction.x};
  const offset=mul(normal,thickness/2);
  const polygon=[add(start,offset),add(end,offset),sub(end,offset),sub(start,offset)];
  return {boundary:polygon,area:norm(sub(end,start))*thickness,length:norm(sub(end,start)),thickness};
}

/** Clamp and merge opening intervals along a host wall; overlaps are reported. */
export function normalizeIntervals(intervals,length,{tolerance=1e-8}={}) {
  if(!Number.isFinite(length)||length<=0) throw new RangeError("Host length must be positive");
  if(!Array.isArray(intervals)) throw new TypeError("Intervals must be an array");
  const sorted=intervals.map((v,i)=>{
    if(!Number.isFinite(v.start)||!Number.isFinite(v.end)||v.start<0||v.end<=v.start||v.end>length+tolerance)
      throw new RangeError(`Invalid interval at index ${i}`);
    return {start:Math.max(0,v.start),end:Math.min(length,v.end),id:v.id??null};
  }).sort((a,b)=>a.start-b.start||a.end-b.end);
  const overlaps=[];
  for(let i=1;i<sorted.length;i++) if(sorted[i].start<sorted[i-1].end-tolerance) overlaps.push({previous:sorted[i-1],current:sorted[i]});
  return {intervals:sorted,overlaps,valid:overlaps.length===0};
}

/** Subtract non-overlapping opening intervals from [0, hostLength]. */
export function wallSolidIntervals(hostLength,openings,{tolerance=1e-8}={}) {
  const normalized=normalizeIntervals(openings,hostLength,{tolerance});
  if(!normalized.valid) throw new RangeError("Opening intervals overlap; resolve the host openings first");
  const solids=[]; let cursor=0;
  for(const opening of normalized.intervals) {
    if(opening.start>cursor+tolerance) solids.push({start:cursor,end:opening.start});
    cursor=Math.max(cursor,opening.end);
  }
  if(cursor<hostLength-tolerance) solids.push({start:cursor,end:hostLength});
  return solids;
}


/**
 * Resolve the end join between two centre-line walls sharing a junction.
 * wallA runs into the junction; wallB runs away from it. Each side is
 * intersected independently. Acute joins beyond the miter limit are bevelled
 * instead of creating long spikes. This returns plan geometry only.
 */
export function wallEndJoin(wallA, wallB, thicknessA, thicknessB=thicknessA, {miterLimit=10,tolerance=1e-7}={}) {
  const validSegment=w=>w&&finitePoint(w.start)&&finitePoint(w.end);
  if(!validSegment(wallA)||!validSegment(wallB)) throw new TypeError("Wall join needs two finite wall segments");
  if(!Number.isFinite(thicknessA)||thicknessA<=0||!Number.isFinite(thicknessB)||thicknessB<=0) throw new RangeError("Wall thicknesses must be positive");
  if(!Number.isFinite(miterLimit)||miterLimit<1) throw new RangeError("Miter limit must be at least 1");
  if(!Number.isFinite(tolerance)||tolerance<0) throw new RangeError("Tolerance must be non-negative");
  const jointA=wallA.end,jointB=wallB.start;
  if(norm(sub(jointA,jointB))>tolerance) throw new RangeError("Wall endpoints do not share a junction");
  const joint=mul(add(jointA,jointB),.5);
  const u1=unit(sub(wallA.end,wallA.start)),u2=unit(sub(wallB.end,wallB.start));
  const n1={x:-u1.y,y:u1.x},n2={x:-u2.y,y:u2.x};
  const halfA=thicknessA/2,halfB=thicknessB/2;
  const resolveSide=sign=>{
    const a=add(joint,mul(n1,halfA*sign)),b=add(joint,mul(n2,halfB*sign));
    const hit=lineIntersection(a,u1,b,u2);
    if(!hit) return {type:"parallel",points:[a,b],miter:null};
    const miterLength=norm(sub(hit.point,joint)),limit=Math.max(halfA,halfB)*miterLimit;
    if(!Number.isFinite(miterLength)||miterLength>limit) return {type:"bevel",points:[a,b],miterLength};
    return {type:"miter",points:[hit.point],miterLength};
  };
  const left=resolveSide(1),right=resolveSide(-1);
  return {junction:joint,left,right,type:left.type==="miter"&&right.type==="miter"?"miter":"bevel"};
}
