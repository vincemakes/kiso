import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/stream.css";
import "./styles/sidebar.css";
import "./styles/settings.css";
import "./styles/rail.css";
import "./styles/panels.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
