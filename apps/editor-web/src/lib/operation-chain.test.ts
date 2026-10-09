import type { DocumentInfoResult, OperationChain } from "@aae/protocol";
import { expect, it } from "vitest";
import {
  describeOperation,
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

const speech = {
  model: "english_2026-01",
  voice: "alba",
  text: "Hello world.",
  temperature: 0.3,
  samplerSteps: 1,
  eosThreshold: -4,
  seed: 4294967295,
  levelDb: -3,
};
it("records speech.generate at the requested cursor with the seed it used", () => {
  const recorded = recordOperation(
    {
      method: "speech.generate",
      params: { documentId: info.documentId, start: 40, end: 40, channelMask: 1, ...speech },
    },
    info,
  );
  expect(recorded).toEqual({
    method: "speech.generate",
    params: { start: 40, end: 40, channelMask: 1, ...speech },
  });
  expect(describeOperation(recorded)).toBe("Speech");
  expect(
    parseOperationChain(JSON.stringify({ version: 1, operations: [recorded] })).operations[0],
  ).toEqual(recorded);
});
it.each([
  [{ text: "" }, /text is empty/],
  [{ text: "   " }, /text is empty/],
  [{ text: "?!" }, /text is empty/],
  [{ text: "𝔸".repeat(5001) }, /exceeds 5000/],
  [{ temperature: 3 }, /temperature/],
  [{ samplerSteps: 0 }, /sampler steps/],
  [{ samplerSteps: 1.5 }, /sampler steps/],
  [{ seed: -1 }, /seed/],
  [{ levelDb: 6 }, /level/],
  [{ model: "" }, /model and a voice/],
  [{ pitch: 2 }, /Unknown chain field: pitch/],
  [{ sourceSampleRate: 24000 }, /Unknown chain field/],
])("rejects speech.generate with %j", (change, error) => {
  expect(() =>
    parseOperationChain(
      JSON.stringify({
        version: 1,
        operations: [{ method: "speech.generate", params: { ...speech, ...change } }],
      }),
    ),
  ).toThrow(error);
});
it("accepts 5000 code points of speech text and rejects the audio generator in chains", () => {
  expect(() =>
    parseOperationChain(
      JSON.stringify({
        version: 1,
        operations: [{ method: "speech.generate", params: { ...speech, text: "𝔸".repeat(5000) } }],
      }),
    ),
  ).not.toThrow();
  expect(() =>
    parseOperationChain(
      JSON.stringify({
        version: 1,
        operations: [
          { method: "process.start", params: { operation: "generate", generator: "audio" } },
        ],
      }),
    ),
  ).toThrow(/record speech as speech.generate/);
});
