package effects

import (
	"context"
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
)

func TestEffectsPublicFactoriesRejectInvalidLimitsAndRuntimeShapes(t *testing.T) {
	document := testDocument(t, 129, 2)
	selected := ops.Range{Start: 0, End: 129, ChannelMask: 3}
	config, err := NewConfig(document, selected, testGraph("ringmod", map[string]any{"carrierHz": 750}), 1, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, limits := range []process.Limits{{MaxOutputBytes: -1}, {MaxOutputBytes: process.DefaultMaxOutputBytes + 1}} {
		if _, err := NewJob(document, selected, config, limits); err == nil {
			t.Fatal("invalid limits accepted")
		}
	}
	if _, err := NewJob(audiobuf.Document{}, selected, config, process.Limits{}); err == nil {
		t.Fatal("invalid job document accepted")
	}
	for _, graph := range []string{"invalid", "{}"} {
		invalid := Config{Graph: graph, Wet: 1}
		if _, err := invalid.NewChain(48000, 2); err == nil {
			t.Fatal("invalid runtime graph accepted")
		}
		if _, err := NewStream(document, selected, invalid); err == nil {
			t.Fatal("invalid stream graph accepted")
		}
		if _, err := NewJob(document, selected, invalid, process.Limits{}); err == nil {
			t.Fatal("invalid job graph accepted")
		}
	}
	if _, err := config.NewChain(48000, 0); err == nil {
		t.Fatal("invalid planar layout accepted")
	}
}

func TestEffectsReadValidationAndParameterOwnership(t *testing.T) {
	document := testDocument(t, 257, 2)
	selected := ops.Range{Start: 7, End: 250, ChannelMask: 3}
	graph := testGraph("ringmod", map[string]any{"carrierHz": 750})
	config, err := NewConfig(document, selected, graph, 1, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	graph.Nodes[1].Params["carrierHz"] = 1700
	stream, err := NewStream(document, selected, config)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		dst   [][]float64
		start int64
	}{{nil, 0}, {[][]float64{make([]float64, 4)}, 0}, {[][]float64{make([]float64, 4), make([]float64, 3)}, 0}, {[][]float64{make([]float64, 4), make([]float64, 4)}, -1}, {[][]float64{make([]float64, 4), make([]float64, 4)}, 255}} {
		if err := stream.Read(tc.dst, tc.start); err == nil {
			t.Fatal("invalid read accepted")
		}
	}
	got := collectStream(t, stream, 0, 257, 7, 2)
	reference, err := NewStream(document, selected, config)
	if err != nil {
		t.Fatal(err)
	}
	want := collectStream(t, reference, 0, 257, 257, 2)
	if !reflect.DeepEqual(got, want) {
		t.Fatal("invalid read advanced state or graph input mutation leaked")
	}
	updated, err := NewUpdatedConfig(config, document, selected, testGraph("ringmod", map[string]any{"carrierHz": 1500}), .5, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Graph == config.Graph || updated.Wet != .5 {
		t.Fatal("cached catalogue update lost graph/mix")
	}
	if stream.Selection() != selected {
		t.Fatal("source selection changed")
	}
	stream.SetMix(0, true)
	if !stream.Identity() {
		t.Fatal("bypass identity absent")
	}
	descriptors, err := Descriptors(48000)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateResponseGraph(testGraph("filter-allpass", nil), descriptors, 48000); err != nil {
		t.Fatal(err)
	}
}

func TestEffectsIdentityCompletionPeakAndNilContextFailure(t *testing.T) {
	document := testDocument(t, 513, 2)
	selected := ops.Range{Start: 3, End: 510, ChannelMask: 1}
	config, err := NewConfig(document, selected, testGraph("ringmod", nil), 0, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewJob(document, selected, config, process.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if !job.Identity() {
		t.Fatal("zero wet should retain source identity")
	}
	candidate := finishJob(t, job)
	if _, err := job.Step(context.Background()); err != nil {
		t.Fatal("complete step is not idempotent", err)
	}
	if got, err := job.MemoryDocument(); err != nil || got.Frames() != candidate.Frames() {
		t.Fatal("complete memory accounting")
	}
	peak, unsafe := job.Peak()
	source, _ := document.Channel(0)
	want, _ := source.FinitePeak(selected.Start, selected.End)
	if unsafe || math.Abs(peak-want) > 1e-15 {
		t.Fatal("identity peak inaccurate", peak, want)
	}
	for channel := range 2 {
		a, b := make([]float32, 513), make([]float32, 513)
		original, _ := document.Channel(channel)
		output, _ := candidate.Channel(channel)
		original.Read(a, 0)
		output.Read(b, 0)
		if !reflect.DeepEqual(a, b) {
			t.Fatal("zero wet materialized changed audio")
		}
	}
	failed, err := NewJob(document, selected, config, process.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	var missingContext context.Context
	if _, err := failed.Step(missingContext); err == nil {
		t.Fatal("nil context accepted")
	}
	if _, err := failed.Step(context.Background()); err == nil {
		t.Fatal("failed job resumed")
	}
}
