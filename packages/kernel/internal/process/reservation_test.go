package process

import (
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// MaterializedBytes is the engine's up-front memory reservation: float32 bytes
// of every newly stored sample, and zero when the result shares source storage.
func TestMaterializedBytesReservesOnlyNewSampleStorage(t *testing.T) {
	const frames = 1000
	stereo := operationDocument(t, make([]float32, frames), make([]float32, frames))
	part := ops.Range{Start: 100, End: 600, ChannelMask: 1}
	whole := ops.Range{End: frames, ChannelMask: 3}
	gain := func(db float64, selected ops.Range) Stepper {
		builder, err := NewBuilder(stereo, selected, Gain{DB: db}, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		return builder
	}
	normalizer := func(operation protocol.OperationName) Stepper {
		normalizer, err := NewNormalizer(stereo, whole, operation, -1, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		return normalizer
	}
	operation := func(settings Settings) Stepper {
		stepper, err := NewOperation(stereo, whole, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		return stepper
	}
	tests := []struct {
		name    string
		stepper Stepper
		want    int64
	}{
		{"gain on one channel of a range", gain(-6, part), 500 * 4},
		{"gain on both channels", gain(-6, whole), frames * 4 * 2},
		{"unity gain shares the source", gain(0, whole), 0},
		// Analysis has not resolved the gain yet, so a full gain pass is reserved.
		{"peak normalization before analysis", normalizer(protocol.OperationNormalizePeak), frames * 4 * 2},
		{"loudness normalization before analysis", normalizer(protocol.OperationNormalizeLoudness), frames * 4 * 2},
		{"resample to the same rate shares the source", operation(Settings{Operation: "resample", SampleRate: 48000}), 0},
		{"resample to twice the rate", operation(Settings{Operation: "resample", SampleRate: 96000}), 2 * frames * 4 * 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.stepper.MaterializedBytes(); got != tt.want {
				t.Fatalf("MaterializedBytes = %d, want %d", got, tt.want)
			}
		})
	}
}
