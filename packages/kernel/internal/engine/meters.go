package engine

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/measure/loudness"
	"github.com/cwbudde/algo-dsp/measure/stereo"
	"github.com/cwbudde/algo-dsp/measure/truepeak"
	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

const playbackSpectrumFrames = 8192

type playbackMeters struct {
	loudness            *loudness.StreamingMeter
	truePeak            *truepeak.Meter
	stereo              *stereo.Analyzer
	statistics          []*timestats.Accumulator
	scratch             []float32
	points              [protocol.MetersGoniometerCapacity]stereo.Point
	peaks               [MaxChannels]float64
	values              [protocol.MetersFloat64Count]float64
	data                [protocol.MetersDataBytes]byte
	frames              int64
	snapshotFrame       int64
	stereoSnapshotFrame int64
	failed              bool
	rate                float64
	channels            int
}

func newPlaybackMeters(rate float64, channels int) (*playbackMeters, error) {
	indices := make([]int, channels)
	for c := range indices {
		indices[c] = c
	}
	l, err := loudness.NewStreamingMeter(loudness.IntegratedConfig{SampleRate: rate, Channels: channels, ChannelWeights: analysisWeights(channels, indices), MaxFrames: int64(rate * 86400)})
	if err != nil {
		return nil, err
	}
	p, err := truepeak.NewMeter(channels)
	if err != nil {
		return nil, err
	}
	s, err := stereo.NewAnalyzer(int(rate/10), protocol.MetersGoniometerCapacity)
	if err != nil {
		return nil, err
	}
	m := &playbackMeters{loudness: l, truePeak: p, stereo: s, statistics: make([]*timestats.Accumulator, channels), scratch: make([]float32, 1024), rate: rate, channels: channels}
	for c := range channels {
		m.statistics[c], err = timestats.NewAccumulator(1024)
		if err != nil {
			return nil, err
		}
	}
	m.reset()
	return m, nil
}

func (m *playbackMeters) reset() {
	m.loudness.Reset()
	m.truePeak.Reset()
	m.stereo.Reset()
	for _, s := range m.statistics {
		s.Reset()
	}
	m.frames = 0
	m.snapshotFrame = -1
	m.stereoSnapshotFrame = -1
	m.failed = false
	clear(m.peaks[:])
	clear(m.values[:])
	clear(m.data[:])
	m.values[0] = 1
	m.values[1] = float64(m.channels)
	m.values[3] = m.rate
	for _, slot := range []int{4, 5, 6, 10, 11} {
		m.values[slot] = math.Inf(-1)
	}
}

func (m *playbackMeters) process(src []float32) {
	if m.failed || len(src) == 0 {
		return
	}
	// Invalid imported samples preserve playback bits but never poison meters.
	for _, v := range src {
		if math.Float32bits(v)&0x7f800000 == 0x7f800000 {
			m.failed = true
			m.values[14] = 1
			return
		}
	}
	for offset := 0; offset < len(src)/m.channels; offset += 1024 {
		n := min(1024, len(src)/m.channels-offset)
		block := src[offset*m.channels : (offset+n)*m.channels]
		if err := m.loudness.ProcessInterleaved32(block); err != nil {
			m.failed = true
			m.values[14] = 3
			if errors.Is(err, loudness.ErrLimit) {
				m.values[14] = 2
			}
			return
		}
		if err := m.truePeak.ProcessInterleaved32(block); err != nil {
			m.failed = true
			m.values[14] = 1
			return
		}
		if err := m.stereo.ProcessInterleaved32(block, m.channels); err != nil {
			m.failed = true
			m.values[14] = 1
			return
		}
		for channel, stats := range m.statistics {
			for frame := range n {
				m.scratch[frame] = block[frame*m.channels+channel]
			}
			stats.Reset()
			_ = stats.Add32(m.scratch[:n])
			r := stats.Result()
			slot := protocol.MetersChannelOffset + channel*protocol.MetersChannelStride
			m.values[slot] = r.Peak
			m.values[slot+1] = r.RMS
			m.values[slot+2] = max(m.values[slot+2], r.Peak)
		}
		m.frames += int64(n)
	}
	_ = m.truePeak.PeaksInto(m.peaks[:m.channels])
	for c := range m.channels {
		m.values[protocol.MetersChannelOffset+c*protocol.MetersChannelStride+3] = m.peaks[c]
	}
	m.values[2] = float64(m.frames)
}

func (m *playbackMeters) flush() {
	if m.failed {
		return
	}
	m.truePeak.Flush()
	_ = m.truePeak.PeaksInto(m.peaks[:m.channels])
	for c := range m.channels {
		m.values[protocol.MetersChannelOffset+c*protocol.MetersChannelStride+3] = m.peaks[c]
	}
}

// MeterData returns a borrowed reusable binary snapshot. The syscall/js bridge
// copies it immediately; callers must not retain or mutate this engine storage.
func (e *Engine) MeterData() []byte {
	m := e.meters
	if m == nil {
		return nil
	}
	// Expensive gated-history snapshots run at display cadence on the control
	// path, never in Render; byte copying still uses one fixed reusable block.
	finished := e.source == sourceStopped || (e.source == sourceDocument && e.transport != nil && !e.transport.playing)
	if m.snapshotFrame < 0 || m.frames-m.snapshotFrame >= int64(m.rate) || (finished && m.snapshotFrame != m.frames) {
		_ = m.loudness.Snapshot()
		m.snapshotFrame = m.frames
	}
	{
		r := m.loudness.Reading()
		m.values[4] = r.Momentary
		m.values[5] = r.ShortTerm
		m.values[6] = r.Integrated
		m.values[7] = r.LRA
		m.values[10] = r.MaxMomentary
		m.values[11] = r.MaxShortTerm
		m.values[12] = 0
		if r.LRAStable {
			m.values[12] = 1
		}
		m.values[13] = float64(r.Frames)
		flags := 0
		if r.HasMomentary {
			flags |= 1
		}
		if r.HasShortTerm {
			flags |= 2
		}
		if r.HasIntegrated {
			flags |= 4
		}
		if r.HasLRA {
			flags |= 8
		}
		m.values[15] = float64(flags)
	}
	if m.stereoSnapshotFrame < 0 || m.frames-m.stereoSnapshotFrame >= int64(m.rate/25) || (finished && m.stereoSnapshotFrame != m.frames) {
		m.values[8] = m.stereo.Correlation()
		n := m.stereo.PointsInto(m.points[:])
		m.values[9] = float64(n)
		clear(m.values[protocol.MetersGoniometerOffset:])
		for i := range n {
			m.values[protocol.MetersGoniometerOffset+i*2] = m.points[i].Mid
			m.values[protocol.MetersGoniometerOffset+i*2+1] = m.points[i].Side
		}
		m.stereoSnapshotFrame = m.frames
	}
	for i, v := range m.values {
		binary.LittleEndian.PutUint64(m.data[i*8:], math.Float64bits(v))
	}
	return m.data[:]
}

func (e *Engine) configureMeters(p protocol.MetersConfigureParams) (protocol.MetersConfigureResult, error) {
	if p.Enabled != nil && !*p.Enabled {
		e.meters = nil
		return protocol.MetersConfigureResult{ByteLength: protocol.MetersDataBytes, Version: 1}, nil
	}
	if e.meters == nil || e.meters.channels != e.channels || e.meters.rate != e.sampleRate {
		m, err := newPlaybackMeters(e.sampleRate, e.channels)
		if err != nil {
			return protocol.MetersConfigureResult{}, fmt.Errorf("meters.configure: %w", err)
		}
		e.meters = m
	} else if p.Reset {
		e.meters.reset()
	}
	return protocol.MetersConfigureResult{Enabled: true, ByteLength: protocol.MetersDataBytes, Version: 1}, nil
}

func (e *Engine) resetMeters() {
	if e.meters != nil {
		e.meters.reset()
	}
	if e.spectrumHistory != nil {
		clear(e.spectrumHistory)
		e.spectrumWrite = 0
		e.spectrumCount = 0
	}
	e.spectrumJob = nil
}

func (e *Engine) recordOutput(output []float32, frames int) {
	if frames <= 0 {
		return
	}
	output = output[:frames*e.channels]
	if e.meters != nil {
		e.meters.process(output)
		if e.source == sourceDocument && e.transport != nil && !e.transport.playing {
			e.meters.flush()
		}
	}
	if e.spectrumHistory != nil {
		for frame := range frames {
			copy(e.spectrumHistory[e.spectrumWrite*e.channels:(e.spectrumWrite+1)*e.channels], output[frame*e.channels:(frame+1)*e.channels])
			e.spectrumWrite = (e.spectrumWrite + 1) % playbackSpectrumFrames
			e.spectrumCount = min(e.spectrumCount+1, playbackSpectrumFrames)
		}
	}
}
