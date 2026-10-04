//go:build js && wasm

package main

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"syscall/js"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestEffectsBridgeRealStereoPreviewApplyResponseAndOwnedIR(t *testing.T) {
	api := newKernelAPI(engine.New())
	request := func(method string, p any, data ...js.Value) protocol.Response {
		t.Helper()
		payload, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		args := []any{method, string(payload)}
		for _, value := range data {
			args = append(args, value)
		}
		var response protocol.Response
		if err := json.Unmarshal([]byte(api.Call("call", args...).String()), &response); err != nil {
			t.Fatal(err)
		}
		if !response.OK {
			t.Fatal(method, response.Error)
		}
		return response
	}
	hello := request("hello", nil)
	var identity protocol.HelloResult
	if err := json.Unmarshal(hello.Result, &identity); err != nil || identity.ProtocolVersion != protocol.Version {
		t.Fatal("actual WASM effects ABI", identity, err)
	}
	u8 := js.Global().Get("Uint8Array")
	input := make([]byte, 257*2*4)
	for frame := range 257 {
		binary.LittleEndian.PutUint32(input[(frame*2)*4:], math.Float32bits(.5))
		binary.LittleEndian.PutUint32(input[(frame*2+1)*4:], math.Float32bits(-.5))
	}
	inputJS := u8.New(len(input))
	js.CopyBytesToJS(inputJS, input)
	opened := request("doc.importBinary", protocol.BinaryDocumentParams{Name: "effects", SampleRate: 48000, Channels: 2, Frames: 257, NextAnchorID: 1}, inputJS)
	inputJS.Call("fill", 0)
	var document protocol.DocumentInfoResult
	if err := json.Unmarshal(opened.Result, &document); err != nil {
		t.Fatal(err)
	}
	catalog := request("effects.list", nil)
	var listed protocol.EffectsListResult
	if err := json.Unmarshal(catalog.Result, &listed); err != nil || len(listed.Effects) < 51 {
		t.Fatal("actual WASM catalogue", len(listed.Effects), err)
	}
	graph := protocol.EffectGraph{Nodes: []protocol.EffectNode{{ID: "_input", Type: "_input"}, {ID: "fx", Type: "widener", Params: map[string]any{"width": 0.0, "mix": 1.0}}, {ID: "_output", Type: "_output"}}, Connections: []protocol.EffectConnection{{From: "_input", To: "fx"}, {From: "fx", To: "_output"}}}
	p := protocol.EffectsPreviewParams{SelectionResult: protocol.SelectionResult{DocumentID: document.DocumentID, SelectionRange: protocol.SelectionRange{Start: 0, End: 257, ChannelMask: 3}}, Graph: graph}
	started := request("effects.preview.start", p)
	var preview protocol.EffectsPreviewResult
	if err := json.Unmarshal(started.Result, &preview); err != nil {
		t.Fatal(err)
	}
	end := int64(257)
	request("transport.play", protocol.TransportPlayParams{Start: 0, End: &end, EffectPreviewID: preview.PreviewID})
	outputJS := u8.New(len(input))
	positionsJS := u8.New(257 * 8)
	if n := api.Call("render", outputJS, 257, positionsJS).Int(); n != 257 {
		t.Fatal("actual effects render frame count", n)
	}
	output := make([]byte, len(input))
	js.CopyBytesToGo(output, outputJS)
	for frame := range 257 {
		for channel := range 2 {
			value := math.Float32frombits(binary.LittleEndian.Uint32(output[(frame*2+channel)*4:]))
			if value != 0 {
				t.Fatal("stereo mid collapse should cancel opposite channels", frame, channel, value)
			}
		}
	}
	positionBytes := make([]byte, 257*8)
	js.CopyBytesToGo(positionBytes, positionsJS)
	if int64(binary.LittleEndian.Uint64(positionBytes[256*8:])) != 257 {
		t.Fatal("effect transport lost exact document tag")
	}
	request("effects.response", protocol.EffectsResponseParams{EffectID: "filter-allpass", Points: 9})
	curveJS := api.Call("takeData")
	curve := make([]byte, curveJS.Get("byteLength").Int())
	js.CopyBytesToGo(curve, curveJS)
	if len(curve) != 9*16 || api.Call("takeData").Get("byteLength").Int() != 0 {
		t.Fatal("response ownership")
	}
	for point := range 9 {
		if math.Abs(math.Float64frombits(binary.LittleEndian.Uint64(curve[point*16+8:]))) > 1e-8 {
			t.Fatal("allpass response actual WASM")
		}
	}
	// IR is decoded and copied by the kernel; corrupting the transferred file
	// after load must not change convolution's separately owned resource.
	irFile := make([]byte, 52)
	copy(irFile[:4], "RIFF")
	binary.LittleEndian.PutUint32(irFile[4:], 44)
	copy(irFile[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(irFile[16:], 16)
	binary.LittleEndian.PutUint16(irFile[20:], 3)
	binary.LittleEndian.PutUint16(irFile[22:], 1)
	binary.LittleEndian.PutUint32(irFile[24:], 48000)
	binary.LittleEndian.PutUint32(irFile[28:], 192000)
	binary.LittleEndian.PutUint16(irFile[32:], 4)
	binary.LittleEndian.PutUint16(irFile[34:], 32)
	copy(irFile[36:40], "data")
	binary.LittleEndian.PutUint32(irFile[40:], 8)
	binary.LittleEndian.PutUint32(irFile[44:], math.Float32bits(1))
	binary.LittleEndian.PutUint32(irFile[48:], math.Float32bits(.5))
	irJS := u8.New(len(irFile))
	js.CopyBytesToJS(irJS, irFile)
	loaded := request("effects.ir.load", protocol.EffectsIRLoadParams{DocumentID: document.DocumentID, Name: "impulse"}, irJS)
	irJS.Call("fill", 0)
	var ir protocol.EffectsIRInfo
	if err := json.Unmarshal(loaded.Result, &ir); err != nil || ir.Frames != 2 {
		t.Fatal("IR bridge", ir, err)
	}
	p.PreviewID = preview.PreviewID
	jobResponse := request("effects.apply", p)
	var job protocol.ProcessJobResult
	if err := json.Unmarshal(jobResponse.Result, &job); err != nil {
		t.Fatal(err)
	}
	params := protocol.ProcessJobParams{DocumentID: job.DocumentID, JobID: job.JobID}
	for job.State == "running" {
		response := request("process.stepBatch", params)
		if err := json.Unmarshal(response.Result, &job); err != nil {
			t.Fatal(err)
		}
	}
	request("process.exportCandidate", params)
	candidateJS := api.Call("takeData")
	candidate := make([]byte, candidateJS.Get("byteLength").Int())
	js.CopyBytesToGo(candidate, candidateJS)
	if len(candidate) != len(input) {
		t.Fatal("candidate bridge shape")
	}
	for offset := 0; offset < len(candidate); offset += 4 {
		if math.Float32frombits(binary.LittleEndian.Uint32(candidate[offset:])) != 0 {
			t.Fatal("offline differs from actual preview")
		}
	}
	request("process.commit", params)
	request("effects.ir.remove", protocol.EffectsIRRemoveParams{DocumentID: document.DocumentID, IRID: ir.IRID})
}

func TestEffectsBridgeSelectedPhysicalChannelUsesCorrespondingStereoIR(t *testing.T) {
	for _, mask := range []int{2, 5} {
		api := newKernelAPI(engine.New())
		request := func(method string, p any, data ...js.Value) protocol.Response {
			t.Helper()
			payload, err := json.Marshal(p)
			if err != nil {
				t.Fatal(err)
			}
			args := []any{method, string(payload)}
			for _, value := range data {
				args = append(args, value)
			}
			var response protocol.Response
			if err := json.Unmarshal([]byte(api.Call("call", args...).String()), &response); err != nil {
				t.Fatal(err)
			}
			if !response.OK {
				t.Fatal(method, response.Error)
			}
			return response
		}
		bytesType := js.Global().Get("Uint8Array")
		source := make([]byte, 601*4*4)
		for channel := range 4 {
			// Binary document transfer is planar; playback output is interleaved.
			binary.LittleEndian.PutUint32(source[(channel*601+7)*4:], math.Float32bits(float32(channel+1)/8))
		}
		sourceJS := bytesType.New(len(source))
		js.CopyBytesToJS(sourceJS, source)
		opened := request(protocol.MethodDocumentImportBinary, protocol.BinaryDocumentParams{Name: "physical", SampleRate: 48000, Channels: 4, Frames: 601, NextAnchorID: 1}, sourceJS)
		var document protocol.DocumentInfoResult
		if err := json.Unmarshal(opened.Result, &document); err != nil {
			t.Fatal(err)
		}
		request(protocol.MethodEngineConfigure, protocol.EngineConfigureParams{SampleRate: 48000, Channels: 4})
		impulse := make([]byte, 44+129*2*4)
		copy(impulse[:4], "RIFF")
		binary.LittleEndian.PutUint32(impulse[4:], uint32(len(impulse)-8))
		copy(impulse[8:16], "WAVEfmt ")
		binary.LittleEndian.PutUint32(impulse[16:], 16)
		binary.LittleEndian.PutUint16(impulse[20:], 3)
		binary.LittleEndian.PutUint16(impulse[22:], 2)
		binary.LittleEndian.PutUint32(impulse[24:], 48000)
		binary.LittleEndian.PutUint32(impulse[28:], 384000)
		binary.LittleEndian.PutUint16(impulse[32:], 8)
		binary.LittleEndian.PutUint16(impulse[34:], 32)
		copy(impulse[36:40], "data")
		binary.LittleEndian.PutUint32(impulse[40:], uint32(len(impulse)-44))
		binary.LittleEndian.PutUint32(impulse[44:], math.Float32bits(.5))
		binary.LittleEndian.PutUint32(impulse[48:], math.Float32bits(-.25))
		binary.LittleEndian.PutUint32(impulse[44+128*8:], math.Float32bits(.125))
		binary.LittleEndian.PutUint32(impulse[48+128*8:], math.Float32bits(.375))
		irJS := bytesType.New(len(impulse))
		js.CopyBytesToJS(irJS, impulse)
		loaded := request(protocol.MethodEffectsIRLoad, protocol.EffectsIRLoadParams{DocumentID: document.DocumentID}, irJS)
		var asset protocol.EffectsIRInfo
		if err := json.Unmarshal(loaded.Result, &asset); err != nil {
			t.Fatal(err)
		}
		graph := protocol.EffectGraph{Nodes: []protocol.EffectNode{{ID: "_input", Type: "_input"}, {ID: "fx", Type: "reverb-conv", Params: map[string]any{"irIndex": asset.IRID, "wet": 1.0}}, {ID: "_output", Type: "_output"}}, Connections: []protocol.EffectConnection{{From: "_input", To: "fx"}, {From: "fx", To: "_output"}}}
		params := protocol.EffectsPreviewParams{SelectionResult: protocol.SelectionResult{DocumentID: document.DocumentID, SelectionRange: protocol.SelectionRange{Start: 3, End: 590, ChannelMask: mask}}, Graph: graph}
		started := request(protocol.MethodEffectsPreviewStart, params)
		var preview protocol.EffectsPreviewResult
		if err := json.Unmarshal(started.Result, &preview); err != nil {
			t.Fatal(err)
		}
		end := int64(601)
		request(protocol.MethodTransportPlay, protocol.TransportPlayParams{End: &end, EffectPreviewID: preview.PreviewID})
		outputJS := bytesType.New(len(source))
		if frames := api.Call("render", outputJS, 601).Int(); frames != 601 {
			t.Fatal("physical-channel preview short", frames)
		}
		output := make([]byte, len(source))
		js.CopyBytesToGo(output, outputJS)
		for channel := range 4 {
			amplitude := float64(channel+1) / 8
			first, tail := amplitude, 0.0
			if mask&(1<<channel) != 0 {
				firstTap, tailTap := .5, .125
				if channel%2 == 1 {
					firstTap, tailTap = -.25, .375
				}
				first += amplitude * firstTap
				tail = amplitude * tailTap
			}
			actualFirst := math.Float32frombits(binary.LittleEndian.Uint32(output[(7*4+channel)*4:]))
			actualTail := math.Float32frombits(binary.LittleEndian.Uint32(output[(135*4+channel)*4:]))
			if math.Abs(float64(actualFirst)-first) > 1e-7 || math.Abs(float64(actualTail)-tail) > 1e-7 {
				t.Fatalf("mask%d physicalchannel%d: first%g tail%g want%g/%g", mask, channel, actualFirst, actualTail, first, tail)
			}
		}
		params.PreviewID = preview.PreviewID
		applied := request(protocol.MethodEffectsApply, params)
		var job protocol.ProcessJobResult
		if err := json.Unmarshal(applied.Result, &job); err != nil {
			t.Fatal(err)
		}
		target := protocol.ProcessJobParams{DocumentID: job.DocumentID, JobID: job.JobID}
		for job.State == "running" {
			step := request(protocol.MethodProcessStepBatch, target)
			if err := json.Unmarshal(step.Result, &job); err != nil {
				t.Fatal(err)
			}
		}
		request(protocol.MethodProcessExportCandidate, target)
		candidateJS := api.Call("takeData")
		candidate := make([]byte, candidateJS.Get("byteLength").Int())
		js.CopyBytesToGo(candidate, candidateJS)
		if len(candidate) != len(output) {
			t.Fatal("physical channel candidate shape")
		}
		for channel := range 4 {
			for frame := range 601 {
				for byteIndex := range 4 {
					if candidate[(channel*601+frame)*4+byteIndex] != output[(frame*4+channel)*4+byteIndex] {
						t.Fatalf("actual WASM preview/apply differs mask%d channel%d frame%d", mask, channel, frame)
					}
				}
			}
		}
		request(protocol.MethodProcessCancel, target)
	}
}
