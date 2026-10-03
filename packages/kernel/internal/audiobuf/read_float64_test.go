package audiobuf

import (
	"math"
	"testing"
)

func readFloat64Pattern(frames int) []float32 {
	patterns := []uint32{
		0, 0x80000000, 1, 0x80000001, 0x007fffff, 0x00800000,
		0x3e800000, 0xbf400000, 0x7f7fffff, 0xff7fffff,
		0x7f800000, 0xff800000, 0x7fc12345, 0xffc54321,
		0x7f812345, 0xff854321,
	}
	values := make([]float32, frames)
	for i := range values {
		values[i] = math.Float32frombits(patterns[i%len(patterns)])
	}
	return values
}

func assertReadFloat64Parity(t *testing.T, channel Channel, start int64, frames int) {
	t.Helper()
	// The oracle is the established immutable Read followed by scalar Go
	// widening. NaN conversions are compared bitwise on the current architecture,
	// rather than imposing one architecture's signaling-NaN quieting policy.
	mono := make([]float32, frames)
	got, want := make([]float64, frames), make([]float64, frames)
	const sentinelBits = uint64(0xfff8123456789abc)
	for i := range got {
		got[i], want[i] = math.Float64frombits(sentinelBits), math.Float64frombits(sentinelBits)
	}
	n := channel.Read(mono, start)
	for i := range n {
		want[i] = float64(mono[i])
	}
	if copied := channel.ReadFloat64(got, start); copied != n {
		t.Fatalf("start=%d frames=%d: count %d, want %d", start, frames, copied, n)
	}
	for i := range got {
		if math.Float64bits(got[i]) != math.Float64bits(want[i]) {
			t.Fatalf("start=%d frames=%d sample=%d: %016x, want %016x", start, frames, i, math.Float64bits(got[i]), math.Float64bits(want[i]))
		}
	}
}

func TestChannelReadFloat64ArbitraryBlocksAndUnalignedGroups(t *testing.T) {
	var blocks []*Block
	var source []float32
	var boundaries []int64
	for _, frames := range []int{1, 2, 7, 8, 9, 15, 16, 17, 31} {
		boundaries = append(boundaries, int64(len(source)))
		values := readFloat64Pattern(frames)
		block, err := NewBlock(values)
		if err != nil {
			t.Fatal(err)
		}
		blocks = append(blocks, block)
		source = append(source, values...)
	}
	channel, err := NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	// Every short-block boundary is exercised before, exactly at, and after
	// the boundary, with copies around both group8 and group16 tail lengths.
	boundaries = append(boundaries, channel.Frames())
	for _, boundary := range boundaries {
		for _, offset := range []int64{-1, 0, 1, 3} {
			for _, frames := range []int{0, 1, 2, 7, 8, 9, 15, 16, 17, 32, 128} {
				assertReadFloat64Parity(t, channel, boundary+offset, frames)
			}
		}
	}
	// Mutating the widened destination cannot affect immutable float32 samples,
	// including their signaling NaN payloads and signed zeros.
	dst := make([]float64, len(source))
	if n := channel.ReadFloat64(dst, 0); n != len(source) {
		t.Fatal("short whole-channel copy", n)
	}
	clear(dst)
	read := make([]float32, len(source))
	if n := channel.Read(read, 0); n != len(source) {
		t.Fatal("short ownership check", n)
	}
	for i := range source {
		if math.Float32bits(read[i]) != math.Float32bits(source[i]) {
			t.Fatalf("destination changed immutable sample %d", i)
		}
	}
}

func TestChannelReadFloat64FullBlockAndTail(t *testing.T) {
	channel := NewChannel(readFloat64Pattern(BlockFrames + 17))
	for _, tt := range []struct {
		start  int64
		frames int
	}{
		{0, BlockFrames + 32},
		{1, BlockFrames},
		{BlockFrames - 9, 32},
		{BlockFrames - 1, 17},
		{BlockFrames, 8},
		{BlockFrames + 16, 17},
	} {
		assertReadFloat64Parity(t, channel, tt.start, tt.frames)
	}
}

func TestChannelReadFloat64Bounds(t *testing.T) {
	channel := NewChannel(readFloat64Pattern(17))
	for _, current := range []Channel{{}, channel} {
		for _, start := range []int64{math.MinInt64, -1, current.Frames(), current.Frames() + 1, math.MaxInt64} {
			assertReadFloat64Parity(t, current, start, 9)
		}
		if n := current.ReadFloat64(nil, 0); n != 0 {
			t.Fatal("nil destination copied frames", n)
		}
	}
}

func TestChannelReadFloat64OffsetsBeyondInt32(t *testing.T) {
	// Real prefix offsets exceed wasm32 int capacity while samples/peaks retain
	// just one immutable full block. Only local block offsets may narrow to int.
	block, err := NewBlock(readFloat64Pattern(BlockFrames))
	if err != nil {
		t.Fatal(err)
	}
	blocks := make([]*Block, math.MaxInt32/BlockFrames+3)
	for i := range blocks {
		blocks[i] = block
	}
	channel, err := NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	for _, start := range []int64{1<<31 - 9, 1 << 31, 1<<31 + BlockFrames - 9, channel.Frames() - 9} {
		assertReadFloat64Parity(t, channel, start, 32)
	}
}

func TestChannelReadFloat64ZeroAllocations(t *testing.T) {
	channel := NewChannel(readFloat64Pattern(BlockFrames + 17))
	dst := make([]float64, 32)
	if allocations := testing.AllocsPerRun(100, func() { channel.ReadFloat64(dst, BlockFrames-9) }); allocations != 0 {
		t.Fatalf("ReadFloat64 allocated %g times", allocations)
	}
}
