/**
 * ARQENVO authoring interaction primitives.
 * Pure geometry/state helpers shared by tool previews and committed elements.
 * Units are metres for model coordinates; rendered coordinates may be pixels.
 */

export function openingOffsetForAnchor(hostLength, openingWidth, anchor = "center", anchorPosition = hostLength / 2) {
  if (!Number.isFinite(hostLength) || hostLength <= 0) throw new RangeError("Host wall length must be positive");
  if (!Number.isFinite(openingWidth) || openingWidth <= 0) throw new RangeError("Opening width must be positive");
  if (openingWidth > hostLength + 1e-8) throw new RangeError("Opening must fit within the host wall");
  if (!Number.isFinite(anchorPosition)) throw new TypeError("Anchor position must be finite");
  const available = Math.max(0, hostLength - openingWidth);
  const position = Math.max(0, Math.min(hostLength, anchorPosition));
  let offset;
  switch (String(anchor || "center").toLowerCase()) {
    case "left": offset = position; break;
    case "right": offset = position - openingWidth; break;
    case "center": offset = position - openingWidth / 2; break;
    default: throw new TypeError("Anchor must be center, left or right");
  }
  return Math.max(0, Math.min(available, offset));
}


/** Resolve edits to an existing hosted door/window from persistent geometry. */
export function resolveHostedOpeningEdit({hostLength, hostHeight, current, changes, changedKey}) {
  if (!current || !changes || typeof current !== "object" || typeof changes !== "object") throw new TypeError("Opening edit requires current values and changes");
  if (!Number.isFinite(hostLength) || hostLength <= 0) throw new RangeError("Host wall length must be positive");
  const oldWidth = Number(current.width), oldOffset = Number(current.offset);
  const oldHeight = Number(current.height), oldSill = Number(current.sill ?? 0);
  const width = Number(changes.width ?? current.width);
  const height = Number(changes.height ?? current.height);
  const sill = Number(changes.sill ?? current.sill ?? 0);
  const offsetInput = Number(changes.offset ?? current.offset);
  const oldAlignment = String(current.alignment || "center").toLowerCase();
  const alignment = String(changes.alignment ?? oldAlignment).toLowerCase();
  if (!["left", "center", "right"].includes(oldAlignment) || !["left", "center", "right"].includes(alignment)) throw new TypeError("Opening anchor must be left, center or right");
  if (![oldWidth, oldOffset, oldHeight, oldSill].every(Number.isFinite) || oldWidth <= 0 || oldOffset < 0 || oldHeight <= 0 || oldSill < 0) throw new RangeError("Current opening geometry is invalid");
  if (!Number.isFinite(width) || width <= 0 || width > hostLength + 1e-8) throw new RangeError("Opening width must be positive and fit within the host wall");
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(sill) || sill < 0) throw new RangeError("Opening height and sill must be valid");
  if (Number.isFinite(hostHeight) && sill + height > hostHeight + 1e-8) throw new RangeError("Opening height and sill exceed the host wall height");
  const anchorPosition = oldOffset + (oldAlignment === "left" ? 0 : oldAlignment === "right" ? oldWidth : oldWidth / 2);
  let offset;
  if (changedKey === "offset") offset = offsetInput;
  else if (changedKey === "width" || changedKey === "propAlignment") offset = openingOffsetForAnchor(hostLength, width, alignment, anchorPosition);
  else offset = oldOffset;
  if (!Number.isFinite(offset) || offset < -1e-8 || offset + width > hostLength + 1e-8) throw new RangeError("Opening cannot fit on the host wall at this position");
  offset = Math.max(0, Math.min(hostLength - width, offset));
  const actualAnchorPosition = offset + (alignment === "left" ? 0 : alignment === "right" ? width : width / 2);
  return { offset, width, height, sill, alignment, anchorPosition: actualAnchorPosition };
}

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
 for(const wall of walls){
  if(!wall||wall.type!=="wall"||!wall.start||!wall.end||![wall.start.x,wall.start.y,wall.end.x,wall.end.y].every(Number.isFinite))continue;
  if(Math.hypot(wall.end.x-wall.start.x,wall.end.y-wall.start.y)<=tolerance)continue;
  const a=nodeFor(wall.start),b=nodeFor(wall.end);if(a.id===b.id)continue;
  const idx=edges.push({wallId:wall.id,a:a.id,b:b.id})-1;a.edges.push(idx);b.edges.push(idx);
 }
 // A branch must not invalidate an otherwise closed perimeter. Enumerate simple
 // cycles through connected references; normalize by edge set to avoid duplicates.
 const cycleKeys=new Set(),loops=[];
 const maxCycles=Math.max(500,edges.length*edges.length*8);
 for(let seed=0;seed<edges.length;seed++){
  const start=edges[seed].a,pathNodes=[start,edges[seed].b],pathEdges=[seed],usedNodes=new Set(pathNodes);
  const walk=(current,previousEdge)=>{
   if(loops.length>=maxCycles)return;
   for(const idx of nodes[current].edges){
    if(idx===previousEdge)continue;
    const edge=edges[idx],next=edge.a===current?edge.b:edge.a;
    if(next===start&&pathEdges.length>=2){
     const cycle=[...pathEdges,idx],key=[...cycle].sort((a,b)=>a-b).join(",");
     if(cycleKeys.has(key))continue;
     cycleKeys.add(key);
     const boundary=pathNodes.map(id=>({x:nodes[id].x,y:nodes[id].y}));
     let twice=0;for(let i=0;i<boundary.length;i++){const a=boundary[i],b=boundary[(i+1)%boundary.length];twice+=a.x*b.y-b.x*a.y}
     const area=Math.abs(twice/2);if(area>=minArea)loops.push({boundary,wallIds:cycle.map(i=>edges[i].wallId),area});
     continue;
    }
    if(usedNodes.has(next)||pathEdges.length>=edges.length-1)continue;
    usedNodes.add(next);pathNodes.push(next);pathEdges.push(idx);walk(next,idx);pathEdges.pop();pathNodes.pop();usedNodes.delete(next);
   }
  };
  walk(pathNodes[1],seed);
 }
 // Keep the smallest valid loop for duplicate contours with identical geometry.
 return loops;
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
/**
 * Closed door leaf for 3D model rendering.
 * The plan swing arc is an annotation; it must not rotate the physical leaf
 * out of the wall plane in the 3D model unless an explicit open angle exists.
 */
export function hostedDoorLeaf3dGeometry(wall, opening, { leafThickness = 0.035, frameWidth = 0.065, startInset = frameWidth, endInset = frameWidth } = {}) {
  // Reuse host/opening validation and the canonical along-wall placement.
  const hosted = hostedOpening3dGeometry(wall, { ...opening, type: "door" }, { leafThickness });
  if (!Number.isFinite(frameWidth) || frameWidth < 0) throw new RangeError("Door frame width must be non-negative");
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy), ux = dx / length, uy = dy / length;
  const nx = -uy, ny = ux;
  const maxInset = Math.max(0, (opening.width - 0.002) / 2);
  const safeStartInset = Math.min(startInset, maxInset), safeEndInset = Math.min(endInset, maxInset);
  const startDistance = opening.offset + safeStartInset, endDistance = opening.offset + opening.width - safeEndInset;
  const start = { x: wall.start.x + ux * startDistance, y: wall.start.y + uy * startDistance };
  const finish = { x: wall.start.x + ux * endDistance, y: wall.start.y + uy * endDistance };
  const depth = Math.max(0.02, Math.min(leafThickness, (wall.thickness || 0.15) * 0.45));
  const half = depth / 2;
  let boundary = [
    { x: start.x + nx * half, y: start.y + ny * half },
    { x: finish.x + nx * half, y: finish.y + ny * half },
    { x: finish.x - nx * half, y: finish.y - ny * half },
    { x: start.x - nx * half, y: start.y - ny * half },
  ];
  // The 2D swing symbol is independent. 3D doors default to closed, and only
  // rotate out of the host plane when the explicit 3D state is set to "open".
  const isOpen = opening.model3dState === "open";
  if (isOpen) {
    const hinge = opening.hingeSide === "right" ? finish : start;
    const direction = opening.swingDirection === "outside" ? -1 : 1;
    const angle = (opening.hingeSide === "right" ? -1 : 1) * direction * Math.PI / 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    boundary = boundary.map(point => {
      const x = point.x - hinge.x, y = point.y - hinge.y;
      return { x: hinge.x + x * c - y * s, y: hinge.y + x * s + y * c };
    });
  }
  return { ...hosted, boundary, thickness: depth, isClosedLeaf: !isOpen, model3dState: isOpen ? "open" : "closed" };
}

export function hostedOpening3dGeometry(wall, opening, { leafThickness = 0.035, paneThickness = 0.025 } = {}) {
  if (!wall?.start || !wall?.end || !opening) throw new TypeError("A host wall and opening are required");
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  if (![wall.start.x, wall.start.y, wall.end.x, wall.end.y].every(Number.isFinite)) throw new TypeError("Host wall endpoints must be finite");
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) throw new RangeError("Host wall length must be positive");
  const offset = opening.offset, width = opening.width, height = opening.height, sill = opening.sill ?? 0;
  if (![offset,width,height,sill].every(Number.isFinite) || offset < 0 || width <= 0 || height <= 0 || sill < 0 || offset + width > length + 1e-8) {
    throw new RangeError("Opening must fit within the host wall and have finite, positive dimensions");
  }
  if (!["door","window","opening"].includes(opening.type)) throw new TypeError("Hosted 3D opening must be a door, window or opening");
  if (!Number.isFinite(leafThickness) || leafThickness <= 0 || !Number.isFinite(paneThickness) || paneThickness <= 0) {
    throw new RangeError("Opening component thicknesses must be positive");
  }
  const ux = dx / length, uy = dy / length, nx = -uy, ny = ux;
  const start = { x: wall.start.x + ux * offset, y: wall.start.y + uy * offset };
  const finish = { x: start.x + ux * width, y: start.y + uy * width };
  let boundary;
  if (opening.type === "door") {
    const hinge = opening.hingeSide === "right" ? finish : start;
    const side = opening.swingDirection === "outside" ? -1 : 1;
    const free = { x: hinge.x + nx * side * width, y: hinge.y + ny * side * width };
    const tx = free.x - hinge.x, ty = free.y - hinge.y, n = Math.hypot(tx, ty);
    const px = -ty / n * leafThickness / 2, py = tx / n * leafThickness / 2;
    boundary = [
      { x: hinge.x + px, y: hinge.y + py }, { x: free.x + px, y: free.y + py },
      { x: free.x - px, y: free.y - py }, { x: hinge.x - px, y: hinge.y - py },
    ];
  } else {
    const half = (wall.thickness || 0.15) / 2 + paneThickness / 2;
    boundary = [
      { x: start.x + nx * half, y: start.y + ny * half }, { x: finish.x + nx * half, y: finish.y + ny * half },
      { x: finish.x - nx * half, y: finish.y - ny * half }, { x: start.x - nx * half, y: start.y - ny * half },
    ];
  }
  return { type: opening.type, boundary, zOffset: sill, height, thickness: opening.type === "door" ? leafThickness : paneThickness };
}

/**
 * Merge the wall's cached opening records with the authoritative top-level
 * door/window elements. Top-level elements win on duplicate IDs because their
 * offset, width and vertical dimensions may have changed since the cache was made.
 */
export function mergeHostedOpeningRecords(wallOpenings = [], hostedElements = []) {
  const merged = new Map();
  for (const opening of Array.isArray(wallOpenings) ? wallOpenings : []) {
    if (!opening || typeof opening !== "object") continue;
    const key = opening.id || `legacy:${merged.size}`;
    merged.set(key, { ...opening });
  }
  for (const opening of Array.isArray(hostedElements) ? hostedElements : []) {
    if (!opening || typeof opening !== "object") continue;
    const key = opening.id || `hosted:${merged.size}`;
    merged.set(key, { ...(merged.get(key) || {}), ...opening });
  }
  return [...merged.values()];
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
    update(changes) {
      if (!pending) return null;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new TypeError("Placement updates must be an object");
      pending = { ...pending, ...structuredClone(changes) };
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
