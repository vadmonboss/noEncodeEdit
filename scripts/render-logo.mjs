// Renders assets/logo.svg to a 1024px PNG for `tauri icon`.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "assets", "logo.svg"), "utf8");
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
writeFileSync(join(root, "assets", "logo.png"), png);
console.log("assets/logo.png written", png.length, "bytes");
