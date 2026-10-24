/**
 * ARQENVO authoring interaction primitives.
 * Pure geometry/state helpers shared by tool previews and committed elements.
 * Units are metres for model coordinates; rendered coordinates may be pixels.
 */

export function openingPlacementDirection(wallStart, wallEnd, cursor) {
  const dx = wallEnd.x - wallStart.x;
  const dy = wallEnd.y - wallStart.y;
  const cross = dx * (cursor.y - wallStart.y) - dy * (cursor.x - wallStart.x);
  return cross >= 0 ? "inside" : "outside";
}


/** Find simple closed wall-reference loops; branched or open networks are ignored. */
export function findClosedWallLoops(walls,{tolerance=0.04,minArea=0.25}={}) {
 if(!Array.isArray(walls)||!(tolerance>0)||!(minArea>0))throw new TypeError("Wall loops need walls and positive tolerances");
 const nodes=[],edges=[];
 const nodeFor=p=>{let n=nodes.find(v=>Math.hypot(v.x-p.x,v.y-p.y)<=tolerance);if(!n){n={id:nodes.length,x:p.x,y:p.y,edges:[]};nodes.push(n)}return n};
 for(const wall of walls){if(!wall||wall.type!=="wall"||!wall.start||!wall.end||![wall.start.x,wall.start.y,wall.end.x,wall.end.y].every(Number.isFinite))continue;if(Math.hypot(wall.end.x-wall.start.x,wall.end.y-wall.start.y)<=tolerance)continue;const a=nodeFor(wall.start),b=nodeFor(wall.end);if(a.id===b.id)continue;const idx=edges.push({wallId:wall.id,a:a.id,b:b.id})-1;a.edges.push(idx);b.edges.push(idx)}
 const loops=[],visited=new Set();
 for(let first=0;first<edges.length;first++){if(visited.has(first))continue;const edgeSet=new Set(),nodeSet=new Set(),stack=[edges[first].a];while(stack.length){const id=stack.pop();if(nodeSet.has(id))continue;nodeSet.add(id);for(const idx of nodes[id].edges){edgeSet.add(idx);const edge=edges[idx];stack.push(edge.a===id?edge.b:edge.a)}}for(const idx of edgeSet)visited.add(idx);if(nodeSet.size<3||edgeSet.size!==nodeSet.size||[...nodeSet].some(id=>nodes[id].edges.length!==2))continue;
  const start=edges[first].a,orderedNodes=[start],orderedEdges=[];let current=start,previous=-1,closed=false;
  for(let step=0;step<=edgeSet.size;step++){const idx=nodes[current].edges.find(v=>v!==previous&&edgeSet.has(v));if(idx===undefined)break;orderedEdges.push(idx);const edge=edges[idx],next=edge.a===current?edge.b:edge.a;if(next===start){closed=true;break}if(orderedNodes.includes(next))break;orderedNodes.push(next);previous=idx;current=next}
  if(!closed||orderedNodes.length<3||orderedEdges.length!==edgeSet.size)continue;
  const boundary=orderedNodes.map(id=>({x:nodes[id].x,y:nodes[id].y}));let twice=0;for(let i=0;i<boundary.length;i++){const a=boundary[i],b=boundary[(i+1)%boundary.length];twice+=a.x*b.y-b.x*a.y}
  const area=Math.abs(twice/2);if(area>=minArea)loops.push({boundary,wallIds:orderedEdges.map(i=>edges[i].wallId),area});
 }return loops;
}

/**
 * Door symbol geometry for a wall opening represented by its two jamb points.
 * Returns a hinged leaf and the exact circular arc from the closed free end
 * to the open free end. This function is renderer-agnostic and testable.
 */
export function doorSwingGeometry(p1, p2, { hingeSide = "left", swingDirection = "inside" } = {}) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const radius = Math.hypot(dx, dy);
  if (!Number.isFinite(radius) || radius <= 1e-9) throw new RangeError("Door opening width must be positive");
  const ux = dx / radius, uy = dy / radius;
  const nx = -uy, ny = ux;
  const rightHinge = hingeSide === "right";
  const hinge = rightHinge ? p2 : p1;
  const closedFree = rightHinge ? p1 : p2;
  const side = swingDirection === "outside" ? -1 : 1;
  const openFree = { x: hinge.x + nx * side * radius, y: hinge.y + ny * side * radius };
  const startAngle = Math.atan2(closedFree.y - hinge.y, closedFree.x - hinge.x);
  const endAngle = Math.atan2(openFree.y - hinge.y, openFree.x - hinge.x);
  const delta = Math.atan2(Math.sin(endAngle - startAngle), Math.cos(endAngle - startAngle));
  return {
    hinge: { x: hinge.x, y: hinge.y },
    closedFree: { x: closedFree.x, y: closedFree.y },
    openFree,
    radius,
    startAngle,
    endAngle: startAngle + delta,
    anticlockwise: delta < 0,
    sweep: delta,
  };
}

/**
 * Plan footprint and vertical range for a hosted opening's 3D component.
 * The wall body is cut independently from its host opening interval.
 * Door leaf is shown in its selected open position; a window is a thin pane
 * centred in the host wall thickness.
 */
export function hostedOpening3dGeometry(wall, opening, { leafThickness = 0.035, paneThickness = 0.025 } = {}) {
  if (!wall?.start || !wall?.end || !opening) throw new TypeError("A host wall and opening are required");
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) throw new RangeError("Host wall length must be positive");
  if (!(opening.width > 0) || !(opening.height > 0) || opening.offset < 0 || opening.offset + opening.width > length + 1e-8) {
    throw new RangeError("Opening must fit within the host wall");
  }
  const ux = dx / length, uy = dy / length, nx = -uy, ny = ux;
  const a = { x: wall.start.x + ux * opening.offset, y: wall.start.y + uy * opening.offset };
  const b = { x: a.x + ux * opening.width, y: a.y + uy * opening.width };
  let boundary;
  if (opening.type === "door") {
    const hinge = opening.hingeSide === "right" ? b : a;
    const side = opening.swingDirection === "outside" ? -1 : 1;
    const free = { x: hinge.x + nx * side * opening.width, y: hinge.y + ny * side * opening.width };
    const tx = free.x - hinge.x, ty = free.y - hinge.y, n = Math.hypot(tx, ty);
    const px = -ty / n * leafThickness / 2, py = tx / n * leafThickness / 2;
    boundary = [
      { x: hinge.x + px, y: hinge.y + py },
      { x: free.x + px, y: free.y + py },
      { x: free.x - px, y: free.y - py },
      { x: hinge.x - px, y: hinge.y - py },
    ];
  } else {
    const half = (wall.thickness || 0.15) / 2 + paneThickness / 2;
    boundary = [
      { x: a.x + nx * half, y: a.y + ny * half },
      { x: b.x + nx * half, y: b.y + ny * half },
      { x: b.x - nx * half, y: b.y - ny * half },
      { x: a.x - nx * half, y: a.y - ny * half },
    ];
  }
  return { type: opening.type, boundary, zOffset: opening.sill || 0, height: opening.height, thickness: opening.type === "door" ? leafThickness : paneThickness };
}

/**
 * Small placement state machine. No model mutation occurs until confirm().
 * The caller owns host lookup and commits the returned payload in one transaction.
 */
export function createOpeningPlacement() {
  let pending = null;
  return {
    get pending() { return pending ? structuredClone(pending) : null; },
    begin(data) {
      if (pending) throw new Error("An opening placement is already active");
      if (!data || !data.wallId || !["door", "window", "opening"].includes(data.type)) throw new TypeError("Opening placement requires a host wall and supported type");
      pending = { ...structuredClone(data), phase: "aiming" };
      return structuredClone(pending);
    },
    aim(cursor, wallStart, wallEnd) {
      if (!pending) return null;
      if (![cursor, wallStart, wallEnd].every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) throw new TypeError("Placement coordinates must be finite");
      pending.cursor = { x: cursor.x, y: cursor.y };
      pending.swingDirection = openingPlacementDirection(wallStart, wallEnd, cursor);
      return structuredClone(pending);
    },
    confirm() {
      if (!pending) return null;
      const result = { ...pending };
      delete result.phase;
      pending = null;
      return result;
    },
    cancel() {
      const wasActive = Boolean(pending);
      pending = null;
      return wasActive;
    },
  };
}
