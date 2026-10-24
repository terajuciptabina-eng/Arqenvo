import test from "node:test";
import assert from "node:assert/strict";
import { createProject, createWall, createSlab, createColumn, createBeam, createRoof, addOpening, wallLength, grossWallArea, netWallArea, polygonArea, polygonPerimeter, createStory, validateProject, serializeProject, deserializeProject, elementSchedule } from "../src/core/model.js";

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

test("project validation rejects duplicate stories and invalid story geometry", () => {
 const p=createProject();
 p.stories.push({id:p.stories[0].id,name:"First Floor",elevation:3,height:3});
 assert.equal(validateProject(p).valid,false);
 const q=createProject();
 q.stories[0].height=0;
 assert.equal(validateProject(q).valid,false);
});
test("project validation rejects elements assigned to unknown stories", () => {
 const p=createProject();
 p.elements.push(createWall({x:0,y:0},{x:2,y:0},{storyId:"missing-story"}));
 assert.ok(validateProject(p).errors.some(error=>error.includes("unknown story")));
});
test("project validation rejects duplicate story names ignoring case", () => {
 const p=createProject();
 p.stories.push({id:"story-first",name:"ground floor",elevation:3,height:3});
 assert.ok(validateProject(p).errors.some(error=>error.includes("Duplicate story name")));
});

test("project validation rejects invalid wall geometry and out-of-bounds openings", () => {
 const p=createProject();
 const wall=createWall({x:0,y:0},{x:2,y:0});
 wall.height=0;
 p.elements.push(wall);
 assert.ok(validateProject(p).errors.some(error=>error.includes("invalid height or thickness")));
 const q=createProject();
 const host=createWall({x:0,y:0},{x:2,y:0});
 host.openings.push({id:"opening-1",type:"door",offset:1.8,width:.5,height:2,sill:0});
 q.elements.push(host);
 assert.ok(validateProject(q).errors.some(error=>error.includes("exceeds wall")));
});
test("project validation rejects hosted door/window elements without host links", () => {
 const p=createProject();
 p.elements.push({id:"door-1",type:"door",storyId:p.stories[0].id,hostWallId:"missing",offset:0,width:.9,height:2.1,sill:0});
 assert.ok(validateProject(p).errors.some(error=>error.includes("has no host wall")));
});

test("Roof persists its wall-derived boundary and parameters",()=>{
 const p=createProject("Roof"),boundary=[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}],roof=createRoof(boundary,{storyId:p.stories[0].id,elevation:3,pitch:30,sourceWallIds:["a","b","c","d"]});
 p.elements.push(roof);assert.equal(validateProject(p).valid,true);assert.equal(elementSchedule(p).find(e=>e.type==="roof").area,12);
 const loaded=deserializeProject(serializeProject(p));assert.deepEqual(loaded.elements[0].boundary,boundary);assert.equal(loaded.elements[0].pitch,30);
 assert.throws(()=>createRoof([{x:0,y:0},{x:1,y:0}],{}),/boundary/);
});
