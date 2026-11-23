// Regenerates resources/icon-maskable.png: the installed app's Dock icon (Chrome on macOS builds app.icns from it, full bleed, and the
// system masks it to its tile). The canvas IS the tile: icon.png's own tile gradient edge to edge and the mark at the same share of the
// tile as in icon.png (572 of its 825 px tile, 69.3%), so the Dock shows the mark as large as icon.png does, with no tile inside a tile.
// The mark is favicon.svg's path, rendered by Chrome at 1024 px. Run: node scripts/make-maskable.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startChrome } from "./proofs/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const path = /<path d="([^"]+)"/.exec(readFileSync(join(here, "..", "resources", "favicon.svg"), "utf8"))?.[1];
if (path === undefined) throw new Error("favicon.svg has no path");
const SIZE = 1024;
const SHARE = 0.693; // the mark's width, of the canvas
// the path's own box: viewBox 0 0 100 100 holds it (the mark spans ~0.5..99.5 of it); the page measures it exactly
const html = `<!doctype html><meta charset=utf-8><style>html,body{margin:0}body{width:${SIZE}px;height:${SIZE}px;background:linear-gradient(#fdfdfd,#f0f1f4)}svg{position:absolute;left:0;top:0}</style><svg id=s width=${SIZE} height=${SIZE} viewBox="0 0 100 100"><path id=p fill="#0a0a0a" d="${path}"/></svg><script>window.__kiso=1;const b=document.getElementById('p').getBBox();const k=${SHARE}*100/b.width;document.getElementById('p').setAttribute('transform','translate('+(50-(b.x+b.width/2)*k)+' '+(50-(b.y+b.height/2)*k)+') scale('+k+')');</script>`;
const chrome = await startChrome();
const tab = await chrome.open(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
await tab.cdp("Emulation.setDeviceMetricsOverride", { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 400));
const png = Buffer.from((await tab.cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 } })).data, "base64");
writeFileSync(join(here, "..", "resources", "icon-maskable.png"), png);
await tab.close();
await chrome.close();
console.log(`icon-maskable.png ${png.length} bytes`);
