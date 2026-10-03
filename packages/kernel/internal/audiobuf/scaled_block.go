package audiobuf

import (
	"fmt"

	"github.com/cwbudde/algo-dsp/dsp/signal"
)

// NewScaledBlock reads a finite range into fresh private float32 storage, then
// delegates linked scaling to upstream DSP. The source and private storage never
// escape; summaries describe the exact rounded stored output.
func NewScaledBlock(source Channel, start int64, frames int, gain float64) (*Block, error) {
	if frames < 1 || frames > BlockFrames || start < 0 || start > source.Frames() || int64(frames) > source.Frames()-start {
		return nil, fmt.Errorf("block.scaled: invalid range")
	}
	block := &Block{samples: make([]float32, frames)}
	if source.Read(block.samples, start) != frames {
		return nil, fmt.Errorf("block.scaled: incomplete read")
	}
	if err := signal.ScaleInto32(block.samples, block.samples, gain); err != nil {
		return nil, fmt.Errorf("block.scaled: upstream gain: %w", err)
	}
	block.buildPeaks()
	return block, nil
}
