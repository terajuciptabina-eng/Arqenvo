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
    layouts: [],
    publisher: { format: "pdf", scope: "all" },
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

export function createRoof(boundary, options = {}) {
  if (!Array.isArray(boundary) || boundary.length < 3 || boundary.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) || polygonArea(boundary) <= 1e-8) throw new RangeError("Roof needs a valid closed boundary with at least three points");
  const thickness=options.thickness??0.18,elevation=options.elevation??3,pitch=options.pitch??30;
  if (!(thickness>0)||!Number.isFinite(elevation)||elevation<0||!Number.isFinite(pitch)||pitch<0||pitch>70) throw new RangeError("Roof thickness, elevation or pitch is invalid");
  const points=boundary.map(p=>point(p.x,p.y));if(points.length>3&&distance(points[0],points[points.length-1])<1e-8)points.pop();
  return {id:options.id??makeId("roof"),type:"roof",storyId:options.storyId??DEFAULT_STORY.id,boundary:points,thickness,elevation,offset:options.offset??0,pitch,sourceWallIds:Array.isArray(options.sourceWallIds)?[...options.sourceWallIds]:[],buildingMaterial:options.buildingMaterial??"Roof - Generic",layer:options.layer??"A-ROOF",properties:{loadBearing:false,...options.properties}};
}

export function createStory(name, elevation, height = 3) {
  if (!name?.trim() || !Number.isFinite(elevation) || !(height > 0)) throw new TypeError("Story needs a name, finite elevation and positive height");
  return { id: makeId("story"), name: name.trim(), elevation, height };
}
export function validateProject(data) {
  const errors = [];
  if (!data || data.format !== MODEL_FORMAT) errors.push("Unsupported project format");
  if (![1, MODEL_VERSION].includes(data?.version)) errors.push("Unsupported project schema version");
  if (data?.version === MODEL_VERSION && (!Array.isArray(data?.stories) || !Array.isArray(data?.elements))) errors.push("Project must contain stories and elements arrays");
  if (data?.version === 1 && !["walls", "slabs", "columns", "beams", "dimensions"].some(k => Array.isArray(data?.[k]))) errors.push("Legacy project has no recognized element collections");
  const storyIds = new Set();
  const storyNames = new Set();
  for (const s of data?.stories ?? []) {
    if (!s.id || storyIds.has(s.id)) errors.push(`Missing or duplicate story id: ${s.id ?? "(missing)"}`);
    storyIds.add(s.id);
    const name = String(s.name ?? "").trim().toLowerCase();
    if (!name) errors.push("Story name is required");
    else if (storyNames.has(name)) errors.push(`Duplicate story name: ${s.name}`);
    storyNames.add(name);
    if (!Number.isFinite(s.elevation) || !Number.isFinite(s.height) || s.height <= 0) errors.push(`Invalid elevation or height for story: ${s.name ?? s.id}`);
  }
  if (data?.version === MODEL_VERSION && (data.stories ?? []).length === 0) errors.push("Project must contain at least one story");
  const ids = new Set();
  for (const el of data?.elements ?? []) {
    if (!el.id || ids.has(el.id)) errors.push(`Missing or duplicate element id: ${el.id ?? "(missing)"}`);
    ids.add(el.id);
    if (!["wall", "slab", "column", "beam", "door", "window", "object", "dimension", "gridline", "room", "roof"].includes(el.type)) errors.push(`Unknown element type: ${el.type}`);
    if (data?.version === MODEL_VERSION && el.storyId && !storyIds.has(el.storyId)) errors.push(`Element ${el.id} references unknown story: ${el.storyId}`);
    const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    const positive = n => Number.isFinite(n) && n > 0;
    if (["wall","beam","dimension","gridline"].includes(el.type)) {
      if (!finitePoint(el.start) || !finitePoint(el.end)) errors.push(`Element ${el.id} has invalid endpoints`);
      else if (distance(el.start, el.end) <= 1e-6 && el.type !== "dimension") errors.push(`Element ${el.id} has zero length`);
    }
    if (el.type === "wall") {
      if (!positive(el.height) || !positive(el.thickness)) errors.push(`Wall ${el.id} has invalid height or thickness`);
      for (const opening of el.openings ?? []) {
        if (!["door","window","opening"].includes(opening.type) || !Number.isFinite(opening.offset) || !positive(opening.width) || !positive(opening.height) || !Number.isFinite(opening.sill ?? 0)) errors.push(`Wall ${el.id} has invalid opening data`);
        else if (opening.offset < 0 || opening.offset + opening.width > wallLength(el) + 1e-6 || (opening.sill ?? 0) < 0 || (opening.sill ?? 0) + opening.height > el.height + 1e-6) errors.push(`Opening ${opening.id ?? ""} exceeds wall ${el.id}`);
      }
    }
    if (el.type === "slab" && (!Array.isArray(el.boundary) || el.boundary.length < 3 || el.boundary.some(v => !finitePoint(v)) || polygonArea(el.boundary) <= 1e-8 || !positive(el.thickness))) errors.push(`Slab ${el.id} has invalid boundary or thickness`);
    if (el.type === "roof" && (!Array.isArray(el.boundary) || el.boundary.length < 3 || el.boundary.some(v=>!finitePoint(v)) || polygonArea(el.boundary)<=1e-8 || !positive(el.thickness) || !Number.isFinite(el.elevation) || el.elevation<0 || !Number.isFinite(el.pitch) || el.pitch<0 || el.pitch>70)) errors.push(`Roof ${el.id} has invalid boundary or parameters`);
    if (el.type === "column" && (!finitePoint(el.position) || !positive(el.width) || !positive(el.depth) || !positive(el.height))) errors.push(`Column ${el.id} has invalid position or dimensions`);
    if (el.type === "beam" && (!positive(el.width) || !positive(el.depth))) errors.push(`Beam ${el.id} has invalid width or depth`);
    if (["door","window"].includes(el.type)) {
      const host = (data?.elements ?? []).find(candidate => candidate.id === el.hostWallId && candidate.type === "wall");
      if (!host) errors.push(`Opening element ${el.id} has no host wall`);
      else if (!(host.openings ?? []).some(opening => opening.id === el.id)) errors.push(`Opening element ${el.id} is missing from its host wall`);
    }
  }
  return { valid: errors.length === 0, errors };
}
export function normalizeHostedOpenings(project) {
  const elements = project.elements;
  const known = new Map(elements.filter(el => el.type === "door" || el.type === "window").map(el => [el.id, el]));
  for (const wall of elements) {
    if (wall.type !== "wall" || !Array.isArray(wall.openings)) continue;
    for (const opening of wall.openings) {
      if (!opening || !["door", "window"].includes(opening.type) || !opening.id) continue;
      const existing = known.get(opening.id);
      if (existing) {
        existing.hostWallId = wall.id;
        existing.storyId ??= wall.storyId ?? project.stories?.[0]?.id;
        continue;
      }
      const selectable = { ...opening, hostWallId: wall.id, storyId: wall.storyId ?? project.stories?.[0]?.id };
      elements.push(selectable);
      known.set(selectable.id, selectable);
    }
  }
  return project;
}

function migrateProject(input) {
  const check = validateProject(input);
  if (!check.valid) throw new Error(check.errors.join("; "));
  if (input.version === MODEL_VERSION) { const current = normalizeHostedOpenings(structuredClone(input)); current.layouts ??= []; current.views ??= []; current.publisher ??= { format: "pdf", scope: "all" }; for (const sheet of current.layouts) { sheet.drawings ??= []; sheet.paper ??= "A3"; sheet.orientation ??= "landscape"; sheet.titleBlock ??= {}; } return current; }
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
  p.layouts = Array.isArray(input.layouts) ? structuredClone(input.layouts) : [];
  p.publisher = input.publisher ?? { format: "pdf", scope: "all" };
  for (const sheet of p.layouts) { sheet.drawings ??= []; sheet.paper ??= "A3"; sheet.orientation ??= "landscape"; sheet.titleBlock ??= {}; }
  p.settings = { ...p.settings, ...(input.settings ?? {}) };
  return normalizeHostedOpenings(p);
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
    area: e.type === "slab" || e.type === "roof" ? Number(polygonArea(e.boundary).toFixed(3)) : e.type === "wall" ? Number(netWallArea(e).toFixed(3)) : null,
    material: e.buildingMaterial ?? "",
  }));
}
