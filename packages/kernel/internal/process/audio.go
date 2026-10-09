package process

import (
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-dsp/dsp/core"
	"github.com/cwbudde/algo-dsp/dsp/resample"
	"github.com/cwbudde/algo-dsp/dsp/signal"
)

// Supplied audio (synthesized speech) may come at any common rate.
const (
	MinAudioRate = 8000
	MaxAudioRate = 384000
)

// prepareAudio validates the audio generator's mono samples and converts
// them to the document rate. The result is owned by the operation; the
// supplied slice is not retained when it is resampled.
func prepareAudio(settings Settings, rate int, limits Limits) ([]float32, error) {
	if len(settings.Audio) == 0 {
		return nil, fmt.Errorf("process.new: audio generator needs samples")
	}
	if settings.AudioRate < MinAudioRate || settings.AudioRate > MaxAudioRate {
		return nil, fmt.Errorf("process.new: audio rate must be in [%d, %d] Hz", MinAudioRate, MaxAudioRate)
	}
	for _, v := range settings.Audio {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return nil, fmt.Errorf("process.new: audio samples must be finite")
		}
	}
	if settings.AudioRate == rate {
		return settings.Audio, nil
	}
	frames, err := resample.FrameCount(int64(len(settings.Audio)), settings.AudioRate, rate)
	if err != nil {
		return nil, fmt.Errorf("process.new: resample audio: %w", err)
	}
	// The float64 working copies cost four times the float32 result.
	if err := outputBudget(frames, 4, limits); err != nil {
		return nil, fmt.Errorf("process.new: resample audio: %w", err)
	}
	in := make([]float64, len(settings.Audio))
	for i, v := range settings.Audio {
		in[i] = float64(v)
	}
	out, err := resample.ResampleAligned(in, float64(settings.AudioRate), float64(rate), resample.WithQuality(resample.QualityBalanced))
	if err != nil {
		return nil, fmt.Errorf("process.new: resample audio: %w", err)
	}
	audio := make([]float32, len(out))
	for i, v := range out {
		audio[i] = float32(v)
	}
	return audio, nil
}

// renderAudio copies the next count frames of the supplied audio, scaled by
// the generator level, into the scratch block; frames past its end (a
// partial-channel region padded to the selection) are silent.
func (b *blockOperation) renderAudio(count int) error {
	offset := min(b.progress.FramesDone, int64(len(b.audio)))
	n := copy(b.mono[:count], b.audio[offset:])
	clear(b.mono[n:count])
	if b.settings.LevelDB == 0 {
		return nil
	}
	return signal.ScaleInto32(b.mono[:count], b.mono[:count], core.DBToLinear(b.settings.LevelDB))
}

// partialRegion is the frames a selection on only some channels keeps:
// the speech may be shorter, but the other channels keep their audio there,
// so the region never shrinks. Whole-channel selections and inserts take
// the speech length alone.
func (b *blockOperation) partialRegion(document audiobuf.Document) int64 {
	if b.selected.ChannelMask == (1<<document.Channels())-1 {
		return 0
	}
	return b.selected.End - b.selected.Start
}
