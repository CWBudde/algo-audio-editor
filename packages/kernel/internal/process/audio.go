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
	if err := outputBudget(frames, 1, limits); err != nil {
		return nil, fmt.Errorf("process.new: resample audio: %w", err)
	}
	// The resample operation's bounded stream, so the kernel links no second
	// resampler: chunks of input never produce more than one block.
	plan, err := resample.NewStreamPlan(settings.AudioRate, rate, audiobuf.BlockFrames, resample.QualityBalanced)
	if err != nil {
		return nil, fmt.Errorf("process.new: resample audio: %w", err)
	}
	chunk, err := plan.InputFramesForOutputLimit(audiobuf.BlockFrames)
	if err != nil {
		return nil, fmt.Errorf("process.new: resample audio: %w", err)
	}
	if plan, err = resample.NewStreamPlan(settings.AudioRate, rate, chunk, resample.QualityBalanced); err != nil {
		return nil, fmt.Errorf("process.new: resample audio: %w", err)
	}
	stream, err := plan.NewStream(int64(len(settings.Audio)))
	if err != nil {
		return nil, fmt.Errorf("process.new: resample audio: %w", err)
	}
	audio := make([]float32, 0, frames)
	in, out := make([]float64, chunk), make([]float64, audiobuf.BlockFrames)
	keep := func(n int) {
		for _, v := range out[:n] {
			audio = append(audio, float32(v))
		}
	}
	for offset := 0; offset < len(settings.Audio); offset += chunk {
		n := min(chunk, len(settings.Audio)-offset)
		for i, v := range settings.Audio[offset : offset+n] {
			in[i] = float64(v)
		}
		written, err := stream.ProcessInto(out, in[:n])
		if err != nil {
			return nil, fmt.Errorf("process.new: resample audio: %w", err)
		}
		keep(written)
	}
	for !stream.Done() {
		written, _, err := stream.FlushInto(out)
		if err != nil {
			return nil, fmt.Errorf("process.new: resample audio: %w", err)
		}
		keep(written)
	}
	if int64(len(audio)) != frames {
		return nil, fmt.Errorf("process.new: resample audio: produced %d of %d frames", len(audio), frames)
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
