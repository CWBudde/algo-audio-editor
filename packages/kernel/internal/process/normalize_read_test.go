package process

import (
	"fmt"
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
)

func TestNormalizeLoudnessDirectAndFragmentedReadParity(t *testing.T) {
	const frames = 2*audiobuf.BlockFrames + 31
	for _, count := range []int{1, 2, 8} {
		t.Run(fmt.Sprintf("%d channels", count), func(t *testing.T) {
			input := make([][]float32, count)
			fragmented := make([]audiobuf.Channel, count)
			for channel := range input {
				input[channel] = normalizeTone(frames, 0.25+float64(channel)/32)
				input[channel][19] = math.Float32frombits(0x80000000)
				cut := 7000 + channel*17
				fragmented[channel] = audiobuf.NewChannel(input[channel][:cut]).Concat(audiobuf.NewChannel(input[channel][cut:]))
			}
			source := fixture(t, input...)
			fragmentedSource, err := audiobuf.NewDocument(fragmented, 48000, source.Metadata())
			if err != nil {
				t.Fatal(err)
			}
			// Unaligned selection also makes verification cross retained-prefix /
			// newly rendered block boundaries. For eight channels, pack only the
			// first and last channels; all others must remain exact identities.
			mask := 1 | 1<<(count-1)
			selected := ops.Range{Start: 17, End: frames - 13, ChannelMask: mask}
			direct, err := NewNormalizer(source, selected, "normalize-loudness", -23, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			copied, err := NewNormalizer(fragmentedSource, selected, "normalize-loudness", -23, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			got, want := finishNormalizer(t, direct), finishNormalizer(t, copied)
			if !reflect.DeepEqual(direct.Status(), copied.Status()) || direct.Status().OutputLUFS == nil || math.Abs(*direct.Status().OutputLUFS+23) > 0.01 {
				t.Fatal("read geometry changed the linked plan or actual stored-output measurement", direct.Status(), copied.Status())
			}
			for channel := range input {
				assertBits(t, samples(t, got, channel), samples(t, want, channel))
				assertBits(t, samples(t, source, channel), input[channel])
				assertBits(t, samples(t, fragmentedSource, channel), input[channel])
				if mask&(1<<channel) == 0 {
					assertBits(t, samples(t, got, channel), input[channel])
				}
			}
			if !reflect.DeepEqual(got.Metadata(), source.Metadata()) || !reflect.DeepEqual(want.Metadata(), source.Metadata()) {
				t.Fatal("read geometry changed document metadata")
			}
		})
	}
}
