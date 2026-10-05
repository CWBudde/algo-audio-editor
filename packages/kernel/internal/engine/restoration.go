package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	processing "github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/effects/restoration"
)

func (e *Engine) prepareRestorationSettings(p protocol.ProcessStartParams, selected ops.Range) (processing.RestorationSettings, error) {
	s := processing.RestorationSettings{FFTSize: p.FFTSize, GainDB: p.GainDB, ReductionDB: p.ReductionDB, NoiseMethod: p.NoiseMethod, Sensitivity: p.Sensitivity, ClipThreshold: p.ClipThreshold, MaxGap: p.MaxGap, DurationRatio: p.DurationRatio, HumHz: p.HumHz, HumQ: p.HumQ, Harmonics: p.Harmonics}
	if p.Operation == protocol.OperationNoiseReduce {
		profile := p.NoiseProfile
		if profile == nil {
			return s, fmt.Errorf("process.start: capture a noise profile first")
		}
		if err := e.validateDocumentID("process.start noise profile", profile.DocumentID); err != nil {
			return s, err
		}
		if profile.Start < 0 || profile.End <= profile.Start || profile.End > e.doc.document.Frames() || profile.ChannelMask <= 0 || profile.ChannelMask&selected.ChannelMask != selected.ChannelMask || profile.ChannelMask&((1<<e.doc.document.Channels())-1) != profile.ChannelMask {
			return s, fmt.Errorf("process.start: noise profile must cover selected channels and a valid range")
		}
		s.ProfileStart, s.ProfileEnd = profile.Start, profile.End
	}
	if p.Operation == protocol.OperationSpectralAttenuate || p.Operation == protocol.OperationSpectralRemove || p.Operation == protocol.OperationSpectralHeal {
		m := p.SpectralMask
		if m == nil || m.Start != selected.Start || m.End != selected.End {
			return s, fmt.Errorf("process.start: spectral mask must match the selected time range")
		}
		s.Mask = restoration.Mask{Start: m.Start, End: m.End, LowHz: m.LowHz, HighHz: m.HighHz}
		if len(m.Points) > 128 {
			return s, fmt.Errorf("process.start: spectral polygon exceeds 128 vertices")
		}
		for _, point := range m.Points {
			s.Mask.Points = append(s.Mask.Points, restoration.Point{Frame: point.Frame, Hz: point.Hz})
		}
	}
	return s, nil
}
