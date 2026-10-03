package audiobuf

import "fmt"

// NewBlockFromFloat64 rounds samples directly into private float32 storage.
// It retains neither the input nor an intermediate rounded copy. This only
// changes representation; sample processing remains the caller's upstream DSP.
func NewBlockFromFloat64(samples []float64) (*Block, error) {
	if len(samples) == 0 || len(samples) > BlockFrames {
		return nil, fmt.Errorf("block.newFloat64: frames %d must be in [1, %d]", len(samples), BlockFrames)
	}
	b := &Block{samples: make([]float32, len(samples))}
	i := 0
	for ; i+8 <= len(samples); i += 8 {
		in, out := samples[i:i+8], b.samples[i:i+8]
		out[0], out[1], out[2], out[3] = float32(in[0]), float32(in[1]), float32(in[2]), float32(in[3])
		out[4], out[5], out[6], out[7] = float32(in[4]), float32(in[5]), float32(in[6]), float32(in[7])
	}
	for ; i < len(samples); i++ {
		b.samples[i] = float32(samples[i])
	}
	b.buildPeaks()
	return b, nil
}
