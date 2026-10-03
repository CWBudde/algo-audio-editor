package audiobuf

import (
	"fmt"

	"github.com/cwbudde/algo-dsp/dsp/fade"
	"github.com/cwbudde/algo-dsp/dsp/signal"
)

// NewFadedBlock delegates a position-aware fade directly into freshly owned
// storage. offset and total are relative to the complete selected fade, so
// storage partitions cannot restart its envelope. Private samples never escape.
func NewFadedBlock(source Channel, start int64, frames int, offset, total int64, shape fade.Shape, fadeIn bool) (*Block, error) {
	block, err := readOwnedBlock(source, start, frames)
	if err != nil {
		return nil, fmt.Errorf("block.fade: %w", err)
	}
	if err := fade.ApplyInto32(block.samples, block.samples, offset, total, shape, fadeIn); err != nil {
		return nil, fmt.Errorf("block.fade: upstream fade: %w", err)
	}
	block.buildPeaks()
	return block, nil
}

// NewDCRemovedBlock subtracts an independently measured whole-range channel
// mean using upstream DSP and rounds directly into immutable float32 storage.
func NewDCRemovedBlock(source Channel, start int64, frames int, mean float64) (*Block, error) {
	block, err := readOwnedBlock(source, start, frames)
	if err != nil {
		return nil, fmt.Errorf("block.remove-dc: %w", err)
	}
	if err := signal.SubtractMeanInto32(block.samples, block.samples, mean); err != nil {
		return nil, fmt.Errorf("block.remove-dc: upstream subtraction: %w", err)
	}
	block.buildPeaks()
	return block, nil
}

func readOwnedBlock(source Channel, start int64, frames int) (*Block, error) {
	if frames < 1 || frames > BlockFrames || start < 0 || start > source.Frames() || int64(frames) > source.Frames()-start {
		return nil, fmt.Errorf("invalid source range")
	}
	block := &Block{samples: make([]float32, frames)}
	if source.Read(block.samples, start) != frames {
		return nil, fmt.Errorf("incomplete source read")
	}
	return block, nil
}
