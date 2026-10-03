package process

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/measure/loudness"
)

func TestNormalizerConstructorRejectsInvalidControlState(t *testing.T) {
	document := fixture(t, []float32{.5, -.25})
	channel, err := document.Channel(0)
	if err != nil {
		t.Fatal(err)
	}
	lowRate, err := audiobuf.NewDocument([]audiobuf.Channel{channel}, 7999, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	highRate, err := audiobuf.NewDocument([]audiobuf.Channel{channel}, 384001, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	channels := make([]audiobuf.Channel, 9)
	for i := range channels {
		channels[i] = channel
	}
	tooMany, err := audiobuf.NewDocument(channels, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name      string
		document  audiobuf.Document
		selected  ops.Range
		operation string
		target    float64
		limits    Limits
	}{
		{"missing document", audiobuf.Document{}, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", 0, Limits{}},
		{"channel count", tooMany, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", 0, Limits{}},
		{"collapsed range", document, ops.Range{Start: 1, End: 1, ChannelMask: 1}, "normalize-peak", 0, Limits{}},
		{"negative range", document, ops.Range{Start: -1, End: 2, ChannelMask: 1}, "normalize-peak", 0, Limits{}},
		{"out of bounds", document, ops.Range{End: 3, ChannelMask: 1}, "normalize-peak", 0, Limits{}},
		{"empty mask", document, ops.Range{End: 2}, "normalize-peak", 0, Limits{}},
		{"unknown channel", document, ops.Range{End: 2, ChannelMask: 2}, "normalize-peak", 0, Limits{}},
		{"unknown operation", document, ops.Range{End: 2, ChannelMask: 1}, "normalize-rms", 0, Limits{}},
		{"negative budget", document, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", 0, Limits{MaxOutputBytes: -1}},
		{"excessive budget", document, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", 0, Limits{MaxOutputBytes: DefaultMaxOutputBytes + 1}},
		{"NaN target", document, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", math.NaN(), Limits{}},
		{"infinite target", document, ops.Range{End: 2, ChannelMask: 1}, "normalize-loudness", math.Inf(1), Limits{}},
		{"positive target", document, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", .1, Limits{}},
		{"peak target lower bound", document, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", -121, Limits{}},
		{"LUFS target lower bound", document, ops.Range{End: 2, ChannelMask: 1}, "normalize-loudness", -70, Limits{}},
		{"LUFS sample rate lower bound", lowRate, ops.Range{End: 2, ChannelMask: 1}, "normalize-loudness", -23, Limits{}},
		{"LUFS sample rate upper bound", highRate, ops.Range{End: 2, ChannelMask: 1}, "normalize-loudness", -23, Limits{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if normalizer, err := NewNormalizer(test.document, test.selected, test.operation, test.target, test.limits); err == nil || normalizer != nil {
				t.Fatal("invalid constructor published a job", err)
			}
		})
	}
	assertBits(t, samples(t, document, 0), []float32{.5, -.25})
}

func assertNormalizerReleased(t *testing.T, normalizer *Normalizer, terminal error) {
	t.Helper()
	if normalizer.builder != nil || normalizer.analyzer != nil || normalizer.verification != nil || normalizer.channels != nil || normalizer.storage != nil || normalizer.block != nil || normalizer.source.Channels() != 0 || normalizer.result.Channels() != 0 {
		t.Fatal("terminal normalizer retained private audio/workspace")
	}
	before := normalizer.progress
	for range 2 {
		progress, err := normalizer.Step(context.Background())
		if err == nil || progress != before || (terminal != nil && !errors.Is(err, terminal)) {
			t.Fatal("terminal Step changed progress or forgot its failure", progress, err)
		}
		if document, err := normalizer.Result(); err == nil || document.Channels() != 0 || (terminal != nil && !errors.Is(err, terminal)) {
			t.Fatal("terminal Result exposed candidate", err)
		}
		if document, err := normalizer.MemoryDocument(); err == nil || document.Channels() != 0 || (terminal != nil && !errors.Is(err, terminal)) {
			t.Fatal("terminal MemoryDocument exposed candidate", err)
		}
		normalizer.Cancel()
	}
}

func TestNormalizerContextResultAndCancellationGuards(t *testing.T) {
	input := normalizeTone(19200, .5)
	document := fixture(t, input)
	for _, kind := range []string{"nil context", "cancelled context", "explicit cancel", "cancel ready result"} {
		t.Run(kind, func(t *testing.T) {
			normalizer, err := NewNormalizer(document, ops.Range{End: 19200, ChannelMask: 1}, "normalize-loudness", -23, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := normalizer.Result(); err == nil {
				t.Fatal("premature candidate exposed")
			}
			if memory, err := normalizer.MemoryDocument(); err != nil || memory.Channels() != 0 {
				t.Fatal("analysis exposed owned output", err)
			}
			terminal := error(context.Canceled)
			switch kind {
			case "nil context":
				//nolint:staticcheck // Deliberately exercise the nil-context rejection guard.
				if _, err := normalizer.Step(nil); err == nil {
					t.Fatal("nil context accepted")
				}
				terminal = nil
			case "cancelled context":
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				if _, err := normalizer.Step(ctx); !errors.Is(err, context.Canceled) {
					t.Fatal("cancelled context was ignored", err)
				}
			case "explicit cancel":
				normalizer.Cancel()
			case "cancel ready result":
				result := finishNormalizer(t, normalizer)
				before := normalizer.progress
				if progress, err := normalizer.Step(context.Background()); err != nil || progress != before {
					t.Fatal("repeated ready step changed result", err)
				}
				if memory, err := normalizer.MemoryDocument(); err != nil || !reflect.DeepEqual(memory, result) {
					t.Fatal("ready candidate missing from memory ownership", err)
				}
				normalizer.Cancel()
				// The consumer's immutable result remains owned independently.
				if math.Abs(measureNormalized(t, result, 1)+23) > .01 {
					t.Fatal("Cancel mutated a previously returned immutable result")
				}
			}
			assertNormalizerReleased(t, normalizer, terminal)
			assertBits(t, samples(t, document, 0), input)
		})
	}
	var zero Normalizer
	if _, err := zero.Step(context.Background()); err == nil {
		t.Fatal("unconfigured normalizer entered a valid phase")
	}
	assertNormalizerReleased(t, &zero, nil)
}

func normalizerInPhase(t *testing.T, document audiobuf.Document, phase string) *Normalizer {
	t.Helper()
	normalizer, err := NewNormalizer(document, ops.Range{End: document.Frames(), ChannelMask: 1}, "normalize-loudness", -23, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	for attempts := 0; normalizer.Status().Phase != phase && attempts < 1000; attempts++ {
		if _, err := normalizer.Step(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if normalizer.Status().Phase != phase || normalizer.progress.Done {
		t.Fatal("requested active phase was not reached")
	}
	return normalizer
}

func TestNormalizerDelayedProcessorFailuresReleasePartialOutput(t *testing.T) {
	input := normalizeTone(audiobuf.BlockFrames+7, .5)
	document := fixture(t, input)
	sentinel := errors.New("injected processor failure after a stored block")
	for _, kind := range []string{"processor error", "nonfinite output"} {
		t.Run(kind, func(t *testing.T) {
			normalizer := normalizerInPhase(t, document, "processing")
			original := normalizer.builder.processors[0]
			calls := 0
			normalizer.builder.processors[0] = processorFunc(func(block []float64) error {
				calls++
				if calls == 2 {
					if kind == "processor error" {
						return sentinel
					}
					block[0] = math.Inf(1)
					return nil
				}
				return original.ProcessBlock(block)
			})
			if _, err := normalizer.Step(context.Background()); err != nil {
				t.Fatal("first block should be retained privately", err)
			}
			if memory, err := normalizer.MemoryDocument(); err != nil || audiobuf.CountMemory(memory).SampleBytes == 0 {
				t.Fatal("partial output missing from accounting", err)
			}
			if _, err := normalizer.Result(); err == nil {
				t.Fatal("partial processor output was published")
			}
			if _, err := normalizer.Step(context.Background()); err == nil {
				t.Fatal("delayed output failure accepted")
			}
			var terminal error
			if kind == "processor error" {
				terminal = sentinel
			}
			assertNormalizerReleased(t, normalizer, terminal)
			assertBits(t, samples(t, document, 0), input)
		})
	}
}

func TestNormalizerRejectsUnreadableChannelsAndInvalidResolvedPlans(t *testing.T) {
	document := fixture(t, []float32{.5, -.25})
	normalizer, err := NewNormalizer(document, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", 0, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a source-storage read failure without modifying the source.
	normalizer.channels[0] = audiobuf.Channel{}
	if _, err := normalizer.Step(context.Background()); err == nil || !strings.Contains(err.Error(), "read") {
		t.Fatal("short source read was accepted", err)
	}
	assertNormalizerReleased(t, normalizer, nil)
	for _, plan := range []struct{ db, gain float64 }{{math.NaN(), 1}, {math.Inf(1), 1}, {0, math.NaN()}, {0, math.Inf(1)}, {0, 0}, {0, -1}} {
		normalizer, err := NewNormalizer(document, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", 0, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := normalizer.startBuilder(plan.db, plan.gain); err == nil {
			t.Fatal("invalid upstream gain plan was accepted")
		}
		assertNormalizerReleased(t, normalizer, nil)
	}
	assertBits(t, samples(t, document, 0), []float32{.5, -.25})
}

func TestNormalizerActualVerificationRejectsCorruptedCandidates(t *testing.T) {
	input := normalizeTone(19200, .5)
	document := fixture(t, input)
	for _, kind := range []string{"wrong materialized gain", "nonfinite candidate", "below gate candidate"} {
		t.Run(kind, func(t *testing.T) {
			normalizer := normalizerInPhase(t, document, "processing")
			original := normalizer.builder.processors[0]
			normalizer.builder.processors[0] = processorFunc(func(block []float64) error {
				if kind == "wrong materialized gain" {
					if err := original.ProcessBlock(block); err != nil {
						return err
					}
					return (gainProcessor{linear: .5}).ProcessBlock(block)
				}
				if kind == "nonfinite candidate" {
					block[51] = math.Inf(1)
					return nil
				}
				return (gainProcessor{linear: 1e-9}).ProcessBlock(block)
			})
			// Corrupt the actual materialized representation before its immutable
			// storage is metered. Storage cannot change after this boundary.
			var terminal error
			if kind == "below gate candidate" {
				terminal = loudness.ErrBelowGate
			}
			failed := false
			for attempts := 0; attempts < 1000; attempts++ {
				progress, err := normalizer.Step(context.Background())
				if err != nil {
					failed = true
					if kind == "wrong materialized gain" && !strings.Contains(err.Error(), "deviates") {
						t.Fatal("wrong-gain candidate failed for unexpected reason", err)
					}
					break
				}
				if progress.Done {
					t.Fatal("invalid candidate became ready")
				}
			}
			if !failed {
				t.Fatal("candidate verification did not terminate")
			}
			assertNormalizerReleased(t, normalizer, terminal)
			assertBits(t, samples(t, document, 0), input)
		})
	}
}

func TestNormalizerCertificateOnlyVerificationWithExplicitInjectedStatus(t *testing.T) {
	document := fixture(t, normalizeTone(19200, .5))
	target := measureNormalized(t, document, 1)
	for _, kind := range []string{"valid identity certificate", "absent certificate", "inaccurate certificate"} {
		t.Run(kind, func(t *testing.T) {
			normalizer, err := NewNormalizer(document, ops.Range{End: 19200, ChannelMask: 1}, "normalize-loudness", target, Limits{MaxOutputBytes: 1})
			if err != nil {
				t.Fatal(err)
			}
			// Explicit test-only certification models the reserved future path.
			// Production currently always remeasures rounded float32 candidates.
			prediction := target
			if kind == "inaccurate certificate" {
				prediction += .02
			}
			if kind != "absent certificate" {
				normalizer.status.PredictedLUFS = &prediction
			}
			normalizer.verifyInput = false
			if _, err := normalizer.startBuilder(0, 1); err != nil {
				t.Fatal(err)
			}
			if _, err := normalizer.Step(context.Background()); err != nil || normalizer.status.Phase != "verifying" {
				t.Fatal("identity candidate did not enter certification", err)
			}
			if normalizer.verification != nil || normalizer.storage != nil {
				t.Fatal("certificate-only path allocated an audio verification scan")
			}
			progress, err := normalizer.Step(context.Background())
			if kind != "valid identity certificate" {
				if err == nil {
					t.Fatal("invalid certificate was accepted")
				}
				assertNormalizerReleased(t, normalizer, nil)
				return
			}
			if err != nil || !progress.Done || progress.FramesDone != progress.FramesTotal || normalizer.status.OutputLUFS != nil || !normalizer.Identity() {
				t.Fatal("certificate-only verification invented a measurement or materialized identity", err)
			}
			result, err := normalizer.Result()
			if err != nil || !reflect.DeepEqual(result, document) {
				t.Fatal("certified identity did not preserve exact source storage", err)
			}
			normalizer.Cancel()
			assertNormalizerReleased(t, normalizer, context.Canceled)
		})
	}
}
