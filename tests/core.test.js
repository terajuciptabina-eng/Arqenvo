import test from "node:test";
import assert from "node:assert/strict";
import { createProject, createWall, createSlab, createColumn, createBeam, addOpening, wallLength, grossWallArea, netWallArea, polygonArea, polygonPerimeter, createStory, validateProject, serializeProject, deserializeProject, elementSchedule } from "../src/core/model.js";

test("project has one ground story and metric units", () => {
 const p=createProject("Test House"); assert.equal(p.project.name,"Test House"); assert.equal(p.project.units,"m"); assert.equal(p.stories.length,1);
});
test("wall length and gross/net area calculate correctly", () => {
 const w=createWall({x:0,y:0},{x:4,y:0},{height:3,thickness:.15}); assert.equal(wallLength(w),4); assert.equal(grossWallArea(w),12);
 addOpening(w,"door",1,.9,2.1); assert.equal(netWallArea(w),10.11);
});
test("wall rejects zero length and invalid opening", () => {
 assert.throws(()=>createWall({x:1,y:1},{x:1,y:1})); const w=createWall({x:0,y:0},{x:2,y:0}); assert.throws(()=>addOpening(w,"window",1.8,.5,1));
});
test("slab area uses polygon geometry and rejects invalid boundary", () => {
 const s=createSlab([{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}]); assert.equal(polygonArea(s.boundary),12); assert.equal(polygonPerimeter(s.boundary),14); assert.throws(()=>createSlab([{x:0,y:0},{x:1,y:1}]));
});
test("columns and beams validate dimensions", () => {
 assert.equal(createColumn({x:0,y:0},{width:.4,depth:.3}).depth,.3); assert.equal(wallLength(createWall({x:0,y:0},{x:0,y:5})),5);
 assert.equal(createBeam({x:0,y:0},{x:3,y:4}).start.x,0); assert.throws(()=>createBeam({x:0,y:0},{x:0,y:0}));
});
test("story and project validation detect duplicate ids", () => {
 assert.equal(createStory("Level 1",3,3).elevation,3); const p=createProject(); p.elements=[createWall({x:0,y:0},{x:1,y:0},{id:"same"}),createWall({x:0,y:1},{x:1,y:1},{id:"same"})]; assert.equal(validateProject(p).valid,false);
});
test("project serialization round trips", () => {
 const p=createProject("Round trip"); p.elements.push(createWall({x:0,y:0},{x:5,y:0})); const q=deserializeProject(serializeProject(p)); assert.equal(q.project.name,"Round trip"); assert.equal(q.elements.length,1); assert.equal(q.version,2);
});
test("legacy v1 project migrates to schema v2", () => {
 const q=deserializeProject(JSON.stringify({format:"ARQENVO-PROJECT",version:1,walls:[{id:"w1",a:{x:0,y:0},b:{x:2,y:0},height:3,thickness:.15}],slabs:[],columns:[],beams:[],dimensions:[]})); assert.equal(q.version,2); assert.equal(q.elements[0].type,"wall"); assert.equal(q.elements[0].start.x,0);
});
test("element schedule reports quantities by story", () => {
 const p=createProject(); p.elements.push(createWall({x:0,y:0},{x:2,y:0})); const rows=elementSchedule(p); assert.equal(rows[0].story,"Ground Floor"); assert.equal(rows[0].length,2); assert.equal(rows[0].area,6);
});
