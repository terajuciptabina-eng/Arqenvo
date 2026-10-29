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
  assert.match(source, /const topFaceGridSize=4,topFaceSpatialBuckets=new Map\(\)/);
  assert.match(source, /const topFaceEdgeCovered=\(face,a,b\)=>/);
  assert.match(source, /Math\.abs\(other\.poly\[0\]\.worldZ-a\.worldZ\)>.001/);
  assert.match(source, /if\(topFaceEdgeCovered\(face,a,b\)\)continue/);
  assert.match(source, /face\.skipTopEdges\?\.includes\(i\)/);
});

test("3D wall skin omits horizontal sill and head edges inside hosted openings", () => {
  assert.match(source, /const openingBoundary=ws\.openings\?\.some\(o=>/);
  assert.match(source, /ws\.lo>=o\.offset-1e-4&&ws\.hi<=o\.offset\+o\.width\+1e-4/);
  assert.match(source, /Math\.abs\(edgeZ-\(\(o\.sill\|\|0\)\+o\.height\)\)<\.001/);
});

test("3D wall top-face visibility uses a model-space spatial index", () => {
  assert.match(source, /const topFaceGridSize=4,topFaceSpatialBuckets=new Map\(\)/);
  assert.match(source, /const topFaceCellKey=\(elevation,x,y\)=>elevation\+":"\+x\+":"\+y/);
  assert.match(source, /const candidates=new Set\(\)/);
  assert.match(source, /topFaceSpatialBuckets\.get\(topFaceCellKey\(elevation,ix,iy\)\)/);
  assert.doesNotMatch(source, /for\(const other of topFacesByElevation\.get/);
});
