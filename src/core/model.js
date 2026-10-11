/**
 * ARQENVO Core Model v0.1
 * Independent architectural BIM data model. No proprietary Archicad code/assets.
 * Units: metres; angles: radians.
 */
export const MODEL_FORMAT = "ARQENVO-PROJECT";
export const MODEL_VERSION = 2;

export const DEFAULT_STORY = Object.freeze({
  id: "story-ground",
  name: "Ground Floor",
  elevation: 0,
  height: 3,
});

export function createProject(name = "Untitled Project") {
  return {
    format: MODEL_FORMAT,
    version: MODEL_VERSION,
    project: { id: makeId("prj"), name, units: "m", createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() },
    settings: { grid: 0.1, snap: true, angleSnap: true, defaultWallHeight: 3, defaultWallThickness: 0.15 },
    stories: [{ ...DEFAULT_STORY }],
    elements: [],
    views: [{ id: "view-floor-ground", name: "Ground Floor", type: "floor-plan", storyId: DEFAULT_STORY.id, scale: 100 }],
    metadata: { engine: "ARQENVO Core", schema: MODEL_VERSION },
  };
}
export function makeId(prefix = "el") {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) }`;
}
export function point(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("Coordinates must be finite numbers");
  return { x, y };
}
export function distance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}
export function polygonPerimeter(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  return points.reduce((sum, p, i) => sum + distance(p, points[(i + 1) % points.length]), 0);
}
export function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, denom = dx * dx + dy * dy;
  if (!denom) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denom));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}
export function createWall(a, b, options = {}) {
  if (distance(a, b) < 1e-6) throw new RangeError("Wall length must be greater than zero");
  const thickness = options.thickness ?? 0.15, height = options.height ?? 3;
  if (!(thickness > 0) || !(height > 0)) throw new RangeError("Wall thickness and height must be positive");
  return {
    id: options.id ?? makeId("wall"), type: "wall", storyId: options.storyId ?? DEFAULT_STORY.id,
    start: point(a.x, a.y), end: point(b.x, b.y), thickness, height,
    baseOffset: options.baseOffset ?? 0, referenceLine: options.referenceLine ?? "center",
    buildingMaterial: options.buildingMaterial ?? "Generic - Concrete", layer: options.layer ?? "A-WALL",
    properties: { fireRating: null, acousticRating: null, loadBearing: false, ...options.properties },
    openings: Array.isArray(options.openings) ? options.openings.map(o => ({ ...o })) : [],
  };
}
export function wallLength(wall) { return distance(wall.start, wall.end); }
export function addOpening(wall, kind, offset, width, height, sill = 0) {
  if (!["door", "window", "opening"].includes(kind)) throw new TypeError("Opening kind must be door, window or opening");
  const length = wallLength(wall);
  if (!(width > 0 && height > 0) || offset < 0 || offset + width > length) throw new RangeError("Opening must fit inside its host wall");
  if (sill < 0 || sill + height > wall.height) throw new RangeError("Opening vertical dimensions exceed wall height");
  const opening = { id: makeId(kind), type: kind, offset, width, height, sill };
  wall.openings.push(opening);
  return opening;
}
export function openingArea(wall) { return wall.openings.reduce((sum, o) => sum + o.width * o.height, 0); }
export function grossWallArea(wall) { return wallLength(wall) * wall.height; }
export function netWallArea(wall) { return Math.max(0, grossWallArea(wall) - openingArea(wall)); }
export function createSlab(boundary, options = {}) {
  if (!Array.isArray(boundary) || boundary.length < 3 || polygonArea(boundary) <= 1e-8) throw new RangeError("Slab needs a valid closed boundary with at least three points");
  return { id: options.id ?? makeId("slab"), type: "slab", storyId: options.storyId ?? DEFAULT_STORY.id,
    boundary: boundary.map(p => point(p.x, p.y)), thickness: options.thickness ?? 0.2,
    elevation: options.elevation ?? 0, buildingMaterial: options.buildingMaterial ?? "Generic - Concrete",
    layer: options.layer ?? "A-SLAB", properties: { loadBearing: true, ...options.properties } };
}
export function createColumn(position, options = {}) {
  const width = options.width ?? 0.3, depth = options.depth ?? width;
  if (!(width > 0 && depth > 0)) throw new RangeError("Column dimensions must be positive");
  return { id: options.id ?? makeId("column"), type: "column", storyId: options.storyId ?? DEFAULT_STORY.id,
    position: point(position.x, position.y), width, depth, height: options.height ?? 3,
    rotation: options.rotation ?? 0, buildingMaterial: options.buildingMaterial ?? "Reinforced Concrete",
    layer: options.layer ?? "A-COLS", properties: { loadBearing: true, ...options.properties } };
}
export function createBeam(start, end, options = {}) {
  if (distance(start, end) < 1e-6) throw new RangeError("Beam length must be greater than zero");
  const width = options.width ?? 0.2, depth = options.depth ?? 0.3;
  if (!(width > 0 && depth > 0)) throw new RangeError("Beam dimensions must be positive");
  return { id: options.id ?? makeId("beam"), type: "beam", storyId: options.storyId ?? DEFAULT_STORY.id,
    start: point(start.x, start.y), end: point(end.x, end.y), width, depth, elevation: options.elevation ?? 2.7,
    buildingMaterial: options.buildingMaterial ?? "Reinforced Concrete", layer: options.layer ?? "A-BEAM",
    properties: { loadBearing: true, ...options.properties } };
}
export function createStory(name, elevation, height = 3) {
  if (!name?.trim() || !Number.isFinite(elevation) || !(height > 0)) throw new TypeError("Story needs a name, finite elevation and positive height");
  return { id: makeId("story"), name: name.trim(), elevation, height };
}
export function validateProject(data) {
  const errors = [];
  if (!data || data.format !== MODEL_FORMAT) errors.push("Unsupported project format");
  if (![1, MODEL_VERSION].includes(data?.version)) errors.push("Unsupported project schema version");
  if (!Array.isArray(data?.stories) || !Array.isArray(data?.elements)) errors.push("Project must contain stories and elements arrays");
  const ids = new Set();
  for (const el of data?.elements ?? []) {
    if (!el.id || ids.has(el.id)) errors.push(`Missing or duplicate element id: ${el.id ?? "(missing)"}`);
    ids.add(el.id);
    if (!["wall", "slab", "column", "beam", "door", "window", "object", "dimension"].includes(el.type)) errors.push(`Unknown element type: ${el.type}`);
  }
  return { valid: errors.length === 0, errors };
}
export function migrateProject(input) {
  const check = validateProject(input);
  if (!check.valid) throw new Error(check.errors.join("; "));
  if (input.version === MODEL_VERSION) return structuredClone(input);
  const p = createProject(input.project?.name ?? "Imported Project");
  p.project = { ...p.project, ...(input.project ?? {}) };
  p.stories = input.stories?.length ? structuredClone(input.stories) : [{ ...DEFAULT_STORY }];
  const oldElements = input.elements ?? [];
  p.elements = oldElements.length ? structuredClone(oldElements) : [
    ...(input.walls ?? []).map(w => ({ ...w, type: "wall", start: w.start ?? w.a, end: w.end ?? w.b })),
    ...(input.slabs ?? []).filter(s => Array.isArray(s.boundary)).map(s => ({ ...s, type: "slab" })),
    ...(input.columns ?? []).map(c => ({ ...c, type: "column", position: c.position ?? { x: c.x, y: c.y } })),
    ...(input.beams ?? []).map(b => ({ ...b, type: "beam", start: b.start ?? b.a, end: b.end ?? b.b })),
    ...(input.dimensions ?? []).map(d => ({ ...d, type: "dimension" })),
  ];
  p.views = input.views ?? p.views;
  p.settings = { ...p.settings, ...(input.settings ?? {}) };
  return p;
}
export function serializeProject(project) {
  const errors = validateProject(project);
  if (!errors.valid) throw new Error(errors.errors.join("; "));
  project.project.modifiedAt = new Date().toISOString();
  return JSON.stringify(project, null, 2);
}
export function deserializeProject(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Project file is not valid JSON"); }
  return migrateProject(data);
}
export function elementSchedule(project) {
  return project.elements.map(e => ({
    id: e.id, type: e.type, story: project.stories.find(s => s.id === e.storyId)?.name ?? "Unassigned",
    length: e.type === "wall" || e.type === "beam" ? Number((e.type === "wall" ? wallLength(e) : distance(e.start, e.end)).toFixed(3)) : null,
    area: e.type === "slab" ? Number(polygonArea(e.boundary).toFixed(3)) : e.type === "wall" ? Number(netWallArea(e).toFixed(3)) : null,
    material: e.buildingMaterial ?? "",
  }));
}
