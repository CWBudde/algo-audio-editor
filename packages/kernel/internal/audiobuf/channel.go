package audiobuf

import (
	"fmt"
	"slices"
	"sort"
)

// Channel is an immutable ordered block list with prefix frame offsets. The
// zero value is an empty channel. All frame positions use int64 even on WASM.
type Channel struct {
	blocks  []*Block
	offsets []int64 // includes the terminal offset (total frames)
}

// NewChannel copies samples into blocks of at most BlockFrames frames.
func NewChannel(samples []float32) Channel {
	blocks := make([]*Block, 0, len(samples)/BlockFrames+1)
	for start := 0; start < len(samples); start += BlockFrames {
		end := min(start+BlockFrames, len(samples))
		blocks = append(blocks, &Block{samples: slices.Clone(samples[start:end])})
	}

	return channelFromBlocks(blocks)
}

// NewChannelFromBlocks shares blocks and copies the caller's block list. This
// allows importers to construct a channel one block at a time.
func NewChannelFromBlocks(blocks []*Block) (Channel, error) {
	for i, block := range blocks {
		if block == nil || block.Frames() == 0 || block.Frames() > BlockFrames {
			return Channel{}, fmt.Errorf("channel.new: invalid block at index %d", i)
		}
	}

	return channelFromBlocks(slices.Clone(blocks)), nil
}

// channelFromBlocks takes ownership of the block list, but shares its blocks.
func channelFromBlocks(blocks []*Block) Channel {
	if len(blocks) == 0 {
		return Channel{}
	}

	offsets := make([]int64, len(blocks)+1)
	for i, block := range blocks {
		offsets[i+1] = offsets[i] + int64(block.Frames())
	}

	return Channel{blocks: blocks, offsets: offsets}
}

// Frames returns the channel's total frame count.
func (c Channel) Frames() int64 {
	if len(c.offsets) == 0 {
		return 0
	}

	return c.offsets[len(c.offsets)-1]
}

// Read copies frames from start across block boundaries without allocating.
// Invalid starts copy nothing; any unfilled tail in dst stays untouched.
func (c Channel) Read(dst []float32, start int64) int {
	if start < 0 || start >= c.Frames() || len(dst) == 0 {
		return 0
	}

	i := c.blockAt(start)
	n := 0
	for i < len(c.blocks) && n < len(dst) {
		n += c.blocks[i].Read(dst[n:], int(start-c.offsets[i]))
		start = c.offsets[i+1]
		i++
	}

	return n
}

func (c Channel) blockAt(frame int64) int {
	return sort.Search(len(c.blocks), func(i int) bool { return c.offsets[i+1] > frame })
}

// Slice returns frames [start, end). Whole blocks are shared; only partial
// boundary blocks are copied. A slice within one block makes just one copy.
func (c Channel) Slice(start, end int64) (Channel, error) {
	if start < 0 || end < start || end > c.Frames() {
		return Channel{}, fmt.Errorf("channel.slice: range [%d, %d) outside [0, %d)", start, end, c.Frames())
	}
	if start == end {
		return Channel{}, nil
	}
	if start == 0 && end == c.Frames() {
		return c, nil
	}

	first, last := c.blockAt(start), c.blockAt(end-1)
	blocks := make([]*Block, 0, last-first+1)
	for i := first; i <= last; i++ {
		block := c.blocks[i]
		lo := int(max(start, c.offsets[i]) - c.offsets[i])
		hi := int(min(end, c.offsets[i+1]) - c.offsets[i])
		if lo != 0 || hi != block.Frames() {
			block = &Block{samples: slices.Clone(block.samples[lo:hi])}
		}
		blocks = append(blocks, block)
	}

	return channelFromBlocks(blocks), nil
}

// Concat joins channels by copying only their block lists, preserving all
// sample blocks. Empty channels are valid operands.
func (c Channel) Concat(other Channel) Channel {
	if c.Frames() == 0 {
		return other
	}
	if other.Frames() == 0 {
		return c
	}

	blocks := make([]*Block, 0, len(c.blocks)+len(other.blocks))
	blocks = append(blocks, c.blocks...)
	blocks = append(blocks, other.blocks...)

	return channelFromBlocks(blocks)
}
