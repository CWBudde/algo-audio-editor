package effects

import (
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestRackRejectsMalformedGraphAndParameterContractsBeforeDSP(t *testing.T) {
	document := testDocument(t, 513, 2)
	selected := ops.Range{Start: 3, End: 510, ChannelMask: 3}
	for _, tc := range []struct {
		name   string
		change func(*protocol.EffectGraph)
	}{
		{"missing-input", func(g *protocol.EffectGraph) { g.Nodes = g.Nodes[1:] }},
		{"missing-output", func(g *protocol.EffectGraph) { g.Nodes = g.Nodes[:2] }},
		{"duplicate-id", func(g *protocol.EffectGraph) { g.Nodes[1].ID = "_input" }},
		{"empty-id", func(g *protocol.EffectGraph) { g.Nodes[1].ID = "" }},
		{"long-id", func(g *protocol.EffectGraph) { g.Nodes[1].ID = strings.Repeat("a", 129) }},
		{"reserved-type", func(g *protocol.EffectGraph) { g.Nodes[0].Type = "ringmod" }},
		{"reserved-param", func(g *protocol.EffectGraph) { g.Nodes[0].Params = map[string]any{"carrierHz": 1} }},
		{"unknown-effect", func(g *protocol.EffectGraph) { g.Nodes[1].Type = "unknown" }},
		{"unknown-param", func(g *protocol.EffectGraph) { g.Nodes[1].Params = map[string]any{"misspelling": 1} }},
		{"nonfinite-param", func(g *protocol.EffectGraph) { g.Nodes[1].Params = map[string]any{"carrierHz": math.Inf(1)} }},
		{"outofrange-param", func(g *protocol.EffectGraph) { g.Nodes[1].Params = map[string]any{"carrierHz": -1.0} }},
		{"string-for-number", func(g *protocol.EffectGraph) { g.Nodes[1].Params = map[string]any{"carrierHz": "750"} }},
		{"array-for-number", func(g *protocol.EffectGraph) { g.Nodes[1].Params = map[string]any{"carrierHz": []float64{750}} }},
		{"boolean-for-number", func(g *protocol.EffectGraph) { g.Nodes[1].Params = map[string]any{"carrierHz": true} }},
		{"null-for-number", func(g *protocol.EffectGraph) { g.Nodes[1].Params = map[string]any{"carrierHz": nil} }},
		{"object-for-number", func(g *protocol.EffectGraph) {
			g.Nodes[1].Params = map[string]any{"carrierHz": map[string]float64{"hz": 750}}
		}},
		{"unknown-edge", func(g *protocol.EffectGraph) { g.Connections[0].From = "missing" }},
		{"duplicate-edge", func(g *protocol.EffectGraph) { g.Connections = append(g.Connections, g.Connections[0]) }},
		{"self-edge", func(g *protocol.EffectGraph) { g.Connections[0].To = "_input" }},
		{"output-edge", func(g *protocol.EffectGraph) { g.Connections[0].From = "_output" }},
		{"negative-port", func(g *protocol.EffectGraph) { g.Connections[0].FromPortIndex = -1 }},
		{"unsupported-port", func(g *protocol.EffectGraph) { g.Connections[0].ToPortIndex = 1 }},
		{"missing-path", func(g *protocol.EffectGraph) { g.Connections = g.Connections[1:] }},
		{"cycle", func(g *protocol.EffectGraph) {
			g.Nodes = append(g.Nodes, protocol.EffectNode{ID: "second", Type: "ringmod"})
			g.Connections = append(g.Connections, protocol.EffectConnection{From: "fx", To: "second"}, protocol.EffectConnection{From: "second", To: "fx"})
		}},
		{"disconnected", func(g *protocol.EffectGraph) {
			g.Nodes = append(g.Nodes, protocol.EffectNode{ID: "unreachable", Type: "ringmod"})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			graph := testGraph("ringmod", nil)
			tc.change(&graph)
			if _, err := NewConfig(document, selected, graph, 1, false, nil); err == nil {
				t.Fatal("invalid graph accepted")
			}
		})
	}
	for _, wet := range []float64{-1, 2, math.NaN(), math.Inf(1)} {
		if _, err := NewConfig(document, selected, testGraph("ringmod", nil), wet, false, nil); err == nil {
			t.Fatal("invalid wet accepted")
		}
	}
	for _, selection := range []ops.Range{{Start: 0, End: 0, ChannelMask: 3}, {Start: -1, End: 3, ChannelMask: 3}, {Start: 0, End: 514, ChannelMask: 3}, {Start: 0, End: 3, ChannelMask: 0}, {Start: 0, End: 3, ChannelMask: 4}} {
		if _, err := NewConfig(document, selection, testGraph("ringmod", nil), 1, false, nil); err == nil {
			t.Fatal("invalid selection accepted")
		}
	}
	if _, err := NewConfig(audiobuf.Document{}, selected, testGraph("ringmod", nil), 1, false, nil); err == nil {
		t.Fatal("absent document accepted")
	}
}

func TestRackStereoEnumBooleanAndConvolutionContracts(t *testing.T) {
	document := testDocument(t, 128, 4)
	selection := ops.Range{Start: 0, End: 128, ChannelMask: 5}
	if _, err := NewConfig(document, selection, testGraph("widener", nil), 1, false, nil); err == nil {
		t.Fatal("nonadjacent channels paired silently")
	}
	selection.ChannelMask = 3
	for _, params := range []map[string]any{{"mode": "invented"}, {"mode": 1.0}} {
		if _, err := NewConfig(document, selection, testGraph("distortion", params), 1, false, nil); err == nil {
			t.Fatal("invalid enum accepted")
		}
	}
	if _, err := NewConfig(document, selection, testGraph("dist-cheb", map[string]any{"invert": 2.0}), 1, false, nil); err == nil {
		t.Fatal("boolean outside0/1 accepted")
	}
	if _, err := NewConfig(document, selection, testGraph("dist-cheb", map[string]any{"invert": true}), 1, false, nil); err != nil {
		t.Fatal(err)
	}
	for _, params := range []map[string]any{nil, {"irIndex": -1.0}, {"irIndex": 1.25}, {"irIndex": "one"}, {"irIndex": 2.0}} {
		if _, err := NewConfig(document, selection, testGraph("reverb-conv", params), 1, false, fixtureIR{}); err == nil {
			t.Fatal("missing/unavailable IR accepted", params)
		}
	}
	if _, err := NewConfig(document, selection, testGraph("reverb-conv", map[string]any{"irIndex": 1.0}), 1, false, nil); err == nil {
		t.Fatal("absent IR provider accepted")
	}
}

func TestRackFiniteProofPreciselySelectedRangeAndChannels(t *testing.T) {
	unsafe := float32(math.Inf(1))
	document, err := audiobuf.NewDocument([]audiobuf.Channel{audiobuf.NewChannel([]float32{unsafe, .1, .2, unsafe}), audiobuf.NewChannel([]float32{unsafe, unsafe, unsafe, unsafe})}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	selected := ops.Range{Start: 1, End: 3, ChannelMask: 1}
	if _, err := NewConfig(document, selected, testGraph("ringmod", nil), 1, false, nil); err != nil {
		t.Fatal("unselected unsafe audio affected proof", err)
	}
	selected.Start = 0
	if _, err := NewConfig(document, selected, testGraph("ringmod", nil), 1, false, nil); err == nil {
		t.Fatal("selected unsafe range accepted")
	}
	selected.Start = 1
	selected.ChannelMask = 3
	if _, err := NewConfig(document, selected, testGraph("ringmod", nil), 1, false, nil); err == nil {
		t.Fatal("selected unsafe channel accepted")
	}
}

type largeIR struct{ samples []float64 }

func (p largeIR) GetIR(index int) ([][]float64, float64, bool) {
	return [][]float64{p.samples}, 48000, index == 1
}

func TestRackResourceBudgetRejectsMultipliedIRBeforeRuntimeConstruction(t *testing.T) {
	document := testDocument(t, 128, 8)
	selected := ops.Range{Start: 0, End: 128, ChannelMask: 255}
	provider := largeIR{samples: make([]float64, 300000)}
	if _, err := NewConfig(document, selected, testGraph("reverb-conv", map[string]any{"irIndex": 1}), 1, false, provider); err == nil {
		t.Fatal("eight independent convolution workspaces exceed worker budget")
	}
	selected.ChannelMask = 1
	if _, err := NewConfig(document, selected, testGraph("reverb-conv", map[string]any{"irIndex": 1}), 1, false, provider); err != nil {
		t.Fatal("bounded mono convolution rejected", err)
	}
}

func TestRackWorkspaceHighestRateAndChannelMultiplicity(t *testing.T) {
	channels := make([]audiobuf.Channel, 8)
	for channel := range channels {
		channels[channel] = audiobuf.NewChannel([]float32{.1, .2, .3})
	}
	document, err := audiobuf.NewDocument(channels, 384000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	selected := ops.Range{Start: 0, End: 3, ChannelMask: 255}
	if _, err := NewConfig(document, selected, testGraph("delay", map[string]any{"time": .001}), 1, false, nil); err == nil {
		t.Fatal("configured short delay hid its fixed-capacity eight-channel histories")
	}
	selected.ChannelMask = 3
	if _, err := NewConfig(document, selected, testGraph("delay", map[string]any{"time": 2.0}), 1, false, nil); err != nil {
		t.Fatal("one bounded stereo delay should fit", err)
	}
	selected.ChannelMask = 255
	if _, err := NewConfig(document, selected, testGraph("pitch-time", map[string]any{"sequence": 120.0, "overlap": 4.0, "search": 40.0, "semitones": -24.0}), 1, false, nil); err == nil {
		t.Fatal("highest-rate WSOLA power-of-two history exceeded worker budget")
	}
	graph := protocol.EffectGraph{Nodes: []protocol.EffectNode{{ID: "_input", Type: "_input"}, {ID: "_output", Type: "_output"}}}
	previous := "_input"
	for node := range 32 {
		id := "delay-" + strconv.Itoa(node)
		graph.Nodes = append(graph.Nodes, protocol.EffectNode{ID: id, Type: "delay", Params: map[string]any{"time": 2.0}})
		graph.Connections = append(graph.Connections, protocol.EffectConnection{From: previous, To: id})
		previous = id
	}
	graph.Connections = append(graph.Connections, protocol.EffectConnection{From: previous, To: "_output"})
	if _, err := NewConfig(document, selected, graph, 1, false, nil); err == nil {
		t.Fatal("highest-rate/channel rack multiplication ignored workspace budget")
	}
	descriptors, err := Descriptors(384000)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateResponseGraph(graph, descriptors, 384000); err == nil {
		t.Fatal("unsupported response rack constructed large histories before rejecting response")
	}
	standardRate, err := audiobuf.NewDocument(channels, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	for node := range graph.Nodes {
		if graph.Nodes[node].Type == "delay" {
			graph.Nodes[node].Params["time"] = .25
		}
	}
	if _, err := NewConfig(standardRate, selected, graph, 1, false, nil); err == nil {
		t.Fatal("32 standard-rate short delays hid fixed 2-second storage per channel")
	}
}
