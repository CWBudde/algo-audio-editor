// Package testaudio builds bounded-memory codec acceptance fixtures.
package testaudio

import (
	"fmt"
	"io"

	"github.com/cwbudde/flac"
	"github.com/cwbudde/flac/frame"
	"github.com/cwbudde/flac/meta"
)

// Fixture constants define sample rate, block size and the one-hour frame count.
const (
	// SampleRate sets the generated FLAC fixture sample rate.
	SampleRate        = 48000
	BlockFrames       = 4096
	HourFrames  int64 = SampleRate * 3600
)

// Sample is a 24-bit integer reference. Channels differ and every FLAC block
// changes value, exposing channel swaps, missing frames and boundary mistakes.
func Sample(position int64, channel int) int32 {
	value := int32((position / BlockFrames) % 256)
	if channel == 0 {
		return (value - 128) * 16384
	}
	return (127-value)*8192 + 17
}

// WriteFLAC encodes real stereo PCM using constant subframes and a complete
// STREAMINFO sample count/MD5. It holds just one 4096-frame block per channel.
// The caller retains ownership of the output writer.
func WriteFLAC(output io.WriteSeeker, frames int64) error {
	if frames < 1 || frames > HourFrames {
		return fmt.Errorf("testaudio.flac: frames must be in [1, %d]", HourFrames)
	}
	encoder, err := flac.NewEncoder(struct{ io.WriteSeeker }{output}, &meta.StreamInfo{
		SampleRate: SampleRate, NChannels: 2, BitsPerSample: 24,
		BlockSizeMin: BlockFrames, BlockSizeMax: BlockFrames,
	})
	if err != nil {
		return fmt.Errorf("testaudio.flac: create encoder: %w", err)
	}
	pcm := [2][]int32{make([]int32, BlockFrames), make([]int32, BlockFrames)}
	for start := int64(0); start < frames; start += BlockFrames {
		count := int(min(int64(BlockFrames), frames-start))
		f := &frame.Frame{Header: frame.Header{
			BlockSize: uint16(count), SampleRate: SampleRate, // #nosec G115 -- count is min(BlockFrames, remaining), with BlockFrames=4096 and remaining positive.
			BitsPerSample: 24, Channels: frame.ChannelsLR,
		}}
		for channel := range pcm {
			for i := range count {
				pcm[channel][i] = Sample(start+int64(i), channel)
			}
			f.Subframes = append(f.Subframes, &frame.Subframe{
				SubHeader: frame.SubHeader{Pred: frame.PredConstant},
				Samples:   pcm[channel][:count], NSamples: count,
			})
		}
		if err := encoder.WriteFrame(f); err != nil {
			return fmt.Errorf("testaudio.flac: frame %d: %w", start, err)
		}
	}
	if err := encoder.Close(); err != nil {
		return fmt.Errorf("testaudio.flac: finish: %w", err)
	}
	return nil
}
