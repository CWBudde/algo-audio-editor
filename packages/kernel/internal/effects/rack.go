// Package effects adapts tagged effectchain runtimes to immutable editor audio.
// Graph/resource validation and representation ownership live here; every sample
// algorithm, including wet/dry mixing and metering, comes from algo-* packages.
package effects

import (
	"encoding/json"
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/effectchain"
)

// Quantum is shared by preview and offline processing, independently of bridge
// render sizes. This also bounds signal prefetch during live parameter changes.
const (
	Quantum  = 128
	MaxNodes = 34
)

type Config struct {
	Graph          string
	Wet            float64
	Bypass         bool
	Provider       effectchain.IRProvider
	catalogue      []protocol.EffectDescriptor
	sourceChannels []int
}

func Descriptors(rate float64) ([]protocol.EffectDescriptor, error) {
	source := effectchain.DefaultDescriptors(rate)
	descriptors := make([]protocol.EffectDescriptor, len(source))
	for i, descriptor := range source {
		out := protocol.EffectDescriptor{ID: descriptor.ID, Name: descriptor.Name, Category: descriptor.Category, ChannelMode: descriptor.ChannelMode, View: descriptor.View, Parameters: make([]protocol.EffectParameterDescriptor, len(descriptor.Parameters)), Presets: make([]protocol.EffectFactoryPreset, len(descriptor.Presets))}
		for j, parameter := range descriptor.Parameters {
			p := protocol.EffectParameterDescriptor{ID: parameter.ID, Label: parameter.Label, Unit: parameter.Unit, Type: parameter.Type, Min: parameter.Min, Max: parameter.Max, Default: parameter.Default, Scale: parameter.Scale, Step: parameter.Step, DefaultString: parameter.DefaultString}
			if len(parameter.Options) > 0 {
				p.Options = make([]protocol.EffectOption, len(parameter.Options))
				for k, option := range parameter.Options {
					p.Options[k] = protocol.EffectOption{Value: option.Value, Label: option.Label}
				}
			}
			out.Parameters[j] = p
		}
		for j, preset := range descriptor.Presets {
			out.Presets[j] = protocol.EffectFactoryPreset{ID: preset.ID, Name: preset.Name, Num: preset.Num, Str: preset.Str}
		}
		descriptors[i] = out
	}
	return descriptors, nil
}

// NewConfig rejects incomplete graphs, unknown parameters, unsafe ranges and
// unavailable convolution resources before an active preview can be changed.
func NewConfig(document audiobuf.Document, selected ops.Range, graph protocol.EffectGraph, wet float64, bypass bool, provider effectchain.IRProvider) (Config, error) {
	return newConfig(document, selected, graph, wet, bypass, provider, false, nil)
}

// NewUpdatedConfig also reuses the session's immutable descriptor catalogue,
// avoiding regeneration or JSON marshalling on the audible update path.
func NewUpdatedConfig(previous Config, document audiobuf.Document, selected ops.Range, graph protocol.EffectGraph, wet float64, bypass bool, provider effectchain.IRProvider) (Config, error) {
	return newConfig(document, selected, graph, wet, bypass, provider, true, previous.catalogue)
}

func newConfig(document audiobuf.Document, selected ops.Range, graph protocol.EffectGraph, wet float64, bypass bool, provider effectchain.IRProvider, proven bool, catalogue []protocol.EffectDescriptor) (Config, error) {
	if document.Channels() < 1 || document.Channels() > 8 || selected.Start < 0 || selected.End <= selected.Start || selected.End > document.Frames() || selected.ChannelMask <= 0 || selected.ChannelMask&((1<<document.Channels())-1) != selected.ChannelMask {
		return Config{}, fmt.Errorf("effects.configure: valid nonempty document selection required")
	}
	if math.IsNaN(wet) || math.IsInf(wet, 0) || wet < 0 || wet > 1 {
		return Config{}, fmt.Errorf("effects.configure: wet must be finite in [0,1]")
	}
	descriptors := catalogue
	if descriptors == nil {
		var err error
		descriptors, err = Descriptors(float64(document.SampleRate()))
		if err != nil {
			return Config{}, err
		}
	}
	if err := validateGraph(graph, descriptors, document.SampleRate(), selected.ChannelMask, provider); err != nil {
		return Config{}, err
	}
	encoded, err := json.Marshal(graph)
	if err != nil {
		return Config{}, fmt.Errorf("effects.configure: encode graph: %w", err)
	}
	if len(encoded) > 64<<10 {
		return Config{}, fmt.Errorf("effects.configure: graph exceeds 64 KiB")
	}
	if err := validateResources(graph, string(encoded), document.SampleRate(), selected.ChannelMask, provider); err != nil {
		return Config{}, err
	}
	for channel := range document.Channels() {
		if proven {
			break
		}
		if selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		data, _ := document.Channel(channel)
		if _, err := data.FinitePeak(selected.Start, selected.End); err != nil {
			return Config{}, fmt.Errorf("effects.configure: channel %d: %w", channel, err)
		}
	}
	indices := make([]int, 0, document.Channels())
	for channel := range document.Channels() {
		if selected.ChannelMask&(1<<channel) != 0 {
			indices = append(indices, channel)
		}
	}
	return Config{Graph: string(encoded), Wet: wet, Bypass: bypass, Provider: provider, catalogue: descriptors, sourceChannels: indices}, nil
}

func ValidateResponseGraph(graph protocol.EffectGraph, descriptors []protocol.EffectDescriptor, rate int) error {
	if err := validateGraph(graph, descriptors, rate, 3, nil); err != nil {
		return err
	}
	encoded, err := json.Marshal(graph)
	if err != nil {
		return fmt.Errorf("effects.response: encode graph: %w", err)
	}
	if len(encoded) > 64<<10 {
		return fmt.Errorf("effects.response: graph exceeds 64 KiB")
	}
	return validateResources(graph, string(encoded), rate, 3, nil)
}

func validateGraph(graph protocol.EffectGraph, descriptors []protocol.EffectDescriptor, rate, mask int, provider effectchain.IRProvider) error {
	if len(graph.Nodes) < 2 || len(graph.Nodes) > MaxNodes || len(graph.Connections) < 1 || len(graph.Connections) > 128 {
		return fmt.Errorf("effects.graph: graph requires 2..%d nodes and 1..128 connections", MaxNodes)
	}
	catalogue := make(map[string]protocol.EffectDescriptor, len(descriptors))
	for _, descriptor := range descriptors {
		catalogue[descriptor.ID] = descriptor
	}
	nodes := make(map[string]protocol.EffectNode, len(graph.Nodes))
	for _, node := range graph.Nodes {
		if node.ID == "" || len(node.ID) > 128 {
			return fmt.Errorf("effects.graph: node ID must contain 1..128 bytes")
		}
		if _, exists := nodes[node.ID]; exists {
			return fmt.Errorf("effects.graph: duplicate node %q", node.ID)
		}
		nodes[node.ID] = node
		if node.ID == effectchain.InputNodeID || node.ID == effectchain.OutputNodeID {
			if node.Type != node.ID || len(node.Params) != 0 {
				return fmt.Errorf("effects.graph: reserved I/O node %q has invalid type or parameters", node.ID)
			}
			continue
		}
		descriptor, exists := catalogue[node.Type]
		if !exists {
			return fmt.Errorf("effects.graph: unknown effect %q", node.Type)
		}
		if descriptor.ChannelMode == "stereo" {
			for channel := 0; channel < 8; channel += 2 {
				pair := (mask >> channel) & 3
				if pair != 0 && pair != 3 {
					return fmt.Errorf("effects.graph: %s requires complete adjacent stereo channel pairs", node.Type)
				}
			}
		}
		if err := validateParameters(node, descriptor); err != nil {
			return err
		}
		if node.Type == "reverb-conv" {
			index, ok := number(node.Params["irIndex"])
			if !ok || index != math.Trunc(index) || index < 0 || index > math.MaxInt32 || provider == nil {
				return fmt.Errorf("effects.graph: convolution requires a loaded irIndex")
			}
			samples, irRate, found := provider.GetIR(int(index))
			if !found || len(samples) == 0 || len(samples[0]) == 0 || irRate != float64(rate) {
				return fmt.Errorf("effects.graph: convolution IR must exist and match the document sample rate")
			}
		}
	}
	if _, ok := nodes[effectchain.InputNodeID]; !ok {
		return fmt.Errorf("effects.graph: missing _input")
	}
	if _, ok := nodes[effectchain.OutputNodeID]; !ok {
		return fmt.Errorf("effects.graph: missing _output")
	}
	incoming := make(map[string]int, len(nodes))
	outgoing := make(map[string][]string, len(nodes))
	reverse := make(map[string][]string, len(nodes))
	seen := make(map[protocol.EffectConnection]bool, len(graph.Connections))
	for _, edge := range graph.Connections {
		_, from := nodes[edge.From]
		_, to := nodes[edge.To]
		if !from || !to || edge.From == edge.To || edge.To == effectchain.InputNodeID || edge.From == effectchain.OutputNodeID || edge.FromPortIndex < 0 || edge.FromPortIndex > 1 || edge.ToPortIndex < 0 || edge.ToPortIndex > 1 || seen[edge] {
			return fmt.Errorf("effects.graph: invalid or duplicate connection")
		}
		if edge.FromPortIndex != 0 || (edge.ToPortIndex != 0 && nodes[edge.To].Type != "dyn-lookahead" && nodes[edge.To].Type != "vocoder") {
			return fmt.Errorf("effects.graph: unsupported connection port")
		}
		seen[edge] = true
		incoming[edge.To]++
		outgoing[edge.From] = append(outgoing[edge.From], edge.To)
		reverse[edge.To] = append(reverse[edge.To], edge.From)
	}
	queue := make([]string, 0, len(nodes))
	for id := range nodes {
		if incoming[id] == 0 {
			queue = append(queue, id)
		}
	}
	for head := 0; head < len(queue); head++ {
		for _, child := range outgoing[queue[head]] {
			incoming[child]--
			if incoming[child] == 0 {
				queue = append(queue, child)
			}
		}
	}
	if len(queue) != len(nodes) {
		return fmt.Errorf("effects.graph: cycle")
	}
	for _, direction := range []struct {
		start string
		edges map[string][]string
	}{{effectchain.InputNodeID, outgoing}, {effectchain.OutputNodeID, reverse}} {
		reachable := map[string]bool{direction.start: true}
		pending := []string{direction.start}
		for head := 0; head < len(pending); head++ {
			for _, next := range direction.edges[pending[head]] {
				if !reachable[next] {
					reachable[next] = true
					pending = append(pending, next)
				}
			}
		}
		if len(reachable) != len(nodes) {
			return fmt.Errorf("effects.graph: every node must lie on an input-to-output path")
		}
	}
	return nil
}

func number(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	default:
		return 0, false
	}
}

func validateParameters(node protocol.EffectNode, descriptor protocol.EffectDescriptor) error {
	parameters := make(map[string]protocol.EffectParameterDescriptor, len(descriptor.Parameters))
	for _, p := range descriptor.Parameters {
		parameters[p.ID] = p
	}
	for id, value := range node.Params {
		parameter, ok := parameters[id]
		if !ok {
			return fmt.Errorf("effects.graph: %s has unknown parameter %q", node.Type, id)
		}
		if parameter.Type == "enum" {
			text, ok := value.(string)
			found := false
			for _, option := range parameter.Options {
				if text == option.Value {
					found = true
					break
				}
			}
			if !ok || !found {
				return fmt.Errorf("effects.graph: invalid enum %s.%s", node.Type, id)
			}
			continue
		}
		v, ok := number(value)
		if parameter.Type == "boolean" {
			if boolean, isBoolean := value.(bool); isBoolean {
				ok = true
				v = 0
				if boolean {
					v = 1
				}
			}
		}
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) || v < parameter.Min || v > parameter.Max || (parameter.Type == "boolean" && v != 0 && v != 1) {
			return fmt.Errorf("effects.graph: parameter %s.%s is outside its descriptor range", node.Type, id)
		}
	}
	return nil
}

func (config Config) NewChain(rate, channels int) (*effectchain.Chain, error) {
	chain := effectchain.New(effectchain.Context{SampleRate: float64(rate)}, effectchain.DefaultRegistry(effectchain.WithIRProvider(config.Provider), effectchain.WithSourceChannelMap(config.sourceChannels)))
	if err := chain.LoadGraph(config.Graph); err != nil {
		return nil, fmt.Errorf("effects.chain: load: %w", err)
	}
	if !chain.HasGraph() {
		return nil, fmt.Errorf("effects.chain: missing valid I/O graph")
	}
	if err := chain.PreparePlanar(channels, Quantum); err != nil {
		return nil, fmt.Errorf("effects.chain: prepare: %w", err)
	}
	return chain, nil
}
