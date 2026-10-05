import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeMathReach,
  classifyNotice,
  inspectWasm,
  parseDumpDependencies,
  sha256,
} from "./go-math-reach-analysis.mjs";

const fingerprint = "a".repeat(64);
const source = (path, notices, declarations) => ({
  path,
  sha256: fingerprint,
  notices,
  declarations,
});
const declaration = (symbol, kind = "go-body") => ({ symbol, line: 10, kind });
const inventory = (sources) => ({ goVersion: "go1.26.8", goos: "linux", goarch: "amd64", sources });

test("dumpdep parses roots, unnamed parents, flags, generic spaces and quoted arrows", () => {
  const graph = parseDumpDependencies(
    '# module/cmd/aae\n_ -> main.main\nmain.main -> math.sin\n -> go:info.math.Sin$abstract\nmain.main -> go:string."foo -> bar"\ntype:struct { A int } <UsedInIface> -> method.M <UsedInIface><ReflectMethod>\n',
  );
  assert.equal(graph.edges.length, 5);
  assert.deepEqual(graph.edges.at(-1), {
    from: "type:struct { A int }",
    to: "method.M",
    fromFlags: ["<UsedInIface>"],
    toFlags: ["<UsedInIface>", "<ReflectMethod>"],
  });
  assert.equal(graph.edges[2].from, "");
  assert.equal(graph.edges[3].to, 'go:string."foo -> bar"');
  assert.deepEqual(graph.roots, ["main.main"]);
});

for (const [label, text] of [
  ["empty input", ""],
  ["missing roots", "main.main -> math.sin"],
  ["unknown header", "# arbitrary command error!\n_ -> main.main"],
  ["unknown flags", "_ -> main.main <FutureFlag>"],
  ["ambiguous delimiters", "_ -> main.main -> math.sin"],
  ["unterminated string", '_ -> go:string."oops'],
  ["empty destination", "_ -> "],
  ["empty root destination", "_ -> _"],
  ["carriage return drift", "_ -> main.main\r"],
  ["NUL", "_ -> main\0main"],
])
  test(`dumpdep fails closed: ${label}`, () => assert.throws(() => parseDumpDependencies(text)));

test("file notices stay distinct from declarations, assembly body and retained bodies", () => {
  const graph = parseDumpDependencies(
    "_ -> main.main\nmain.main -> math.archExp.abi0\nmath.archExp.abi0 -> math.sin\nmain.main -> math/cmplx.Sqrt\nmain.main -> math..inittask\n",
  );
  const result = analyzeMathReach(
    graph,
    inventory([
      source("src/math/exp.go", ["SunPro"], [declaration("math.Exp")]),
      source("src/math/stubs.go", [], [declaration("math.archExp", "go-declaration")]),
      source("src/math/exp_amd64.s", [], [declaration("math.archExp", "assembly-body")]),
      source(
        "src/math/sin.go",
        ["LicenseRef-Cephes"],
        [declaration("math.Sin"), declaration("math.sin")],
      ),
      source("src/math/cmplx/sqrt.go", ["LicenseRef-Cephes"], [declaration("math/cmplx.Sqrt")]),
    ]),
  );
  assert.equal(result.retainedBodyCount, 3);
  assert.equal(result.restrictedNoticeBodyCount, 2);
  const archExp = result.retainedMathSymbols.find((item) => item.symbol === "math.archExp.abi0");
  assert.equal(archExp.abiWrapper, true);
  assert.equal(archExp.sources.length, 2);
  assert.equal(archExp.mapping, "selected-source-body");
  const sin = result.retainedMathSymbols.find((item) => item.symbol === "math.sin");
  assert.deepEqual(sin.retentionPath, ["_", "main.main", "math.archExp.abi0", "math.sin"]);
  assert.equal(sin.sources[0].sourceSha256, fingerprint);
  assert.equal(sin.sources[0].line, 10);
  assert.equal(
    result.retainedMathSymbols.find((item) => item.symbol === "math..inittask").mapping,
    "unmapped-metadata-or-generated-symbol",
  );
  assert.equal(
    result.selectedSources.find((item) => item.path.endsWith("exp.go")).noticeClassification,
    "SunPro-file-notice",
  );
});

test("unrecorded, unnamed, ambiguous and cyclic retention paths remain explicit", () => {
  const graph = parseDumpDependencies(
    "_ -> main.main\nmissing -> math.Sin\n -> math.Cos\nmain.main -> math.Tan\nmain.other -> math.Tan\nmath.Exp -> math.exp\nmath.exp -> math.Exp\n",
  );
  const result = analyzeMathReach(graph, inventory([]));
  const termination = (name) =>
    result.retainedMathSymbols.find((item) => item.symbol === name).pathTermination;
  assert.equal(termination("math.Sin"), "unrecorded-parent");
  assert.equal(termination("math.Cos"), "unnamed-parent");
  assert.equal(termination("math.Tan"), "ambiguous-name");
  assert.equal(termination("math.Exp"), "cycle");
});

test("declaration-only and duplicate source implementations are not claimed mapped bodies", () => {
  const graph = parseDumpDependencies("_ -> math.archExp\n_ -> math.sin\n");
  const result = analyzeMathReach(
    graph,
    inventory([
      source("src/math/stubs.go", [], [declaration("math.archExp", "go-declaration")]),
      source("src/math/sin.go", ["LicenseRef-Cephes"], [declaration("math.sin")]),
      source("src/math/duplicate.go", [], [declaration("math.sin")]),
    ]),
  );
  assert.equal(result.retainedBodyCount, 0);
  assert.deepEqual(
    result.retainedMathSymbols.map((item) => item.mapping),
    ["declaration-only", "ambiguous-source-body"],
  );
});

test("notice classifier preserves mixed files and never infers a BSD override", () => {
  assert.equal(classifyNotice([]), "no-SunPro-or-Cephes-file-notice");
  assert.equal(classifyNotice(["SunPro"]), "SunPro-file-notice");
  assert.equal(classifyNotice(["LicenseRef-Cephes"]), "Cephes-file-notice");
  assert.equal(classifyNotice(["SunPro", "LicenseRef-Cephes"]), "mixed-SunPro-Cephes-file-notices");
  assert.throws(() => classifyNotice(["BSD-3-Clause"]));
});

test("source inventory rejects unsupported toolchain, unsafe source path and invalid declarations", () => {
  const graph = parseDumpDependencies("_ -> math.Sin");
  assert.throws(() => analyzeMathReach(graph, { ...inventory([]), goVersion: "go1.27.0" }));
  for (const invalid of [
    source("src/math/../secret.go", [], []),
    { ...source("src/math/sin.go", [], []), sha256: "bad" },
    source("src/math/sin.go", [], [{ symbol: "math.Sin", line: 0, kind: "go-body" }]),
    source("src/math/sin.go", [], [declaration("os.Open")]),
  ])
    assert.throws(() => analyzeMathReach(graph, inventory([invalid])));
  const duplicate = source("src/math/sin.go", [], []);
  assert.throws(() => analyzeMathReach(graph, inventory([duplicate, duplicate])));
  assert.throws(() =>
    analyzeMathReach(
      graph,
      inventory([source("src/math/sin.go", [], [declaration("math.sin", "assembly-body")])]),
    ),
  );
});

function leb(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(value ? byte | 128 : byte);
  } while (value);
  return Buffer.from(bytes);
}
function encodedString(value) {
  const text = Buffer.from(value);
  return Buffer.concat([leb(text.length), text]);
}
const header = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const section = (id, payload) => Buffer.concat([Buffer.from([id]), leb(payload.length), payload]);
const custom = (name, payload) => section(0, Buffer.concat([encodedString(name), payload]));
const functionNames = (entries) =>
  section(
    1,
    Buffer.concat([
      leb(entries.length),
      ...entries.map(([index, name]) => Buffer.concat([leb(index), encodedString(name)])),
    ]),
  );

test("WASM custom section removal compares exact surviving bytes and maps function names", () => {
  const code = section(10, Buffer.from([1, 2, 0, 11]));
  const stripped = Buffer.concat([header, code]);
  const named = Buffer.concat([
    header,
    custom("producer", Buffer.from([42])),
    code,
    custom(
      "name",
      functionNames([
        [3, "math.sin"],
        [130, "math/cmplx.Sqrt"],
      ]),
    ),
  ]);
  const info = inspectWasm(named);
  assert.equal(info.nonCustomSha256, sha256(stripped));
  assert.equal(info.nonCustomSha256, inspectWasm(stripped).nonCustomSha256);
  assert.deepEqual(info.functionNames, [
    { index: 3, name: "math.sin" },
    { index: 130, name: "math/cmplx.Sqrt" },
  ]);
  assert.deepEqual(
    info.customSections.map((item) => item.name),
    ["producer", "name"],
  );
  assert.notEqual(
    info.nonCustomSha256,
    inspectWasm(Buffer.concat([header, section(10, Buffer.from([1, 2, 0, 12]))])).nonCustomSha256,
  );
});

for (const [label, bytes] of [
  ["bad header", Buffer.from("garbage!")],
  ["truncated section", Buffer.concat([header, Buffer.from([10, 2, 0])])],
  ["varuint overflow", Buffer.concat([header, Buffer.from([10, 255, 255, 255, 255, 31])])],
  ["unterminated varuint", Buffer.concat([header, Buffer.from([10, 128])])],
  ["unknown section", Buffer.concat([header, Buffer.from([14, 0])])],
  [
    "duplicate standard section",
    Buffer.concat([header, section(1, Buffer.from([0])), section(1, Buffer.from([0]))]),
  ],
  ["truncated custom name", Buffer.concat([header, section(0, Buffer.from([2, 65]))])],
  ["invalid UTF8", Buffer.concat([header, section(0, Buffer.from([1, 255]))])],
  [
    "duplicate name section",
    Buffer.concat([header, custom("name", Buffer.alloc(0)), custom("name", Buffer.alloc(0))]),
  ],
  [
    "duplicate function index",
    Buffer.concat([
      header,
      custom(
        "name",
        functionNames([
          [1, "x"],
          [1, "y"],
        ]),
      ),
    ]),
  ],
  [
    "duplicate function subsection",
    Buffer.concat([header, custom("name", Buffer.concat([functionNames([]), functionNames([])]))]),
  ],
  ["name subsection too long", Buffer.concat([header, custom("name", Buffer.from([1, 2, 0]))])],
  [
    "trailing function names",
    Buffer.concat([header, custom("name", section(1, Buffer.from([0, 0])))]),
  ],
])
  test(`WASM parser rejects ${label}`, () => assert.throws(() => inspectWasm(bytes)));
