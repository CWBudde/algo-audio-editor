import type { DocumentInfoResult, OperationChain } from "@aae/protocol";
import { expect, it } from "vitest";
import {
  MAX_CHAIN_BYTES,
  parseOperationChain,
  recordOperation,
  serializeOperationChain,
} from "./operation-chain";

const info: DocumentInfoResult = {
  documentId: "old-id",
  name: "tone.wav",
  frames: 100,
  channels: 2,
  sampleRate: 48000,
  bitDepth: 16,
  float: false,
};
it("records portable whole-document ranges, exact partial ranges and detached parameter snapshots", () => {
  expect(
    recordOperation(
      {
        method: "process.start",
        params: {
          documentId: info.documentId,
          start: 0,
          end: 100,
          channelMask: 3,
          operation: "gain",
          gainDb: -6,
        },
      },
      info,
    ),
  ).toEqual({
    method: "process.start",
    range: "document",
    params: { operation: "gain", gainDb: -6 },
  });
  expect(
    recordOperation(
      {
        method: "edit.apply",
        params: {
          documentId: info.documentId,
          start: 10,
          end: 20,
          channelMask: 2,
          operation: "paste-mix",
          clipboardVersion: "old-clipboard",
          convert: true,
        },
      },
      info,
    ),
  ).toEqual({
    method: "edit.apply",
    params: { start: 10, end: 20, channelMask: 2, operation: "paste-mix", convert: true },
  });
  const graph = {
    nodes: [{ id: "ring", type: "mod-ring", params: { frequency: 400 } }],
    connections: [],
  };
  const recorded = recordOperation(
    {
      method: "effects.apply",
      params: {
        documentId: info.documentId,
        start: 0,
        end: 100,
        channelMask: 2,
        graph,
        wet: 0.5,
        previewId: "old-preview",
      },
    },
    info,
  );
  graph.nodes[0].params.frequency = 800;
  expect(recorded).toMatchObject({
    range: "document",
    params: { channelMask: 2, wet: 0.5, graph: { nodes: [{ params: { frequency: 400 } }] } },
  });
});
it.each([
  { version: 2, operations: [] },
  { version: 1, operations: [], typo: true },
  { version: 1, operations: [{ method: "doc.export", params: {} }] },
  {
    version: 1,
    operations: [{ method: "edit.apply", params: { operation: "mute", documentId: "old" } }],
  },
  {
    version: 1,
    operations: [{ method: "process.start", params: { operation: "gain", gain_dB: 2 } }],
  },
  {
    version: 1,
    operations: [
      { method: "edit.apply", range: "document", params: { operation: "copy", start: 0 } },
    ],
  },
  { version: 1, operations: [{ method: "edit.apply", params: { operation: "copy", start: -1 } }] },
  {
    version: 1,
    operations: [{ method: "process.start", params: { operation: "extract-channel" } }],
  },
  {
    version: 1,
    operations: [
      {
        method: "process.start",
        params: { operation: "noise-reduce", noiseProfile: { documentId: "old" } },
      },
    ],
  },
  {
    version: 1,
    operations: [
      { method: "effects.apply", params: { graph: { nodes: [{ type: "reverb-conv" }] } } },
    ],
  },
  {
    version: 1,
    operations: Array.from({ length: 65 }, () => ({
      method: "edit.apply",
      params: { operation: "mute" },
    })),
  },
])("rejects invalid or session-bound control envelopes %j", (chain) => {
  expect(() => parseOperationChain(JSON.stringify(chain))).toThrow();
});
it("bounds imported bytes and retains current-selection semantics for earlier chains", () => {
  expect(() => parseOperationChain(" ".repeat(MAX_CHAIN_BYTES + 1))).toThrow("1 MiB");
  expect(
    parseOperationChain(
      '{"version":1,"operations":[{"method":"process.start","params":{"operation":"reverse"}}]}',
    ),
  ).toEqual({
    version: 1,
    operations: [{ method: "process.start", params: { operation: "reverse" } }],
  });
});

it("rejects overflowing JSON numbers before they can turn into null on replay", () => {
  expect(() =>
    parseOperationChain(
      '{"version":1,"operations":[{"method":"process.start","params":{"operation":"gain","gainDb":1e400}}]}',
    ),
  ).toThrow("finite");
});

it("exports near-limit chains as reimportable compact JSON when indentation would exceed the cap", () => {
  const chain: OperationChain = {
    version: 1,
    operations: [
      {
        method: "effects.apply",
        params: {
          graph: {
            nodes: [
              { id: "fx", type: "ringmod", params: { label: "a".repeat(MAX_CHAIN_BYTES - 180) } },
            ],
            connections: [],
          },
        },
      },
    ],
  };
  const text = serializeOperationChain(chain);
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_CHAIN_BYTES);
  expect(parseOperationChain(text)).toEqual(chain);
  expect(text).toBe(JSON.stringify(chain));
});
