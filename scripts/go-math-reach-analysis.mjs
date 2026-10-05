import { createHash } from "node:crypto";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Go's mark() prints the parent that first retained each symbol. This is not
// a call graph, and unnamed parents and duplicate symbol names are possible.
export function parseDumpDependencies(text) {
  const edges = [];
  const headers = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "") continue;
    if (/^# [A-Za-z0-9_./-]+$/.test(line)) {
      headers.push(line.slice(2));
      continue;
    }
    let quote = "";
    let escaped = false;
    const delimiters = [];
    for (let pos = 0; pos < line.length; pos++) {
      const char = line[pos];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\" && quote === '"') escaped = true;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "`") quote = char;
      else if (line.startsWith(" -> ", pos)) {
        delimiters.push(pos);
        pos += 3;
      }
    }
    if (quote || delimiters.length !== 1 || /[\r\0]/.test(line)) {
      throw new Error(`Unrecognized Go dumpdep line ${index + 1}`);
    }
    const delimiter = delimiters[0];
    const from = splitFlags(line.slice(0, delimiter));
    const to = splitFlags(line.slice(delimiter + 4));
    if (!to.symbol || to.symbol === "_")
      throw new Error(`Invalid dumpdep destination at line ${index + 1}`);
    edges.push({ from: from.symbol, to: to.symbol, fromFlags: from.flags, toFlags: to.flags });
  }
  if (edges.length === 0 || !edges.some((edge) => edge.from === "_")) {
    throw new Error("Go dumpdep contains no root retention records");
  }
  return {
    format: "go1.26.8-first-mark",
    headers,
    edges,
    roots: [...new Set(edges.filter((edge) => edge.from === "_").map((edge) => edge.to))].sort(),
    symbols: [...new Set(edges.map((edge) => edge.to))].sort(),
  };
}

function splitFlags(value) {
  if (/ <[^ ]+>$/.test(value) && !/ (<UsedInIface>)?(<ReflectMethod>)?$/.test(value)) {
    throw new Error("Unknown Go dumpdep symbol flags");
  }
  const suffix = value.match(/ (<UsedInIface>)?(<ReflectMethod>)?$/);
  if (!suffix || suffix[0] === " ") return { symbol: value, flags: [] };
  return {
    symbol: value.slice(0, -suffix[0].length),
    flags: [suffix[1], suffix[2]].filter(Boolean),
  };
}

export function classifyNotice(notices) {
  const values = [...new Set(notices)].sort();
  if (values.some((value) => !["SunPro", "LicenseRef-Cephes"].includes(value))) {
    throw new Error("Unknown math source notice classification");
  }
  if (values.length === 2) return "mixed-SunPro-Cephes-file-notices";
  if (values.includes("SunPro")) return "SunPro-file-notice";
  if (values.includes("LicenseRef-Cephes")) return "Cephes-file-notice";
  return "no-SunPro-or-Cephes-file-notice";
}

export function analyzeMathReach(graph, inventory) {
  if (inventory.goVersion !== "go1.26.8" || !Array.isArray(inventory.sources)) {
    throw new Error("Unsupported math source inventory");
  }
  const locations = new Map();
  const selectedPaths = new Set();
  const sources = inventory.sources.map((source) => {
    if (
      !/^src\/math\/(cmplx\/)?[A-Za-z0-9_]+\.(go|s)$/.test(source.path) ||
      !/^[a-f0-9]{64}$/.test(source.sha256)
    ) {
      throw new Error("Invalid selected math source fingerprint");
    }
    if (selectedPaths.has(source.path)) throw new Error("Duplicate selected math source path");
    selectedPaths.add(source.path);
    const noticeClassification = classifyNotice(source.notices);
    for (const declaration of source.declarations) {
      if (
        !/^math(\/cmplx)?\.[A-Za-z_][A-Za-z_0-9]*$/.test(declaration.symbol) ||
        !Number.isInteger(declaration.line) ||
        declaration.line < 1 ||
        !["go-body", "go-declaration", "assembly-body"].includes(declaration.kind)
      ) {
        throw new Error("Invalid math declaration");
      }
      if (source.path.endsWith(".s") !== (declaration.kind === "assembly-body"))
        throw new Error("Math body language disagrees with source path");
      const list = locations.get(declaration.symbol) ?? [];
      list.push({
        ...declaration,
        source: source.path,
        sourceSha256: source.sha256,
        notices: source.notices,
        noticeClassification,
      });
      locations.set(declaration.symbol, list);
    }
    return { ...source, noticeClassification };
  });
  const parents = new Map();
  for (const edge of graph.edges) {
    const list = parents.get(edge.to) ?? [];
    list.push(edge.from);
    parents.set(edge.to, list);
  }
  const retainedMathSymbols = graph.symbols
    .filter((symbol) => symbol.startsWith("math.") || symbol.startsWith("math/cmplx."))
    .map((symbol) => {
      const base = symbol.replace(/\.abi0$/, "");
      const matches = locations.get(base) ?? [];
      const bodies = matches.filter((location) => location.kind !== "go-declaration");
      const path = [symbol];
      let current = symbol;
      let termination = "root";
      while (current !== "_") {
        const list = parents.get(current);
        if (!list || list.length !== 1) {
          termination = list ? "ambiguous-name" : "unrecorded-parent";
          break;
        }
        current = list[0];
        if (current === "") {
          termination = "unnamed-parent";
          break;
        }
        if (path.includes(current)) {
          termination = "cycle";
          break;
        }
        path.unshift(current);
      }
      return {
        symbol,
        firstRetainingParents: parents.get(symbol) ?? [],
        retentionPath: path,
        pathTermination: termination,
        mapping:
          bodies.length === 1
            ? "selected-source-body"
            : bodies.length > 1
              ? "ambiguous-source-body"
              : matches.length
                ? "declaration-only"
                : "unmapped-metadata-or-generated-symbol",
        abiWrapper: base !== symbol,
        sources: matches,
      };
    });
  return {
    selectedSources: sources,
    retainedMathSymbols,
    retainedBodyCount: retainedMathSymbols.filter(
      (entry) => entry.mapping === "selected-source-body",
    ).length,
    restrictedNoticeBodyCount: retainedMathSymbols.filter((entry) =>
      entry.sources.some((source) => source.kind !== "go-declaration" && source.notices.length > 0),
    ).length,
    limitations: [
      "Only the first retaining parent is printed; this is not a complete call graph.",
      "File notices classify source files, not individual functions or legal compliance.",
      "ABI suffix matches identify a source implementation, not the generated wrapper's instruction provenance.",
      "Absent out-of-line symbols do not prove absent inlined bodies, constants or derived code.",
      "Unmapped math symbols include metadata, variables and compiler-generated records; they are not cleared.",
    ],
  };
}

export function inspectWasm(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    throw new Error("Invalid WASM v1 header");
  const nonCustom = [bytes.subarray(0, 8)];
  const customSections = [];
  const functionNames = [];
  const standardSeen = new Set();
  const namedIndices = new Set();
  let namesSeen = false;
  let offset = 8;
  function leb(state, end) {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (state.pos >= end) throw new Error("Truncated WASM varuint32");
      const byte = bytes[state.pos++];
      if (shift === 28 && byte & 0xf0) throw new Error("Overflow WASM varuint32");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid WASM varuint32");
  }
  function string(state, end) {
    const length = leb(state, end);
    if (length > end - state.pos) throw new Error("Truncated WASM string");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(state.pos, state.pos + length),
    );
    state.pos += length;
    return value;
  }
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++];
    if (id > 13) throw new Error("Unsupported WASM section ID");
    const state = { pos: offset };
    const length = leb(state, bytes.length);
    const end = state.pos + length;
    if (end > bytes.length) throw new Error("Truncated WASM section");
    if (id === 0) {
      const name = string(state, end);
      customSections.push({ name, bytes: end - start });
      if (name === "name") {
        if (namesSeen) throw new Error("Duplicate WASM name section");
        namesSeen = true;
        let functionSubsectionSeen = false;
        while (state.pos < end) {
          const subsection = bytes[state.pos++];
          const sublength = leb(state, end);
          const subend = state.pos + sublength;
          if (subend > end) throw new Error("Truncated WASM name subsection");
          if (subsection === 1) {
            if (functionSubsectionSeen) throw new Error("Duplicate WASM function name subsection");
            functionSubsectionSeen = true;
            const count = leb(state, subend);
            if (count > sublength) throw new Error("Invalid WASM name count");
            for (let item = 0; item < count; item++) {
              const index = leb(state, subend);
              const name = string(state, subend);
              if (namedIndices.has(index)) throw new Error("Duplicate WASM function index");
              namedIndices.add(index);
              functionNames.push({ index, name });
            }
            if (state.pos !== subend) throw new Error("Trailing WASM function name data");
          }
          state.pos = subend;
        }
      }
    } else {
      if (standardSeen.has(id)) throw new Error("Duplicate WASM standard section");
      standardSeen.add(id);
      nonCustom.push(bytes.subarray(start, end));
    }
    offset = end;
  }
  return {
    bytes: bytes.length,
    customSections,
    functionNames,
    nonCustomSha256: sha256(Buffer.concat(nonCustom)),
  };
}
