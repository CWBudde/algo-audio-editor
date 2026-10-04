package engine

import (
	"encoding/binary"
	"fmt"
	"math"

	"github.com/cwbudde/algo-dsp/dsp/spectrum"
	"github.com/cwbudde/algo-dsp/dsp/stft"
	"github.com/cwbudde/algo-dsp/dsp/window"
	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

type spectrumAnalysis struct {
	transform          *stft.STFT
	input              []float64
	bins               []complex128
	frequencies, power []float64
	accumulators       []powerAccumulator
	count              []int
	averaging          int
	smoothing          int
	windowSum          float64
}

type powerAccumulator interface {
	Add([]float64) error
	ValuesInto([]float64) error
	Reset()
}

func newSpectrumAnalysis(rate float64, channels, size int, name string, averaging int, smoothing float64) (*spectrumAnalysis, error) {
	if size == 0 {
		size = 2048
	}
	if name == "" {
		name = "hann"
	}
	if averaging == 0 {
		averaging = 1
	}
	if size < 256 || size > 8192 || size&(size-1) != 0 || averaging < 1 || averaging > 64 {
		return nil, fmt.Errorf("analysis.spectrum: FFT must be power of two256..8192 and averaging1..64")
	}
	if smoothing != 0 && smoothing != 3 && smoothing != 6 && smoothing != 12 && smoothing != 24 {
		return nil, fmt.Errorf("analysis.spectrum: invalid fractional-octave smoothing")
	}
	var w window.Type
	switch name {
	case "hann":
		w = window.TypeHann
	case "hamming":
		w = window.TypeHamming
	case "blackman":
		w = window.TypeBlackman
	case "rectangular":
		w = window.TypeRectangular
	default:
		return nil, fmt.Errorf("analysis.spectrum: unknown window %q", name)
	}
	t, err := stft.New(size, size, stft.WithWindow(w), stft.WithCenter(stft.PadNone))
	if err != nil {
		return nil, fmt.Errorf("analysis.spectrum: prepare: %w", err)
	}
	sum := timestats.DC(t.Window()) * float64(size)
	s := &spectrumAnalysis{transform: t, input: make([]float64, size), bins: make([]complex128, t.Bins()), frequencies: make([]float64, t.Bins()), power: make([]float64, t.Bins()), accumulators: make([]powerAccumulator, channels), count: make([]int, channels), averaging: averaging, smoothing: int(smoothing), windowSum: sum}
	for i := range s.frequencies {
		s.frequencies[i] = float64(i) * rate / float64(size)
	}
	for i := range s.accumulators {
		s.accumulators[i], err = spectrum.NewPowerAccumulator(t.Bins())
		if err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *spectrumAnalysis) add(channel int) error {
	for _, x := range s.input {
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return fmt.Errorf("analysis.spectrum: nonfinite input")
		}
	}
	if err := s.transform.FrameInto(s.bins, s.input, 0); err != nil {
		return err
	}
	if err := spectrum.PowerInto(s.power, s.bins); err != nil {
		return err
	}
	if err := s.accumulators[channel].Add(s.power); err != nil {
		return err
	}
	s.count[channel]++
	return nil
}

func (s *spectrumAnalysis) levels(channel int) ([]float64, error) {
	values := make([]float64, len(s.frequencies))
	if err := s.accumulators[channel].ValuesInto(values); err != nil {
		return nil, err
	}
	if s.smoothing != 0 {
		smoothed := make([]float64, len(values)-1)
		if err := spectrum.SmoothFractionalOctaveInto(smoothed, s.frequencies[1:], values[1:], s.smoothing); err != nil {
			return nil, err
		}
		copy(values[1:], smoothed)
	}
	if err := spectrum.PowerToDBInto(values, values, s.windowSum, s.transform.NFFT()); err != nil {
		return nil, err
	}
	for i, v := range values {
		values[i] = max(-180, v)
	}
	return values, nil
}

func (s *spectrumAnalysis) encodeChannel(channel int, data []byte) error {
	values, err := s.levels(channel)
	if err != nil {
		return err
	}
	for bin, frequency := range s.frequencies {
		offset := (channel*len(values) + bin) * 16
		binary.LittleEndian.PutUint64(data[offset:], math.Float64bits(frequency))
		binary.LittleEndian.PutUint64(data[offset+8:], math.Float64bits(values[bin]))
	}
	return nil
}
