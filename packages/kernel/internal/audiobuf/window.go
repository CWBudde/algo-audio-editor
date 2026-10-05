package audiobuf

import (
	"fmt"
	"slices"
	"sync"
)

// Window is an immutable bounded view retaining only its touched original
// blocks. Fractional edges retain their original samples and peaks without
// copying; unrelated blocks and the original channel list are not retained.
type Window struct {
	channel Channel
	start   int64
	frames  int64
}

// Window selects [start,end) without copying any samples or cached peaks.
func (c Channel) Window(start, end int64) (Window, error) {
	if start < 0 || end < start || end > c.Frames() {
		return Window{}, fmt.Errorf("channel.window: range [%d, %d) outside [0, %d)", start, end, c.Frames())
	}
	if start == end {
		return Window{}, nil
	}
	first, last := c.blockAt(start), c.blockAt(end-1)
	return Window{
		channel: channelFromBlocks(slices.Clone(c.blocks[first : last+1])),
		start:   start - c.offsets[first], frames: end - start,
	}, nil
}

// Frames returns the length of the shared channel view.
func (w Window) Frames() int64 { return w.frames }

// Read copies out only selected frames, never exposing a fractional edge.
func (w Window) Read(dst []float32, start int64) int {
	if start < 0 || start >= w.frames {
		return 0
	}
	n := int(min(int64(len(dst)), w.frames-start))
	return w.channel.Read(dst[:n], w.start+start)
}

// Materialize shares whole blocks and copies only fractional boundaries.
func (w Window) Materialize() (Channel, error) {
	channel, err := w.channel.Slice(w.start, w.start+w.frames)
	if err != nil {
		return Channel{}, fmt.Errorf("window.materialize: %w", err)
	}
	return channel, nil
}

var fullSilenceBlock = sync.OnceValue(func() *Block {
	return newBlock(make([]float32, BlockFrames))
})

// NewSilence builds a channel from shared immutable zero blocks, not a
// duration-sized sample buffer. The block-list limit bounds allocation even
// for malformed requests containing enormous otherwise JS-safe durations.
func NewSilence(frames int64) (Channel, error) {
	const maxSilenceBlocks = 1 << 20
	if frames < 0 || frames > 1<<53-1 {
		return Channel{}, fmt.Errorf("channel.silence: frames %d must be nonnegative and JS-safe", frames)
	}
	count := frames / BlockFrames
	if frames%BlockFrames != 0 {
		count++
	}
	if count > maxSilenceBlocks {
		return Channel{}, fmt.Errorf("channel.silence: duration requires more than %d block references", maxSilenceBlocks)
	}
	if count == 0 {
		return Channel{}, nil
	}
	zero := fullSilenceBlock()
	blocks := make([]*Block, int(count))
	for i := range blocks {
		blocks[i] = zero
	}
	if tail := frames % BlockFrames; tail != 0 {
		blocks[len(blocks)-1] = newBlock(zero.samples[:tail])
	}
	return channelFromBlocks(blocks), nil
}
