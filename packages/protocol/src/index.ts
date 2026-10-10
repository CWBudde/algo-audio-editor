/**
 * Kernel ABI: method names, request params and results.
 *
 * Mirrors packages/kernel/internal/protocol/protocol.go by hand. Change both
 * sides in the same commit, and bump PROTOCOL_VERSION when an existing payload
 * changes shape.
 */

/** Must equal protocol.Version in the Go kernel. */
export const PROTOCOL_VERSION = 20;

/** Envelope returned by every `AAEKernel.call`. */
export type KernelResponse<T> = { ok: true; result: T } | { ok: false; error: string };

export interface HelloResult {
  protocolVersion: number;
  kernelVersion: string;
  buildTime: string;
  goVersion: string;
  sampleRate: number;
  channels: number;
}

export interface EngineConfigureParams {
  sampleRate: number;
  channels: number;
}

export interface EngineConfigureResult {
  sampleRate: number;
  channels: number;
}

export interface ToneConfigureParams {
  frequencyHz: number;
  amplitude: number;
}

/** `frequencyHz` comes back rounded to whole hertz. */
export interface ToneConfigureResult {
  frequencyHz: number;
  amplitude: number;
}

/** Retained samples and peaks; excludes metadata, block lists and runtime overhead. */
export interface DocumentMemoryResult {
  sampleBytes: number;
  peakBytes: number;
  uniqueBlocks: number;
  blockReferences: number;
}

/** Viewport and desired pixel width; output count can exceed buckets. */
export interface PeaksGetParams {
  channel: number;
  startFrame: number;
  endFrame: number;
  buckets: number;
}

export interface PeaksGetInfo {
  framesPerBucket: number;
  count: number;
  dataBytes: number;
}

/**
 * Buffer layout (little-endian): count min/max/RMS float32 triples,
 * count uint32 frame counts, then count float64 absolute start frames.
 * Cached records can straddle the viewport; draw at their true positions.
 */
export interface PeaksGetResult extends PeaksGetInfo {
  data: ArrayBuffer;
}

/** File contents accompany the control payload as transferable bytes. */
export interface DocumentOpenParams {
  name: string;
}

export interface DocumentInfoResult {
  format?: "" | "wav" | "flac" | "aiff" | "mp3";
  documentId: string;
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  bitDepth: number;
  float: boolean;
}

/** Bounded source copy; channels packed in ascending order, planar LE float32. */
export interface PCMReadParams {
  documentId: string;
  stateId: string;
  start: number;
  frames: number;
  channelMask: number;
}
export interface PCMReadResult {
  sampleRate: number;
  channels: number;
  frames: number;
  dataBytes: number;
  data: ArrayBuffer;
}

/** Equal endpoints form a cursor; bit zero selects the first channel. */
export interface SelectionRange {
  start: number;
  end: number;
  channelMask: number;
}

export interface SelectionResult extends SelectionRange {
  documentId: string;
}

export type SelectionSetParams = SelectionResult;

export interface SelectionGetParams {
  documentId: string;
}

/** Read-only, inclusive zero-crossing query; radius is at most 8192 frames. */
export interface SelectionSnapParams {
  documentId: string;
  frame: number;
  radius: number;
  channelMask: number;
}

export interface SelectionSnapResult {
  documentId: string;
  frame: number;
  found: boolean;
}

export interface TimelineMarker {
  id: number;
  frame: number;
  name: string;
  color: string;
}

export interface TimelineRegion {
  id: number;
  start: number;
  end: number;
  name: string;
  color: string;
}

export interface TimelineResult {
  documentId: string;
  markers: TimelineMarker[];
  regions: TimelineRegion[];
}

export type TimelineGetParams = SelectionGetParams;

export interface TimelineMutationResult extends TimelineResult {
  history: HistoryListResult;
  changed: boolean;
}

export interface MarkerAddParams {
  documentId: string;
  frame: number;
  name: string;
  color?: string;
  selection?: SelectionRange;
}

export interface RegionAddParams {
  documentId: string;
  start: number;
  end: number;
  name: string;
  color?: string;
  selection?: SelectionRange;
}

export interface MarkerUpdateParams extends MarkerAddParams {
  id: number;
}

export interface RegionUpdateParams extends RegionAddParams {
  id: number;
}

export interface TimelineRemoveParams {
  documentId: string;
  id: number;
  selection?: SelectionRange;
}

export interface TimelineExportParams {
  documentId: string;
  format: "csv" | "labels";
}

export interface ClipboardInfo {
  version: string;
  available: boolean;
  sampleRate: number;
  channels: number;
  frames: number;
}

export const EDIT_OPERATIONS = [
  "delete",
  "cut",
  "copy",
  "paste-insert",
  "paste-replace",
  "paste-mix",
  "crop",
  "insert-silence",
  "duplicate",
  "swap-channels",
  "mute",
] as const;
export type EditOperation = (typeof EDIT_OPERATIONS)[number];

/** Complete selection snapshot; paste requires the current clipboard version. */
export interface EditApplyParams extends SelectionResult {
  operation: EditOperation;
  frames?: number;
  convert?: boolean;
  clipboardVersion?: string;
}

export interface EditResult {
  document: DocumentInfoResult;
  selection: SelectionResult;
  timeline: TimelineResult;
  clipboard: ClipboardInfo;
  changed: boolean;
  history: HistoryListResult;
}

export type FadeCurve = "linear" | "equal-power" | "logarithmic" | "s-curve";
export type ResampleQuality = "fast" | "balanced" | "best";
export type GeneratorKind =
  | "silence"
  | "sine"
  | "white-noise"
  | "pink-noise"
  | "linear-sweep"
  | "log-sweep";
/** Geometry in document sample-frame/Hz coordinates. */
export interface SpectralPoint {
  frame: number;
  hz: number;
}
export interface SpectralMask {
  start: number;
  end: number;
  lowHz: number;
  highHz: number;
  points?: SpectralPoint[];
}
export const RESTORATION_OPERATIONS = [
  "spectral-attenuate",
  "spectral-remove",
  "spectral-heal",
  "noise-reduce",
  "remove-clicks",
  "declip",
  "time-stretch",
  "remove-hum",
] as const;
export type RestorationOperation = (typeof RESTORATION_OPERATIONS)[number];
export const PROCESS_OPERATIONS = [
  "gain",
  "normalize-peak",
  "normalize-loudness",
  "fade-in",
  "fade-out",
  "crossfade",
  "reverse",
  "invert",
  "remove-dc",
  "mono-to-stereo",
  "stereo-to-mono",
  "resample",
  "generate",
  "extract-channel",
  "effects",
  ...RESTORATION_OPERATIONS,
] as const;
export type ProcessOperation = (typeof PROCESS_OPERATIONS)[number];
export type ProcessStartParams = SelectionResult &
  (
    | { operation: "gain"; gainDb: number }
    | {
        operation: "spectral-attenuate" | "spectral-remove" | "spectral-heal";
        spectralMask: SpectralMask;
        fftSize: number;
        gainDb?: number;
      }
    | {
        operation: "noise-reduce";
        noiseProfile: SelectionResult;
        fftSize: number;
        reductionDb: number;
        noiseMethod: "wiener" | "subtraction" | "gate";
      }
    | { operation: "remove-clicks"; sensitivity: number; maxGap: number }
    | { operation: "declip"; clipThreshold: number; maxGap: number }
    | { operation: "time-stretch"; durationRatio: number }
    | { operation: "remove-hum"; humHz: 50 | 60; humQ: number; harmonics: number }
    | { operation: "normalize-peak"; target: number }
    | {
        operation: "normalize-loudness";
        target: number;
        /** dBTP in [-60, 0]; caps the gain so the output true peak stays below it. */
        truePeakCeiling?: number;
      }
    | { operation: "fade-in" | "fade-out"; curve: FadeCurve }
    | { operation: "crossfade"; curve: FadeCurve; durationFrames: number }
    | { operation: "reverse" | "invert" | "remove-dc" | "mono-to-stereo" }
    | { operation: "stereo-to-mono"; channelMode: "mix" | "left" | "right" }
    | { operation: "extract-channel"; channel: number }
    | { operation: "resample"; sampleRate: number; quality: ResampleQuality }
    | {
        operation: "generate";
        generator: GeneratorKind;
        durationFrames: number;
        frequency: number;
        endFrequency: number;
        levelDb: number;
        seed: number;
      }
    | {
        /** Places the mono float32 PCM sent as binary input at its own length. */
        operation: "generate";
        generator: "audio";
        sourceSampleRate: number;
        levelDb?: number;
      }
  );

/** Private output geometry; source coordinates remain in the job envelope. */
export interface ProcessCandidate extends SelectionRange {
  sampleRate: number;
  channels: number;
  frames: number;
}

/** A new silent document; frames may be zero and an empty name becomes "Untitled". */
export interface DocumentNewParams {
  name?: string;
  sampleRate: number;
  channels: number;
  frames: number;
}

/** Metadata accompanying planar little-endian float32 window-handoff bytes. */
export interface BinaryDocumentParams {
  name: string;
  tags: Record<string, string>;
  sampleRate: number;
  channels: number;
  frames: number;
  nextAnchorId: number;
  markers: TimelineMarker[];
  regions: TimelineRegion[];
}
export interface BinaryDocumentResult extends BinaryDocumentParams {
  dataBytes: number;
  data: ArrayBuffer;
}

export interface ProcessJobParams {
  documentId: string;
  jobId: string;
}

/** Private candidate progress; only process.commit changes the document. */
export const JOB_STATES = ["running", "ready", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const PROCESS_PHASES = ["analyzing", "processing", "verifying"] as const;
export type ProcessPhase = (typeof PROCESS_PHASES)[number];

export interface ProcessJobResult extends SelectionResult {
  candidate: ProcessCandidate | null;
  jobId: string;
  state: JobState;
  operation: ProcessOperation;
  /** Requested normalization target, not the resolved gain. Absent for gain. */
  target?: number;
  phase: ProcessPhase;
  phaseIndex: number;
  phaseCount: number;
  /** Gain is unknown while normalizing input is being analyzed. */
  gainResolved: boolean;
  gainDb: number;
  /** Counters are local to a phase and reset only when phaseIndex advances. */
  processedFrames: number;
  totalFrames: number;
  /** Actual bounded planning calls; advances even while analysis frames are complete. */
  planningSteps: number;
  /** Source amplitude, separate from processed-output peak. */
  inputPeak: number;
  /** Null when source loudness is undefined or not yet measured. */
  inputLufs: number | null;
  /** Energy-domain output prediction, not a claim of actual output metering. */
  predictedLufs: number | null;
  /** Actual float32 candidate metering; null when verified by a rounding bound. */
  outputLufs: number | null;
  unchangedReason?: "silent";
  /** Maximum finite absolute float32 output; nonfinite values are separate. */
  peak: number;
  nonFinite: boolean;
  /** Requested true-peak ceiling (dBTP); loudness normalization only. */
  truePeakCeiling?: number;
  /**
   * Output 4x-oversampled linear peak, derived from the measured input and the
   * resolved linear gain. Null until normalization resolves its gain, and for
   * every other operation.
   */
  truePeak: number | null;
  /** The ceiling lowered the gain, so the output is quieter than the target. */
  ceilingLimited?: boolean;
}

export interface HistoryListParams {
  documentId: string;
}
export interface HistoryJumpParams extends HistoryListParams {
  stateId: string;
}
export interface MarkSavedParams extends HistoryListParams {
  stateId: string;
}
export interface HistoryEntry {
  stateId: string;
  label: string;
}
export interface HistoryListResult {
  documentId: string;
  currentStateId: string;
  savedStateId: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  entries: HistoryEntry[];
  maxEntries: number;
  maxBytes: number;
  retainedBytes: number;
}

export interface PreparePasteParams {
  documentId: string;
  channelMask: number;
  clipboardVersion: string;
}

/** Mismatched rates or selected channel counts require explicit conversion. */
export interface PastePlan {
  conversionRequired: boolean;
  sourceRate: number;
  targetRate: number;
  sourceChannels: number;
  targetChannels: number;
  frames: number;
  clipboardVersion: string;
}

export type ExportScope = "document" | "selection";
export type ExportDither = "none" | "rectangular" | "triangular" | "gaussian" | "fast-gaussian";
export type ExportNoiseShaping = "none" | "efb" | "2sc" | "9fc" | "sbm" | "sharp";

export interface DocumentExportParams {
  format: "wav" | "flac" | "aiff";
  bitDepth: number;
  float: boolean;
  scope?: ExportScope;
  dither?: ExportDither;
  noiseShaping?: ExportNoiseShaping;
  seed?: number;
  documentId?: string;
}

export interface ExportInfo {
  name: string;
  mimeType: string;
  dataBytes: number;
}

export interface ExportResult extends ExportInfo {
  data: ArrayBuffer;
}

export interface TransportPlayParams {
  start: number;
  end?: number;
  loop: boolean;
  previewJobId?: string;
  effectPreviewId?: string;
}

export interface TransportSeekParams {
  frame: number;
}

/** Renderer state; the audible cursor comes from consumed SAB frame tags. */
export interface TransportResult {
  start: number;
  end: number;
  loop: boolean;
  position: number;
  playing: boolean;
}

export interface EffectParameterDescriptor {
  id: string;
  label: string;
  unit: string;
  type: "number" | "enum" | "boolean";
  min: number;
  max: number;
  default: number;
  scale: "lin" | "log" | "dB";
  step: number;
  defaultString?: string;
  options?: { value: string; label: string }[];
}
export interface EffectFactoryPreset {
  id: string;
  name: string;
  num: Record<string, number>;
  str: Record<string, string>;
}
export interface EffectDescriptor {
  id: string;
  name: string;
  category: string;
  channelMode: "mono" | "stereo";
  view: "generic" | "eq" | "dynamics";
  parameters: EffectParameterDescriptor[];
  presets: EffectFactoryPreset[];
}
export interface EffectGraph {
  nodes: {
    id: string;
    type: string;
    bypassed?: boolean;
    params: Record<string, number | string | boolean>;
  }[];
  connections: { from: string; to: string; fromPortIndex?: number; toPortIndex?: number }[];
}
export interface EffectPreviewParams extends SelectionResult {
  graph: EffectGraph;
  wet?: number;
  bypass?: boolean;
  previewId?: string;
}
export interface EffectPreviewResult extends SelectionResult {
  previewId: string;
  wet: number;
  bypass: boolean;
}

/** Version 1 editor/native CLI/MCP chains reuse the UI's control payloads.
 * Selection fields are optional and default to the current kernel selection.
 * range: "document" resolves current dimensions and excludes explicit start/end.
 * Runners supply documentId and follow committed identity changes.
 */
type RecordedParams<T extends SelectionResult> = T extends unknown
  ? Omit<T, keyof SelectionResult> & Partial<SelectionRange>
  : never;
/** speech.generate is a chain method, not a kernel method: runners synthesize
 * with go-pocket-tts and place the result with the "audio" generator. */
export const CHAIN_SPEECH_GENERATE = "speech.generate";
export const MAX_SPEECH_TEXT_LENGTH = 5000;
export interface SpeechGenerateParams extends SelectionResult {
  model: string;
  voice: string;
  text: string;
  temperature: number;
  samplerSteps: number;
  eosThreshold: number;
  seed: number;
  levelDb?: number;
}
export type RecordedOperation = { range?: "document" } & (
  | { method: "edit.apply"; params: RecordedParams<EditApplyParams> }
  | {
      method: "process.start";
      params: RecordedParams<Exclude<ProcessStartParams, { operation: "extract-channel" }>>;
    }
  | { method: "effects.apply"; params: RecordedParams<EffectPreviewParams> }
  | { method: typeof CHAIN_SPEECH_GENERATE; params: RecordedParams<SpeechGenerateParams> }
);
export interface OperationChain {
  version: 1;
  operations: RecordedOperation[];
}
export interface EffectSessionParams {
  documentId: string;
  previewId: string;
}
export interface EffectMetersResult extends EffectSessionParams {
  frames: number;
  inputPeak: number[];
  inputRms: number[];
  outputPeak: number[];
  outputRms: number[];
}
export interface EffectIRResult {
  irId: number;
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
}
export interface EffectResponseParams {
  mode?: "frequency" | "transfer";
  graph?: EffectGraph;
  effectId?: string;
  params?: Record<string, number | string | boolean>;
  sampleRate?: number;
  points?: number;
}
/** Little-endian float64 frequency Hz / magnitude dB pairs. */
export interface EffectResponseResult {
  axis: "frequency" | "level";
  count: number;
  dataBytes: number;
  data: ArrayBuffer;
}

export const METERS_DATA_BYTES = 1536;
export const METERS_FLOAT64_COUNT = 192;
export const METERS_CHANNEL_OFFSET = 16;
export const METERS_CHANNEL_STRIDE = 4;
export const METERS_GONIOMETER_OFFSET = 64;
export const METERS_GONIOMETER_CAPACITY = 64;
export interface MetersConfigureResult {
  enabled: boolean;
  byteLength: number;
  version: number;
}
export const ANALYSIS_KINDS = [
  "statistics",
  "pitch",
  "spectrum",
  "spectrogram",
  "clipping",
] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];
export interface AnalysisStartParams extends SelectionResult {
  kind: AnalysisKind;
  fftSize?: number;
  window?: string;
  averaging?: number;
  smoothing?: number;
  hopSize?: number;
  minHz?: number;
  maxHz?: number;
  threshold?: number;
  channel?: number;
  width?: number;
  height?: number;
  minDB?: number;
  maxDB?: number;
  colorMap?: string;
}
export interface AnalysisJobParams {
  documentId: string;
  jobId: string;
  includeData?: boolean;
}
export interface ChannelStatistics {
  channel: number;
  peak: number;
  rms: number;
  dc: number;
  crestDB: number | null;
  zeroCrossings: number;
  clippedSamples: number;
}
export interface AnalysisJobResult extends SelectionResult {
  jobId: string;
  kind: AnalysisKind;
  state: JobState;
  processedFrames: number;
  totalFrames: number;
  sampleRate: number;
  dataBytes: number;
  channels: number[];
  fftSize?: number;
  bins?: number;
  width?: number;
  height?: number;
  completedColumns?: number;
  records?: number;
  statistics?: ChannelStatistics[];
  integratedLUFS: number | null;
  markerCount?: number;
  /** Spectrum: channel-majorFloat64(Hz,dB); pitch:(channel,frame,Hz,confidence); tiles:RGBA8. */
  data?: ArrayBuffer;
}
export interface AnalysisSpectrumParams {
  jobId?: string;
  source: "playback";
  fftSize?: number;
  window?: string;
  averaging?: number;
  smoothing?: number;
}
export interface AnalysisSpectrumResult {
  documentId: string;
  jobId: string;
  state: Exclude<JobState, "cancelled">;
  source: "playback";
  sampleRate: number;
  channels: number;
  fftSize: number;
  bins: number;
  dataBytes: number;
  data: ArrayBuffer;
}

/** Editable text and a summary of opaque WAV metadata retained by Go. */
export interface MetadataResult {
  documentId: string;
  stateId: string;
  tags: Record<string, string>;
  preservedBytes: number;
  chunks: string[];
}
export interface MetadataSetParams {
  documentId: string;
  stateId: string;
  tags: Record<string, string>;
}
export interface MetadataMutationResult extends MetadataResult {
  history: HistoryListResult;
  changed: boolean;
}

/** Every kernel method with its params and result types. */
export interface KernelMethods {
  "metadata.get": { params: SelectionGetParams; result: MetadataResult };
  "metadata.set": { params: MetadataSetParams; result: MetadataMutationResult };
  "meters.configure": {
    params: { enabled?: boolean; reset?: boolean } | undefined;
    result: MetersConfigureResult;
  };
  "analysis.start": { params: AnalysisStartParams; result: AnalysisJobResult };
  "analysis.step": { params: AnalysisJobParams; result: AnalysisJobResult };
  "analysis.cancel": { params: AnalysisJobParams; result: AnalysisJobResult };
  "analysis.commit": { params: AnalysisJobParams; result: EditResult };
  "analysis.spectrum": { params: AnalysisSpectrumParams; result: AnalysisSpectrumResult };
  "effects.list": {
    params: { sampleRate?: number } | undefined;
    result: { effects: EffectDescriptor[] };
  };
  "effects.response": { params: EffectResponseParams; result: EffectResponseResult };
  "effects.preview.start": { params: EffectPreviewParams; result: EffectPreviewResult };
  "effects.preview.update": { params: EffectPreviewParams; result: EffectPreviewResult };
  "effects.preview.stop": { params: EffectSessionParams; result: { stopped: boolean } };
  "effects.preview.meters": { params: EffectSessionParams; result: EffectMetersResult };
  "effects.apply": { params: EffectPreviewParams; result: ProcessJobResult };
  "effects.ir.load": { params: { documentId: string; name: string }; result: EffectIRResult };
  "effects.ir.remove": {
    params: { documentId: string; irId: number };
    result: { removed: boolean };
  };
  hello: { params: undefined; result: HelloResult };
  "engine.configure": { params: EngineConfigureParams; result: EngineConfigureResult };
  "tone.configure": { params: ToneConfigureParams; result: ToneConfigureResult };
  "doc.memory": { params: undefined; result: DocumentMemoryResult };
  "peaks.get": { params: PeaksGetParams; result: PeaksGetResult };
  "doc.open": { params: DocumentOpenParams; result: DocumentInfoResult };
  "doc.info": { params: undefined; result: DocumentInfoResult };
  "doc.export": { params: DocumentExportParams; result: ExportResult };
  "doc.readPCM": { params: PCMReadParams; result: PCMReadResult };
  "transport.play": { params: TransportPlayParams; result: TransportResult };
  "transport.stop": { params: undefined; result: TransportResult };
  "transport.seek": { params: TransportSeekParams; result: TransportResult };
  "selection.get": { params: SelectionGetParams; result: SelectionResult };
  "selection.set": { params: SelectionSetParams; result: SelectionResult };
  "selection.snap": { params: SelectionSnapParams; result: SelectionSnapResult };
  "timeline.get": { params: TimelineGetParams; result: TimelineResult };
  "markers.add": { params: MarkerAddParams; result: TimelineMutationResult };
  "regions.add": { params: RegionAddParams; result: TimelineMutationResult };
  "markers.update": { params: MarkerUpdateParams; result: TimelineMutationResult };
  "regions.update": { params: RegionUpdateParams; result: TimelineMutationResult };
  "markers.remove": { params: TimelineRemoveParams; result: TimelineMutationResult };
  "regions.remove": { params: TimelineRemoveParams; result: TimelineMutationResult };
  "timeline.export": { params: TimelineExportParams; result: ExportResult };
  "edit.state": { params: undefined; result: ClipboardInfo };
  "edit.apply": { params: EditApplyParams; result: EditResult };
  "edit.prepare-paste": { params: PreparePasteParams; result: PastePlan };
  "history.list": { params: HistoryListParams; result: HistoryListResult };
  "history.jump": { params: HistoryJumpParams; result: EditResult };
  "edit.undo": { params: HistoryListParams; result: EditResult };
  "edit.redo": { params: HistoryListParams; result: EditResult };
  "doc.mark-saved": { params: MarkSavedParams; result: HistoryListResult };
  "process.start": { params: ProcessStartParams; result: ProcessJobResult };
  "process.step": { params: ProcessJobParams; result: ProcessJobResult };
  /** At most four bounded steps, stopping at phase changes or terminal state. */
  "process.stepBatch": { params: ProcessJobParams; result: ProcessJobResult };
  "process.cancel": { params: ProcessJobParams; result: ProcessJobResult };
  "process.commit": { params: ProcessJobParams; result: EditResult };
  "process.exportCandidate": { params: ProcessJobParams; result: BinaryDocumentResult };
  "doc.openPCM": { params: BinaryDocumentParams; result: DocumentInfoResult };
  "doc.new": { params: DocumentNewParams; result: DocumentInfoResult };
  "doc.importBinary": { params: BinaryDocumentParams; result: DocumentInfoResult };
}

export type KernelMethod = keyof KernelMethods;
export type ParamsOf<M extends KernelMethod> = KernelMethods[M]["params"];
export type ResultOf<M extends KernelMethod> = KernelMethods[M]["result"];

/** The object the Go program installs as `globalThis.AAEKernel`. */
export interface KernelBridge {
  /** Returns a JSON-encoded {@link KernelResponse}. */
  call(method: string, paramsJSON?: string, data?: Uint8Array): string;
  /** Takes the binary result of the preceding call; returns empty data otherwise. */
  takeData(): Uint8Array;
  /**
   * Renders `frames` interleaved float32 frames into `dst` (little-endian
   * bytes) and returns the number written, or -1 on invalid arguments. Requests
   * must contain 1..65536 frames to keep worker buffers bounded. Optional
   * positions receives one int64 little-endian document cursor per output frame,
   * representing the cursor AFTER that frame is consumed. A short result signals
   * EOF; unused sample bytes are zeroed. Diagnostics can omit position tags.
   */
  render(dst: Uint8Array, frames: number, positions?: Uint8Array): number;
  /** Copies the reusable meter payload; zero means metering is disabled. */
  copyMeters(dst: Uint8Array): number;
}
