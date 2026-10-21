import test from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph, ModelHistory, transactModel } from "../src/core/transactions.js";

test("dependency graph invalidates all downstream derived outputs", () => {
  const graph = new DependencyGraph()
    .add("wall:1", "join:1")
    .add("join:1", "room:1")
    .add("room:1", "schedule:rooms")
    .add("wall:1", "section:A-A");
  assert.deepEqual(new Set(graph.dependentsOf(["wall:1"])), new Set(["join:1", "room:1", "schedule:rooms", "section:A-A"]));
  assert.deepEqual(graph.dependenciesOf("room:1"), ["join:1"]);
});

test("dependency graph rejects self-dependencies and cycles", () => {
  const graph = new DependencyGraph().add("wall", "room").add("room", "schedule");
  assert.throws(() => graph.add("wall", "wall"), /itself/);
  assert.throws(() => graph.add("schedule", "wall"), /cycle/);
});

test("transactions are atomic and validate before publishing", () => {
  const original = { elements: [{ id: "w1", height: 3 }] };
  const result = transactModel(original, {
    label: "Change wall height",
    mutate: draft => { draft.elements[0].height = 4; return { changedNodes: ["wall:w1"] }; },
    validate: draft => draft.elements[0].height > 0
  });
  assert.equal(original.elements[0].height, 3);
  assert.equal(result.model.elements[0].height, 4);
  assert.deepEqual(result.changedNodes, ["wall:w1"]);
  assert.throws(() => transactModel(original, {
    mutate: draft => { draft.elements[0].height = -1; },
    validate: () => false
  }), /validation failed/);
  assert.equal(original.elements[0].height, 3);
});

test("transactions reject async mutators so partial edits cannot escape", () => {
  const model = { value: 1 };
  assert.throws(() => transactModel(model, { mutate: async draft => { draft.value = 2; } }), /synchronous/);
  assert.equal(model.value, 1);
});

test("model history supports undo redo and clears redo on new edit", () => {
  const history = new ModelHistory({ limit: 2 });
  const a = { value: 1 }, b = { value: 2 }, c = { value: 3 };
  history.commit(a, b, "one");
  history.commit(b, c, "two");
  assert.deepEqual(history.undo(c), b);
  assert.deepEqual(history.redo(b), c);
  history.undo(c);
  history.commit(b, { value: 9 }, "replacement");
  assert.equal(history.canRedo, false);
});

test("history enforces a bounded positive limit", () => {
  assert.throws(() => new ModelHistory({ limit: 0 }), /positive/);
  const history = new ModelHistory({ limit: 2 });
  history.commit({ n: 0 }, { n: 1 });
  history.commit({ n: 1 }, { n: 2 });
  history.commit({ n: 2 }, { n: 3 });
  assert.deepEqual(history.undo({ n: 3 }), { n: 2 });
  assert.deepEqual(history.undo({ n: 2 }), { n: 1 });
  assert.equal(history.canUndo, false);
});

test("model history ignores no-op snapshots and preserves undo state", () => {
  const history = new ModelHistory();
  const model = { elements: [{ id: "wall-1", thickness: 0.2 }] };
  history.commit(model, structuredClone(model), "No-op edit");
  assert.equal(history.canUndo, false);
  history.commit(model, { elements: [{ id: "wall-1", thickness: 0.3 }] }, "Change thickness");
  assert.equal(history.canUndo, true);
  assert.deepEqual(history.undo({ elements: [{ id: "wall-1", thickness: 0.3 }] }), model);
});
