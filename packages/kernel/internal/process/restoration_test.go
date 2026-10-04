package process

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/dsp/effects/restoration"
)

func restorationDocument(t *testing.T, n, channels int) (audiobuf.Document, []float32) {
	t.Helper()
	x := make([]float32, n)
	for i := range x {
		x[i] = float32(0.4 * math.Sin(2*math.Pi*440*float64(i)/48000))
	}
	parts := make([]audiobuf.Channel, channels)
	for i := range parts {
		parts[i] = audiobuf.NewChannel(x)
	}
	doc, err := audiobuf.NewDocument(parts, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	return doc, x
}

func restoreSettings(op string) Settings {
	return Settings{Operation: op, Restoration: RestorationSettings{FFTSize: 2048, ReductionDB: 24, NoiseMethod: "wiener", ProfileEnd: 2048, Sensitivity: 8, ClipThreshold: 0.25, MaxGap: 64, DurationRatio: 1.5, HumHz: 50, HumQ: 30, Harmonics: 8, Mask: restoration.Mask{Start: 6000, End: 6004, HighHz: 24000}}}
}

func TestRestorationBoundedStorageAndSourceSharing(t *testing.T) {
	for _, op := range []string{"spectral-attenuate", "spectral-remove", "spectral-heal", "noise-reduce", "remove-clicks", "declip", "time-stretch", "remove-hum"} {
		t.Run(op, func(t *testing.T) {
			doc, x := restorationDocument(t, 12000, 2)
			selected := ops.Range{Start: 6000, End: 6004, ChannelMask: 1}
			if op == "time-stretch" {
				selected.ChannelMask = 3
			}
			settings := restoreSettings(op)
			job, err := NewOperation(doc, selected, settings, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = job.Result(); err == nil {
				t.Fatal("early result")
			}
			for steps := 0; steps < 1000; steps++ {
				progress, err := job.Step(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if _, err = job.MemoryDocument(); err != nil {
					t.Fatal("memory accounting", err)
				}
				if progress.Done {
					break
				}
				if steps == 999 {
					t.Fatal("unbounded job")
				}
			}
			out, err := job.Result()
			if err != nil {
				t.Fatal(err)
			}
			expected := int64(12000)
			if op == "time-stretch" {
				expected += 2
			}
			if out.Frames() != expected {
				t.Fatal("output length")
			}
			source, _ := doc.Channel(0)
			original := make([]float32, len(x))
			source.Read(original, 0)
			for i := range x {
				if original[i] != x[i] {
					t.Fatal("source changed")
				}
			}
			if op != "time-stretch" {
				right, _ := out.Channel(1)
				unchanged := make([]float32, len(x))
				right.Read(unchanged, 0)
				for i := range x {
					if unchanged[i] != x[i] {
						t.Fatal("unselected changed")
					}
				}
			}
			job.Cancel()
			if _, err = job.Result(); !errors.Is(err, context.Canceled) {
				t.Fatal("cancel failed", err)
			}
		})
	}
}

func TestRestorationBudgetCancellationAndIdentity(t *testing.T) {
	doc, _ := restorationDocument(t, 140000, 2)
	selected := ops.Range{End: 140000, ChannelMask: 3}
	for _, op := range []string{"time-stretch", "noise-reduce", "remove-clicks", "declip", "remove-hum"} {
		settings := restoreSettings(op)
		if _, err := NewOperation(doc, selected, settings, Limits{MaxOutputBytes: 16}); err == nil {
			t.Fatal("budget accepted", op)
		}
		job, err := NewOperation(doc, selected, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err = job.Step(ctx); !errors.Is(err, context.Canceled) {
			t.Fatal("cancel context", err)
		}
		if _, err = job.MemoryDocument(); err == nil {
			t.Fatal("retained canceled output")
		}
	}
	identity := restoreSettings("time-stretch")
	identity.Restoration.DurationRatio = 1
	job, err := NewOperation(doc, selected, identity, Limits{MaxOutputBytes: 16})
	if err != nil {
		t.Fatal("identity materialized", err)
	}
	for {
		progress, err := job.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if progress.Done {
			break
		}
	}
	if !job.Identity() {
		t.Fatal("identity not declared")
	}
	out, err := job.Result()
	if err != nil || out.Frames() != doc.Frames() {
		t.Fatal(err)
	}
}

func TestRestorationRejectsInvalidControls(t *testing.T) {
	doc, _ := restorationDocument(t, 12000, 2)
	selected := ops.Range{End: 12000, ChannelMask: 3}
	for _, op := range []string{"time-stretch", "noise-reduce", "remove-clicks", "declip", "remove-hum", "spectral-heal"} {
		settings := restoreSettings(op)
		settings.Restoration.DurationRatio = 0
		settings.Restoration.ReductionDB = 100
		settings.Restoration.Sensitivity = 1
		settings.Restoration.ClipThreshold = 2
		settings.Restoration.HumHz = 55
		settings.Restoration.Mask.End = 7000
		if _, err := NewOperation(doc, selected, settings, Limits{}); err == nil {
			t.Fatal("bad controls", op)
		}
	}
	if _, err := NewOperation(doc, ops.Range{End: 12001, ChannelMask: 3}, restoreSettings("remove-clicks"), Limits{}); err == nil {
		t.Fatal("bad range")
	}
	if _, err := NewOperation(doc, selected, restoreSettings("remove-clicks"), Limits{MaxOutputBytes: -1}); err == nil {
		t.Fatal("bad budget")
	}
}

func TestRestorationLongOutputPacksStorageAndAccountsOnlyCompletedBlocks(t *testing.T) {
	doc, _ := restorationDocument(t, 140000, 2)
	selected := ops.Range{Start: 200, End: 139800, ChannelMask: 3}
	job, err := NewOperation(doc, selected, restoreSettings("remove-hum"), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	lastFrames := int64(0)
	for {
		progress, err := job.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		memory, err := job.MemoryDocument()
		if err != nil {
			t.Fatal(err)
		}
		if !progress.Done && memory.Frames() > progress.FramesDone {
			t.Fatal("published pending workspace")
		}
		if memory.Frames() < lastFrames {
			t.Fatal("accounting regressed")
		}
		lastFrames = memory.Frames()
		if progress.Done {
			break
		}
	}
	out, err := job.Result()
	if err != nil || out.Frames() != 140000 {
		t.Fatal(err)
	}
	for i := range 2 {
		ch, _ := out.Channel(i)
		if ch.Frames() != out.Frames() {
			t.Fatal("channel clock")
		}
	}
	if peak, nonfinite := job.Peak(); nonfinite || peak <= 0 || peak > 1 {
		t.Fatal("stored peak", peak, nonfinite)
	}
}

func TestRestorationRejectsNonfiniteSourceAndInvalidSpectralProfiles(t *testing.T) {
	x := make([]float32, 4000)
	x[2000] = float32(math.NaN())
	doc, err := audiobuf.NewDocument([]audiobuf.Channel{audiobuf.NewChannel(x)}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"remove-clicks", "declip", "remove-hum", "noise-reduce", "spectral-remove"} {
		settings := restoreSettings(op)
		settings.Restoration.ProfileEnd = 4000
		settings.Restoration.Mask = restoration.Mask{End: 4000, HighHz: 24000}
		job, err := NewOperation(doc, ops.Range{End: 4000, ChannelMask: 1}, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		failed := false
		for i := 0; i < 20; i++ {
			_, err := job.Step(context.Background())
			if err != nil {
				failed = true
				break
			}
		}
		if !failed {
			t.Fatal("nonfinite accepted", op)
		}
		if _, err = job.Result(); err == nil {
			t.Fatal("failed result retained")
		}
	}
	safe, _ := restorationDocument(t, 12000, 1)
	selected := ops.Range{Start: 6000, End: 6004, ChannelMask: 1}
	for _, change := range []func(*RestorationSettings){func(s *RestorationSettings) { s.FFTSize = 3 }, func(s *RestorationSettings) { s.Mask.HighHz = 25000 }, func(s *RestorationSettings) { s.GainDB = 1 }, func(s *RestorationSettings) { s.Mask.Start = 5999 }} {
		settings := restoreSettings("spectral-attenuate")
		change(&settings.Restoration)
		if _, err = NewOperation(safe, selected, settings, Limits{}); err == nil {
			t.Fatal("invalid spectrum accepted")
		}
	}
	for _, change := range []func(*RestorationSettings){func(s *RestorationSettings) { s.ProfileStart = -1 }, func(s *RestorationSettings) { s.ProfileEnd = 12001 }, func(s *RestorationSettings) { s.ProfileEnd = 10 }, func(s *RestorationSettings) { s.NoiseMethod = "bad" }} {
		settings := restoreSettings("noise-reduce")
		change(&settings.Restoration)
		if _, err = NewOperation(safe, selected, settings, Limits{}); err == nil {
			t.Fatal("invalid profile accepted")
		}
	}
	settings := restoreSettings("remove-clicks")
	job, err := NewOperation(safe, selected, settings, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	//nolint:staticcheck // Deliberately test nil-context rejection.
	if _, err = job.Step(nil); err == nil {
		t.Fatal("nil context accepted")
	}
}

func TestStretchTimelinePreservesIDsAndExactRoundedTime(t *testing.T) {
	tline := audiobuf.Timeline{Markers: []audiobuf.Marker{{ID: 1, Frame: 0}, {ID: 2, Frame: 100}, {ID: 3, Frame: 101}, {ID: 4, Frame: 150}, {ID: 5, Frame: 199}, {ID: 6, Frame: 200}, {ID: 7, Frame: 250}}, Regions: []audiobuf.Region{{ID: 8, Start: 101, End: 102}, {ID: 9, Start: 120, End: 180}}}
	stretchTimeline(&tline, ops.Range{Start: 100, End: 200, ChannelMask: 3}, 50)
	expected := []int64{0, 100, 101, 125, 150, 150, 200}
	for i, m := range tline.Markers {
		if m.ID != int64(i+1) || m.Frame != expected[i] {
			t.Fatal("marker mapping", m)
		}
	}
	if len(tline.Regions) != 1 || tline.Regions[0].ID != 9 || tline.Regions[0].Start != 110 || tline.Regions[0].End != 140 {
		t.Fatal("region mapping", tline.Regions)
	}
	base := int64(1<<52) + 8
	exact := audiobuf.Timeline{Markers: []audiobuf.Marker{{ID: 1, Frame: base + 1}, {ID: 2, Frame: base + 50}, {ID: 3, Frame: base + 101}}}
	stretchTimeline(&exact, ops.Range{Start: base, End: base + 100, ChannelMask: 3}, 151)
	if exact.Markers[0].Frame != base+2 || exact.Markers[1].Frame != base+76 || exact.Markers[2].Frame != base+152 {
		t.Fatal("large exact integer rounding", exact)
	}
}

func TestNoiseProfileCaptureUsesUnpaddedSourceWindows(t *testing.T) {
	for _, offset := range []int64{0, 64} {
		for _, length := range []int64{1024, 2048, 5000} {
			input := make([]float32, 6000)
			for i := range input {
				input[i] = .125
			}
			document := operationDocument(t, input)
			settings := restoreSettings("noise-reduce")
			settings.Restoration.ProfileStart = offset
			settings.Restoration.ProfileEnd = offset + length
			stepper, err := NewOperation(document, ops.Range{End: 6000, ChannelMask: 1}, settings, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			operation := stepper.(*restorationOperation)
			for operation.Status().Phase == "analyzing" {
				if _, err := operation.Step(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			// A constant Hann-windowed source has DC power (amplitude*N/2)^2.
			// Both an exactly half-window profile and long profiles must retain it.
			got := operation.profiles[0].Powers()[0]
			want := math.Pow(.125*float64(settings.Restoration.FFTSize)/2, 2)
			if math.Abs(got-want) > 1e-6 {
				t.Fatalf("offset %d length %d: biased power %g, want %g", offset, length, got, want)
			}
			operation.Cancel()
		}
	}
}
