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

func TestAnalysisBridgeReusableMeterAndAtomicValidation(t *testing.T) {
	api := newKernelAPI(engine.New())
	request := func(method string, params any) protocol.Response {
		payload, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		var response protocol.Response
		if err := json.Unmarshal([]byte(api.Call("call", method, string(payload)).String()), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	hello := request(protocol.MethodHello, nil)
	var info protocol.HelloResult
	if err := json.Unmarshal(hello.Result, &info); err != nil || info.ProtocolVersion != protocol.Version {
		t.Fatal(info, err)
	}
	dst := js.Global().Get("Uint8Array").New(protocol.MetersDataBytes)
	if n := api.Call("copyMeters", dst).Int(); n != 0 {
		t.Fatal("eager meters", n)
	}
	if !request(protocol.MethodMetersConfigure, protocol.MetersConfigureParams{}).OK {
		t.Fatal("enable meters")
	}
	output := js.Global().Get("Uint8Array").New(128 * 2 * 4)
	if n := api.Call("render", output, 128).Int(); n != 128 {
		t.Fatal(n)
	}
	if n := api.Call("copyMeters", dst).Int(); n != protocol.MetersDataBytes {
		t.Fatal(n)
	}
	data := make([]byte, protocol.MetersDataBytes)
	js.CopyBytesToGo(data, dst)
	value := func(i int) float64 { return math.Float64frombits(binary.LittleEndian.Uint64(data[i*8:])) }
	if value(0) != 1 || value(1) != 2 || value(2) != 128 || value(3) != 48000 || value(16) <= 0 || value(17) <= 0 || value(18) <= 0 || value(19) <= 0 {
		t.Fatal("meter snapshot", data[:32])
	}
	for _, invalid := range []js.Value{js.ValueOf(1), js.Global().Get("Float64Array").New(192), js.Global().Get("Uint8Array").New(1535), js.Null()} {
		if n := api.Call("copyMeters", invalid).Int(); n != 0 {
			t.Fatal("invalid destination accepted", n)
		}
	}
	if n := api.Call("copyMeters", dst).Int(); n != protocol.MetersDataBytes {
		t.Fatal(n)
	}
	after := make([]byte, len(data))
	js.CopyBytesToGo(after, dst)
	for i := range data {
		if after[i] != data[i] {
			t.Fatal("invalid copy altered meter")
		}
	}
	if api.Call("takeData").Get("byteLength").Int() != 0 {
		t.Fatal("meter payload escaped into RPC bulk buffer")
	}
}

func TestAnalysisBridgeProgressiveRGBAAndClippingOneUndo(t *testing.T) {
	api := newKernelAPI(engine.New())
	request := func(method string, params any, input ...js.Value) protocol.Response {
		payload, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		args := []any{method, string(payload)}
		if len(input) > 0 {
			args = append(args, input[0])
		}
		var response protocol.Response
		if err := json.Unmarshal([]byte(api.Call("call", args...).String()), &response); err != nil || !response.OK {
			t.Fatal(method, response, err)
		}
		return response
	}
	encoded := make([]byte, 2049*4)
	for frame := range 2049 {
		value := float32(.125)
		if frame >= 1022 && frame < 1028 {
			value = 1
		}
		binary.LittleEndian.PutUint32(encoded[frame*4:], math.Float32bits(value))
	}
	input := js.Global().Get("Uint8Array").New(len(encoded))
	js.CopyBytesToJS(input, encoded)
	opened := request(protocol.MethodDocumentImportBinary, protocol.BinaryDocumentParams{Name: "analysis", SampleRate: 48000, Channels: 1, Frames: 2049, NextAnchorID: 1}, input)
	var doc protocol.DocumentInfoResult
	if err := json.Unmarshal(opened.Result, &doc); err != nil {
		t.Fatal(err)
	}
	p := protocol.AnalysisStartParams{SelectionResult: protocol.SelectionResult{DocumentID: doc.DocumentID, SelectionRange: protocol.SelectionRange{End: 2049, ChannelMask: 1}}, Kind: "spectrogram", FFTSize: 256, Width: 8, Height: 16, ColorMap: "viridis"}
	started := request(protocol.MethodAnalysisStart, p)
	var result protocol.AnalysisJobResult
	_ = json.Unmarshal(started.Result, &result)
	progress := 0
	include := false
	for result.State != "ready" {
		include = progress%2 == 0
		reply := request(protocol.MethodAnalysisStep, protocol.AnalysisJobParams{DocumentID: doc.DocumentID, JobID: result.JobID, IncludeData: &include})
		_ = json.Unmarshal(reply.Result, &result)
		bulk := api.Call("takeData")
		length := bulk.Get("byteLength").Int()
		if length != result.DataBytes {
			t.Fatal("bulk metadata", length, result.DataBytes)
		}
		if length > 0 {
			if length != 8*16*4 {
				t.Fatal("progressive dimensions", length)
			}
			rgba := make([]byte, length)
			js.CopyBytesToGo(rgba, bulk)
			for row := range 16 {
				for column := 0; column < result.CompletedColumns; column++ {
					if rgba[(row*8+column)*4+3] != 255 {
						t.Fatal("computed column not painted")
					}
				}
			}
		}
		progress++
	}
	if progress < 8 {
		t.Fatal("spectrogram was not bounded", progress)
	}
	p.Kind = "clipping"
	started = request(protocol.MethodAnalysisStart, p)
	_ = json.Unmarshal(started.Result, &result)
	for result.State != "ready" {
		reply := request(protocol.MethodAnalysisStep, protocol.AnalysisJobParams{DocumentID: doc.DocumentID, JobID: result.JobID})
		_ = json.Unmarshal(reply.Result, &result)
	}
	if result.MarkerCount != 1 {
		t.Fatal(result)
	}
	committed := request(protocol.MethodAnalysisCommit, protocol.AnalysisJobParams{DocumentID: doc.DocumentID, JobID: result.JobID})
	var edit protocol.EditResult
	_ = json.Unmarshal(committed.Result, &edit)
	if len(edit.Timeline.Markers) != 1 || edit.Timeline.Markers[0].Frame != 1022 || len(edit.History.Entries) != 2 {
		t.Fatal("public single undo", edit)
	}
	undone := request(protocol.MethodEditUndo, protocol.HistoryListParams{DocumentID: edit.Document.DocumentID})
	_ = json.Unmarshal(undone.Result, &edit)
	if len(edit.Timeline.Markers) != 0 {
		t.Fatal("public undo retained detected marker")
	}
}
