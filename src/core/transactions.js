/**
 * ARQENVO model transaction and dependency services.
 * Pure local-first services; no UI, network, or storage coupling.
 */
const clone = value => structuredClone(value);

export class DependencyGraph {
  #forward = new Map();
  #reverse = new Map();

  add(source, dependent) {
    if (!source || !dependent) throw new TypeError("Dependency nodes must be non-empty strings");
    if (source === dependent) throw new RangeError("A node cannot depend on itself");
    if (this.#reachable(dependent, source)) throw new RangeError("Dependency would create a cycle");
    if (!this.#forward.has(source)) this.#forward.set(source, new Set());
    if (!this.#reverse.has(dependent)) this.#reverse.set(dependent, new Set());
    this.#forward.get(source).add(dependent);
    this.#reverse.get(dependent).add(source);
    return this;
  }

  remove(source, dependent) {
    this.#forward.get(source)?.delete(dependent);
    this.#reverse.get(dependent)?.delete(source);
  }

  #reachable(from, target) {
    const seen = new Set(), stack = [from];
    while (stack.length) {
      const node = stack.pop();
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(this.#forward.get(node) ?? []));
    }
    return false;
  }

  dependentsOf(changedNodes) {
    const seen = new Set(), queue = [...new Set(changedNodes)];
    while (queue.length) {
      const node = queue.shift();
      for (const dependent of this.#forward.get(node) ?? []) {
        if (!seen.has(dependent)) { seen.add(dependent); queue.push(dependent); }
      }
    }
    return [...seen];
  }

  dependenciesOf(node) { return [...(this.#reverse.get(node) ?? [])]; }
  clear() { this.#forward.clear(); this.#reverse.clear(); }
}

export class ModelHistory {
  #past = [];
  #future = [];
  #limit;

  constructor({ limit = 80 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("History limit must be a positive integer");
    this.#limit = limit;
  }

  get canUndo() { return this.#past.length > 0; }
  get canRedo() { return this.#future.length > 0; }

  commit(before, after, label = "Edit model") {
    if (!label.trim()) throw new TypeError("History label is required");
    this.#past.push({ snapshot: clone(before), label });
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#future = [];
    return clone(after);
  }

  undo(current) {
    if (!this.canUndo) return null;
    const entry = this.#past.pop();
    this.#future.push({ snapshot: clone(current), label: entry.label });
    return clone(entry.snapshot);
  }

  redo(current) {
    if (!this.canRedo) return null;
    const entry = this.#future.pop();
    this.#past.push({ snapshot: clone(current), label: entry.label });
    return clone(entry.snapshot);
  }

  clear() { this.#past = []; this.#future = []; }
}

/**
 * Runs a synchronous model edit atomically. The mutator edits a cloned draft;
 * validation must throw or return false to abort. Original model remains untouched
 * on any failure. The returned changed-node list drives derived-view invalidation.
 */
export function transactModel(model, { label, mutate, validate, history } = {}) {
  if (!model || typeof model !== "object") throw new TypeError("A model object is required");
  if (typeof mutate !== "function") throw new TypeError("A transaction mutator is required");
  const before = clone(model);
  const draft = clone(model);
  const result = mutate(draft);
  if (result && typeof result.then === "function") throw new TypeError("Model transactions must be synchronous");
  if (validate) {
    const verdict = validate(draft);
    if (verdict === false) throw new Error("Model transaction validation failed");
    if (verdict && verdict.valid === false) throw new Error((verdict.errors ?? ["Model transaction validation failed"]).join("; "));
  }
  const changedNodes = result?.changedNodes ?? ["model"];
  const next = history ? history.commit(before, draft, label ?? "Edit model") : draft;
  return { model: next, result: result?.value, changedNodes: [...new Set(changedNodes)] };
}
