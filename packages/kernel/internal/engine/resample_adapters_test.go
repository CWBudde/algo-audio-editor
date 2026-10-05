package engine

import (
	"context"
	"fmt"
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestResampleAdaptersShareFiniteSamplesAndTail(t *testing.T) {
	for _, rates := range [][2]int{{44100, 48000}, {48000, 44100}, {96000, 48000}, {8000, 384000}, {384000, 8000}} {
		for _, frames := range []int{1, 7, 2113, 65539} {
			if frames == 65539 && (rates[0] == 8000 || rates[0] == 384000) {
				continue
			}
			t.Run(fmt.Sprintf("%d-%d/%d", rates[0], rates[1], frames), func(t *testing.T) {
				input := make([]float32, frames*2)
				for i := range frames {
					input[i*2] = float32(.2 + .1*math.Sin(float64(i)*.07))
					input[i*2+1] = float32(-.1 + .15*math.Cos(float64(i)*.11))
				}
				input[0], input[len(input)-1] = 1, -.75
				e := transportEngine(t, input, 2, rates[0], rates[1])
				selection := ops.Range{End: int64(frames), ChannelMask: 3}
				clip, err := ops.NewClipboard(e.doc.document, selection)
				if err != nil {
					t.Fatal(err)
				}
				converted, err := convertClipboard(clip, rates[1], 2)
				if err != nil {
					t.Fatal(err)
				}
				stepper, err := process.NewOperation(e.doc.document, selection, process.Settings{Operation: "resample", SampleRate: rates[1], Quality: "balanced"}, process.Limits{})
				if err != nil {
					t.Fatal(err)
				}
				for {
					progress, err := stepper.Step(context.Background())
					if err != nil {
						t.Fatal(err)
					}
					if progress.Done {
						break
					}
				}
				candidate, err := stepper.Result()
				if err != nil {
					t.Fatal(err)
				}
				count := (frames*rates[1] + rates[0] - 1) / rates[0]
				if candidate.Frames() != int64(count) || converted.Frames() != int64(count) {
					t.Fatal("adapters changed exact finite duration")
				}
				playRange(t, e, 0, int64(frames), false)
				played, positions := make([]float32, count*2), make([]int64, count)
				for start := 0; start < count; start += 257 {
					end := min(count, start+257)
					if n := e.RenderWithPositions(played[start*2:end*2], positions[start:end]); n != end-start {
						t.Fatalf("transport produced %d of %d requested frames", n, end-start)
					}
				}
				if positions[count-1] != int64(frames) || e.playback.transport.playing {
					t.Fatal("transport omitted final source-position tag")
				}
				for channel := range 2 {
					fromClip, fromCandidate := make([]float32, count), make([]float32, count)
					part, _ := candidate.Channel(channel)
					if converted.Read(fromClip, channel, 0) != count || part.Read(fromCandidate, 0) != count {
						t.Fatal("short adapter output")
					}
					for i := range count {
						if math.Float32bits(fromClip[i]) != math.Float32bits(fromCandidate[i]) || math.Float32bits(fromClip[i]) != math.Float32bits(played[i*2+channel]) {
							t.Fatalf("channel %d sample %d: clipboard=%v candidate=%v transport=%v", channel, i, fromClip[i], fromCandidate[i], played[i*2+channel])
						}
					}
				}
			})
		}
	}
}

func TestResampledEffectLoopResetsChainAndKeepsFIRHistory(t *testing.T) {
	input := make([]float32, 514)
	for i := range input {
		input[i] = .25
	}
	prepare := func(outRate int) *Engine {
		e := transportEngine(t, input, 1, 48000, outRate)
		p := effectParams(e, 7, 264, 1, "ringmod", map[string]any{"carrierHz": 750.0})
		started, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
		if err != nil {
			t.Fatal(err)
		}
		end := p.End
		if _, err := e.playDocument(protocol.TransportPlayParams{Start: p.Start, End: &end, Loop: true, EffectPreviewID: started.PreviewID}); err != nil {
			t.Fatal(err)
		}
		return e
	}
	const count = 7000
	baseline := prepare(48000)
	periodic := make([]float32, (count+200)*48000/44100+200)
	if baseline.Render(periodic) != len(periodic) {
		t.Fatal("baseline effect loop ended")
	}
	want := directResampled(t, periodic, 48000, 44100, count)
	e := prepare(44100)
	got, tags := make([]float32, count), make([]int64, count)
	for start := 0; start < count; start += 101 {
		end := min(start+101, count)
		if n := e.RenderWithPositions(got[start:end], tags[start:end]); n != end-start {
			t.Fatal("resampled effect loop ended")
		}
	}
	for i := range count {
		// The baseline rounds effect output to float32 before the independent
		// FIR reference; live preview retains float64 until the final copy.
		if math.Abs(float64(got[i]-want[i])) > 2e-7 {
			t.Fatalf("effect/FIR history changed at %d: got %v want %v", i, got[i], want[i])
		}
		if tags[i] != int64(7+((i+1)*48000/44100)%257) {
			t.Fatalf("loop source-position tag %d: %d", i, tags[i])
		}
	}
	if _, err := e.seekDocument(protocol.TransportSeekParams{Frame: 7}); err != nil {
		t.Fatal(err)
	}
	restarted := make([]float32, count)
	if e.Render(restarted) != count {
		t.Fatal("seek restarted loop ended")
	}
	assertEditBits(t, restarted, got)
	buffer := make([]float32, 127)
	if allocations := testing.AllocsPerRun(50, func() { e.Render(buffer) }); allocations != 0 {
		t.Fatalf("resampled effect render allocates %v", allocations)
	}
}
