package audiobuf

import (
	"errors"
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-dsp/measure/loudness"
)

func readerAnalyzer(t *testing.T, channels int, frames int64) *loudness.TargetAnalyzer {
	t.Helper()
	analyzer, err := loudness.NewTargetAnalyzer(loudness.IntegratedConfig{SampleRate: 48000, Channels: channels, MaxFrames: frames}, -23)
	if err != nil {
		t.Fatal(err)
	}
	return analyzer
}

func finishReaderMeasurement(t *testing.T, analyzer *loudness.TargetAnalyzer) loudness.IntegratedResult {
	t.Helper()
	for attempts := 0; attempts < 1000; attempts++ {
		done, err := analyzer.FinishMeasurementStep(7)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			result, err := analyzer.MeasurementResult()
			if err != nil {
				t.Fatal(err)
			}
			return result
		}
	}
	t.Fatal("bounded measurement did not finish")
	return loudness.IntegratedResult{}
}

func readerProgram(channels, frames int) [][]float32 {
	program := make([][]float32, channels)
	for channel := range program {
		program[channel] = make([]float32, frames)
		for frame := range program[channel] {
			program[channel][frame] = float32(frame%(31+channel*2)-(15+channel)) / 128
		}
	}
	return program
}

func assertFeedViewsCleared(t *testing.T, buffer *TargetFeedBuffer) {
	t.Helper()
	for _, view := range buffer.views {
		if view != nil {
			t.Fatal("descriptor buffer retained an immutable source view")
		}
	}
}

func TestFeedTargetAnalyzerContiguousUnalignedAndPackedChannelParity(t *testing.T) {
	var buffer TargetFeedBuffer
	const frames = 24000
	const offset = 17
	for _, count := range []int{1, 2, 8} {
		input := readerProgram(count, frames+offset+23)
		input[count-1][offset+3] = math.Float32frombits(0x80000000)
		input[count-1][0] = math.Float32frombits(0x7f812345)
		input[0][len(input[0])-1] = float32(math.Inf(1))
		channels := make([]Channel, count)
		weights := make([]float64, count)
		for i := range channels {
			// Reverse source order makes preserving packed channel order explicit.
			channels[i] = NewChannel(input[count-i-1])
			weights[i] = float64(i+1) / 4
		}
		if count > 1 {
			// Zero-weight channels still belong to the exact peak proof.
			weights[0] = 0
			input[count-1][offset+5] = .99
			channels[0] = NewChannel(input[count-1])
		}
		config := loudness.IntegratedConfig{SampleRate: 48000, Channels: count, MaxFrames: frames, ChannelWeights: weights}
		analyzer, err := loudness.NewTargetAnalyzer(config, -23)
		if err != nil {
			t.Fatal(err)
		}
		copied, err := loudness.NewTargetAnalyzer(config, -23)
		if err != nil {
			t.Fatal(err)
		}
		for processed := 0; processed < frames; {
			chunk := min([]int{113, 4096, 257, 8192}[processed%4], frames-processed)
			fed, err := buffer.Feed(analyzer, channels, int64(offset+processed), chunk)
			if err != nil || !fed {
				t.Fatal("contiguous internal block views were not fed", fed, err)
			}
			assertFeedViewsCleared(t, &buffer)
			block := make([][]float32, count)
			for i, channel := range channels {
				block[i] = make([]float32, chunk)
				if channel.Read(block[i], int64(offset+processed)) != chunk {
					t.Fatal("copied reference read failed")
				}
			}
			if err := copied.ProcessPlanar32(block); err != nil {
				t.Fatal(err)
			}
			if analyzer.SamplePeak() != copied.SamplePeak() {
				t.Fatal("direct read changed progressive finite peak")
			}
			processed += chunk
		}
		if got, want := finishReaderMeasurement(t, analyzer), finishReaderMeasurement(t, copied); !reflect.DeepEqual(got, want) {
			t.Fatal("direct views changed exact filter/window/measurement bits", got, want)
		}
		for i, channel := range channels {
			read := make([]float32, len(input[0]))
			channel.Read(read, 0)
			for frame := range read {
				if math.Float32bits(read[frame]) != math.Float32bits(input[count-i-1][frame]) {
					t.Fatal("trusted concrete analyzer changed immutable source samples")
				}
			}
		}
	}
}

func TestFeedTargetAnalyzerGeometryFallbackIsAtomicAcrossChannels(t *testing.T) {
	var buffer TargetFeedBuffer
	const frames = 19200
	input := readerProgram(2, frames)
	first := NewChannel(input[0])
	second := NewChannel(input[1][:7000]).Concat(NewChannel(input[1][7000:]))
	analyzer := readerAnalyzer(t, 2, frames)
	if fed, err := buffer.Feed(analyzer, []Channel{first, second}, 0, frames); err != nil || fed || analyzer.SamplePeak() != 0 {
		t.Fatal("block-spanning channel partially advanced analyzer", fed, err)
	}
	assertFeedViewsCleared(t, &buffer)
	// Complete fallback can use the same still-pristine analyzer. If any first
	// channel had advanced it, this input would violate MaxFrames or change bits.
	if err := analyzer.ProcessPlanar32(input); err != nil {
		t.Fatal(err)
	}
	reference := readerAnalyzer(t, 2, frames)
	if err := reference.ProcessPlanar32(input); err != nil {
		t.Fatal(err)
	}
	if got, want := finishReaderMeasurement(t, analyzer), finishReaderMeasurement(t, reference); !reflect.DeepEqual(got, want) {
		t.Fatal("geometry fallback consumed input before returning false")
	}
	// A fallback in an earlier channel must not conceal invalid later geometry.
	invalid := readerAnalyzer(t, 2, frames)
	if fed, err := buffer.Feed(invalid, []Channel{second, NewChannel(input[0][:frames-1])}, 0, frames); err == nil || fed || invalid.SamplePeak() != 0 {
		t.Fatal("early geometry fallback hid an invalid later channel", fed, err)
	}
	assertFeedViewsCleared(t, &buffer)
}

func TestFeedTargetAnalyzerInvalidArgumentsAndConfiguredLayout(t *testing.T) {
	var buffer TargetFeedBuffer
	channels := []Channel{NewChannel(readerProgram(1, 19200)[0])}
	analyzer := readerAnalyzer(t, 1, 19200)
	for _, test := range []struct {
		analyzer *loudness.TargetAnalyzer
		channels []Channel
		start    int64
		frames   int
	}{
		{nil, channels, 0, 1},
		{analyzer, nil, 0, 1},
		{analyzer, make([]Channel, 9), 0, 1},
		{analyzer, channels, -1, 1},
		{analyzer, channels, 0, 0},
		{analyzer, channels, 0, -1},
		{analyzer, channels, 0, BlockFrames + 1},
		{analyzer, channels, 0, 19201},
		{analyzer, channels, 19200, 1},
		{analyzer, channels, math.MaxInt64, 1},
		{analyzer, []Channel{{}}, 0, 1},
	} {
		buffer.views[0] = channels[0].blocks[0].samples
		if fed, err := buffer.Feed(test.analyzer, test.channels, test.start, test.frames); err == nil || fed || analyzer.SamplePeak() != 0 {
			t.Fatal("invalid geometry mutated analyzer or succeeded", fed, err)
		}
		assertFeedViewsCleared(t, &buffer)
	}
	// The concrete analyzer additionally validates its configured packed layout.
	if fed, err := buffer.Feed(analyzer, []Channel{channels[0], channels[0]}, 0, 19200); err == nil || fed || analyzer.SamplePeak() != 0 {
		t.Fatal("configured layout mismatch advanced analyzer", fed, err)
	}
	assertFeedViewsCleared(t, &buffer)
	if fed, err := buffer.Feed(analyzer, channels, 0, 19200); err != nil || !fed {
		t.Fatal("invalid calls prevented a later valid input", fed, err)
	}
	assertFeedViewsCleared(t, &buffer)
	var missing *TargetFeedBuffer
	if fed, err := missing.Feed(analyzer, channels, 0, 1); fed || err == nil {
		t.Fatal("missing feed buffer accepted")
	}
	if result := finishReaderMeasurement(t, analyzer); result.Frames != 19200 {
		t.Fatal("invalid calls changed total consumed frames")
	}
}

func TestFeedTargetAnalyzerNonfinitePreflightAndResetNeverAliasesSource(t *testing.T) {
	var buffer TargetFeedBuffer
	const frames = 19200
	for _, bits := range []uint32{0x7f812345, 0xffc54321, 0x7f800000, 0xff800000} {
		input := readerProgram(2, frames)
		input[1][55] = math.Float32frombits(bits)
		channels := []Channel{NewChannel(input[0]), NewChannel(input[1])}
		analyzer := readerAnalyzer(t, 2, frames)
		if fed, err := buffer.Feed(analyzer, channels, 0, frames); fed || !errors.Is(err, loudness.ErrNonFinite) || analyzer.SamplePeak() != 0 {
			t.Fatal("later selected nonfinite input partially advanced analyzer", fed, err)
		}
		assertFeedViewsCleared(t, &buffer)
		// Reset and subsequent processing cannot retain/mutate the previous views.
		analyzer.Reset()
		valid := readerProgram(2, frames)
		validChannels := []Channel{NewChannel(valid[0]), NewChannel(valid[1])}
		if fed, err := buffer.Feed(analyzer, validChannels, 0, frames); err != nil || !fed {
			t.Fatal(err)
		}
		assertFeedViewsCleared(t, &buffer)
		before := finishReaderMeasurement(t, analyzer)
		valid[0][55] = 99 // caller arrays cannot alias NewChannel's storage.
		analyzer.Reset()
		if fed, err := buffer.Feed(analyzer, validChannels, 0, frames); err != nil || !fed {
			t.Fatal(err)
		}
		assertFeedViewsCleared(t, &buffer)
		if after := finishReaderMeasurement(t, analyzer); !reflect.DeepEqual(after, before) {
			t.Fatal("input retention or caller storage alias changed a later stream")
		}
		analyzer.Reset()
		read := make([]float32, 1)
		channels[1].Read(read, 55)
		if math.Float32bits(read[0]) != bits || math.Float32bits(input[1][55]) != bits {
			t.Fatal("processing/Reset rewrote source NaN/Inf payloads")
		}
		validChannels[0].Read(read, 55)
		if read[0] == 99 {
			t.Fatal("caller input accessor mutated immutable block storage")
		}
	}
}

func TestFeedTargetAnalyzerHotPathAllocatesNothing(t *testing.T) {
	var buffer TargetFeedBuffer
	input := readerProgram(2, 4096)
	channels := []Channel{NewChannel(input[0]), NewChannel(input[1])}
	analyzer := readerAnalyzer(t, 2, 4096)
	if allocations := testing.AllocsPerRun(50, func() {
		analyzer.Reset()
		if fed, err := buffer.Feed(analyzer, channels, 0, 4096); err != nil || !fed {
			panic("validated direct input failed")
		}
	}); allocations != 0 {
		t.Fatalf("direct internal sample views allocated %g times", allocations)
	}
	assertFeedViewsCleared(t, &buffer)
}

func TestFeedStoredCandidateBlocksExactMeasurementAndAtomicRejection(t *testing.T) {
	var buffer TargetFeedBuffer
	const frames = 24000
	input := readerProgram(2, frames)
	blocks := make([]*Block, 2)
	for channel := range blocks {
		var err error
		blocks[channel], err = NewBlock(input[channel])
		if err != nil {
			t.Fatal(err)
		}
	}
	analyzer, reference := readerAnalyzer(t, 2, frames), readerAnalyzer(t, 2, frames)
	if err := buffer.FeedBlocks(analyzer, blocks); err != nil {
		t.Fatal(err)
	}
	assertFeedViewsCleared(t, &buffer)
	if err := reference.ProcessPlanar32(input); err != nil {
		t.Fatal(err)
	}
	if got, want := finishReaderMeasurement(t, analyzer), finishReaderMeasurement(t, reference); !reflect.DeepEqual(got, want) {
		t.Fatal("stored candidate scan differs from copied actual reference", got, want)
	}
	for _, special := range []uint32{0x7f812345, 0xff800000} {
		bad := append([]float32(nil), input[1]...)
		bad[31] = math.Float32frombits(special)
		badBlock, err := NewBlock(bad)
		if err != nil {
			t.Fatal(err)
		}
		analyzer.Reset()
		if err := buffer.FeedBlocks(analyzer, []*Block{blocks[0], badBlock}); !errors.Is(err, loudness.ErrNonFinite) || analyzer.SamplePeak() != 0 {
			t.Fatalf("later unsafe candidate channel advanced actual meter: %v", err)
		}
		assertFeedViewsCleared(t, &buffer)
		got := make([]float32, frames)
		badBlock.Read(got, 0)
		if math.Float32bits(got[31]) != special {
			t.Fatal("candidate scan changed IEEE payload")
		}
		analyzer.Reset()
		if err := buffer.FeedBlocks(analyzer, blocks); err != nil {
			t.Fatal(err)
		}
		if got, want := finishReaderMeasurement(t, analyzer), finishReaderMeasurement(t, reference); !reflect.DeepEqual(got, want) {
			t.Fatal("unsafe candidate views remained after Reset")
		}
	}
}

func TestFeedStoredBlocksInvalidGeometryClearsViews(t *testing.T) {
	var buffer TargetFeedBuffer
	block, err := NewBlock([]float32{1, 2})
	if err != nil {
		t.Fatal(err)
	}
	short, err := NewBlock([]float32{1})
	if err != nil {
		t.Fatal(err)
	}
	analyzer := readerAnalyzer(t, 2, 24000)
	for _, blocks := range [][]*Block{nil, {nil}, {block, nil}, {block, short}, {{}}, make([]*Block, 9)} {
		buffer.views[0] = block.samples
		if err := buffer.FeedBlocks(analyzer, blocks); err == nil || analyzer.SamplePeak() != 0 {
			t.Fatal("invalid stored geometry advanced meter")
		}
		assertFeedViewsCleared(t, &buffer)
	}
	if err := buffer.FeedBlocks(nil, []*Block{block}); err == nil {
		t.Fatal("missing candidate meter accepted")
	}
	var absent *TargetFeedBuffer
	if err := absent.FeedBlocks(analyzer, []*Block{block}); err == nil {
		t.Fatal("missing descriptor buffer accepted")
	}
}
