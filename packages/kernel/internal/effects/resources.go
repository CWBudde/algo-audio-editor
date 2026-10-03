package effects

import (
	"fmt"
	"math/bits"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/effectchain"
)

// MaxWorkspaceBytes bounds prepared DSP histories, routing buffers and FFT
// workspaces independently of immutable document storage. The upstream estimator
// counts fixed-capacity delays, power-of-two pitch histories and convolution
// partitions before the worker constructs any processor.
const MaxWorkspaceBytes int64 = 64 << 20

func validateResources(graph protocol.EffectGraph, encoded string, rate, mask int, provider effectchain.IRProvider) error {
	irFrames := make(map[int]int)
	for _, node := range graph.Nodes {
		if node.Type != "reverb-conv" {
			continue
		}
		index, _ := number(node.Params["irIndex"])
		if provider != nil {
			samples, _, found := provider.GetIR(int(index))
			if found && len(samples) > 0 {
				irFrames[int(index)] = len(samples[0])
			}
		}
	}
	total, err := effectchain.EstimateWorkspace(effectchain.Context{SampleRate: float64(rate)}, encoded, bits.OnesCount(uint(mask)), effectchain.WithWorkspaceFrames(Quantum), effectchain.WithWorkspaceIRFrames(irFrames))
	if err != nil {
		return fmt.Errorf("effects.graph: estimate DSP workspace: %w", err)
	}
	if total > MaxWorkspaceBytes {
		return fmt.Errorf("effects.graph: estimated DSP workspace %d bytes exceeds %d-byte worker limit", total, MaxWorkspaceBytes)
	}
	return nil
}
