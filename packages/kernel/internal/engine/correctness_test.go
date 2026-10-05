package engine

import (
	"errors"
	"io"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestSurroundNormalizeStatisticsExportAndMeters(t *testing.T) {
	const frames = 48000
	for _, tc := range []struct{ channels, mask int }{{5, 31}, {6, 63}, {6, 1<<4 | 1<<5}, {6, 1 | 1<<3 | 1<<5}} {
		input := make([]float32, frames*tc.channels)
		for frame := range frames {
			for ch := range tc.channels {
				amplitude := .03 * float64(ch+1)
				if tc.channels == 6 && ch == 3 {
					amplitude = .75
				}
				input[frame*tc.channels+ch] = float32(amplitude * math.Sin(2*math.Pi*float64(300+100*ch)*float64(frame)/48000))
			}
		}
		e, _ := openEditorFixture(t, input, tc.channels)
		before := e.editResult(false)
		job := startEngineProcess(t, e, normalizationParams(e, 0, frames, tc.mask, "normalize-loudness", -23))
		job = finishEngineNormalization(t, e, job)
		if job.OutputLUFS == nil || math.Abs(*job.OutputLUFS+23) > .01 {
			t.Fatalf("candidate loudness %+v", job)
		}
		if !reflect.DeepEqual(before, e.editResult(false)) {
			t.Fatal("private normalization published")
		}
		if _, err := e.commitProcess(jobParams(job)); err != nil {
			t.Fatal(err)
		}
		for _, format := range []string{"wav", "flac", "aiff"} {
			info, err := e.exportDocument(protocol.DocumentExportParams{Format: format, BitDepth: 24})
			if err != nil {
				t.Fatal(err)
			}
			reopened := New()
			if _, err := reopened.openDocument(protocol.DocumentOpenParams{Name: info.Name}, e.TakeData()); err != nil {
				t.Fatal(err)
			}
			result, err := reopened.startAnalysis(analysisParams(reopened, "statistics", 0, frames, tc.mask))
			if err != nil {
				t.Fatal(err)
			}
			result, _ = finishAnalysis(t, reopened, result)
			if result.IntegratedLUFS == nil || math.Abs(*result.IntegratedLUFS+23) > .01 {
				t.Fatalf("%d channels mask %d %s: LUFS %v", tc.channels, tc.mask, format, result.IntegratedLUFS)
			}
		}
		if tc.mask == (1<<tc.channels)-1 {
			if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: tc.channels}); err != nil {
				t.Fatal(err)
			}
			if _, err := e.configureMeters(protocol.MetersConfigureParams{}); err != nil {
				t.Fatal(err)
			}
			if _, err := e.playDocument(protocol.TransportPlayParams{}); err != nil {
				t.Fatal(err)
			}
			output := make([]float32, 512*tc.channels)
			rendered := 0
			for {
				n := e.Render(output)
				rendered += n
				if n != 512 {
					break
				}
			}
			if rendered != frames {
				t.Fatalf("rendered %d frames, want %d", rendered, frames)
			}
			if got := meterValues(t, e)[6]; math.Abs(got+23) > .01 {
				t.Fatalf("%d-channel meters %g", tc.channels, got)
			}
		}
	}
}

func TestLFEOnlyNormalizationRejectsWithoutPublication(t *testing.T) {
	e, _ := openEditorFixture(t, make([]float32, 48000*6), 6)
	before := e.editResult(false)
	if _, err := e.startProcess(normalizationParams(e, 0, 48000, 1<<3, "normalize-loudness", -23)); err == nil {
		t.Fatal("LFE has no programme loudness")
	}
	if e.jobs.processJob != nil || !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("rejected LFE job published")
	}
}

func TestAnalysisMissingHistoryBeforeActiveJobCheck(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.25, .5, -.25, -.5}, 1)
	p := analysisParams(e, "statistics", 0, 4, 1)
	if _, err := e.startAnalysis(p); err != nil {
		t.Fatal(err)
	}
	job := e.analysis.analysisJob
	e.historyState.history = nil
	if _, err := e.startAnalysis(p); err == nil || !strings.Contains(err.Error(), "analysis.start: analysis history unavailable") {
		t.Fatal(err)
	}
	if e.analysis.analysisJob != job || e.analysis.analysisSequence != 1 {
		t.Fatal("rejected analysis changed job")
	}
}

func TestCodecExportShortReads(t *testing.T) {
	source := audiobuf.NewChannel([]float32{.25, .5, .75})
	for _, format := range []string{"flac", "aiff"} {
		if err := readCodecExportSamples(source, make([]float32, 4), 0, format, 0); !errors.Is(err, io.ErrUnexpectedEOF) || !strings.Contains(err.Error(), "doc.export: "+format) {
			t.Fatal(err)
		}
		dst := make([]float32, 2)
		if err := readCodecExportSamples(source, dst, 1, format, 0); err != nil || !reflect.DeepEqual(dst, []float32{.5, .75}) {
			t.Fatalf("valid read %v: %v", dst, err)
		}
	}
}

func TestGeneratorSubsetCommitKeepsSyncAndUndo(t *testing.T) {
	input := []float32{1, 5, 2, 6, 3, 7, 4, 8}
	e, _ := openEditorFixture(t, input, 2)
	setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 3, Name: "tail", Color: "#112233"}}, nil)
	p := processParams(e, 2, 2, 1, 0)
	p.Operation, p.Generator, p.DurationFrames = "generate", "silence", 4
	job := finishEngineNormalization(t, e, startEngineProcess(t, e, p))
	assertEditBits(t, editSamples(t, e), input)
	if job.Candidate == nil || job.Candidate.Frames != 8 {
		t.Fatal("candidate geometry")
	}
	if _, err := e.commitProcess(jobParams(job)); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, e), []float32{1, 5, 2, 6, 0, 0, 0, 0, 0, 0, 0, 0, 3, 7, 4, 8})
	if e.doc.document.Metadata().Timeline.Markers[0].Frame != 7 {
		t.Fatal("marker out of sync")
	}
	historyNavigate(t, e, protocol.MethodEditUndo, "")
	assertEditBits(t, editSamples(t, e), input)
	if e.doc.document.Metadata().Timeline.Markers[0].Frame != 3 {
		t.Fatal("undo did not restore marker")
	}
}
