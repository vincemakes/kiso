// Loaded into the host (--import) by delete-tree: once a delete has removed `wp.jsonl`, the host stops for 3 s, as a descheduled CI host
// does, so the proof's restart (SIGKILL) lands in the middle of the delete's files (#21/#28): the startup sweep must finish it.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rm = fs.rmSync, pause = new Int32Array(new SharedArrayBuffer(4));
let held = false;
fs.rmSync = (p, o) => { const out = rm(p, o); if (!held && /[/\\]wp\.jsonl$/.test(String(p))) (held = true), Atomics.wait(pause, 0, 0, 3000); return out; };
syncBuiltinESMExports();
