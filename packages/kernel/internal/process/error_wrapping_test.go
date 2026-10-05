package process

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/measure/loudness"
)

func TestRestorationErrorsIncludeContextAndRetainCause(t *testing.T) {
	document, _ := restorationDocument(t, 4096, 1)
	settings := restoreSettings("remove-hum")
	settings.Restoration.HumHz = math.NaN()
	_, err := NewOperation(document, ops.Range{End: document.Frames(), ChannelMask: 1}, settings, Limits{})
	if err == nil || !strings.HasPrefix(err.Error(), "process.restoration: hum filter:") || errors.Unwrap(err) == nil {
		t.Fatalf("hum constructor lost upstream context or cause: %v", err)
	}
	settings = restoreSettings("spectral-remove")
	settings.Restoration.Mask.Start, settings.Restoration.Mask.End = 0, document.Frames()
	stepper, err := NewOperation(document, ops.Range{End: document.Frames(), ChannelMask: 1}, settings, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = stepper.Step(ctx)
	if !errors.Is(err, context.Canceled) || !strings.HasPrefix(err.Error(), "process.restoration:") {
		t.Fatalf("restoration cancellation lost cause: %v", err)
	}
}

func TestNormalizationNonFiniteErrorRetainsBothCauses(t *testing.T) {
	document := fixture(t, []float32{.25, float32(math.NaN())})
	stepper, err := NewNormalizer(document, ops.Range{End: 2, ChannelMask: 1}, protocol.OperationNormalizePeak, -1, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = stepper.Step(context.Background())
	if !errors.Is(err, audiobuf.ErrNonFiniteSamples) || !errors.Is(err, loudness.ErrNonFinite) {
		t.Fatalf("peak normalization lost an upstream failure identity: %v", err)
	}
}
