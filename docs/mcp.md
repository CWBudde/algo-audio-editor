# Native automation and MCP

`aae-mcp` runs the editor's Go kernel as a local stdio MCP server. `aae` runs
the same kernel and recorded operation chains as a single-file or batch CLI. Both work
without Electron, a browser, WASM or an audio device. DSP and codecs remain in
the engine and its tagged upstream dependencies.

This is the first Phase 12/14 increment. The server uses the
[official Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk) v1.8.0.
Its session is independent of any running editor window. Linux native execution
is tested; Claude Code/Desktop configuration examples below follow their
official documentation, but interactive acceptance in those apps is pending.

## Build and connect

From the repository root:

```sh
just native-build
```

This builds `packages/kernel/bin/aae` and `packages/kernel/bin/aae-mcp` for
the host OS/architecture (`.exe` on Windows). Go's pinned toolchain downloads
dependencies on the first build. The resulting binaries need no Go runtime
installation, frontend assets or external codec executables.

Use absolute executable and output-directory paths in client configuration.
For [Claude Code](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server):

```sh
claude mcp add --transport stdio algo-audio-editor -- \
  /absolute/path/algo-audio-editor/packages/kernel/bin/aae-mcp \
  --allow-write /absolute/path/audio-output
```

Omit `--allow-write` for a server that can inspect and edit in memory but cannot
write files. Repeat it to grant multiple existing output directories.

For [Claude Desktop's local server configuration](https://modelcontextprotocol.io/docs/develop/connect-local-servers),
merge this entry into `claude_desktop_config.json`, then restart the client:

```json
{
  "mcpServers": {
    "algo-audio-editor": {
      "command": "/absolute/path/algo-audio-editor/packages/kernel/bin/aae-mcp",
      "args": ["--allow-write", "/absolute/path/audio-output"]
    }
  }
}
```

On Windows use the `.exe` executable and JSON-escaped paths (for example
`C:\\audio-output`). The output directory must already exist. Running the
server directly waits for JSON-RPC messages on stdin; stdout belongs solely
to MCP. Startup errors and diagnostics go to stderr.

## Session and filesystem behavior

- `open_document` reads a local regular file using the server process's OS
  permissions. Read paths are not restricted by `--allow-write`. Relative paths
  use the process's working directory; absolute paths are recommended.
- Each of up to eight documents has an independent engine, selection,
  clipboard and undo stack. MCP routing IDs such as `document-1` remain stable
  while the engine rotates its internal ID after each publication. Closing
  the server loses these in-memory sessions; `close_document` discards one.
- File input is capped at 128 MiB and chain JSON at 1 MiB in the CLI. Kernel
  decoded-codec, processing, effect and history budgets also apply. These are
  per-input/per-engine bounds, not a shared process memory budget.
- File writes require an explicit allowed root. `os.Root` confines filesystem
  operations, including symlink traversal. A temporary file is written and
  synced beside the destination, then published atomically. Parent directories
  must exist. Default publication refuses existing files; `overwrite: true`
  (CLI `--overwrite`) explicitly allows replacement. No filesystem writes are
  undoable; undo/redo restore the kernel document only.
- `export_document` writes a copy without changing the save point.
  `save_document` writes the whole document and marks its current history state
  saved only after success. Failed encoding or writing leaves the save point
  unchanged. There is no automatic save back to an input path.
- Tool calls are serialized and have a two-minute processing deadline. Kernel
  processing yields between bounded steps; cancellation discards the current
  private candidate. A completed prefix of a chain stays committed.

## Tools

| Tool | Parameters and result |
| --- | --- |
| `open_document` | `path`; returns session ID, format, dimensions, duration, metadata and summary URI |
| `close_document` | `documentId`; discards this session document and its history |
| `list_documents` | No parameters; lists up to eight documents in ID order |
| `document_info` | `documentId`; current dimensions, source encoding and metadata |
| `select_range` | `documentId`, `range: {start, end, channelMask}` in sample frames |
| `get_statistics` | `documentId`, optional `range`; peak, RMS, DC, crest factor, zero crossings, clipped samples and integrated LUFS |
| `detect_clipping` | `documentId`, `threshold`, optional `range`; counts clipped regions without adding markers |
| `list_operations` | No parameters; protocol version and JSON schemas generated from Go edit/process/effect payloads |
| `apply_operation` | `documentId`, `operation`, optional `dryRun`; applies one recorded operation |
| `apply_chain` | `documentId`, `chain`; runs up to 64 operations sequentially |
| `list_effects` | Optional `documentId` for sample-rate-specific ranges, `offset`, `limit` (default 10, maximum 20); descriptors, parameter limits and presets |
| `apply_effect` | `documentId`, `graph`, optional `range`, `wet`, `bypass`, `dryRun`; renders through the kernel's effect job |
| `undo`, `redo` | `documentId`; navigate the kernel's history |
| `history` | `documentId`; current/save states and bounded history entries |
| `export_document` | `documentId`, `path`, `format`, `bitDepth`; optional `float`, `scope`, `dither`, `noiseShaping`, `seed`, `overwrite` |
| `save_document` | Same export fields, whole-document scope only; also marks the save point |

The MCP client discovers and validates the full tool input schemas. The
operation payload schemas are generated from `internal/protocol`; unknown
payload fields and unsupported methods are rejected before dispatch.

Frame ranges have an exclusive end. `channelMask` bit 0 selects channel 0;
stereo all-channel selection is `3`. A collapsed range is a cursor: processing
and statistics resolve it to the whole document with that channel mask, as in
the UI. Structural edits such as `crop` need an explicit nonempty range.
Selections themselves are not history entries. Audio-changing operations use
the engine's normal undo history and its retention limits.

Native import supports WAV, FLAC, AIFF/AIFC and MP3; export supports WAV, FLAC
and AIFF/AIFC with the existing kernel's bit-depth/dither rules. Browser-only
Opus/AAC codec APIs are unavailable here. To change rate, apply `resample`
before exporting; export has no independent sample-rate conversion option.
Existing [metadata preservation limits](codecs.md) apply too.

Statistics return linear peak/RMS/DC and LUFS when a gated measurement is
available (`null` otherwise). Offline true peak is not yet exposed. Bulk audio
and peaks are never emitted as JSON sample arrays. Operation results omit
repeated annotation lists and full history stacks; query history/info as
needed. Effect descriptors are paginated; numeric rounding and additional
pagination remain follow-up work.

## Recorded chains and the CLI

A version 1 chain stores the UI protocol method and its control parameters:

```json
{
  "version": 1,
  "operations": [
    {"method": "process.start", "range": "document", "params": {"operation": "gain", "gainDb": -6}},
    {"method": "process.start", "range": "document", "params": {"operation": "resample", "sampleRate": 44100, "quality": "balanced"}}
  ]
}
```

The accepted methods are `edit.apply`, `process.start` and `effects.apply`.
Omit `documentId` from their `params`; the runner supplies the current engine
identity. Missing `start`, `end` and `channelMask` use the current selection
at that step. The optional operation-level `"range": "document"` instead uses
the current whole document, following each file's dimensions and preceding
structural edits. It cannot be combined with `start` or `end`; an explicit
`channelMask` can restrict channels. Supply frame fields explicitly for fades,
crops or other scoped operations. A recorded paste with no `clipboardVersion`
binds to the current engine clipboard, allowing earlier recorded copy/cut steps
to supply it. Headless paste needs a preceding copy/cut step; clipboard audio
is never serialized. Inspect `list_operations` and `list_effects` before choosing
parameters. `extract-channel` is excluded because it creates another document;
loading convolution impulse resources through MCP is also pending.

Save the example as `chain.json` and process one file:

```sh
packages/kernel/bin/aae \
  --input /absolute/path/input.wav \
  --chain /absolute/path/chain.json \
  --output /absolute/path/audio-output/result.flac \
  --allow-write /absolute/path/audio-output \
  --format flac --bit-depth 16
```

Omit `--chain` for format conversion without processing. `--float`, `--dither`
and `--overwrite` are available; `--help` lists flags. A successful run prints
the output path, encoded byte count and completed operation count as JSON.
On failure it exits nonzero and prints the wrapped error on stderr. The CLI
writes a file only after its whole chain succeeds.

For multiple files, repeat `--input` and use `--output-dir`:

```sh
packages/kernel/bin/aae \
  --input /absolute/path/first.wav \
  --input /absolute/path/second.mp3 \
  --chain /absolute/path/chain.json \
  --output-dir /absolute/path/audio-output \
  --allow-write /absolute/path/audio-output \
  --suffix=-mastered --format flac --bit-depth 16
```

The existing output directory receives `first-mastered.flac` and
`second-mastered.flac`. The default suffix is `-processed`. Duplicate output
names and unauthorized paths fail preflight before audio is read. Each file
uses a fresh engine, selection, clipboard and history. Files run sequentially;
stdout emits one JSON result per attempted file, including `input` and either
success details or `error`. A failed file produces no output; other files
continue by default. `--fail-fast` stops at the first failure. Any failed file
makes the final exit status nonzero. Successful outputs remain on disk if
another file fails or the process is interrupted. Existing files require the
explicit `--overwrite` flag.

In the editor, File → **Record new macro** clears the current chain and begins
recording successful edit, processing and effect requests. The header indicator
and File → **Stop recording macro** end recording. File → **Macros and
automation…** lists the steps, imports/exports the JSON and applies the chain
to the current document, with progress and cancellation. It uses the shared
document lock and stops playback before replay. Whole-document steps adapt;
partial selections and spectral geometry retain sample coordinates. Previews,
Undo/Redo, timeline and metadata actions are excluded. Undo during recording
does not remove previously recorded requests. Noise profiles, channel extraction
and loaded convolution IRs stop recording with an explanation while retaining
the preceding chain; editor import also rejects these session-bound operations.
The chain remains in memory until the page closes; export JSON to retain it.
The UI batch file-list/output dialog remains pending.

Each changing step creates its own history entry, subject to the kernel's
history limits. A failing chain returns an MCP tool error with `result.applied`,
compact results for the completed prefix and the failed zero-based operation
index. Semantic validation happens in the kernel at each step; a later invalid
value can therefore fail after earlier changes committed. Inspect history and
undo those changes if needed. There is no atomic whole-chain transaction.

`dryRun: true` evaluates a processing or effect candidate through the real DSP
and cancels it instead of committing. The result includes output geometry,
peak for the processed samples and the normalization job's available loudness
fields. Query statistics separately for whole-document output measurements.
It is computation,
not a fast estimate; arbitrary processing does not calculate output LUFS.
Structural-edit and whole-chain dry runs are not implemented.

## Resources, prompts and validation

Each open document exposes `aae://documents/<id>/summary` as an
`application/json` resource. Reads reflect the current document and closed
documents lose their resources. Waveform PNG/peak resources are pending.

The server offers `mastering_check`, `podcast_cleanup` and `batch_convert`
prompts. They guide inspection, schema discovery and explicit output choices;
they do not automatically execute operations. The batch file-list/output dialog
and the 100-file UI acceptance remain Phase 12 work. HTTP transport and editing
the running Electron session remain Phase 14 work.

`just test-go` exercises actual MCP client/server messages in memory and a
native stdio child process. Tests cover golden advertised schemas, descriptor
pagination, independent documents, effect/application dry runs, resources,
partial-chain errors, save points and filesystem confinement/no-clobber.
The same gain/reverse chain through MCP, the CLI runner and an independently
driven UI protocol sequence produces byte-identical float WAV output, checked
against the reviewed Phase 3 IEEE-754 vectors. Production browser regressions
also exercise actual macro recording, JSON export, exact processing/effect
replay, clipboard versions, structural edits and undoable failures. Electron
coverage records via native menus, writes macro JSON through the file grant
and replays/undoes it. On Linux, the compiled CLI produces byte-identical float
WAV from the browser-recorded/exported gain/reverse macro. `batch_test.go`
processes 100 files through normalization to −16 LUFS, both edge fades and
44.1 kHz/16-bit FLAC; every file matches the independent UI-method oracle.
Interactive Claude host acceptance remains pending.

Review schema changes before deliberately updating the golden with
`UPDATE_MCP_SCHEMAS=1 just test-go`. `just ci` includes native race tests and the
existing real WASM/browser/Electron acceptance gates. ABI 18 is unchanged;
chain format version 1 is separate and mirrored by `OperationChain` /
`RecordedOperation` in `packages/protocol`.
