package engine

import (
	"encoding/binary"
	"fmt"
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestDynamicEQResponseUsesBandModeOffsetAndRange(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.1, -.1}, 1)
	params := map[string]any{"bands": 3}
	modes := []string{"downward", "upward", "upward-below"}
	for b, mode := range modes {
		prefix := fmt.Sprintf("band%d", b+1)
		params[prefix+"Mode"] = mode
		params[prefix+"ThresholdDB"] = -20
		params[prefix+"Ratio"] = 4
		params[prefix+"KneeDB"] = 0
		params[prefix+"RangeDB"] = 6
		params[prefix+"GainDB"] = float64(b + 1)
	}
	for band, mode := range modes {
		params["responseBand"] = band
		response := effectRPCCall(t, e, protocol.MethodEffectsResponse, protocol.EffectsResponseParams{EffectID: "dyn-eq", SampleRate: 48000, Mode: "transfer", Points: 5, Params: params}, nil)
		if !response.OK {
			t.Fatal(response.Error)
		}
		data := e.TakeData()
		if len(data) != 5*16 {
			t.Fatalf("invalid response size %d", len(data))
		}
		for point := range 5 {
			input := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16:]))
			output := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16+8:]))
			delta := 0.0
			switch mode {
			case "downward":
				delta = -math.Min(6, math.Max(0, (input+20)*.75))
			case "upward":
				delta = math.Min(6, math.Max(0, (input+20)*.75))
			case "upward-below":
				delta = math.Min(6, math.Max(0, (-20-input)*.75))
			}
			want := input + float64(band+1) + delta
			if math.Abs(output-want) > 1e-8 {
				t.Fatalf("band%d input%g: got%g want%g", band, input, output, want)
			}
		}
	}
	params["responseBand"] = 8
	if response := effectRPCCall(t, e, protocol.MethodEffectsResponse, protocol.EffectsResponseParams{EffectID: "dyn-eq", Mode: "transfer", Params: params}, nil); response.OK || len(e.TakeData()) != 0 {
		t.Fatal("invalid band accepted or stale data retained")
	}
}
