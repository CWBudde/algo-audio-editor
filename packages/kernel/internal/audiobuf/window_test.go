package audiobuf

import (
	"math"
	"testing"
)

func TestWindowRetainsOnlyTouchedBlocksWithoutCopies(t *testing.T) {
	channel := NewChannel(make([]float32, 4*BlockFrames))
	channel.blocks[1].samples[BlockFrames-1] = math.Float32frombits(0x7f801234)
	channel.blocks[2].samples[0] = math.Float32frombits(0x80000000)
	window, err := channel.Window(2*BlockFrames-1, 2*BlockFrames+1)
	if err != nil {
		t.Fatal(err)
	}
	if window.Frames() != 2 || len(window.channel.blocks) != 2 || window.channel.blocks[0] != channel.blocks[1] || window.channel.blocks[1] != channel.blocks[2] {
		t.Fatal("window copied samples or retained unrelated blocks")
	}
	stats := CountMemoryWithWindows(nil, window)
	if stats.UniqueBlocks != 2 || stats.SampleBytes != 2*BlockFrames*4 || stats.PeakBytes != 2*273*peakSummaryBytes {
		t.Fatalf("window accounting %+v", stats)
	}
	document, err := NewDocument([]Channel{channel}, 48000, Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	combined := CountMemoryWithWindows([]Document{document}, window, window)
	if combined.UniqueBlocks != 4 || combined.BlockReferences != 8 || combined.SampleBytes != 4*BlockFrames*4 {
		t.Fatalf("deduplicated document/window accounting %+v", combined)
	}
	got := []float32{123, 123, 123}
	if n := window.Read(got, 0); n != 2 || math.Float32bits(got[0]) != 0x7f801234 || math.Float32bits(got[1]) != 0x80000000 || got[2] != 123 {
		t.Fatalf("window read %v", got)
	}
	got[0] = 99
	if window.Read(got[:1], 0) != 1 || math.Float32bits(got[0]) != 0x7f801234 {
		t.Fatal("window exposes mutable backing samples")
	}
	materialized, err := window.Materialize()
	if err != nil || materialized.Frames() != 2 || len(materialized.blocks) != 2 || materialized.blocks[0] == window.channel.blocks[0] || materialized.blocks[1] == window.channel.blocks[1] {
		t.Fatalf("partial boundaries not materialized independently: %v", err)
	}
	full, err := channel.Window(BlockFrames, 3*BlockFrames)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := full.Materialize()
	if err != nil || shared.blocks[0] != channel.blocks[1] || shared.blocks[1] != channel.blocks[2] {
		t.Fatalf("whole window blocks not shared: %v", err)
	}
}

func TestWindowValidationAndBoundedRead(t *testing.T) {
	channel := NewChannel([]float32{1, 2, 3, 4})
	for _, bounds := range [][2]int64{{-1, 2}, {3, 2}, {0, 5}, {0, math.MaxInt64}} {
		if _, err := channel.Window(bounds[0], bounds[1]); err == nil {
			t.Fatalf("invalid bounds accepted %v", bounds)
		}
	}
	for _, bounds := range [][2]int64{{0, 0}, {4, 4}, {1, 3}} {
		window, err := channel.Window(bounds[0], bounds[1])
		if err != nil {
			t.Fatal(err)
		}
		for _, start := range []int64{-1, window.Frames(), math.MaxInt64} {
			dst := []float32{99}
			if n := window.Read(dst, start); n != 0 || dst[0] != 99 {
				t.Fatalf("invalid window read %d", start)
			}
		}
		if window.Read(nil, 0) != 0 {
			t.Fatal("empty destination read frames")
		}
		part, err := window.Materialize()
		if err != nil || part.Frames() != bounds[1]-bounds[0] {
			t.Fatalf("materialized duration %d, %v", part.Frames(), err)
		}
	}
}

func TestSilenceSharesFullBlocks(t *testing.T) {
	channel, err := NewSilence(3*BlockFrames + 17)
	if err != nil || len(channel.blocks) != 4 || channel.blocks[0] != channel.blocks[1] || channel.blocks[0] != channel.blocks[2] || channel.blocks[3].Frames() != 17 {
		t.Fatalf("silence block sharing %v", err)
	}
	assertSamples(t, channel, make([]float32, 3*BlockFrames+17))
	for _, frames := range []int64{-1, 1 << 53, (1<<20)*BlockFrames + 1} {
		if _, err := NewSilence(frames); err == nil {
			t.Fatalf("invalid/unreasonable silence duration accepted %d", frames)
		}
	}
	if empty, err := NewSilence(0); err != nil || empty.Frames() != 0 {
		t.Fatalf("zero silence %v", err)
	}
}
