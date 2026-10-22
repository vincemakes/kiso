/**
 * The coding product's policy, as a library door: the prompt and tool rules,
 * and the extensions that bound what a coding agent may do (the catastrophe
 * floor, the protected-file shell guard, the read-only shell allow, the loop
 * breaker, the mode tiers). Everything here is state-free except the mode
 * tier, which is process-local (`getMode` / `setMode`). A host that is not
 * the terminal (the desktop app) composes the same agent from these and the
 * public runtime and tool packages.
 */

export { CODING_TOOL_RULES, SYSTEM_PROMPT, composeSystemPrompt } from "./coding-prompt.js";
export { breakerExtension } from "./breaker.js";
export { floorExtension } from "./floor.js";
export { MODE_LABEL, OFFERED_MODES, getMode, modeExtensions, modeSystemPrompt, setMode } from "./mode.js";
export { protectedShellExtension } from "./protected-shell.js";
export { guardSavedAllow, neverInheritedCall } from "./protected-writes.js";
export { readOnlyShellExtension } from "./readonly-shell.js";
