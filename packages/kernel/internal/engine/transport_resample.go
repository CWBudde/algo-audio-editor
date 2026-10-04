package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/effects"
	"github.com/cwbudde/algo-dsp/dsp/resample"
)

// Bound workspaces before designing exact-ratio filters. Some uncommon integer
// rate pairs have enormous reduced numerators and cannot fit a browser worker.
const maxResampleWorkspaceBytes int64 = 64 << 20

type documentResampler struct {
	streams              []*resample.Stream
	input, output        [][]float64
	inRate, outRate      int64
	readFrame            int64
	remainingOutput      int64
	tagRemainder         int64
	stageStart, stageEnd int
}

func newDocumentResampler(t *documentTransport, inRate, outRate int) (*documentResampler, error) {
	if inRate < MinSampleRate || inRate > MaxSampleRate || outRate < MinSampleRate || outRate > MaxSampleRate {
		return nil, fmt.Errorf("resample.prepare: rates %d/%d outside [%d, %d]", inRate, outRate, MinSampleRate, MaxSampleRate)
	}
	plan, err := resample.NewStreamPlan(inRate, outRate, transportBlockFrames, resample.QualityBalanced)
	if err != nil {
		return nil, fmt.Errorf("resample.prepare: plan filter: %w", err)
	}
	workspace, err := plan.WorkspaceBytes(len(t.channels))
	if err != nil {
		return nil, fmt.Errorf("resample.prepare: estimate workspace: %w", err)
	}
	capacity := plan.OutputBlockFrames()
	workspace += int64(len(t.channels)) * int64(transportBlockFrames+capacity) * 8
	if workspace > maxResampleWorkspaceBytes {
		return nil, fmt.Errorf("resample.prepare: exact rate ratio needs approximately %d bytes, exceeding the %d-byte worker workspace limit", workspace, maxResampleWorkspaceBytes)
	}
	frames := t.end - t.position
	remainingOutput, err := resample.FrameCount(frames, inRate, outRate)
	if err != nil {
		return nil, fmt.Errorf("resample.prepare: output duration: %w", err)
	}
	if t.loop {
		frames = -1
	}
	base, err := plan.NewStream(frames)
	if err != nil {
		return nil, fmt.Errorf("resample.prepare: design filter: %w", err)
	}
	r := &documentResampler{
		streams: make([]*resample.Stream, len(t.channels)),
		input:   make([][]float64, len(t.channels)), output: make([][]float64, len(t.channels)),
		inRate: int64(inRate), outRate: int64(outRate), readFrame: t.position,
		remainingOutput: remainingOutput,
	}
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

func (r *documentResampler) prepareStage(t *documentTransport) bool {
	count := transportBlockFrames
	if t.effects != nil {
		count = effects.Quantum
	}
	flushing := !t.loop && r.readFrame == t.end
	if !t.loop {
		count = int(min(int64(count), t.end-r.readFrame))
	}
	if t.effects != nil && !flushing {
		cursor, copied := r.readFrame, 0
		for copied < count {
			n := int(min(int64(count-copied), t.end-cursor))
			for channel := range t.planar {
				t.planar[channel] = t.planar[channel][:n]
			}
			if err := t.effects.Read(t.planar, cursor); err != nil {
				return false
			}
			for channel := range r.input {
				copy(r.input[channel][copied:copied+n], t.planar[channel])
			}
			copied += n
			cursor += int64(n)
			if cursor == t.end && t.loop {
				cursor = t.start
				if err := t.effects.Reset(cursor); err != nil {
					return false
				}
			}
		}
	} else {
		for channel, samples := range t.channels {
			input := r.input[channel][:count]
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
	}
	if !flushing {
		r.readFrame += int64(count)
		if t.loop && r.readFrame >= t.end {
			r.readFrame = t.start + (r.readFrame-t.start)%(t.end-t.start)
		}
	}
	n := 0
	done := false
	for channel, stream := range r.streams {
		var written int
		var finished bool
		var err error
		if flushing {
			written, finished, err = stream.FlushInto(r.output[channel])
		} else {
			written, err = stream.ProcessInto(r.output[channel], r.input[channel][:count])
		}
		if err != nil || (channel > 0 && (written != n || finished != done)) {
			// Workspace bounds and identical channel clocks make this impossible
			// for valid upstream state. Fail silent instead of emitting stale data.
			return false
		}
		n, done = written, finished
	}
	r.stageEnd = n
	r.stageStart = 0
	return n > 0 || !done
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
