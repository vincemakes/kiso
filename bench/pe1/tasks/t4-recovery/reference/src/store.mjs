let seq = 0;
const notes = new Map();

export function add(text) {
  seq += 1;
  notes.set(seq, { id: seq, text });
  return seq;
}

export function remove(id) {
  return notes.delete(id);
}

export function list() {
  return [...notes.values()];
}

export function reset() {
  seq = 0;
  notes.clear();
}
