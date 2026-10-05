import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function decodeHTML(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity) => {
    if (entity.startsWith("#")) {
      const number =
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return String.fromCodePoint(number);
    }
    if (!(entity in named)) throw new Error(`Unsupported notice HTML entity: ${entity}`);
    return named[entity];
  });
}

// These are lexical evidence tags, not SPDX expressions or license selections.
// For example, MPL's text mentions LGPL as a possible secondary license, and a
// component may offer an Apache/Boost choice. A tag alone cannot approve either.
const families = [
  ["MIT", /Permission is hereby granted, free of charge/i],
  ["BSD", /Redistribution and use in source and binary forms/i],
  ["Apache-2.0", /Apache License[\s\S]*?Version 2\.0/i],
  ["LGPL", /GNU (?:Lesser|Library) General Public License/i],
  ["GPL", /GNU General Public License/i],
  ["MPL", /Mozilla Public License/i],
  ["ISC", /ISC License|ISC licence/i],
  ["FTL", /The FreeType Project LICENSE/i],
  ["OFL-1.1", /SIL OPEN FONT LICENSE Version 1\.1/i],
  ["Zlib", /The origin of this software must not be misrepresented/i],
  ["BSL-1.0", /Boost Software License/i],
  ["Unicode-3.0", /UNICODE LICENSE V3/i],
  ["Creative-Commons", /Creative Commons|CC0 1\.0/i],
  ["SunPro", /Developed at SunPro|SunPro license/i],
  ["public-domain", /public domain|unencumbered software/i],
];

export function parseChromiumNotices(html) {
  const components = [];
  const occurrences = new Map();
  let line = 1;
  let previous = 0;
  for (const match of html.matchAll(
    /<div class="product">([\s\S]*?)(?=<div class="product">|$)/g,
  )) {
    line += html.slice(previous, match.index).split("\n").length - 1;
    previous = match.index;
    const section = match[1];
    const title = section.match(/<span class="title">([\s\S]*?)<\/span>/)?.[1];
    const grants = [...section.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((entry) =>
      decodeHTML(entry[1]),
    );
    if (!title || !grants.length || !grants.some((text) => text.trim()))
      throw new Error("Chromium product section has no title or license text");
    const name = decodeHTML(title);
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    const text = grants.join("\n");
    components.push({
      name,
      occurrence,
      noticeLine: line,
      sha256: sha256(text),
      licenseFamilies: families
        .filter(([, pattern]) => pattern.test(text))
        .map(([family]) => family),
    });
  }
  if (!components.length) throw new Error("No recognized Chromium product sections");
  return components;
}

/** Preserve binary-license evidence separately from the npm wrapper's MIT grant. */
export async function collectElectronLicenses({ root }) {
  const directory = "apps/desktop/node_modules/electron";
  const pkg = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"));
  const result = {
    version: pkg.version,
    platform: process.platform,
    arch: process.arch,
    artifacts: [],
    components: [],
    findings: [],
  };
  const finding = (message) =>
    result.findings.push({
      ecosystem: "npm",
      name: "electron",
      version: pkg.version,
      kind: "binary-evidence",
      message,
    });
  try {
    const version = (await readFile(path.join(root, directory, "dist/version"), "utf8"))
      .trim()
      .replace(/^v/, "");
    if (version !== pkg.version)
      throw new Error(`Installed Electron binary ${version} differs from npm ${pkg.version}`);
    for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
      const file = `${directory}/dist/${name}`;
      const bytes = await readFile(path.join(root, file));
      if (!bytes.length) throw new Error(`Empty Electron binary notice: ${name}`);
      result.artifacts.push({ file, sha256: sha256(bytes), bytes: bytes.length });
      if (name === "LICENSES.chromium.html")
        result.components = parseChromiumNotices(bytes.toString("utf8"));
    }
    finding(
      `Electron's npm MIT grant does not approve the bundled Chromium/Node/FFmpeg runtime. ${result.components.length} notice sections were recorded; license selections and per-platform binary reachability remain unresolved under the MIT/BSD/Apache-only policy. See docs/licenses/electron-audit.md.`,
    );
  } catch (error) {
    finding(`Electron binary notice evidence is incomplete: ${error.message}`);
  }
  return result;
}
