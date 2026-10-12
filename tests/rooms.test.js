import test from "node:test";
import assert from "node:assert/strict";
import { createWall } from "../src/core/model.js";
import { detectRooms } from "../src/core/rooms.js";

test("detects one closed rectangular room from connected walls", () => {
  const walls=[
    createWall({x:0,y:0},{x:4,y:0},{id:"a"}),
    createWall({x:4,y:0},{x:4,y:3},{id:"b"}),
    createWall({x:4,y:3},{x:0,y:3},{id:"c"}),
    createWall({x:0,y:3},{x:0,y:0},{id:"d"})
  ];
  const rooms=detectRooms(walls);
  assert.equal(rooms.length,1);
  assert.equal(rooms[0].area,12);
  assert.equal(rooms[0].boundaryWallIds.length,4);
});
test("does not report an open three-wall chain as a room", () => {
  const walls=[createWall({x:0,y:0},{x:4,y:0}),createWall({x:4,y:0},{x:4,y:3}),createWall({x:4,y:3},{x:0,y:3})];
  assert.equal(detectRooms(walls).length,0);
});
test("tolerance joins slightly offset endpoints", () => {
  const walls=[createWall({x:0,y:0},{x:4,y:0}),createWall({x:4.005,y:0},{x:4,y:3}),createWall({x:4,y:3},{x:0,y:3}),createWall({x:0,y:3},{x:0,y:0})];
  assert.equal(detectRooms(walls,{tolerance:.02}).length,1);
});
test("splits mid-wall intersections and detects two rooms from a partition", () => {
  const walls = [
    createWall({x:0,y:0},{x:4,y:0},{id:"bottom"}),
    createWall({x:4,y:0},{x:4,y:3},{id:"right"}),
    createWall({x:4,y:3},{x:0,y:3},{id:"top"}),
    createWall({x:0,y:3},{x:0,y:0},{id:"left"}),
    createWall({x:2,y:0},{x:2,y:3},{id:"partition"})
  ];
  const rooms = detectRooms(walls);
  assert.equal(rooms.length, 2);
  assert.deepEqual(rooms.map(r => r.area), [6, 6]);
  assert.ok(rooms.every(r => r.boundaryWallIds.includes("partition")));
});
test("splits walls at proper X crossings without inventing a closed room", () => {
  const walls = [
    createWall({x:0,y:0},{x:4,y:4},{id:"diagonal-a"}),
    createWall({x:0,y:4},{x:4,y:0},{id:"diagonal-b"})
  ];
  assert.equal(detectRooms(walls).length, 0);
});
test("rejects non-positive room tolerance", () => {
  assert.throws(() => detectRooms([], { tolerance: 0 }), /tolerance/);
});
