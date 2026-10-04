package process

import (
	"context"
	"fmt"
	"math"
	"math/bits"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/dsp/effects/pitch"
	"github.com/cwbudde/algo-dsp/dsp/effects/restoration"
	"github.com/cwbudde/algo-dsp/dsp/stft"
)

// RestorationSettings contains control data for upstream algorithms only.
type RestorationSettings struct {
	FFTSize                                                int
	GainDB, ReductionDB                                    float64
	NoiseMethod                                            string
	ProfileStart, ProfileEnd                               int64
	Mask                                                   restoration.Mask
	Sensitivity, ClipThreshold, DurationRatio, HumHz, HumQ float64
	MaxGap, Harmonics                                      int
}

const (
	restorationChunk = 4096
	repairContext    = 512
)

// restorationOperation coordinates immutable storage and upstream bounded DSP.
type restorationOperation struct {
	*blockOperation
	spectral               []*restoration.SpectralProcessor
	profiles               []*restoration.NoiseProfile
	hum                    []*restoration.HumRemover
	stretch                *pitch.StretchStream
	transform              *stft.STFT
	raw                    []float64
	bins                   []complex128
	pending                [][]float64
	kept                   []int64
	profileFrame           int64
	regionStart, regionEnd int64
}

func newRestorationOperation(document audiobuf.Document, selected ops.Range, settings Settings, limits Limits) (*restorationOperation, error) {
	if err := validateOperation(document, selected, limits); err != nil {
		return nil, fmt.Errorf("process.restoration: %w", err)
	}
	if selected.Start == selected.End {
		selected.Start, selected.End = 0, document.Frames()
	}
	if selected.Start == selected.End {
		return nil, fmt.Errorf("process.restoration: nonempty audio required")
	}
	c := settings.Restoration
	b := &blockOperation{source: document, selected: selected, outputSelection: selected, settings: settings, outputRate: document.SampleRate(), outputChannels: document.Channels(), outputFrames: document.Frames(), renderFrames: selected.End - selected.Start, status: NormalizationStatus{Phase: "processing", PhaseCount: 1, GainResolved: true, GainDB: c.GainDB}}
	r := &restorationOperation{blockOperation: b}
	if settings.Operation == "time-stretch" {
		if selected.ChannelMask != (1<<document.Channels())-1 || math.IsNaN(c.DurationRatio) || math.IsInf(c.DurationRatio, 0) || c.DurationRatio < 0.25 || c.DurationRatio > 4 {
			return nil, fmt.Errorf("process.stretch: duration ratio [0.25,4] and all channels required")
		}
		b.renderFrames = max(1, int64(math.Round(float64(selected.End-selected.Start)*c.DurationRatio)))
		b.outputFrames = document.Frames() - (selected.End - selected.Start) + b.renderFrames
		if b.outputFrames > 1<<53-1 {
			return nil, fmt.Errorf("process.stretch: output exceeds safe frame range")
		}
		b.outputSelection.End = selected.Start + b.renderFrames
		b.identity = c.DurationRatio == 1
	}
	count := bits.OnesCount(uint(selected.ChannelMask))
	if err := outputBudget(b.renderFrames, count, limits); err != nil && !b.identity {
		return nil, fmt.Errorf("process.restoration: %w", err)
	}
	switch settings.Operation {
	case "remove-clicks":
		if !finiteControl(c.Sensitivity, 3, 30) || c.MaxGap < 1 || c.MaxGap > 256 {
			return nil, fmt.Errorf("process.clicks: sensitivity [3,30] and gap [1,256] required")
		}
	case "declip":
		if !finiteControl(c.ClipThreshold, 0.1, 1) || c.MaxGap < 1 || c.MaxGap > 256 {
			return nil, fmt.Errorf("process.declip: threshold [0.1,1] and gap [1,256] required")
		}
	case "noise-reduce":
		if c.ProfileStart < 0 || c.ProfileEnd <= c.ProfileStart || c.ProfileEnd > document.Frames() || c.ProfileEnd-c.ProfileStart < int64(c.FFTSize/2) || !finiteControl(c.ReductionDB, 0, 60) || (c.NoiseMethod != "wiener" && c.NoiseMethod != "subtraction" && c.NoiseMethod != "gate") {
			return nil, fmt.Errorf("process.noise: invalid profile or reduction settings")
		}
	case "spectral-attenuate", "spectral-remove", "spectral-heal":
		if c.Mask.Start != selected.Start || c.Mask.End != selected.End {
			return nil, fmt.Errorf("process.restoration: spectral mask must match selected time")
		}
		if err := c.Mask.Validate(document.Frames(), float64(document.SampleRate())); err != nil {
			return nil, err
		}
	}
	if strings.HasPrefix(settings.Operation, "spectral-") || settings.Operation == "noise-reduce" {
		if c.FFTSize < 256 || c.FFTSize > 8192 || c.FFTSize&(c.FFTSize-1) != 0 {
			return nil, fmt.Errorf("process.restoration: invalid FFT size")
		}
		r.regionStart = max(0, selected.Start-int64(c.FFTSize))
		r.regionEnd = min(document.Frames(), selected.End+int64(c.FFTSize))
	}
	b.mono, b.dsp = make([]float32, audiobuf.BlockFrames), make([]float64, audiobuf.BlockFrames)
	for channel := range document.Channels() {
		if selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		part, _ := document.Channel(channel)
		b.channels = append(b.channels, part)
		b.indices = append(b.indices, channel)
	}
	b.progress.FramesTotal = b.renderFrames
	if b.identity {
		return r, nil
	}
	b.blocks = make([][]*audiobuf.Block, count)
	r.pending = make([][]float64, count)
	r.kept = make([]int64, count)
	for i := range count {
		r.pending[i] = make([]float64, 0, audiobuf.BlockFrames)
		b.blocks[i] = make([]*audiobuf.Block, 0, int((b.renderFrames+audiobuf.BlockFrames-1)/audiobuf.BlockFrames))
	}
	var err error
	switch settings.Operation {
	case "time-stretch":
		r.stretch, err = pitch.NewStretchStream(float64(document.SampleRate()), c.DurationRatio, selected.End-selected.Start, count, func(channel int, start int64, dst []float64) int {
			return r.channels[channel].ReadFloat64(dst, selected.Start+start)
		})
	case "remove-hum":
		for range count {
			h, e := restoration.NewHumRemover(float64(document.SampleRate()), c.HumHz, c.HumQ, c.Harmonics)
			if e != nil {
				return nil, e
			}
			r.hum = append(r.hum, h)
		}
	case "noise-reduce":
		r.transform, err = stft.New(c.FFTSize, c.FFTSize/4, stft.WithCenter(stft.PadNone))
		if err != nil {
			return nil, err
		}
		r.raw = make([]float64, c.FFTSize)
		r.bins = make([]complex128, c.FFTSize/2+1)
		for range count {
			profile, e := restoration.NewNoiseProfile(c.FFTSize, float64(document.SampleRate()))
			if e != nil {
				return nil, e
			}
			r.profiles = append(r.profiles, profile)
		}
		r.status.Phase, r.status.PhaseCount = "analyzing", 2
		r.progress.FramesTotal = c.ProfileEnd - c.ProfileStart
	case "spectral-attenuate", "spectral-remove", "spectral-heal":
		err = r.prepareSpectral()
	}
	if err != nil {
		return nil, fmt.Errorf("process.restoration: upstream: %w", err)
	}
	if r.raw == nil {
		r.raw = make([]float64, restorationChunk+2*repairContext)
	}
	return r, nil
}

func finiteControl(x, minValue, maxValue float64) bool {
	return !math.IsNaN(x) && !math.IsInf(x, 0) && x >= minValue && x <= maxValue
}

func (r *restorationOperation) prepareSpectral() error {
	c := r.settings.Restoration
	mode := strings.TrimPrefix(r.settings.Operation, "spectral-")
	if r.settings.Operation == "noise-reduce" {
		mode = "noise"
	}
	mask := c.Mask
	mask.Start -= r.regionStart
	mask.End -= r.regionStart
	mask.Points = append([]restoration.Point(nil), mask.Points...)
	for i := range mask.Points {
		mask.Points[i].Frame -= float64(r.regionStart)
	}
	for i := range r.channels {
		cfg := restoration.SpectralConfig{Mode: mode, FFTSize: c.FFTSize, SampleRate: float64(r.outputRate), GainDB: c.GainDB, Mask: mask, ReductionDB: c.ReductionDB, Method: c.NoiseMethod}
		if mode == "noise" {
			cfg.Profile = r.profiles[i]
		}
		processor, err := restoration.NewSpectralProcessor(r.regionEnd-r.regionStart, func(dst []float64, start int64) int { return r.channels[i].ReadFloat64(dst, r.regionStart+start) }, cfg)
		if err != nil {
			return err
		}
		r.spectral = append(r.spectral, processor)
	}
	return nil
}

func (r *restorationOperation) Step(ctx context.Context) (Progress, error) {
	if r.failure != nil {
		return r.progress, r.failure
	}
	if r.progress.Done {
		return r.progress, nil
	}
	if ctx == nil {
		return r.fail(fmt.Errorf("process.restoration: nil context"))
	}
	if err := ctx.Err(); err != nil {
		return r.fail(fmt.Errorf("process.restoration: %w", err))
	}
	c := r.settings.Restoration
	if r.status.Phase == "analyzing" {
		start := c.ProfileStart + r.profileFrame*int64(c.FFTSize/4) - int64(c.FFTSize/2)
		for i := range r.channels {
			clear(r.raw)
			lo := max(int64(0), c.ProfileStart-start)
			hi := min(int64(len(r.raw)), c.ProfileEnd-start)
			if hi > lo && r.channels[i].ReadFloat64(r.raw[lo:hi], start+lo) != int(hi-lo) {
				return r.fail(fmt.Errorf("process.noise: short profile read"))
			}
			if err := r.transform.FrameInto(r.bins, r.raw, 0); err != nil {
				return r.fail(err)
			}
			if err := r.profiles[i].AddSpectrum(r.bins); err != nil {
				return r.fail(err)
			}
		}
		r.profileFrame++
		r.progress.FramesDone = min(r.progress.FramesTotal, r.profileFrame*int64(c.FFTSize/4))
		if r.progress.FramesDone == r.progress.FramesTotal {
			if err := r.prepareSpectral(); err != nil {
				return r.fail(err)
			}
			r.status.Phase, r.status.PhaseIndex = "processing", 1
			r.progress.FramesDone, r.progress.FramesTotal = 0, r.renderFrames
		}
		return r.progress, nil
	}
	if r.identity {
		count := int(min(int64(restorationChunk), r.renderFrames-r.progress.FramesDone))
		for i := range r.channels {
			cached, err := r.scanShared(i, count)
			if err != nil {
				return r.fail(err)
			}
			if !cached {
				r.channels[i].Read(r.mono[:count], r.selected.Start+r.progress.FramesDone)
				r.measureStoredSamples(r.mono[:count])
			}
		}
		if err := ctx.Err(); err != nil {
			return r.fail(fmt.Errorf("process.restoration: %w", err))
		}
		r.progress.FramesDone += int64(count)
		if r.progress.FramesDone == r.renderFrames {
			r.result, r.progress.Done = r.source, true
			r.release()
		}
		return r.progress, nil
	}
	done := false
	var err error
	switch {
	case r.stretch != nil:
		done, err = r.stretch.Step(ctx, func(channel int, _ int64, samples []float64) error { return r.appendOutput(channel, samples) })
	case len(r.spectral) > 0:
		for i, p := range r.spectral {
			done, err = p.Step(ctx, func(at int64, samples []float64) error {
				start := r.regionStart + at
				lo := max(int64(0), r.selected.Start-start)
				hi := min(int64(len(samples)), r.selected.End-start)
				if hi > lo {
					return r.appendOutput(i, samples[lo:hi])
				}
				return nil
			})
			if err != nil {
				break
			}
		}
	default:
		count := int(min(int64(restorationChunk), r.renderFrames-r.progress.FramesDone))
		start := r.selected.Start + r.progress.FramesDone
		for i, ch := range r.channels {
			if err = ctx.Err(); err != nil {
				break
			}
			readStart, readEnd := start, start+int64(count)
			if r.settings.Operation == "remove-clicks" || r.settings.Operation == "declip" {
				readStart = max(0, start-repairContext)
				readEnd = min(r.source.Frames(), readEnd+repairContext)
			}
			raw := r.raw[:readEnd-readStart]
			if ch.ReadFloat64(raw, readStart) != len(raw) {
				err = fmt.Errorf("process.restoration: short read")
				break
			}
			switch r.settings.Operation {
			case "remove-clicks":
				err = restoration.RepairClicks(raw, c.Sensitivity, c.MaxGap)
			case "declip":
				err = restoration.Declip(raw, c.ClipThreshold, c.MaxGap)
			case "remove-hum":
				err = r.hum[i].ProcessInPlace(raw)
			}
			if err != nil {
				break
			}
			if err = r.appendOutput(i, raw[start-readStart:start-readStart+int64(count)]); err != nil {
				break
			}
		}
		done = r.kept[0] == r.renderFrames
	}
	if err != nil {
		return r.fail(fmt.Errorf("process.restoration.step: %w", err))
	}
	if err = ctx.Err(); err != nil {
		return r.fail(err)
	}
	r.progress.FramesDone = r.kept[0]
	if !done {
		return r.progress, nil
	}
	for i := range r.pending {
		if len(r.pending[i]) > 0 {
			if err = r.storeConverted(i, r.pending[i]); err != nil {
				return r.fail(err)
			}
			r.pending[i] = r.pending[i][:0]
		}
		if r.kept[i] != r.renderFrames {
			return r.fail(fmt.Errorf("process.restoration: inconsistent output length"))
		}
	}
	result, err := r.assemble()
	if err != nil {
		return r.fail(err)
	}
	if err = ctx.Err(); err != nil {
		return r.fail(err)
	}
	r.result, r.progress.Done = result, true
	r.release()
	return r.progress, nil
}

func (r *restorationOperation) appendOutput(channel int, samples []float64) error {
	if int64(len(samples)) > r.renderFrames-r.kept[channel] {
		return fmt.Errorf("process.restoration: output overflow")
	}
	r.kept[channel] += int64(len(samples))
	for len(samples) > 0 {
		n := min(len(samples), audiobuf.BlockFrames-len(r.pending[channel]))
		r.pending[channel] = append(r.pending[channel], samples[:n]...)
		samples = samples[n:]
		if len(r.pending[channel]) == audiobuf.BlockFrames {
			if err := r.storeConverted(channel, r.pending[channel]); err != nil {
				return err
			}
			r.pending[channel] = r.pending[channel][:0]
		}
	}
	return nil
}

func (r *restorationOperation) release() {
	r.blockOperation.release()
	r.spectral = nil
	r.profiles = nil
	r.hum = nil
	r.stretch = nil
	r.transform = nil
	r.raw = nil
	r.bins = nil
	r.pending = nil
}

func (r *restorationOperation) fail(err error) (Progress, error) {
	r.release()
	return r.blockOperation.fail(err)
}

func (r *restorationOperation) Cancel() {
	if r.failure == nil {
		_, _ = r.fail(fmt.Errorf("process.cancel: %w", context.Canceled))
	}
}

func stretchTimeline(t *audiobuf.Timeline, selected ops.Range, output int64) {
	scale := func(frame int64) int64 {
		if frame <= selected.Start {
			return frame
		}
		if frame >= selected.End {
			return frame - (selected.End - selected.Start) + output
		}
		hi, lo := bits.Mul64(uint64(frame-selected.Start), uint64(output))
		q, rem := bits.Div64(hi, lo, uint64(selected.End-selected.Start))
		if rem >= uint64((selected.End-selected.Start+1)/2) {
			q++
		}
		return selected.Start + int64(q)
	}
	for i := range t.Markers {
		t.Markers[i].Frame = scale(t.Markers[i].Frame)
	}
	regions := t.Regions[:0]
	for _, region := range t.Regions {
		region.Start, region.End = scale(region.Start), scale(region.End)
		if region.Start < region.End {
			regions = append(regions, region)
		}
	}
	t.Regions = regions
}
