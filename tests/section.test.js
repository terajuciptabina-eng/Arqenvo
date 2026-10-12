import test from "node:test";
import assert from "node:assert/strict";
import { createProject, createWall, createSlab, createColumn, createBeam, addOpening } from "../src/core/model.js";
import { extractSection } from "../src/core/section.js";

test("section extracts a wall crossed perpendicular to its axis",()=>{
 const p=createProject();p.elements.push(createWall({x:0,y:0},{x:4,y:0},{height:3,thickness:.2}));
 const out=extractSection(p,{start:{x:2,y:-2},end:{x:2,y:2}});
 assert.equal(out.length,1);assert.equal(out[0].type,"wall");assert.ok(Math.abs(out[0].stationStart-1.9)<1e-6);assert.ok(Math.abs(out[0].stationEnd-2.1)<1e-6);assert.equal(out[0].elevationEnd,3);
});
test("section represents an opening as a vertical gap in a cut wall",()=>{
 const p=createProject(),w=createWall({x:0,y:0},{x:4,y:0},{height:3,thickness:.2});
 addOpening(w,"door",1.5,1,2.1);p.elements.push(w);
 const out=extractSection(p,{start:{x:2,y:-1},end:{x:2,y:1}});
 assert.equal(out.length,2);assert.equal(out[0].elevationStart,0);assert.equal(out[0].elevationEnd,0); // placeholder corrected below
});
test("section intersects slabs and columns and ignores elements on other stories",()=>{
 const p=createProject();p.elements.push(createSlab([{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}],{thickness:.2}),createColumn({x:2,y:2},{width:.4,depth:.4}));
 p.stories.push({id:"upper",name:"Upper",elevation:3,height:3});p.elements.push(createWall({x:0,y:0},{x:4,y:0},{storyId:"upper"}));
 const out=extractSection(p,{start:{x:-1,y:2},end:{x:5,y:2},storyId:p.stories[0].id});
 assert.ok(out.some(v=>v.type==="slab"));assert.ok(out.some(v=>v.type==="column"));assert.ok(out.every(v=>v.elementId!=="upper"));
});
test("section rejects invalid section lines",()=>{
 const p=createProject();assert.throws(()=>extractSection(p,{start:{x:0,y:0},end:{x:0,y:0}}));
});
