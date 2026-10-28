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
  assert.match(source, /const edgePointKey=pt=>\[pt\.worldX,pt\.worldY,pt\.worldZ\]/);
  assert.match(source, /segmentCoveredByPolygon2D\(start2,end2,other\.poly\.map\(uv\),\{tolerance:\.001\}\)/);
});

test("3D edge renderer delegates complete coplanar coverage to the geometric predicate", () => {
  assert.match(source, /segmentCoveredByPolygon2D\(start2,end2,other\.poly\.map\(uv\),\{tolerance:\.001\}\)/);
  assert.match(source, /wallEndNeighbors\.get\(endpointKey\)\|\|\[\]/);
});

test("3D wall top-face renderer suppresses only fully covered coplanar cap edges", () => {
  assert.match(source, /const topFaces=orderedFaces\.filter\(face=>face\.topFace&&face\.poly\.length>=3\)/);
  assert.match(source, /const topFaceEdgeCovered=\(face,a,b\)=>/);
  assert.match(source, /Math\.abs\(other\.poly\[0\]\.worldZ-a\.worldZ\)>.001/);
  assert.match(source, /if\(topFaceEdgeCovered\(face,a,b\)\)continue/);
  assert.match(source, /face\.skipTopEdges\?\.includes\(i\)/);
});
