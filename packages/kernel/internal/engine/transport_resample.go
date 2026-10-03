package engine

import (
	"fmt"
	"math"

	"github.com/cwbudde/algo-dsp/dsp/resample"
)

// Bound workspaces before designing exact-ratio filters. Some uncommon integer
// rate pairs have enormous reduced numerators and cannot fit a browser worker.
const maxResampleWorkspaceBytes int64 = 64 << 20

type documentResampler struct {
	streams              []*resample.Resampler
	input, output        [][]float64
	inRate, outRate      int64
	readFrame            int64
	flushRemaining       int64
	remainingOutput      int64
	tagRemainder         int64
	skip                 int
	stageStart, stageEnd int
}

func newDocumentResampler(t *documentTransport, inRate, outRate int) (*documentResampler, error) {
	if inRate < MinSampleRate || inRate > MaxSampleRate || outRate < MinSampleRate || outRate > MaxSampleRate {
		return nil, fmt.Errorf("resample.prepare: rates %d/%d outside [%d, %d]", inRate, outRate, MinSampleRate, MaxSampleRate)
	}
	g := rateGCD(inRate, outRate)
	up, down := outRate/g, inRate/g
	// Keep anti-alias transition width consistent when downsampling: the
	// upstream prototype is tapsPerPhase*up, so down/up needs longer branches.
	tapsPerPhase := resample.QualityProfile(resample.QualityBalanced).TapsPerPhase * ((down + up - 1) / up)
	capacity := (transportBlockFrames*outRate+inRate-1)/inRate + 1
	coefficientBytes := int64(tapsPerPhase)*int64(up)*16 + int64(up)*32
	channelBytes := int64(len(t.channels)) * int64(tapsPerPhase+transportBlockFrames+capacity) * 8
	if coefficientBytes+channelBytes > maxResampleWorkspaceBytes {
		return nil, fmt.Errorf("resample.prepare: exact rate ratio %d/%d needs approximately %d bytes, exceeding the %d-byte worker workspace limit", up, down, coefficientBytes+channelBytes, maxResampleWorkspaceBytes)
	}
	base, err := resample.NewRational(up, down, resample.WithTapsPerPhase(tapsPerPhase))
	if err != nil {
		return nil, fmt.Errorf("resample.prepare: design filter: %w", err)
	}
	r := &documentResampler{
		streams: make([]*resample.Resampler, len(t.channels)),
		input:   make([][]float64, len(t.channels)), output: make([][]float64, len(t.channels)),
		inRate: int64(inRate), outRate: int64(outRate), readFrame: t.position,
		skip:            int(math.Ceil(base.GroupDelayOutput())),
		remainingOutput: convertedFrameCount(t.end-t.position, int64(inRate), int64(outRate)),
	}
	// Feeding explicit zero frames recovers the delayed final samples. Output
	// is trimmed to the exact source duration after the leading delay is removed.
	r.flushRemaining = (int64(r.skip)*int64(inRate)+int64(outRate)-1)/int64(outRate) + 1
	for channel := range r.streams {
		if channel == 0 {
			r.streams[channel] = base
		} else {
			r.streams[channel] = base.Clone()
		}
		r.input[channel] = make([]float64, transportBlockFrames)
		r.output[channel] = make([]float64, capacity)
	}
	return r, nil
}

// Split quotient/remainder first so long documents do not overflow frames*rate.
func convertedFrameCount(frames, inRate, outRate int64) int64 {
	return (frames/inRate)*outRate + ((frames%inRate)*outRate+inRate-1)/inRate
}

func rateGCD(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func (r *documentResampler) prepareStage(t *documentTransport) bool {
	count := transportBlockFrames
	zeros := !t.loop && r.readFrame == t.end
	if zeros {
		if r.flushRemaining == 0 {
			return false
		}
		count = int(min(int64(count), r.flushRemaining))
		r.flushRemaining -= int64(count)
	} else if !t.loop {
		count = int(min(int64(count), t.end-r.readFrame))
	}
	for channel, samples := range t.channels {
		input := r.input[channel][:count]
		if zeros {
			clear(input)
			continue
		}
		cursor, copied := r.readFrame, 0
		for copied < count {
			n := int(min(int64(count-copied), t.end-cursor))
			samples.Read(t.mono[:n], cursor)
			for frame := range n {
				input[copied+frame] = float64(t.mono[frame])
			}
			copied += n
			cursor += int64(n)
			if cursor == t.end && t.loop {
				cursor = t.start
			}
		}
	}
	if !zeros {
		r.readFrame += int64(count)
		if t.loop && r.readFrame >= t.end {
			r.readFrame = t.start + (r.readFrame-t.start)%(t.end-t.start)
		}
	}
	n := 0
	for channel, stream := range r.streams {
		written, err := stream.ProcessInto(r.output[channel], r.input[channel][:count])
		if err != nil || (channel > 0 && written != n) {
			// Workspace bounds and identical channel clocks make this impossible
			// for valid upstream state. Fail silent instead of emitting stale data.
			return false
		}
		n = written
	}
	r.stageEnd = n
	r.stageStart = min(n, r.skip)
	r.skip -= r.stageStart
	return true
}

func (t *documentTransport) renderResampled(dst []float32, positions []int64) int {
	r := t.resampled
	frames, written := len(dst)/len(t.channels), 0
	for written < frames && t.playing {
		if r.stageStart == r.stageEnd {
			if !r.prepareStage(t) {
				t.playing = false
				break
			}
			if r.stageStart == r.stageEnd {
				continue
			}
		}
		count := min(frames-written, r.stageEnd-r.stageStart)
		if !t.loop {
			count = int(min(int64(count), r.remainingOutput))
		}
		for frame := range count {
			for channel := range t.channels {
				dst[(written+frame)*len(t.channels)+channel] = float32(r.output[channel][r.stageStart+frame])
			}
			r.tagRemainder += r.inRate
			t.position += r.tagRemainder / r.outRate
			r.tagRemainder %= r.outRate
			if t.loop {
				if t.position >= t.end {
					t.position = t.start + (t.position-t.start)%(t.end-t.start)
				}
			} else {
				r.remainingOutput--
				if r.remainingOutput == 0 {
					t.position = t.end
					t.playing = false
				}
			}
			if positions != nil {
				positions[written+frame] = t.position
			}
		}
		r.stageStart += count
		written += count
	}
	return written
}
