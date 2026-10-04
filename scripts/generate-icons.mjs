import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ImageMagick is needed only to regenerate the checked-in assets, not to build.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "assets/appicon.png");
const desktop = path.join(root, "apps/desktop/build");
const web = path.join(root, "apps/editor-web/public");
let convert;
for (const candidate of ["magick", "convert"]) {
  try {
    const version = execFileSync(candidate, ["-version"], { encoding: "utf8" });
    if (version.includes("ImageMagick")) {
      convert = candidate;
      break;
    }
  } catch {
    // ImageMagick 7 uses magick; older installations use convert.
  }
}
if (!convert) throw new Error("Install ImageMagick to regenerate the app icons.");

mkdirSync(path.join(desktop, "icons"), { recursive: true });
mkdirSync(web, { recursive: true });
const temporary = mkdtempSync(path.join(tmpdir(), "aae-icons-"));
try {
  const pngs = new Map();
  for (const size of [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024]) {
    const destination = path.join(temporary, `${size}.png`);
    execFileSync(convert, [
      source,
      "-filter",
      "Lanczos",
      "-resize",
      `${size}x${size}`,
      "-strip",
      destination,
    ]);
    pngs.set(size, destination);
  }
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    copyFileSync(pngs.get(size), path.join(desktop, "icons", `${size}x${size}.png`));
  }
  copyFileSync(pngs.get(32), path.join(web, "favicon-32.png"));
  copyFileSync(pngs.get(180), path.join(web, "apple-touch-icon.png"));
  copyFileSync(pngs.get(512), path.join(web, "app-icon.png"));
  execFileSync(convert, [
    ...[16, 24, 32, 48, 64, 128, 256].map((size) => pngs.get(size)),
    path.join(desktop, "icon.ico"),
  ]);
  execFileSync(convert, [
    ...[16, 32, 48].map((size) => pngs.get(size)),
    path.join(web, "favicon.ico"),
  ]);

  // Modern ICNS entries store PNG data with a type and big-endian chunk length.
  const chunks = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ].map(([type, size]) => {
    const png = readFileSync(pngs.get(size));
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  writeFileSync(path.join(desktop, "icon.icns"), Buffer.concat([header, ...chunks]));
  console.log("Generated desktop and web icons from assets/appicon.png.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
