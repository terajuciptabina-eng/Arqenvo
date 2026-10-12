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
