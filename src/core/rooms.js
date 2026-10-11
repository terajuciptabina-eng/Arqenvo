/**
 * Room boundary detection from connected wall endpoints.
 * This first-pass detector supports closed, endpoint-connected wall loops.
 * Intersections through the middle of a wall are intentionally not split yet.
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
export function detectRooms(walls, options = {}) {
  const tolerance = options.tolerance ?? 0.02;
  if (!(tolerance > 0)) throw new RangeError("Room detection tolerance must be positive");
  const nodes = new Map(), edges = [];
  const getNode = p => {
    const key = nodeKey(p, tolerance);
    if (!nodes.has(key)) nodes.set(key, { key, position: point(p.x, p.y), edges: [] });
    return nodes.get(key);
  };
  for (const wall of walls) {
    if (!wall?.start || !wall?.end || wallLength(wall) <= tolerance) continue;
    const a = getNode(wall.start), b = getNode(wall.end);
    if (a.key === b.key) continue;
    const edge = { id: wall.id, a, b };
    edges.push(edge); a.edges.push(edge); b.edges.push(edge);
  }
  const found = new Map();
  // Walk simple cycles. Limit path length to protect large drawings from exponential paths.
  const maxDepth = options.maxCycleEdges ?? 24;
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
              perimeter: pathEdges.reduce((sum, e) => sum + distance(e.a.position, e.b.position), 0),
              boundaryWallIds: pathEdges.map(e => e.id),
              center: boundary.reduce((c, p) => ({x:c.x+p.x/boundary.length,y:c.y+p.y/boundary.length}),{x:0,y:0}),
            });
          }
          continue;
        }
        if (next === start || pathNodes.includes(next)) continue;
        // Avoid backtracking into a branch that cannot possibly close within the remaining budget.
        visit(next, edge, [...pathNodes, next], [...pathEdges, edge]);
      }
    };
    visit(start, null, [start], []);
  }
  return [...found.values()].sort((a,b) => a.area - b.area);
}
