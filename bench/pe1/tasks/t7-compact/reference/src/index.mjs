import { status1 } from "./mod1.mjs";
import { status2 } from "./mod2.mjs";
import { status3 } from "./mod3.mjs";
import { status4 } from "./mod4.mjs";
import { status5 } from "./mod5.mjs";
import { status6 } from "./mod6.mjs";

export function allFinal() {
  return [status1(), status2(), status3(), status4(), status5(), status6()].every((s) => s === "final");
}
