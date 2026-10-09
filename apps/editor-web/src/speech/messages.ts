import type { SpeechGenerateParams } from "@aae/protocol";
import type { SpeechModelFile } from "@/platform";

/** A pinned catalog file; `url` is the revision-pinned Hugging Face download. */
export type SpeechCatalogFile = SpeechModelFile;

export interface SpeechCatalogVoice extends SpeechCatalogFile {
  id: string;
}

/** One go-pocket-tts model config as speech.wasm's catalog() reports it. */
export interface SpeechCatalogModel {
  name: string;
  label: string;
  /** ISO 639-1 language code. */
  language: string;
  layers: number;
  default_voice: string;
  default_temperature: number;
  default_text: string;
  weights: SpeechCatalogFile;
  tokenizer: SpeechCatalogFile;
  voices: SpeechCatalogVoice[];
}

export interface SpeechCatalog {
  default: string;
  models: SpeechCatalogModel[];
}

/** A file the worker fetches, verifies by size and SHA-256, then loads. */
export interface SpeechSourceFile extends SpeechCatalogFile {
  /** Where the worker fetches it: the catalog URL, or the desktop app:// copy. */
  source: string;
}

/** The speech fields synthesis reads; selection fields are the kernel's. */
export type SpeechSynthesisParams = Omit<
  SpeechGenerateParams,
  "documentId" | "start" | "end" | "channelMask"
>;

export type SpeechProgress =
  | { stage: "download"; path: string; done: number; total: number }
  | { stage: "load" }
  | { stage: "synthesize"; chunk: number; chunks: number; step: number; maxSteps: number };

export interface SpeechLoaded {
  model: string;
  voices: string[];
}

/**
 * Main thread ↔ speech worker messages. Every request gets exactly one reply
 * with its id; `progress` events precede it. The worker posts an unsolicited
 * `fatal` event when the Go program exits (for example out of memory).
 */
export type SpeechOp =
  | { op: "init"; wasmUrl: string; wasmExecUrl: string }
  | {
      op: "ensure";
      model: string;
      voice: string;
      /** Model files are present only when the model is not loaded yet. */
      weights?: SpeechSourceFile;
      tokenizer?: SpeechSourceFile;
      voiceFile?: SpeechSourceFile;
    }
  | { op: "synthesize"; params: SpeechSynthesisParams }
  /** Aborts the running ensure download and the running synthesis. */
  | { op: "cancel" }
  | { op: "unload" };

export type SpeechRequest = { id: number } & SpeechOp;

export type SpeechReply =
  | { kind: "progress"; id: number; progress: SpeechProgress }
  | { kind: "reply"; id: number; ok: true; result: unknown }
  | { kind: "reply"; id: number; ok: false; error: string }
  | { kind: "fatal"; error: string };

/** The init reply: the embedded catalog and the output rate. */
export interface SpeechInitResult {
  catalog: SpeechCatalog;
  sampleRate: number;
}

/** The synthesize reply; `pcm` is transferred, mono little-endian float32. */
export interface SpeechSynthesisResult {
  pcm: ArrayBuffer;
  sampleRate: number;
}
