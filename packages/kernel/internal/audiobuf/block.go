// Package audiobuf provides immutable, block-based audio storage. Channels and
// documents are values: copying them shares sample blocks safely. Go's garbage
// collector releases blocks once no document, clipboard or history retains them.
package audiobuf

import (
	"fmt"
	"slices"
)

// BlockFrames is the maximum number of mono float32 frames in a block.
const BlockFrames = 65536

// Block owns immutable samples for one channel. Samples are never exposed;
// Read copies them into a caller-owned destination.
type Block struct {
	samples []float32
	peaks   [3][]peakSummary
}

// NewBlock copies samples into a block. Empty and oversized blocks are rejected.
func NewBlock(samples []float32) (*Block, error) {
	if len(samples) == 0 || len(samples) > BlockFrames {
		return nil, fmt.Errorf("block.new: frames %d must be in [1, %d]", len(samples), BlockFrames)
	}

	return newBlock(samples), nil
}

// newBlock copies valid samples and calculates their immutable peak pyramid.
func newBlock(samples []float32) *Block {
	b := &Block{samples: slices.Clone(samples)}
	b.buildPeaks()

	return b
}

// Frames returns the number of frames in the block.
func (b *Block) Frames() int { return len(b.samples) }

// Read copies frames from start into dst and returns the count copied. Invalid
// starts copy nothing; the part of dst after the copied frames is untouched.
func (b *Block) Read(dst []float32, start int) int {
	if start < 0 || start >= len(b.samples) {
		return 0
	}

	return copy(dst, b.samples[start:])
}
