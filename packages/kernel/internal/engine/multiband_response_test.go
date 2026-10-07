package engine

import (
	"encoding/binary"
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestMultibandResponseUsesEachActualBandGainComputer(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.1, -.1}, 1)
	prefixes := []string{"low", "mid", "upper", "high"}
	thresholds := []float64{-70, -40, -20, -10}
	ratios := []float64{2, 4, 8, 2}
	params := map[string]any{"bands": 4, "perBand": 1, "kneeDB": 0}
	for band, prefix := range prefixes {
		params[prefix+"ThresholdDB"] = thresholds[band]
		params[prefix+"Ratio"] = ratios[band]
		params[prefix+"KneeDB"] = 0
		params[prefix+"MakeupGainDB"] = float64(band)
	}
	for band := range prefixes {
		params["responseBand"] = band
		response := effectRPCCall(t, e, protocol.MethodEffectsResponse,
			protocol.EffectsResponseParams{EffectID: "dyn-multiband", SampleRate: 48000, Mode: "transfer", Points: 5, Params: params}, nil)
		if !response.OK {
			t.Fatal(response.Error)
		}
		data := e.TakeData()
		if len(data) != 5*16 {
			t.Fatalf("band %d: response bytes %d", band, len(data))
		}
		for point := range 5 {
			input := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16:]))
			output := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16+8:]))
			want := input
			if input > thresholds[band] {
				want = thresholds[band] + (input-thresholds[band])/ratios[band]
			}
			want += float64(band)
			if math.Abs(output-want) > 1e-8 {
				t.Fatalf("band %d input %g: output %g, want %g", band, input, output, want)
			}
		}
	}
	params["responseBand"] = 4
	if response := effectRPCCall(t, e, protocol.MethodEffectsResponse,
		protocol.EffectsResponseParams{EffectID: "dyn-multiband", Mode: "transfer", Params: params}, nil); response.OK || len(e.TakeData()) != 0 {
		t.Fatal("invalid inspection band accepted or stale binary data retained")
	}
}
