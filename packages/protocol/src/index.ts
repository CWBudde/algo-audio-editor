/**
 * Kernel ABI: method names, request params and results.
 *
 * Mirrors packages/kernel/internal/protocol/protocol.go by hand. Change both
 * sides in the same commit, and bump PROTOCOL_VERSION when an existing payload
 * changes shape.
 */

/** Must equal protocol.Version in the Go kernel. */
export const PROTOCOL_VERSION = 9;

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
  documentId: string;
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  bitDepth: number;
  float: boolean;
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

export type EditOperation =
  | "delete"
  | "cut"
  | "copy"
  | "paste-insert"
  | "paste-replace"
  | "paste-mix"
  | "crop"
  | "insert-silence"
  | "duplicate"
  | "swap-channels"
  | "mute";

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

export type ProcessOperation = "gain" | "normalize-peak" | "normalize-loudness";
export type ProcessStartParams = SelectionResult &
  (
    | { operation: "gain"; gainDb: number }
    | { operation: "normalize-peak" | "normalize-loudness"; target: number }
  );

export interface ProcessJobParams {
  documentId: string;
  jobId: string;
}

/** Private candidate progress; only process.commit changes the document. */
export interface ProcessJobResult extends SelectionResult {
  jobId: string;
  state: "running" | "ready" | "cancelled";
  operation: ProcessOperation;
  /** Requested normalization target, not the resolved gain. Absent for gain. */
  target?: number;
  phase: "analyzing" | "processing" | "verifying";
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

export interface DocumentExportParams {
  format: "wav";
  bitDepth: number;
  float: boolean;
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

/** Every kernel method with its params and result types. */
export interface KernelMethods {
  hello: { params: undefined; result: HelloResult };
  "engine.configure": { params: EngineConfigureParams; result: EngineConfigureResult };
  "tone.configure": { params: ToneConfigureParams; result: ToneConfigureResult };
  "doc.memory": { params: undefined; result: DocumentMemoryResult };
  "peaks.get": { params: PeaksGetParams; result: PeaksGetResult };
  "doc.open": { params: DocumentOpenParams; result: DocumentInfoResult };
  "doc.info": { params: undefined; result: DocumentInfoResult };
  "doc.export": { params: DocumentExportParams; result: ExportResult };
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
  "process.cancel": { params: ProcessJobParams; result: ProcessJobResult };
  "process.commit": { params: ProcessJobParams; result: EditResult };
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
}
