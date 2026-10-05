package effects

import (
	"fmt"
	"math"
	"math/bits"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/dsp/effectchain"
	timestats "github.com/cwbudde/algo-dsp/stats/time"
	vecmath "github.com/cwbudde/algo-vecmath"
)

// Stream renders fixed, selection-relative blocks through real upstream DSP.
// A bridge may consume these blocks in any partition without changing samples.
// All storage and runtime workspaces are prepared before playback begins.
type Stream struct {
	channels    []audiobuf.Channel
	selected    ops.Range
	config      Config
	chain       *effectchain.Chain
	indices     []int
	stage       [][]float64
	active      [][]float64
	dry         [][]float64
	work        [][]float64
	dspRead     int64
	dspSkip     int
	dspOffset   int
	dspFrames   int
	stageStart  int64
	stageFrames int
	next        int64
	processed   bool
	meters      Meters
}

// Meters contains the most recent upstream input and output level snapshot.
type Meters struct {
	Frames                                     int64
	InputPeak, InputRMS, OutputPeak, OutputRMS []float64
}

// NewStream prepares a stateful effect stream over a document selection.
func NewStream(document audiobuf.Document, selected ops.Range, config Config) (*Stream, error) {
	chain, err := config.NewChain(document.SampleRate(), bits.OnesCount(uint(selected.ChannelMask)))
	if err != nil {
		return nil, err
	}
	s := &Stream{selected: selected, config: config, chain: chain, channels: make([]audiobuf.Channel, document.Channels()), stage: make([][]float64, document.Channels()), next: -1}
	count := bits.OnesCount(uint(selected.ChannelMask))
	s.active = make([][]float64, count)
	s.dry = make([][]float64, count)
	s.work = make([][]float64, count)
	s.meters = Meters{InputPeak: make([]float64, document.Channels()), InputRMS: make([]float64, document.Channels()), OutputPeak: make([]float64, document.Channels()), OutputRMS: make([]float64, document.Channels())}
	for channel := range document.Channels() {
		s.channels[channel], err = document.Channel(channel)
		if err != nil {
			return nil, err
		}
		s.stage[channel] = make([]float64, Quantum)
		if selected.ChannelMask&(1<<channel) != 0 {
			s.indices = append(s.indices, channel)
		}
	}
	for channel := range s.dry {
		s.dry[channel] = make([]float64, Quantum)
		s.work[channel] = make([]float64, Quantum)
	}
	return s, nil
}

// Reset is allocation-free after upstream preparation, including loop wraps.
// Signal starts fresh at frame; earlier source samples are never prerendered.
func (s *Stream) Reset(frame int64) error {
	if err := s.chain.ResetProcessing(); err != nil {
		return fmt.Errorf("effects.reset: %w", err)
	}
	s.next = frame
	s.stageFrames = 0
	s.processed = false
	s.dspRead = frame
	s.dspSkip = s.chain.Latency()
	s.dspOffset = 0
	s.dspFrames = 0
	return nil
}

// Prime prepares only the next quantum from immutable source lookahead. It is
// called on the worker control path before playback or atomic live replacement.
func (s *Stream) Prime(frame int64) error {
	if err := s.Reset(frame); err != nil {
		return err
	}
	s.meters.Frames = 0
	clear(s.meters.InputPeak)
	clear(s.meters.InputRMS)
	clear(s.meters.OutputPeak)
	clear(s.meters.OutputRMS)
	if frame >= s.channels[0].Frames() {
		return nil
	}
	return s.prepare(frame)
}

// Read copies a sequential document range into planar caller-owned buffers.
// Source positioning and float32 rounding occur identically offline/preview.
func (s *Stream) Read(dst [][]float64, frame int64) error {
	if len(dst) != len(s.channels) || len(dst) == 0 {
		return fmt.Errorf("effects.read: channel layout differs")
	}
	count := len(dst[0])
	for _, channel := range dst {
		if len(channel) != count {
			return fmt.Errorf("effects.read: unequal channel lengths")
		}
	}
	if frame < 0 || int64(count) > s.channels[0].Frames()-frame {
		return fmt.Errorf("effects.read: range outside source")
	}
	if frame != s.next {
		if err := s.Reset(frame); err != nil {
			return err
		}
	}
	for copied := 0; copied < count; {
		cursor := frame + int64(copied)
		if s.stageFrames == 0 || cursor < s.stageStart || cursor >= s.stageStart+int64(s.stageFrames) {
			if err := s.prepare(cursor); err != nil {
				return err
			}
		}
		offset := int(cursor - s.stageStart)
		n := min(count-copied, s.stageFrames-offset)
		for channel := range dst {
			copy(dst[channel][copied:copied+n], s.stage[channel][offset:offset+n])
		}
		copied += n
	}
	s.next = frame + int64(count)
	return nil
}

func (s *Stream) prepare(frame int64) error {
	count := int(min(int64(Quantum), s.channels[0].Frames()-frame))
	if frame < s.selected.Start {
		count = int(min(int64(count), s.selected.Start-frame))
	} else if frame < s.selected.End {
		count = int(min(int64(count), s.selected.End-frame))
	}
	for channel, data := range s.channels {
		if n := data.ReadFloat64(s.stage[channel][:count], frame); n != count {
			return fmt.Errorf("effects.read: source channel %d read %d/%d", channel, n, count)
		}
	}
	if frame >= s.selected.Start && frame < s.selected.End {
		for packed, channel := range s.indices {
			s.active[packed] = s.stage[channel][:count]
			copy(s.dry[packed][:count], s.active[packed])
			s.meters.InputPeak[channel] = timestats.Peak(s.active[packed])
			s.meters.InputRMS[channel] = timestats.RMS(s.active[packed])
		}
		if !s.processed {
			s.dspRead = frame
			s.dspSkip = s.chain.Latency()
			s.dspOffset = 0
			s.dspFrames = 0
		}
		if err := s.renderWet(count); err != nil {
			return err
		}
		for packed, channel := range s.indices {
			if s.config.Bypass || s.config.Wet == 0 {
				copy(s.active[packed], s.dry[packed][:count])
			} else if s.config.Wet != 1 {
				vecmath.ScaleBlockInPlace(s.active[packed], s.config.Wet)
				vecmath.AddScaledBlockInPlace(s.active[packed], s.dry[packed][:count], 1-s.config.Wet)
			}
			for i, value := range s.active[packed] {
				rounded := float32(value)
				if math.Float32bits(rounded)&0x7f800000 == 0x7f800000 {
					return fmt.Errorf("effects.process: channel %d generated unsafe float32 sample", channel)
				}
				s.active[packed][i] = float64(rounded)
			}
			s.meters.OutputPeak[channel] = timestats.Peak(s.active[packed])
			s.meters.OutputRMS[channel] = timestats.RMS(s.active[packed])
		}
		s.meters.Frames += int64(count)
		s.processed = true
	}
	s.stageStart = frame
	s.stageFrames = count
	return nil
}

func (s *Stream) renderWet(count int) error {
	for copied := 0; copied < count; {
		if s.dspOffset == s.dspFrames {
			n := Quantum
			if s.dspRead < s.selected.End {
				n = int(min(int64(n), s.selected.End-s.dspRead))
			}
			for packed, channel := range s.indices {
				buffer := s.work[packed][:n]
				s.work[packed] = buffer
				if s.dspRead < s.selected.End {
					if read := s.channels[channel].ReadFloat64(buffer, s.dspRead); read != n {
						return fmt.Errorf("effects.process: incomplete lookahead source")
					}
				} else {
					clear(buffer)
				}
			}
			if err := s.chain.ProcessPlanar(s.work); err != nil {
				return fmt.Errorf("effects.process: %w", err)
			}
			s.dspRead += int64(n)
			s.dspFrames = n
			s.dspOffset = min(n, s.dspSkip)
			s.dspSkip -= s.dspOffset
			if s.dspOffset == s.dspFrames {
				continue
			}
		}
		n := min(count-copied, s.dspFrames-s.dspOffset)
		for channel := range s.active {
			copy(s.active[channel][copied:copied+n], s.work[channel][s.dspOffset:s.dspOffset+n])
		}
		s.dspOffset += n
		copied += n
	}
	return nil
}

// Meters returns the most recent upstream meter snapshot.
func (s *Stream) Meters() Meters { return s.meters }

// Identity reports whether processing preserves the source audio.
func (s *Stream) Identity() bool { return s.config.Bypass || s.config.Wet == 0 }

// Selection returns the source selection processed by the stream.
func (s *Stream) Selection() ops.Range { return s.selected }

// TryUpdate preserves prepared histories for upstream-supported graph changes.
// Buffered or structural changes require a separately primed replacement.
func (s *Stream) TryUpdate(config Config) (bool, error) {
	updated, err := s.chain.TryUpdateGraph(config.Graph)
	if err != nil {
		return false, fmt.Errorf("effects.update: %w", err)
	}
	if updated {
		s.config = config
	}
	return updated, nil
}

// SetMix changes routing without clearing clocks, filter memory or delay tails.
// Any already-rendered quantum remains valid; the new mix starts next quantum.
func (s *Stream) SetMix(wet float64, bypass bool) { s.config.Wet = wet; s.config.Bypass = bypass }
