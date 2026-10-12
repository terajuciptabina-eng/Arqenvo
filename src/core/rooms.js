/**
 * Topology-aware room detection.
 * Wall segments are split at endpoint, T-junction and proper crossing intersections
 * before cycle detection. Coordinates and tolerances are in metres.
 */
import { wallLength, polygonArea, point, distance } from "./model.js";

function nodeKey(p, tolerance) {
  return `${Math.round(p.x / tolerance)},${Math.round(p.y / tolerance)}`;
}
function canonicalCycle(ids) {
  const rotations = [];
  for (let i = 0; i < ids.length; i++) {
    const r = ids.slice(i).concat(ids.slice(0, i));
    rotations.push(r.join("|"));
    rotations.push(r.slice().reverse().join("|"));
  }
  rotations.sort();
  return rotations[0];
}
function cross(ax, ay, bx, by) { return ax * by - ay * bx; }
function clamp01(t) { return Math.max(0, Math.min(1, t)); }
function parameterOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  if (d2 === 0) return null;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / d2;
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return distance(p, q) <= 1e-8 && t >= -1e-8 && t <= 1 + 1e-8 ? clamp01(t) : null;
}
function segmentIntersectionParameters(a, b, c, d, epsilon = 1e-9) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const denominator = cross(rx, ry, sx, sy);
  const qpx = c.x - a.x, qpy = c.y - a.y;
  if (Math.abs(denominator) > epsilon) {
    const t = cross(qpx, qpy, sx, sy) / denominator;
    const u = cross(qpx, qpy, rx, ry) / denominator;
    return t >= -epsilon && t <= 1 + epsilon && u >= -epsilon && u <= 1 + epsilon
      ? [{ t: clamp01(t), u: clamp01(u) }] : [];
  }
  // Collinear segments: include shared endpoints so overlapping networks stay connected.
  if (Math.abs(cross(qpx, qpy, rx, ry)) > epsilon) return [];
  const hits = [];
  for (const p of [a, b]) {
    const u = parameterOnSegment(p, c, d);
    const t = parameterOnSegment(p, a, b);
    if (u !== null && t !== null) hits.push({ t, u });
  }
  for (const p of [c, d]) {
    const t = parameterOnSegment(p, a, b);
    const u = parameterOnSegment(p, c, d);
    if (t !== null && u !== null) hits.push({ t, u });
  }
  const unique = new Map();
  for (const h of hits) unique.set(`${h.t.toFixed(9)}:${h.u.toFixed(9)}`, h);
  return [...unique.values()];
}
function splitWallNetwork(walls, tolerance) {
  const source = walls.filter(w => w?.start && w?.end && wallLength(w) > tolerance);
  const cuts = source.map(() => [0, 1]);
  for (let i = 0; i < source.length; i++) {
    for (let j = i + 1; j < source.length; j++) {
      for (const hit of segmentIntersectionParameters(source[i].start, source[i].end, source[j].start, source[j].end)) {
        cuts[i].push(hit.t);
        cuts[j].push(hit.u);
      }
      // Near-but-not-exact T-junctions within tolerance are projected onto the other wall.
      for (const [pointIndex, p] of [[i, source[i].start], [i, source[i].end], [j, source[j].start], [j, source[j].end]]) {
        const otherIndex = pointIndex === i ? j : i;
        const other = source[otherIndex];
        const t = parameterOnSegment(p, other.start, other.end);
        if (t !== null) {
          const projected = { x: other.start.x + (other.end.x - other.start.x) * t, y: other.start.y + (other.end.y - other.start.y) * t };
          if (distance(p, projected) <= tolerance) {
            if (pointIndex === i) cuts[i].push(parameterOnSegment(p, source[i].start, source[i].end));
            cuts[otherIndex].push(t);
          }
        }
      }
    }
  }
  const segments = [];
  source.forEach((wall, i) => {
    const ts = [...new Set(cuts[i].filter(Number.isFinite).map(t => clamp01(t)).sort((a,b) => a-b).map(t => t.toFixed(9)))].map(Number);
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k], t1 = ts[k+1];
      const start = point(wall.start.x + (wall.end.x-wall.start.x)*t0, wall.start.y + (wall.end.y-wall.start.y)*t0);
      const end = point(wall.start.x + (wall.end.x-wall.start.x)*t1, wall.start.y + (wall.end.y-wall.start.y)*t1);
      if (distance(start, end) > tolerance * 0.1) segments.push({ id: `${wall.id}#${k}`, wallId: wall.id, start, end });
    }
  });
  return segments;
}

export function detectRooms(walls, options = {}) {
  const tolerance = options.tolerance ?? 0.02;
  if (!(tolerance > 0)) throw new RangeError("Room detection tolerance must be positive");
  const segments = splitWallNetwork(walls, tolerance);
  const nodes = new Map(), edges = [];
  const getNode = p => {
    const key = nodeKey(p, tolerance);
    if (!nodes.has(key)) nodes.set(key, { key, position: point(p.x, p.y), edges: [] });
    return nodes.get(key);
  };
  for (const segment of segments) {
    const a = getNode(segment.start), b = getNode(segment.end);
    if (a.key === b.key) continue;
    const edge = { id: segment.id, wallId: segment.wallId, a, b };
    edges.push(edge); a.edges.push(edge); b.edges.push(edge);
  }
  const found = new Map();
  const maxDepth = options.maxCycleEdges ?? 48;
  for (const start of nodes.values()) {
    const visit = (current, previous, pathNodes, pathEdges) => {
      if (pathEdges.length >= maxDepth) return;
      for (const edge of current.edges) {
        if (edge === previous) continue;
        const next = edge.a === current ? edge.b : edge.a;
        if (next === start && pathEdges.length >= 2) {
          const ids = pathNodes.map(n => n.key);
          const key = canonicalCycle(ids);
          if (!found.has(key)) {
            const boundary = pathNodes.map(n => n.position);
            const area = polygonArea(boundary);
            if (area > tolerance * tolerance) found.set(key, {
              id: `room-${found.size + 1}`, type: "room", boundary, area,
              perimeter: [...pathEdges, edge].reduce((sum, e) => sum + distance(e.a.position, e.b.position), 0),
              boundaryWallIds: [...new Set([...pathEdges, edge].map(e => e.wallId))],
              center: boundary.reduce((c, p) => ({x:c.x+p.x/boundary.length,y:c.y+p.y/boundary.length}),{x:0,y:0}),
            });
          }
          continue;
        }
        if (next === start || pathNodes.includes(next)) continue;
        visit(next, edge, [...pathNodes, next], [...pathEdges, edge]);
      }
    };
    visit(start, null, [start], []);
  }
  const candidates = [...found.values()].sort((a,b) => a.area - b.area);
  // A closed outer perimeter is not a room when smaller closed faces partition it.
  // Suppress a containing cycle only when the non-overlapping smaller faces account
  // for its full area; this preserves legitimate nested spaces with unfilled area.
  const containsPoint = (poly, p) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      const crosses = ((a.y > p.y) !== (b.y > p.y)) &&
        (p.x < (b.x - a.x) * (p.y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x);
      if (crosses) inside = !inside;
    }
    return inside;
  };
  return candidates.filter(room => {
    const contained = candidates.filter(other =>
      other.area < room.area - tolerance * tolerance &&
      containsPoint(room.boundary, other.center)
    );
    const coveredArea = contained.reduce((sum, other) => sum + other.area, 0);
    return coveredArea < room.area - tolerance * tolerance;
  });
}
