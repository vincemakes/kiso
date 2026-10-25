import { createContext, useContext } from "react";
import type { PanelKind } from "../state/panels.js";

/** Opening a panel from anywhere: the menu, a thumbnail in the stream, a row in the rail. */
export const PanelContext = createContext<(kind: PanelKind, focus?: string) => void>(() => undefined);
export const useOpenPanel = (): ((kind: PanelKind, focus?: string) => void) => useContext(PanelContext);
