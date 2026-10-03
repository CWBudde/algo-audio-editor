// Package process builds immutable audio results in bounded, cancellable steps.
// Sample algorithms belong to the tagged algo-* libraries; this package moves
// representations, owns output blocks and coordinates independent DSP streams.
package process

import (
	"fmt"
	"math"

	"github.com/cwbudde/algo-dsp/dsp/core"
	vecmath "github.com/cwbudde/algo-vecmath"
)

// Processor owns one channel's state for the entire selected stream. Its input
// is private scratch, valid only during ProcessBlock, and must not be retained.
type Processor interface {
	ProcessBlock([]float64) error
}

// Process creates a fresh independent stream for every selected source channel.
// Length-preserving mono processors may preserve state across arbitrarily short
// final blocks. Rate-changing and cross-channel processors need a separate API.
type Process interface {
	NewChannel(sampleRate int, channel int, frames int64) (Processor, error)
}

// Gain scales samples without clipping. Zero dB is an exact storage identity;
// the builder still scans selected audio for truthful peak/warning metadata.
type Gain struct{ DB float64 }

func (g Gain) NewChannel(_ int, _ int, _ int64) (Processor, error) {
	if math.IsNaN(g.DB) || math.IsInf(g.DB, 0) || g.DB < -120 || g.DB > 60 {
		return nil, fmt.Errorf("process.gain: dB must be finite in [-120, 60]")
	}
	return gainProcessor{linear: core.DBToLinear(g.DB)}, nil
}

type gainProcessor struct{ linear float64 }

func (g gainProcessor) ProcessBlock(block []float64) error {
	vecmath.ScaleBlockInPlace(block, g.linear)
	return nil
}

func identityProcess(process Process) bool {
	switch gain := process.(type) {
	case Gain:
		return gain.DB == 0
	case *Gain:
		return gain != nil && gain.DB == 0
	default:
		return false
	}
}
