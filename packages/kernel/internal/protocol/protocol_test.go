package protocol_test

import (
	_ "embed"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// Shared with the TypeScript processing runner test. Comparing raw JSON, not
// decoding back into Go structs, binds both ABI sides to the same field names
// and distinguishes explicit null metrics from omitted or capitalized keys.
//
//go:embed testdata/process-jobs.json
var processWireGolden []byte

func TestProcessJobWireGolden(t *testing.T) {
	base := protocol.ProcessJobResult{
		SelectionResult: protocol.SelectionResult{
			DocumentID: "doc-1", SelectionRange: protocol.SelectionRange{Start: 10, End: 30, ChannelMask: 5},
		},
		JobID: "job-1", State: "running", Operation: "gain", GainDB: 6,
		ProcessedFrames: 8, TotalFrames: 20, Peak: 0.5,
		Phase: "processing", PhaseCount: 1, GainResolved: true,
	}
	peak := base
	peak.Operation, peak.GainDB, peak.Peak = "normalize-peak", 0, 0
	peak.Phase, peak.PhaseCount, peak.GainResolved, peak.InputPeak = "analyzing", 2, false, 0.25
	peakTarget := -1.0
	peak.Target = &peakTarget
	lufs := base
	lufs.State, lufs.Operation, lufs.GainDB, lufs.Peak = "ready", "normalize-loudness", -5, 0.1405853
	lufs.Phase, lufs.PhaseIndex, lufs.PhaseCount, lufs.ProcessedFrames = "verifying", 2, 3, 20
	lufs.PlanningSteps, lufs.InputPeak = 2, 0.25
	input, predicted, output, target := -18.0, -23.0, -23.0000001, -23.0
	lufs.InputLUFS, lufs.PredictedLUFS, lufs.OutputLUFS, lufs.Target = &input, &predicted, &output, &target
	encoded, err := json.Marshal([]protocol.ProcessJobResult{base, peak, lufs})
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(processWireGolden, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Go process wire differs from shared TypeScript golden:\n got: %s\nwant: %s", encoded, processWireGolden)
	}
}
