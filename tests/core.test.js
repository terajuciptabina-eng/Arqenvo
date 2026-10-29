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
test("deserialization exposes wall-hosted openings as selectable project elements", () => {
 const p=createProject("Hosted opening selection");
 const wall=createWall({x:0,y:0},{x:4,y:0},{storyId:p.stories[0].id});
 const door=addOpening(wall,"door",1,.9,2.1);
 p.elements.push(wall);
 const loaded=deserializeProject(serializeProject(p));
 const selectable=loaded.elements.find(el=>el.type==="door"&&el.id===door.id);
 assert.ok(selectable,"A door stored only inside wall.openings must be exposed in project.elements");
 assert.equal(selectable.hostWallId,wall.id);
 assert.equal(selectable.storyId,wall.storyId);
 assert.equal(loaded.elements.filter(el=>el.id===door.id).length,1,"Normalization must not duplicate an already top-level opening");
});
test("deserialization reconciles standalone door data back into its host wall opening", () => {
 const p=createProject("Hosted opening reconciliation");
 const wall=createWall({x:0,y:0},{x:4,y:0},{storyId:p.stories[0].id});
 const door=addOpening(wall,"door",1,.9,2.1);
 door.hingeSide="right"; door.swingDirection="outside";
 p.elements.push(wall,{...door,hostWallId:wall.id,storyId:wall.storyId});
 const serialized=JSON.parse(serializeProject(p));
 serialized.elements.find(el=>el.type==="wall").openings=[];
 const loaded=deserializeProject(JSON.stringify(serialized));
 const host=loaded.elements.find(el=>el.id===wall.id);
 const opening=host.openings.find(el=>el.id===door.id);
 assert.ok(opening,"The host wall must regain the opening from its selectable Door element");
 assert.equal(opening.hingeSide,"right");
 assert.equal(opening.swingDirection,"outside");
 assert.equal(loaded.elements.filter(el=>el.id===door.id).length,1,"Exactly one selectable Door element must remain in project.elements");
});
test("element schedule reports quantities by story", () => {
 const p=createProject(); p.elements.push(createWall({x:0,y:0},{x:2,y:0})); const rows=elementSchedule(p); assert.equal(rows[0].story,"Ground Floor"); assert.equal(rows[0].length,2); assert.equal(rows[0].area,6);
});

test("Zone elements expose number, name, category, area and perimeter in schedules", () => {
 const p=createProject();
 p.elements.push({
  id:"zone-living",type:"room",storyId:p.stories[0].id,
  zoneNumber:"Z-01",roomName:"Living Room",zoneCategory:"Living",
  boundary:[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}],area:12,
 });
 const zone=elementSchedule(p).find(row=>row.id==="zone-living");
 assert.equal(zone.zoneNumber,"Z-01");
 assert.equal(zone.zoneName,"Living Room");
 assert.equal(zone.zoneCategory,"Living");
 assert.equal(zone.area,12);
 assert.equal(zone.perimeter,14);
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


test("normalization re-hosts an opening without stale or duplicate wall records", () => {
 const p=createProject("Re-host opening");
 const first=createWall({x:0,y:0},{x:4,y:0},{id:"wall-a",storyId:p.stories[0].id});
 const second=createWall({x:0,y:2},{x:4,y:2},{id:"wall-b",storyId:p.stories[0].id});
 const door={id:"door-a",type:"door",hostWallId:first.id,storyId:first.storyId,offset:1,width:.9,height:2.1,sill:0};
 first.openings=[{...door},{...door}]; second.openings=[{...door}];
 p.elements.push(first,second,{...door,hostWallId:second.id,offset:2});
 const loaded=deserializeProject(JSON.stringify(p));
 assert.equal(loaded.elements.find(e=>e.id==="wall-a").openings.some(o=>o.id==="door-a"),false);
 assert.equal(loaded.elements.find(e=>e.id==="wall-b").openings.filter(o=>o.id==="door-a").length,1);
 assert.equal(loaded.elements.filter(e=>e.id==="door-a").length,1);
 assert.equal(loaded.elements.find(e=>e.id==="door-a").hostWallId,"wall-b");
 assert.equal(loaded.elements.find(e=>e.id==="door-a").offset,2);
});

test("normalization binds hosted opening story to its current host wall", () => {
 const p=createProject("Host story");
 p.stories.push({id:"story-upper",name:"Upper Floor",elevation:3,height:3});
 const host=createWall({x:0,y:0},{x:4,y:0},{id:"wall-upper",storyId:"story-upper"});
 const door={id:"door-upper",type:"door",hostWallId:host.id,storyId:p.stories[0].id,offset:1,width:.9,height:2.1,sill:0};
 host.openings=[{...door}]; p.elements.push(host,{...door});
 const loaded=deserializeProject(JSON.stringify(p));
 assert.equal(loaded.elements.find(e=>e.id==="door-upper").storyId,"story-upper");
 assert.equal(validateProject(loaded).valid,true);
});

test("validation rejects hosted opening dimension/story mismatch and duplicates", () => {
 const makeFixture=()=>{
  const p=createProject("Invalid hosted opening");
  const wall=createWall({x:0,y:0},{x:4,y:0},{id:"wall-host"});
  const door={id:"door-host",type:"door",hostWallId:wall.id,storyId:wall.storyId,offset:1,width:.9,height:2.1,sill:0};
  wall.openings=[{...door}]; p.elements.push(wall,{...door}); return p;
 };
 for (const change of [{offset:NaN},{offset:3.5},{width:NaN},{width:0},{height:NaN},{sill:-.1},{storyId:"other-story"}]) {
  const p=makeFixture(); Object.assign(p.elements.find(e=>e.type==="door"),change);
  assert.equal(validateProject(p).valid,false);
 }
 const p=makeFixture(); p.elements.find(e=>e.type==="wall").openings.push({...p.elements.find(e=>e.type==="door")});
 assert.ok(validateProject(p).errors.some(error=>error.includes("duplicate hosted opening id")));
});

test("text annotation is a valid serializable project element", () => {
 const p=createProject("Text Annotation");
 p.elements.push({id:"text-1",type:"text",position:{x:1.25,y:2.5},text:"Ground Floor\\nRevision A",textSizeMm:2.5,storyId:p.stories[0].id});
 assert.deepEqual(validateProject(p),[]);
 const restored=deserializeProject(serializeProject(p));
 assert.equal(restored.elements[0].type,"text");
 assert.equal(restored.elements[0].text,"Ground Floor\\nRevision A");
 assert.deepEqual(restored.elements[0].position,{x:1.25,y:2.5});
 const invalid=structuredClone(p);invalid.elements[0].position.x=NaN;
 assert.ok(validateProject(invalid).some(error=>error.includes("Text text-1 has invalid position")));
});
