import test from "node:test";
import assert from "node:assert/strict";
import { createProject,createWall,createSlab,createColumn,createBeam } from "../src/core/model.js";
import { exportFloorPlanDxf } from "../src/core/dxf.js";

test("DXF exports supported plan geometry in model metres",()=>{
 const p=createProject();p.elements.push(createWall({x:0,y:0},{x:4,y:0}),createSlab([{x:0,y:0},{x:2,y:0},{x:2,y:2}]),createColumn({x:1,y:1}),createBeam({x:0,y:2},{x:4,y:2}));
 const dxf=exportFloorPlanDxf(p);
 assert.ok(dxf.startsWith("0\nSECTION\n2\nHEADER"));
 assert.ok(dxf.includes("$INSUNITS"));assert.ok(dxf.includes("A-WALL"));assert.ok(dxf.includes("A-SLAB"));assert.ok(dxf.includes("A-COLS"));assert.ok(dxf.endsWith("0\nEOF\n"));
 assert.equal((dxf.match(/\nLINE\n/g)||[]).length,9);
});
test("DXF respects selected story and rejects unknown story",()=>{
 const p=createProject();p.elements.push(createWall({x:0,y:0},{x:2,y:0}));p.stories.push({id:"upper",name:"Upper",elevation:3,height:3});p.elements.push(createWall({x:0,y:1},{x:2,y:1},{storyId:"upper"}));
 assert.equal((exportFloorPlanDxf(p).match(/\nLINE\n/g)||[]).length,1);
 assert.throws(()=>exportFloorPlanDxf(p,{storyId:"missing"}),/story/);
});
