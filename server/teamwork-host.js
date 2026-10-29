import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.resolve(process.env.ARQENVO_TEAMWORK_DATA || path.join(os.homedir(), ".arqenvo", "teamwork"));
const PORT = Number(process.env.ARQENVO_TEAMWORK_PORT || 8080);
const HOST = process.env.ARQENVO_TEAMWORK_HOST || "0.0.0.0";
const MAX_BODY = 20 * 1024 * 1024;
const RESERVATION_TTL = 90_000;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".mjs":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".ico":"image/x-icon", ".woff2":"font/woff2" };

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const USERS_FILE = path.join(DATA_DIR, "users.json");
const PROJECT_FILE = path.join(DATA_DIR, "project.json");
const RESERVATIONS_FILE = path.join(DATA_DIR, "reservations.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
const sessions = new Map();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error("Cannot read " + path.basename(file) + ": " + error.message);
  }
}
function atomicJson(file, value) {
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function verifyPassword(password, record) {
  if (typeof password !== "string" || !record?.salt || !record?.hash) return false;
  const expected = Buffer.from(record.hash, "hex");
  const actual = crypto.scryptSync(password, record.salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function publicUser(user) { return { username: user.username, role: user.role, displayName: user.displayName || user.username }; }
function loadUsers() {
  const data = readJson(USERS_FILE, null);
  if (data) return data;
  let password = process.env.ARQENVO_TEAMWORK_ADMIN_PASSWORD;
  if (!password || password.length < 4) {
    password = crypto.randomBytes(18).toString("base64url");
    console.warn("\nARQENVO TEAMWORK FIRST-START ADMIN CREDENTIALS");
    console.warn("Username: admin");
    console.warn("Temporary password (save it now): " + password);
    console.warn("Set ARQENVO_TEAMWORK_ADMIN_PASSWORD to choose your own password on a clean setup.\n");
  }
  const record = hashPassword(password);
  const users = [{ username: process.env.ARQENVO_TEAMWORK_ADMIN_USER || "admin", role: "admin", displayName: "Project Host", ...record, createdAt: new Date().toISOString() }];
  atomicJson(USERS_FILE, users);
  return users;
}
loadUsers();

function currentProject() {
  return readJson(PROJECT_FILE, { revision: 0, project: null, updatedAt: null, updatedBy: null });
}
function cleanReservations() {
  const reservations = readJson(RESERVATIONS_FILE, {});
  const now = Date.now();
  let changed = false;
  for (const [id, item] of Object.entries(reservations)) {
    if (!item || now - Number(item.heartbeat || item.createdAtMs || 0) > RESERVATION_TTL) {
      delete reservations[id]; changed = true;
    }
  }
  if (changed) atomicJson(RESERVATIONS_FILE, reservations);
  return reservations;
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type":"application/json; charset=utf-8", "content-length":Buffer.byteLength(body), "cache-control":"no-store", "x-content-type-options":"nosniff", "referrer-policy":"no-referrer" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "", size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Request body too large"), { status:413 })); req.destroy(); return; }
      body += chunk;
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error("Invalid JSON body"), { status:400 })); }
    });
    req.on("error", reject);
  });
}
function tokenFrom(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return match?.[1] || "";
}
function auth(req, res, roles = []) {
  const token = tokenFrom(req), session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    json(res, 401, { error:"Authentication required" }); return null;
  }
  const user = loadUsers().find(item => item.username === session.username);
  if (!user) { sessions.delete(token); json(res, 401, { error:"Account no longer exists" }); return null; }
  if (roles.length && !roles.includes(user.role)) { json(res, 403, { error:"Insufficient permission" }); return null; }
  session.expiresAt = Date.now() + SESSION_TTL;
  return { token, session, user };
}
function validateProject(project) {
  if (!project || project.format !== "ARQENVO-PROJECT" || !Number.isInteger(project.version) || !Array.isArray(project.elements) || !Array.isArray(project.stories)) return "Invalid or unsupported ARQENVO project";
  if (project.elements.length > 250_000 || project.stories.length > 500) return "Project exceeds supported limits";
  const ids = new Set();
  for (const element of project.elements) {
    if (!element || typeof element.id !== "string" || !element.id || ids.has(element.id)) return "Project contains missing or duplicate element IDs";
    ids.add(element.id);
  }
  return null;
}
function makeBackup(existing) {
  if (!existing?.project) return;
  const name = "project-" + String(existing.revision).padStart(8, "0") + "-" + new Date().toISOString().replaceAll(":","-") + ".json";
  atomicJson(path.join(BACKUP_DIR, name), existing);
  const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json")).sort();
  while (backups.length > 50) fs.rmSync(path.join(BACKUP_DIR, backups.shift()), { force:true });
}
function clientInfo(req) {
  return { host: os.hostname(), platform: process.platform, port: PORT, lanAddresses: Object.values(os.networkInterfaces()).flat().filter(v => v && v.family === "IPv4" && !v.internal).map(v => v.address), projectRevision: currentProject().revision };
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;
    if (route.startsWith("/api/teamwork/")) {
      if (req.method === "GET" && route === "/api/teamwork/health") return json(res, 200, { ok:true, service:"ARQENVO Local Teamwork", ...clientInfo(req) });
      if (req.method === "POST" && route === "/api/teamwork/login") {
        const body = await readBody(req), users = loadUsers();
        const user = users.find(item => item.username === body.username);
        if (!user || !verifyPassword(body.password, user)) return json(res, 401, { error:"Invalid username or password" });
        const token = crypto.randomBytes(32).toString("base64url");
        sessions.set(token, { username:user.username, expiresAt:Date.now() + SESSION_TTL });
        return json(res, 200, { token, user:publicUser(user), expiresIn:SESSION_TTL });
      }
      if (req.method === "POST" && route === "/api/teamwork/logout") {
        const session = auth(req, res); if (!session) return;
        sessions.delete(session.token); return json(res, 200, { ok:true });
      }
      if (req.method === "GET" && route === "/api/teamwork/session") {
        const session = auth(req, res); if (!session) return;
        return json(res, 200, { user:publicUser(session.user), ...clientInfo(req) });
      }
      if (req.method === "GET" && route === "/api/teamwork/project") {
        const session = auth(req, res); if (!session) return;
        const record = currentProject();
        return json(res, 200, { revision:record.revision, project:record.project, updatedAt:record.updatedAt, updatedBy:record.updatedBy, reservations:cleanReservations() });
      }
      if (req.method === "PUT" && route === "/api/teamwork/project") {
        const session = auth(req, res); if (!session) return;
        if (session.user.role === "viewer") return json(res, 403, { error:"Viewer accounts cannot modify the shared project" });
        const body = await readBody(req), record = currentProject();
        if (!Number.isInteger(body.expectedRevision)) return json(res, 400, { error:"expectedRevision is required" });
        if (body.expectedRevision !== record.revision) return json(res, 409, { error:"Project revision conflict", revision:record.revision, updatedBy:record.updatedBy, updatedAt:record.updatedAt });
        const invalid = validateProject(body.project);
        if (invalid) return json(res, 422, { error:invalid });
        const reservations = cleanReservations();
        const userReserved = Object.values(reservations).filter(item => item.username === session.user.username);
        const changedIds = Array.isArray(body.changedElementIds) ? body.changedElementIds.map(String) : [];
        for (const id of changedIds) {
          const held = reservations[id];
          if (held && held.username !== session.user.username && session.user.role !== "admin") return json(res, 423, { error:"Element is reserved by another team member", elementId:id, reservedBy:held.username });
        }
        makeBackup(record);
        const next = { revision:record.revision + 1, project:body.project, updatedAt:new Date().toISOString(), updatedBy:session.user.username };
        atomicJson(PROJECT_FILE, next);
        return json(res, 200, { ok:true, revision:next.revision, updatedAt:next.updatedAt, updatedBy:next.updatedBy });
      }
      if (req.method === "GET" && route === "/api/teamwork/reservations") {
        const session = auth(req, res); if (!session) return;
        return json(res, 200, { reservations:cleanReservations() });
      }
      if (req.method === "POST" && route === "/api/teamwork/reserve") {
        const session = auth(req, res, ["admin","member"]); if (!session) return;
        const body = await readBody(req);
        if (!Array.isArray(body.elementIds) || !body.elementIds.length || body.elementIds.length > 5000 || body.elementIds.some(id => typeof id !== "string" || !id)) return json(res, 400, { error:"elementIds must be a non-empty array of element IDs" });
        const reservations = cleanReservations();
        for (const id of body.elementIds) if (reservations[id] && reservations[id].username !== session.user.username) return json(res, 423, { error:"One or more elements are reserved by another team member", elementId:id, reservedBy:reservations[id].username });
        const now = Date.now();
        for (const id of body.elementIds) reservations[id] = { elementId:id, username:session.user.username, displayName:session.user.displayName || session.user.username, createdAtMs:reservations[id]?.createdAtMs || now, heartbeat:now };
        atomicJson(RESERVATIONS_FILE, reservations);
        return json(res, 200, { ok:true, reservations });
      }
      if (req.method === "POST" && route === "/api/teamwork/release") {
        const session = auth(req, res, ["admin","member"]); if (!session) return;
        const body = await readBody(req);
        if (!Array.isArray(body.elementIds) || !body.elementIds.length) return json(res, 400, { error:"elementIds must be a non-empty array" });
        const reservations = cleanReservations();
        for (const id of body.elementIds) {
          if (reservations[id] && reservations[id].username !== session.user.username && session.user.role !== "admin") return json(res, 403, { error:"Cannot release another member's reservation", elementId:id });
        }
        for (const id of body.elementIds) delete reservations[id];
        atomicJson(RESERVATIONS_FILE, reservations);
        return json(res, 200, { ok:true, reservations });
      }
      if (req.method === "POST" && route === "/api/teamwork/reservation-heartbeat") {
        const session = auth(req, res); if (!session) return;
        const reservations = cleanReservations(), now = Date.now();
        for (const item of Object.values(reservations)) if (item.username === session.user.username) item.heartbeat = now;
        atomicJson(RESERVATIONS_FILE, reservations);
        return json(res, 200, { ok:true });
      }
      if (req.method === "POST" && route === "/api/teamwork/members") {
        const session = auth(req, res, ["admin"]); if (!session) return;
        const body = await readBody(req), username = String(body.username || "").trim(), password = String(body.password || "");
        if (!/^[a-zA-Z0-9._-]{1,40}$/.test(username)) return json(res, 400, { error:"Username must be 1-40 letters, numbers, dots, underscores or hyphens" });
        if (password.length < 4) return json(res, 400, { error:"Password must contain at least 4 characters" });
        if (!["member","viewer","admin"].includes(body.role || "member")) return json(res, 400, { error:"Unsupported role" });
        const users = loadUsers();
        if (users.some(item => item.username.toLowerCase() === username.toLowerCase())) return json(res, 409, { error:"Username already exists" });
        users.push({ username, role:body.role || "member", displayName:String(body.displayName || username).slice(0,80), ...hashPassword(password), createdAt:new Date().toISOString() });
        atomicJson(USERS_FILE, users);
        return json(res, 201, { user:publicUser(users.at(-1)) });
      }
      if (req.method === "GET" && route === "/api/teamwork/members") {
        const session = auth(req, res, ["admin"]); if (!session) return;
        return json(res, 200, { users:loadUsers().map(publicUser) });
      }
      return json(res, 404, { error:"Unknown Teamwork endpoint" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error:"Method not allowed" });
    let pathname = decodeURIComponent(route === "/" ? "/index.html" : route);
    if (pathname.includes("\0") || pathname.split("/").some(part => part === "..") || pathname.startsWith("/.")) return json(res, 400, { error:"Invalid path" });
    const file = path.resolve(ROOT, "." + pathname);
    if (!file.startsWith(ROOT + path.sep) || file.startsWith(DATA_DIR + path.sep)) return json(res, 403, { error:"Forbidden" });
    let stat;
    try { stat = fs.statSync(file); } catch { return json(res, 404, { error:"File not found" }); }
    if (!stat.isFile()) return json(res, 404, { error:"File not found" });
    res.writeHead(200, { "content-type":MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "content-length":stat.size, "cache-control":path.extname(file)===".html"?"no-cache":"public, max-age=300", "x-content-type-options":"nosniff", "referrer-policy":"no-referrer" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error:error.status ? error.message : "Internal Teamwork host error" });
    else res.destroy();
  }
};
const server = http.createServer(handler);

const cert = process.env.ARQENVO_TEAMWORK_TLS_CERT, key = process.env.ARQENVO_TEAMWORK_TLS_KEY;
if (cert && key) {
  const tlsServer = https.createServer({ cert:fs.readFileSync(path.resolve(cert)), key:fs.readFileSync(path.resolve(key)) }, handler);
  tlsServer.listen(PORT, HOST, () => console.log("ARQENVO Teamwork HTTPS host listening on " + HOST + ":" + PORT));
} else {
  server.listen(PORT, HOST, () => {
    console.log("ARQENVO Teamwork host listening on http://" + HOST + ":" + PORT);
    console.log("Open from other devices using one of these LAN addresses:");
    for (const address of clientInfo().lanAddresses) console.log("  http://" + address + ":" + PORT);
    console.log("Data and backups: " + DATA_DIR);
    console.warn("Use a trusted private LAN, enable the OS firewall, and do not port-forward this service to the public internet.");
  });
}

export { server, DATA_DIR, validateProject };
