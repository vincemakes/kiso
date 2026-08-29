/** The components cell renderer moved to tui-cells (ADR-0043
 *  Amendment 4) — this module is the re-export shim: the compositor's
 *  and index.ts's imports (./components.js) stay verbatim. */
export * from "@vincemakes/kiso-tui-cells/components";

// R3 (design §5.2): the two motion cycles reach the compositor through
// the same shim every other cell primitive does.
export { foldCountsObjects, foldTerms } from "@vincemakes/kiso-tui-cells/components";
export { MOTION_FRAMES, TWINKLE, breathFrame, twinkleFrame } from "@vincemakes/kiso-tui-cells/render";
