package audiobuf

import (
	"math"
	"math/rand/v2"
	"slices"
	"testing"
)

func testSamples(frames int) []float32 {
	samples := make([]float32, frames)
	for i := range samples {
		samples[i] = float32(i%997) / 997
	}
	if frames > 4 {
		samples[0] = math.Float32frombits(0x80000000) // negative zero
		samples[1] = math.Float32frombits(0x7fc00001) // NaN payload
		samples[2] = math.Float32frombits(0x7f800000) // positive infinity
	}

	return samples
}

func assertSamples(t *testing.T, channel Channel, want []float32) {
	t.Helper()
	if channel.Frames() != int64(len(want)) {
		t.Fatalf("Frames() = %d, want %d", channel.Frames(), len(want))
	}
	got := make([]float32, len(want))
	if n := channel.Read(got, 0); n != len(want) {
		t.Fatalf("Read() = %d, want %d", n, len(want))
	}
	for i := range want {
		if math.Float32bits(got[i]) != math.Float32bits(want[i]) {
			t.Fatalf("sample %d bits = %08x, want %08x", i, math.Float32bits(got[i]), math.Float32bits(want[i]))
		}
	}
}

func TestBlockValidationAndOwnership(t *testing.T) {
	for _, frames := range []int{0, 1, BlockFrames, BlockFrames + 1} {
		block, err := NewBlock(make([]float32, frames))
		valid := frames > 0 && frames <= BlockFrames
		if (err == nil) != valid {
			t.Fatalf("NewBlock(%d): error = %v", frames, err)
		}
		if valid && block.Frames() != frames {
			t.Fatalf("Frames() = %d, want %d", block.Frames(), frames)
		}
	}

	source := []float32{1, 2, 3}
	block, err := NewBlock(source)
	if err != nil {
		t.Fatal(err)
	}
	source[0] = 99
	dst := []float32{-1, -1, -1, -1}
	if n := block.Read(dst, 0); n != 3 || !slices.Equal(dst, []float32{1, 2, 3, -1}) {
		t.Fatalf("Read() = %d, %v", n, dst)
	}
	dst[0] = 99
	if n := block.Read(dst[:1], 0); n != 1 || dst[0] != 1 {
		t.Fatal("read destination aliases block storage")
	}
	for _, start := range []int{-1, 3, 4} {
		if n := block.Read(dst, start); n != 0 {
			t.Fatalf("Read(start=%d) = %d, want 0", start, n)
		}
	}
}

func TestChannelConstruction(t *testing.T) {
	for _, frames := range []int{0, 1, BlockFrames - 1, BlockFrames, BlockFrames + 1, 3*BlockFrames + 17} {
		source := testSamples(frames)
		want := slices.Clone(source)
		channel := NewChannel(source)
		clear(source)
		assertSamples(t, channel, want)
	}

	block, err := NewBlock([]float32{1, 2})
	if err != nil {
		t.Fatal(err)
	}
	blocks := []*Block{block, block}
	channel, err := NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	blocks[0] = nil
	assertSamples(t, channel, []float32{1, 2, 1, 2})
	for _, invalid := range [][]*Block{{nil}, {{}}, {block, nil}} {
		if _, err := NewChannelFromBlocks(invalid); err == nil {
			t.Fatal("invalid block list accepted")
		}
	}
	var empty Channel
	assertSamples(t, empty, nil)
}

func TestChannelRead(t *testing.T) {
	samples := testSamples(2*BlockFrames + 17)
	channel := NewChannel(samples)
	tests := []struct {
		name  string
		start int64
		size  int
		count int
	}{
		{"first", 0, 7, 7},
		{"boundary", BlockFrames, 7, 7},
		{"cross boundary", BlockFrames - 3, 7, 7},
		{"multiple blocks", 4, len(samples), len(samples) - 4},
		{"tail", int64(len(samples) - 3), 7, 3},
		{"negative", -1, 7, 0},
		{"at end", int64(len(samples)), 7, 0},
		{"beyond end", math.MaxInt64, 7, 0},
		{"empty destination", 0, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dst := make([]float32, tt.size)
			for i := range dst {
				dst[i] = -7
			}
			if n := channel.Read(dst, tt.start); n != tt.count {
				t.Fatalf("Read() = %d, want %d", n, tt.count)
			}
			for i := range tt.count {
				if math.Float32bits(dst[i]) != math.Float32bits(samples[int(tt.start)+i]) {
					t.Fatalf("unexpected sample at %d", i)
				}
			}
			for _, sample := range dst[tt.count:] {
				if sample != -7 {
					t.Fatal("Read overwrote destination tail")
				}
			}
		})
	}
	dst := make([]float32, 128)
	if allocs := testing.AllocsPerRun(100, func() { channel.Read(dst, BlockFrames-64) }); allocs != 0 {
		t.Fatalf("Read allocations = %v, want 0", allocs)
	}
}

func TestChannelSliceSharing(t *testing.T) {
	samples := testSamples(3*BlockFrames + 17)
	channel := NewChannel(samples)
	tests := []struct {
		name       string
		start, end int64
		shared     int
	}{
		{"whole", 0, int64(len(samples)), 4},
		{"empty", 5, 5, 0},
		{"aligned", BlockFrames, 3 * BlockFrames, 2},
		{"two partial edges", 1, 3*BlockFrames - 1, 1},
		{"within one block", 7, 17, 0},
		{"partial last block", 3*BlockFrames + 1, int64(len(samples)), 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			part, err := channel.Slice(tt.start, tt.end)
			if err != nil {
				t.Fatal(err)
			}
			assertSamples(t, part, samples[tt.start:tt.end])
			shared := 0
			for _, block := range part.blocks {
				if slices.Contains(channel.blocks, block) {
					shared++
				}
			}
			if shared != tt.shared {
				t.Fatalf("shared blocks = %d, want %d", shared, tt.shared)
			}
		})
	}
	for _, bounds := range [][2]int64{{-1, 0}, {7, 6}, {0, int64(len(samples) + 1)}, {math.MaxInt64, math.MaxInt64}} {
		if _, err := channel.Slice(bounds[0], bounds[1]); err == nil {
			t.Fatalf("invalid slice %v accepted", bounds)
		}
	}
	assertSamples(t, channel, samples)
}

func TestChannelOffsetsBeyondInt32(t *testing.T) {
	// Repeat an immutable block to exercise wasm32-sized offsets while retaining
	// only 256 KiB of samples. Frame offsets must never be narrowed to int.
	samples := testSamples(BlockFrames)
	block, err := NewBlock(samples)
	if err != nil {
		t.Fatal(err)
	}
	blocks := make([]*Block, math.MaxInt32/BlockFrames+2)
	for i := range blocks {
		blocks[i] = block
	}
	channel, err := NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	const start int64 = 1 << 31
	if channel.Frames() != start+BlockFrames {
		t.Fatalf("Frames() = %d, want %d", channel.Frames(), start+BlockFrames)
	}
	part, err := channel.Slice(start, start+17)
	if err != nil {
		t.Fatal(err)
	}
	assertSamples(t, part, samples[:17])
	dst := make([]float32, 17)
	if n := channel.Read(dst, start); n != len(dst) {
		t.Fatalf("Read beyond Int32 = %d, want %d", n, len(dst))
	}
	for i := range dst {
		if math.Float32bits(dst[i]) != math.Float32bits(samples[i]) {
			t.Fatalf("sample %d differs beyond Int32", i)
		}
	}
	joined := channel.Concat(part)
	tail, err := joined.Slice(channel.Frames(), joined.Frames())
	if err != nil {
		t.Fatal(err)
	}
	assertSamples(t, tail, samples[:17])
}

// Deterministic property test: arbitrary slice/concat sequences must reproduce
// a flat reference buffer bit for bit, including special floating-point values.
func TestRandomChannelEdits(t *testing.T) {
	rng := rand.New(rand.NewPCG(42, 7))
	for trial := range 32 {
		original := testSamples(rng.IntN(2*BlockFrames + 1))
		base := NewChannel(original)
		channel, reference := base, slices.Clone(original)
		for step := range 32 {
			start := rng.IntN(len(reference) + 1)
			end := start + rng.IntN(len(reference)-start+1)
			part, err := channel.Slice(int64(start), int64(end))
			if err != nil {
				t.Fatalf("trial %d, step %d: %v", trial, step, err)
			}
			reference = slices.Clone(reference[start:end])
			if rng.IntN(2) == 0 {
				channel = part.Concat(base)
				reference = append(reference, original...)
			} else {
				channel = base.Concat(part)
				reference = append(slices.Clone(original), reference...)
			}
			assertSamples(t, channel, reference)
		}
		assertSamples(t, base, original)
	}
}

func makeDocument(t *testing.T, channels []Channel, rate int, metadata Metadata) Document {
	t.Helper()
	document, err := NewDocument(channels, rate, metadata)
	if err != nil {
		t.Fatal(err)
	}

	return document
}

func TestDocumentValidation(t *testing.T) {
	channel := NewChannel([]float32{1, 2})
	for _, tt := range []struct {
		channels []Channel
		rate     int
	}{
		{nil, 48000},
		{[]Channel{channel}, 0},
		{[]Channel{channel}, -1},
		{[]Channel{channel, {}}, 48000},
	} {
		if _, err := NewDocument(tt.channels, tt.rate, Metadata{}); err == nil {
			t.Fatal("invalid document accepted")
		}
	}
	document := makeDocument(t, []Channel{channel}, 48000, Metadata{})
	for _, index := range []int{-1, 1} {
		if _, err := document.Channel(index); err == nil {
			t.Fatalf("invalid channel %d accepted", index)
		}
	}
	for _, other := range []Document{
		{},
		makeDocument(t, []Channel{channel}, 44100, Metadata{}),
		makeDocument(t, []Channel{channel, channel}, 48000, Metadata{}),
	} {
		if _, err := document.Concat(other); err == nil {
			t.Fatal("incompatible concat accepted")
		}
	}
	var empty Document
	if _, err := empty.Slice(0, 0); err == nil {
		t.Fatal("slice of absent document accepted")
	}
	if empty.Frames() != 0 || empty.Channels() != 0 || empty.SampleRate() != 0 {
		t.Fatal("unexpected zero document format")
	}
}

func TestDocumentSnapshots(t *testing.T) {
	left, right := []float32{1, 2, 3, 4}, []float32{5, 6, 7, 8}
	channels := []Channel{NewChannel(left), NewChannel(right)}
	metadata := Metadata{Name: "original.wav", Tags: map[string]string{"artist": "original"}}
	document := makeDocument(t, channels, 48000, metadata)
	channels[0] = Channel{}
	metadata.Tags["artist"] = "changed"
	gotMetadata := document.Metadata()
	gotMetadata.Tags["artist"] = "changed again"
	if document.Metadata().Tags["artist"] != "original" || document.Metadata().Name != "original.wav" {
		t.Fatal("metadata was mutated through caller storage")
	}
	if document.Frames() != 4 || document.SampleRate() != 48000 || document.Channels() != 2 {
		t.Fatal("unexpected document format")
	}
	part, err := document.Slice(1, 3)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := part.Concat(part)
	if err != nil {
		t.Fatal(err)
	}
	for i, samples := range [][]float32{left, right} {
		original, err := document.Channel(i)
		if err != nil {
			t.Fatal(err)
		}
		assertSamples(t, original, samples)
		channel, err := joined.Channel(i)
		if err != nil {
			t.Fatal(err)
		}
		assertSamples(t, channel, []float32{samples[1], samples[2], samples[1], samples[2]})
	}
	renamed := document.WithMetadata(Metadata{Name: "renamed.wav"})
	if renamed.Metadata().Name != "renamed.wav" || document.Metadata().Name != "original.wav" {
		t.Fatal("WithMetadata mutated the original snapshot")
	}
	if renamed.channels[0].blocks[0] != document.channels[0].blocks[0] {
		t.Fatal("metadata change copied sample storage")
	}
	if _, err := document.Slice(0, 5); err == nil {
		t.Fatal("invalid document slice accepted")
	}
	empty := makeDocument(t, []Channel{{}, {}}, 48000, Metadata{})
	joined, err = empty.Concat(document)
	if err != nil || joined.Frames() != document.Frames() {
		t.Fatalf("empty concat: frames %d, error %v", joined.Frames(), err)
	}
}

func TestMemoryCountsSharedBlocksOnce(t *testing.T) {
	channel := NewChannel(testSamples(2*BlockFrames + 17))
	document := makeDocument(t, []Channel{channel, channel}, 48000, Metadata{})
	part, err := document.Slice(BlockFrames, 2*BlockFrames)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := document.Concat(document)
	if err != nil {
		t.Fatal(err)
	}
	stats := CountMemory(document, part, joined)
	want := MemoryStats{SampleBytes: int64(2*BlockFrames+17) * 4, UniqueBlocks: 3, BlockReferences: 20}
	if stats != want {
		t.Fatalf("CountMemory() = %+v, want %+v", stats, want)
	}
	edge, err := document.Slice(1, 3)
	if err != nil {
		t.Fatal(err)
	}
	stats = CountMemory(document, edge)
	if stats.SampleBytes != want.SampleBytes+16 || stats.UniqueBlocks != 5 || stats.BlockReferences != 8 {
		t.Fatalf("partial edges not counted independently: %+v", stats)
	}
	stats = CountMemory(part)
	if stats.SampleBytes != BlockFrames*4 || stats.UniqueBlocks != 1 || stats.BlockReferences != 2 {
		t.Fatalf("unretained blocks still counted: %+v", stats)
	}
	if stats := CountMemory(Document{}); stats != (MemoryStats{}) {
		t.Fatalf("empty memory = %+v", stats)
	}
}

func BenchmarkChannelRead(b *testing.B) {
	channel := NewChannel(testSamples(2 * BlockFrames))
	dst := make([]float32, 128)
	b.ReportAllocs()
	b.SetBytes(int64(len(dst)) * 4)
	for b.Loop() {
		channel.Read(dst, BlockFrames-64)
	}
}

func BenchmarkChannelSlice(b *testing.B) {
	// One hour at 48 kHz: reuse one immutable block to avoid a 659 MiB fixture.
	block, err := NewBlock(make([]float32, BlockFrames))
	if err != nil {
		b.Fatal(err)
	}
	blocks := make([]*Block, 48000*3600/BlockFrames)
	for i := range blocks {
		blocks[i] = block
	}
	channel, err := NewChannelFromBlocks(blocks)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := channel.Slice(1, channel.Frames()-1); err != nil {
			b.Fatal(err)
		}
	}
}
