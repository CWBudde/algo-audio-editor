package engine

import (
	"encoding/binary"
	"fmt"
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestGraphicEQResponseEqualGainsHaveNoOverlapSpikes(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.1, -.1}, 1)
	for _, order := range []int{4, 6, 8, 10, 12} {
		for _, gain := range []float64{-24, -12, 0, 12, 24} {
			t.Run(fmt.Sprintf("order%d/gain%g", order, gain), func(t *testing.T) {
				params := map[string]any{"order": order}
				for band := 1; band <= 10; band++ {
					params[fmt.Sprintf("gain%dDB", band)] = gain
				}
				response := effectRPCCall(t, e, protocol.MethodEffectsResponse,
					protocol.EffectsResponseParams{EffectID: "eq-graphic", SampleRate: 48000, Points: 1024, Params: params}, nil)
				if !response.OK {
					t.Fatal(response.Error)
				}
				data := e.TakeData()
				if len(data) != 1024*16 {
					t.Fatalf("response bytes: %d", len(data))
				}
				for point := range 1024 {
					db := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16+8:]))
					if math.IsNaN(db) || math.Abs(db-gain) > 1e-9 {
						t.Fatalf("point%d: %g dB, want %g", point, db, gain)
					}
				}
			})
		}
	}
}
