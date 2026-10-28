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
 * Select the host-wall face approached by a terminating branch at a T-junction.
 * `branchRay` points from the branch endpoint back into the branch; the face
 * on that same side of the host centreline is the one the branch must meet.
 */
export function wallHostFaceSide(branchRay, hostNormal, {tolerance=1e-8}={}) {
  if(!finitePoint(branchRay)||!finitePoint(hostNormal)) throw new TypeError("T-junction directions must be finite points");
  if(!Number.isFinite(tolerance)||tolerance<0) throw new RangeError("Tolerance must be non-negative");
  const rayLength=norm(branchRay),normalLength=norm(hostNormal);
  if(rayLength<EPS||normalLength<EPS) throw new RangeError("T-junction directions must have non-zero length");
  const alignment=dot(branchRay,hostNormal)/(rayLength*normalLength);
  if(Math.abs(alignment)<=tolerance) return 1;
  return alignment<0?-1:1;
}

/**
 * Resolve the end join between two centre-line walls sharing a junction.
 * wallA runs into the junction; wallB runs away from it. Each side is
 * intersected independently. Acute joins beyond the miter limit are bevelled
 * instead of creating long spikes. This returns plan geometry only.
 */
/**
 * Intersection of two finite line segments. Returns the intersection point,
 * normalized parameters and endpoint flags; parallel/collinear pairs return null.
 */
export function segmentIntersection(a,b,c,d,{tolerance=1e-8}={}) {
  if (![a,b,c,d].every(finitePoint)) throw new TypeError("Segment coordinates must be finite points");
  if (!Number.isFinite(tolerance)||tolerance<0) throw new RangeError("Tolerance must be non-negative");
  const r=sub(b,a),s=sub(d,c),lengthA=norm(r),lengthB=norm(s);
  if(lengthA<EPS||lengthB<EPS) throw new RangeError("Segments must have non-zero length");
  const denominator=cross(r,s);
  if(Math.abs(denominator)<=EPS*lengthA*lengthB) return null;
  const offset=sub(c,a),t=cross(offset,s)/denominator,u=cross(offset,r)/denominator;
  const toleranceA=tolerance/lengthA,toleranceB=tolerance/lengthB;
  if(t < -toleranceA||t > 1+toleranceA||u < -toleranceB||u > 1+toleranceB) return null;
  const clampedT=Math.max(0,Math.min(1,t)),clampedU=Math.max(0,Math.min(1,u));
  const pointA=add(a,mul(r,clampedT)),pointB=add(c,mul(s,clampedU));
  const point=mul(add(pointA,pointB),.5);
  return {
    point,t:clampedT,u:clampedU,
    endpointA:clampedT<=toleranceA||clampedT>=1-toleranceA,
    endpointB:clampedU<=toleranceB||clampedU>=1-toleranceB
  };
}

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

/**
 * Deterministically resolve a wall-end junction from geometrically eligible
 * same-story candidates. Element order must not decide equal-distance joins.
 */
export function selectWallJunctionCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const score = candidate => {
    if (!candidate || !Number.isFinite(candidate.distance) || !Number.isFinite(candidate.alignment)) {
      throw new TypeError("Wall junction candidates need finite distance and alignment values");
    }
    return candidate.distance + (candidate.isT ? 0.0025 : 0) +
      (1 - Math.max(0, Math.min(1, candidate.alignment))) * 0.002;
  };
  candidates.forEach(score);
  return candidates.reduce((best, candidate) => score(candidate) < score(best) ? candidate : best, candidates[0]);
}


/**
 * Resolve one wall-side vertex at an endpoint junction.
 *
 * The offset boundary lines are infinite lines, not forward-only rays: one
 * side of an L junction legitimately intersects behind the centre-line
 * endpoint. Restricting either line to the forward direction creates the
 * diagonal end caps and overlapping strips visible at wall corners.
 *
 * T branches terminate at the approached face of the host wall. Their
 * intersection may lie up to half the host thickness behind the branch end.
 * Every candidate is bounded by a local miter limit to avoid spikes.
 */
export function resolveWallEndCorner(wall, atStart, side, candidates = [], {
  endpointTolerance = 0.005,
  maxMiterRatio = 8,
  parallelTolerance = 1e-8,
} = {}) {
  const validWall = value => value && finitePoint(value.start) && finitePoint(value.end);
  if (!validWall(wall)) throw new TypeError("Wall corner needs finite wall endpoints");
  if (typeof atStart !== "boolean") throw new TypeError("Wall corner endpoint must be start or end");
  if (![1, -1].includes(side)) throw new RangeError("Wall corner side must be 1 or -1");
  if (!Array.isArray(candidates)) throw new TypeError("Wall corner candidates must be an array");
  if (![endpointTolerance, maxMiterRatio, parallelTolerance].every(Number.isFinite) ||
      endpointTolerance < 0 || maxMiterRatio < 1 || parallelTolerance <= 0) {
    throw new RangeError("Wall corner tolerances or miter ratio are invalid");
  }

  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  const joint = atStart ? wall.start : wall.end;
  if (length <= EPS) return { point: { ...joint }, resolved: false, reason: "degenerate-wall" };

  const ux = dx / length, uy = dy / length;
  const inwardRay = { x: atStart ? ux : -ux, y: atStart ? uy : -uy };
  const outwardRay = { x: -inwardRay.x, y: -inwardRay.y };
  const normal = { x: -inwardRay.y, y: inwardRay.x };
  const localSide = side * (atStart ? 1 : -1);
  const half = (Number.isFinite(wall.thickness) && wall.thickness > 0 ? wall.thickness : 0.15) / 2;
  const fallback = { x: joint.x + normal.x * half * localSide, y: joint.y + normal.y * half * localSide };
  const a = fallback;
  const cross2 = (u, v) => u.x * v.y - u.y * v.x;
  const dot2 = (u, v) => u.x * v.x + u.y * v.y;
  const sideNormal = { x: normal.x * localSide, y: normal.y * localSide };
  let best = null;

  for (const info of candidates) {
    const neighbor = info?.neighbor;
    if (!validWall(neighbor)) continue;
    const ndx = neighbor.end.x - neighbor.start.x, ndy = neighbor.end.y - neighbor.start.y;
    const nlen = Math.hypot(ndx, ndy);
    if (nlen <= EPS) continue;

    const nux = ndx / nlen, nuy = ndy / nlen;
    const neighborHalf = (Number.isFinite(neighbor.thickness) && neighbor.thickness > 0 ? neighbor.thickness : 0.15) / 2;
    const isT = Boolean(info.isT);
    const neighborT = Number.isFinite(info.neighborT) ? info.neighborT : 0;
    const center = finitePoint(info.closest) ? info.closest : joint;
    const options = [];

    if (isT) {
      const hostNormal = { x: -nuy, y: nux };
      const faceSide = wallHostFaceSide(inwardRay, hostNormal);
      const b = {
        x: center.x + hostNormal.x * neighborHalf * faceSide,
        y: center.y + hostNormal.y * neighborHalf * faceSide,
      };
      // A T-junction connects to the host face on either side of the
      // branch's endpoint projection; the host line is not a forward ray.
      options.push({ b, ray: { x: nux, y: nuy }, sidePenalty: 0, tJunction: true });
    } else {
      const neighborInward = neighborT < 0.5
        ? { x: nux, y: nuy }
        : { x: -nux, y: -nuy };
      const neighborNormal = { x: -neighborInward.y, y: neighborInward.x };
      for (const sign of [-1, 1]) {
        const offset = { x: neighborNormal.x * neighborHalf * sign, y: neighborNormal.y * neighborHalf * sign };
        const b = { x: joint.x + offset.x, y: joint.y + offset.y };
        // Of the two parallel wall faces, select the one on the same
        // boundary side as this offset edge. This distinguishes the external
        // and re-entrant vertices at a corner without a distance-only guess.
        const handedness = Math.sign(cross2(outwardRay, sideNormal));
        const facing = handedness * dot2(offset, outwardRay);
        options.push({
          b,
          ray: neighborInward,
          sidePenalty: facing < -parallelTolerance ? 1 : 0,
          tJunction: false,
        });
      }
    }

    for (const option of options) {
      const denominator = cross2(outwardRay, option.ray);
      if (Math.abs(denominator) <= parallelTolerance) {
        // Collinear wall chains share a continuous offset edge. Mark that
        // edge resolved only when the candidate offset vertex actually
        // coincides with this wall's offset vertex.
        if (!option.tJunction && Math.hypot(option.b.x - a.x, option.b.y - a.y) <= endpointTolerance) {
          const score = (option.sidePenalty || 0) * 1e6 + (Number(info.distance) || 0);
          if (!best || score < best.score) best = { point: { x: (option.b.x + a.x) / 2, y: (option.b.y + a.y) / 2 }, score, neighborId: neighbor.id };
        }
        continue;
      }

      const delta = { x: option.b.x - a.x, y: option.b.y - a.y };
      const t = cross2(delta, option.ray) / denominator;
      const s = cross2(delta, outwardRay) / denominator;
      if (!Number.isFinite(t) || !Number.isFinite(s)) continue;

      const hit = { x: a.x + outwardRay.x * t, y: a.y + outwardRay.y * t };
      const hitDistance = Math.hypot(hit.x - joint.x, hit.y - joint.y);
      const maxDistance = Math.max(half, neighborHalf) * maxMiterRatio + endpointTolerance;
      if (!Number.isFinite(hitDistance) || hitDistance > maxDistance) continue;

      // At a T-junction the endpoint is projected onto a host face, so the
      // vertex must remain within half the host thickness. For endpoint joins,
      // use the global miter bound and let side-consistency choose the vertex.
      if (option.tJunction && Math.abs(t) > neighborHalf + endpointTolerance) continue;

      const score = (option.sidePenalty || 0) * 1e6 +
        hitDistance + Math.abs(t) * 1e-3 + (Number(info.distance) || 0) * 1e-2 +
        (option.tJunction ? -1e-4 : 0);
      if (!best || score < best.score) best = { point: hit, score, neighborId: neighbor.id };
    }
  }

  if (best) return { point: best.point, resolved: true, neighborId: best.neighborId };
  return { point: fallback, resolved: false, reason: candidates.length ? "no-valid-intersection" : "isolated-end" };
}
