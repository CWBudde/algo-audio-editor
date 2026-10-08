package protocol_test

import (
	_ "embed"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// Each golden file maps a TypeScript payload type name to wire values Go
// marshals for it. protocol-parity.test.ts parses every value against that
// declared type (required keys, absent optionals, null only where nullable,
// literal unions), so a Go encoding change or a TS type drift fails one side.
var (
	//go:embed testdata/document.json
	documentWireGolden []byte
	//go:embed testdata/analysis.json
	analysisWireGolden []byte
	//go:embed testdata/effects.json
	effectsWireGolden []byte
)

func TestDocumentWireGolden(t *testing.T) {
	document := protocol.DocumentInfoResult{
		Format: "wav", DocumentID: "doc-1", Name: "take.wav",
		SampleRate: 48000, Channels: 2, Frames: 96000, BitDepth: 24,
	}
	// Window handoffs and generated documents have no source container.
	handoff := protocol.DocumentInfoResult{
		DocumentID: "doc-2", Name: "Untitled", SampleRate: 44100, Channels: 1, BitDepth: 32, Float: true,
	}
	history := protocol.HistoryListResult{
		DocumentID: "doc-1", CurrentStateID: "state-2", SavedStateID: "state-1",
		Dirty: true, CanUndo: true,
		Entries:    []protocol.HistoryEntry{{StateID: "state-1", Label: "Open"}, {StateID: "state-2", Label: "Cut"}},
		MaxEntries: 100, MaxBytes: 1 << 30, RetainedBytes: 768000,
	}
	timeline := protocol.TimelineResult{
		DocumentID: "doc-1",
		Markers:    []protocol.TimelineMarker{{ID: 1, Frame: 4800, Name: "Intro", Color: "#f59e0b"}},
		Regions:    []protocol.TimelineRegion{{ID: 2, Start: 9600, End: 19200, Name: "Chorus"}},
	}
	edit := protocol.EditResult{
		Document: document,
		Selection: protocol.SelectionResult{
			DocumentID: "doc-1", SelectionRange: protocol.SelectionRange{Start: 480, End: 9600, ChannelMask: 3},
		},
		Timeline:  timeline,
		Clipboard: protocol.ClipboardInfo{Version: "clip-1", Available: true, SampleRate: 48000, Channels: 2, Frames: 9120},
		Changed:   true,
		History:   history,
	}
	// The engine allocates empty collections; they must reach TypeScript as [].
	emptyHistory := protocol.HistoryListResult{DocumentID: "doc-2", Entries: []protocol.HistoryEntry{}, MaxEntries: 100}
	unchanged := protocol.TimelineMutationResult{
		TimelineResult: protocol.TimelineResult{
			DocumentID: "doc-2", Markers: []protocol.TimelineMarker{}, Regions: []protocol.TimelineRegion{},
		},
		History: emptyHistory,
	}
	metadata := protocol.MetadataResult{
		DocumentID: "doc-1", StateID: "state-2", Tags: map[string]string{"title": "Take"},
		PreservedBytes: 64, Chunks: []string{"bext"},
	}
	assertWireGolden(t, documentWireGolden, map[string]any{
		"DocumentInfoResult":     []protocol.DocumentInfoResult{document, handoff},
		"EditResult":             []protocol.EditResult{edit},
		"TimelineMutationResult": []protocol.TimelineMutationResult{unchanged},
		"MetadataResult":         []protocol.MetadataResult{metadata},
	})
}

func TestAnalysisWireGolden(t *testing.T) {
	stereo := protocol.SelectionResult{
		DocumentID: "doc-1", SelectionRange: protocol.SelectionRange{Start: 0, End: 48000, ChannelMask: 3},
	}
	crest, lufs := 6.0206, -23.0
	statistics := protocol.AnalysisJobResult{
		SelectionResult: stereo, JobID: "job-1", Kind: protocol.AnalysisStatistics, State: protocol.JobReady,
		ProcessedFrames: 48000, TotalFrames: 48000, SampleRate: 48000, Channels: []int{0, 1},
		Statistics: []protocol.ChannelStatistics{
			{Channel: 0, Peak: 0.5, RMS: 0.25, DC: 0.001, CrestDB: &crest, ZeroCrossings: 120, ClippedSamples: 2},
			// A silent channel has no defined crest factor.
			{Channel: 1},
		},
		IntegratedLUFS: &lufs,
	}
	spectrum := protocol.AnalysisJobResult{
		SelectionResult: stereo, JobID: "job-1", Kind: protocol.AnalysisSpectrum, State: protocol.JobRunning,
		ProcessedFrames: 12000, TotalFrames: 48000, SampleRate: 48000, Channels: []int{0, 1},
		FFTSize: 4096, Bins: 2049,
	}
	spectrogram := protocol.AnalysisJobResult{
		SelectionResult: protocol.SelectionResult{
			DocumentID: "doc-1", SelectionRange: protocol.SelectionRange{Start: 0, End: 48000, ChannelMask: 1},
		},
		JobID: "job-1", Kind: protocol.AnalysisSpectrogram, State: protocol.JobRunning,
		ProcessedFrames: 12000, TotalFrames: 48000, SampleRate: 48000, Channels: []int{0},
		FFTSize: 2048, Width: 128, Height: 256, CompletedColumns: 32,
	}
	pitch := protocol.AnalysisJobResult{
		SelectionResult: stereo, JobID: "job-1", Kind: protocol.AnalysisPitch, State: protocol.JobReady,
		ProcessedFrames: 48000, TotalFrames: 48000, SampleRate: 48000, Channels: []int{0, 1},
		DataBytes: 384, Records: 12,
	}
	clipping := protocol.AnalysisJobResult{
		SelectionResult: stereo, JobID: "job-1", Kind: protocol.AnalysisClipping, State: protocol.JobCancelled,
		ProcessedFrames: 24000, TotalFrames: 48000, SampleRate: 48000, Channels: []int{0, 1}, MarkerCount: 3,
	}
	live := protocol.AnalysisSpectrumResult{
		DocumentID: "doc-1", JobID: "live-1", State: protocol.JobRunning, Source: "playback",
		SampleRate: 48000, Channels: 2, FFTSize: 4096, Bins: 2049,
	}
	assertWireGolden(t, analysisWireGolden, map[string]any{
		"AnalysisJobResult":      []protocol.AnalysisJobResult{statistics, spectrum, spectrogram, pitch, clipping},
		"AnalysisSpectrumResult": []protocol.AnalysisSpectrumResult{live},
		"MetersConfigureResult":  []protocol.MetersConfigureResult{{Enabled: true, ByteLength: protocol.MetersDataBytes, Version: 1}},
	})
}

func TestEffectsWireGolden(t *testing.T) {
	descriptor := protocol.EffectDescriptor{
		ID: "saturator", Name: "Saturator", Category: "Distortion", ChannelMode: "mono", View: "generic",
		Parameters: []protocol.EffectParameterDescriptor{
			{ID: "drive", Label: "Drive", Unit: "dB", Type: "number", Min: 0, Max: 24, Default: 6, Scale: "dB", Step: 0.1},
			{ID: "frequency", Label: "Tone", Unit: "Hz", Type: "number", Min: 20, Max: 20000, Default: 1000, Scale: "log", Step: 1},
			{ID: "oversample", Label: "Oversample", Type: "boolean", Max: 1, Default: 1, Scale: "lin", Step: 1},
			{
				ID: "curve", Label: "Curve", Type: "enum", Max: 1, Scale: "lin", Step: 1, DefaultString: "soft",
				Options: []protocol.EffectOption{{Value: "soft", Label: "Soft"}, {Value: "hard", Label: "Hard"}},
			},
		},
		Presets: []protocol.EffectFactoryPreset{{
			ID: "warm", Name: "Warm", Num: map[string]float64{"drive": 9}, Str: map[string]string{"curve": "soft"},
		}},
	}
	// Upstream descriptors without presets still list an empty array.
	plain := protocol.EffectDescriptor{
		ID: "invert", Name: "Invert", Category: "Utility", ChannelMode: "stereo", View: "generic",
		Parameters: []protocol.EffectParameterDescriptor{}, Presets: []protocol.EffectFactoryPreset{},
	}
	preview := protocol.EffectsPreviewResult{
		SelectionResult: protocol.SelectionResult{
			DocumentID: "doc-1", SelectionRange: protocol.SelectionRange{Start: 0, End: 48000, ChannelMask: 3},
		},
		PreviewID: "preview-1", Wet: 0.5,
	}
	meters := protocol.EffectsMetersResult{
		DocumentID: "doc-1", PreviewID: "preview-1", Frames: 4800,
		InputPeak: []float64{0.5, 0.25}, InputRMS: []float64{0.2, 0.1},
		OutputPeak: []float64{0.7, 0.35}, OutputRMS: []float64{0.3, 0.15},
	}
	assertWireGolden(t, effectsWireGolden, map[string]any{
		"EffectDescriptor":     []protocol.EffectDescriptor{descriptor, plain},
		"EffectPreviewResult":  []protocol.EffectsPreviewResult{preview},
		"EffectMetersResult":   []protocol.EffectsMetersResult{meters},
		"EffectIRResult":       []protocol.EffectsIRInfo{{IRID: 1, Name: "hall.wav", SampleRate: 48000, Channels: 2, Frames: 96000}},
		"EffectResponseResult": []protocol.EffectsResponseInfo{{Axis: "frequency", Count: 256, DataBytes: 4096}},
	})
}
