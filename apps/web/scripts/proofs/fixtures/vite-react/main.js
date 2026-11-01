// A page built by Vite with React, for the preview-pages proof: module scripts and a stylesheet from /assets/, loaded with CORS
// from the page's own preview server. Once it has rendered it tells the panel's page what it sees.
import { createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
	useEffect(() => {
		const title = document.querySelector("h1");
		parent.postMessage({ page: "react", text: title.textContent, color: getComputedStyle(title).color }, "*");
	}, []);
	return h("h1", null, "A React page");
}

createRoot(document.getElementById("root")).render(h(App));
