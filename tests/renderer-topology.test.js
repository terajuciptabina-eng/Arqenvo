import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

test("3D projected vertices retain model-space coordinates for topology", () => {
  assert.match(
    source,
    /return\{x:c\.clientWidth\/2\+origin\.x\+px,y:c\.clientHeight\*\.58\+origin\.y\+py,depth:ry\*cp\+wz\*sp,worldX:wx,worldY:wy,worldZ:wz\}/,
    "projection must retain world coordinates alongside screen coordinates"
  );
});

test("3D wall edge identity and face normals are camera-independent", () => {
  assert.match(source, /const edgePointKey=pt=>\[pt\.worldX,pt\.worldY,pt\.worldZ\]/);
  assert.match(source, /const ux=b\.worldX-a\.worldX,uy=b\.worldY-a\.worldY,uz=b\.worldZ-a\.worldZ/);
  assert.match(source, /const d=normal\.x\*p\.worldX\+normal\.y\*p\.worldY\+normal\.z\*p\.worldZ/);
  assert.match(source, /const edgeVec=\{x:b\.worldX-a\.worldX,y:b\.worldY-a\.worldY,z:b\.worldZ-a\.worldZ\}/);
});

test("coplanar wall seam suppression uses model-space tolerances", () => {
  assert.match(source, /Math\.abs\(plane\.d-otherPlane\.d\)>.001/);
  assert.match(source, /Math\.hypot\(wx-vx\*t,wy-vy\*t,wz-vz\*t\)<=\.001/);
});

test("3D seam cleanup checks partial edge coverage in model space", () => {
  assert.match(source, /const edgeCoveredByCoplanarFace=/);
  assert.match(source, /const samples=\[0,\.25,\.5,\.75,1\]/);
  assert.match(source, /samples\.every\(point=>pointInFace3d\(point,other\)\)/);
});

test("3D wall endpoint edge is omitted only when topology identifies a joined endpoint", () => {
  assert.match(source, /wallEndNeighbors\.get\(face\.id\+":"\+\(atStart\?"start":"end"\)\)/);
  assert.match(source, /if\(exactSharedCoplanarEdge\|\|edgeCoveredByCoplanarFace\(a,b,face\)\)continue/);
});
