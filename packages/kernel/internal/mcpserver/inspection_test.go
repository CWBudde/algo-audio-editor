//go:build !js

package mcpserver

import (
	"bytes"
	"encoding/binary"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/automation"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestSecondsSelection(t *testing.T) {
	client, ctx := client(t, nil)
	id := open(ctx, t, client, writeFixture(t, t.TempDir()))
	args := map[string]any{"documentId": id}
	before := call(ctx, t, client, "history", args, false)
	for _, test := range []struct {
		name               string
		start, end         float64
		mask               int
		wantStart, wantEnd float64
		invalid            bool
	}{
		{"nearest frames", 1.4 / 48000, 8.6 / 48000, 1, 1, 9, false},
		{"half rounds up", 1.5 / 48000, 7.5 / 48000, 1, 2, 8, false},
		{"clamp end", 2.0 / 48000, 100, 1, 2, 10, false},
		{"clamp both", 100, math.MaxFloat64, 1, 10, 10, false},
		{"cursor", 3.0 / 48000, 3.0 / 48000, 1, 3, 3, false},
		{"negative", -1, 0, 1, 0, 0, true},
		{"reversed", 1, 0, 1, 0, 0, true},
		{"zero mask", 0, 1, 0, 0, 0, true},
		{"wrong channel", 0, 1, 2, 0, 0, true},
		{"negative mask", 0, 1, -1, 0, 0, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			out := call(ctx, t, client, "select_seconds", map[string]any{"documentId": id, "startSeconds": test.start, "endSeconds": test.end, "channelMask": test.mask}, test.invalid)
			if !test.invalid && (out["start"] != test.wantStart || out["end"] != test.wantEnd || out["channelMask"] != float64(test.mask)) {
				t.Fatal(out)
			}
		})
	}
	call(ctx, t, client, "select_seconds", map[string]any{"documentId": id, "startSeconds": 0, "endSeconds": "NaN", "channelMask": 1}, true)
	call(ctx, t, client, "select_seconds", map[string]any{"documentId": id, "startSeconds": 0, "endSeconds": 0.1, "channelMask": 1, "unexpected": true}, true)
	if !reflect.DeepEqual(before, call(ctx, t, client, "history", args, false)) {
		t.Fatal("selection changed history")
	}
	call(ctx, t, client, "select_seconds", map[string]any{"documentId": id, "startSeconds": 1.0 / 48000, "endSeconds": 9.0 / 48000, "channelMask": 1}, false)
	call(ctx, t, client, "select_seconds", map[string]any{"documentId": id, "startSeconds": -1, "endSeconds": 1, "channelMask": 1}, true)
	result := call(ctx, t, client, "apply_operation", map[string]any{"documentId": id, "operation": automation.Operation{Method: protocol.MethodEditApply, Params: map[string]any{"operation": "crop"}}}, false)
	if result["document"].(map[string]any)["frames"] != float64(8) {
		t.Fatal("failed selection lost previous selection", result)
	}
}

func TestMultichannelInspectionAndSelection(t *testing.T) {
	// Independent stereo fixture: reviewed mono samples on the left and constant
	// 0.5 on the right. The adapter must route physical channels, not mix them.
	mono := fixtureWAV()
	stereo := make([]byte, 44+2*(len(mono)-44))
	copy(stereo, mono[:44])
	binary.LittleEndian.PutUint32(stereo[4:], uint32(len(stereo)-8))
	binary.LittleEndian.PutUint16(stereo[22:], 2)
	binary.LittleEndian.PutUint32(stereo[28:], 48000*8)
	binary.LittleEndian.PutUint16(stereo[32:], 8)
	binary.LittleEndian.PutUint32(stereo[40:], uint32(len(stereo)-44))
	for i := range 10 {
		copy(stereo[44+i*8:], mono[44+i*4:44+i*4+4])
		binary.LittleEndian.PutUint32(stereo[44+i*8+4:], math.Float32bits(0.5))
	}
	path := filepath.Join(t.TempDir(), "stereo.wav")
	if err := os.WriteFile(path, stereo, 0o600); err != nil {
		t.Fatal(err)
	}
	client, ctx := client(t, nil)
	id := open(ctx, t, client, path)
	for _, mask := range []int{1, 2, 3} {
		out := call(ctx, t, client, "select_seconds", map[string]any{"documentId": id, "startSeconds": 0, "endSeconds": 1, "channelMask": mask}, false)
		if out["channelMask"] != float64(mask) {
			t.Fatal("channel mask changed", out)
		}
		stats := call(ctx, t, client, "get_statistics", map[string]any{"documentId": id}, false)
		if got := len(stats["channels"].([]any)); got != map[int]int{1: 1, 2: 1, 3: 2}[mask] {
			t.Fatal("wrong channels", stats)
		}
	}
	call(ctx, t, client, "select_seconds", map[string]any{"documentId": id, "startSeconds": 0, "endSeconds": 1, "channelMask": 4}, true)
	resource, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: peaksURI(id) + "?channel=1"})
	if err != nil {
		t.Fatal(err)
	}
	data := resource.Contents[0].Blob
	if binary.LittleEndian.Uint32(data[12:]) != 1 || binary.LittleEndian.Uint32(data[48:]) != math.Float32bits(0.5) || binary.LittleEndian.Uint32(data[52:]) != math.Float32bits(0.5) {
		t.Fatal("wrong physical channel", data)
	}
	resource, err = client.ReadResource(ctx, &mcp.ReadResourceParams{URI: waveformURI(id) + "?channel=1&width=2048&height=512"})
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(resource.Contents[0].Blob))
	if err != nil || img.Bounds().Dx() != 2048 || img.Bounds().Dy() != 512 || len(resource.Contents[0].Blob) > 2048*512*4+65536 {
		t.Fatal("maximum PNG output not bounded", err)
	}
	if color.RGBAModel.Convert(img.At(1024, 128)) != (color.RGBA{143, 108, 211, 255}) {
		t.Fatal("right channel waveform missing")
	}
}

func TestWaveformAndBinaryPeakResources(t *testing.T) {
	client, ctx := client(t, nil)
	id := open(ctx, t, client, writeFixture(t, t.TempDir()))
	args := map[string]any{"documentId": id}
	before := call(ctx, t, client, "history", args, false)
	infoBefore := call(ctx, t, client, "document_info", args, false)
	if infoBefore["waveformURI"] != waveformURI(id) || infoBefore["peaksURI"] != peaksURI(id) {
		t.Fatal(infoBefore)
	}
	templates, err := client.ListResourceTemplates(ctx, nil)
	if err != nil || len(templates.ResourceTemplates) != 2 {
		t.Fatal(templates, err)
	}
	read := func(uri, mime string) []byte {
		t.Helper()
		resource, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: uri})
		if err != nil {
			t.Fatal(err)
		}
		if len(resource.Contents) != 1 || resource.Contents[0].URI != uri || resource.Contents[0].MIMEType != mime || resource.Contents[0].Text != "" || len(resource.Contents[0].Blob) == 0 {
			t.Fatal("not a binary resource", resource)
		}
		return resource.Contents[0].Blob
	}
	peakData := read(peaksURI(id), peakMIME)
	if string(peakData[:4]) != "AAEP" || binary.LittleEndian.Uint32(peakData[4:]) != 1 || binary.LittleEndian.Uint32(peakData[8:]) != 48000 || binary.LittleEndian.Uint32(peakData[12:]) != 0 || binary.LittleEndian.Uint32(peakData[16:]) != 10 || binary.LittleEndian.Uint32(peakData[20:]) != 0 || binary.LittleEndian.Uint64(peakData[24:]) != 1 || binary.LittleEndian.Uint64(peakData[32:]) != 0 || binary.LittleEndian.Uint64(peakData[40:]) != 10 {
		t.Fatal("bad binary header", peakData[:48])
	}
	// Verify transport preserves the engine's actual binary boundary unchanged.
	e := engine.New()
	var info protocol.DocumentInfoResult
	if _, err := automation.Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: "input.wav"}, fixtureWAV(), &info); err != nil {
		t.Fatal(err)
	}
	data, err := automation.Call(e, protocol.MethodPeaksGet, protocol.PeaksGetParams{Channel: 0, StartFrame: 0, EndFrame: 10, Buckets: 1024}, nil, nil)
	if err != nil || !bytes.Equal(peakData[peakHeaderBytes:], data) {
		t.Fatal("kernel peaks changed at MCP boundary", err)
	}
	img, err := png.Decode(bytes.NewReader(read(waveformURI(id)+"?width=100&height=100", "image/png")))
	if err != nil || img.Bounds().Dx() != 100 || img.Bounds().Dy() != 100 {
		t.Fatal("invalid PNG dimensions", img, err)
	}
	// Sample 2 is -0.25; its min/max draws an orange pixel at y=62. RMS
	// is clipped to the min/max range, preserving the signed sample position.
	if got := color.RGBAModel.Convert(img.At(25, 62)); got != (color.RGBA{143, 108, 211, 255}) {
		t.Fatal("kernel peak position not drawn", got)
	}
	empty, err := png.Decode(bytes.NewReader(read(waveformURI(id)+"?start=5&end=5&width=64&height=64", "image/png")))
	if err != nil || color.RGBAModel.Convert(empty.At(0, 32)) != (color.RGBA{72, 62, 86, 255}) {
		t.Fatal("empty range lost axis", err)
	}
	for _, query := range []string{"?width=63", "?width=2049", "?height=513", "?width=100&width=101", "?channel=1", "?channel=-1", "?start=-1", "?end=11", "?start=8&end=4", "?width=1.5", "?width=NaN", "?width=", "?unknown=1", "?buckets=100", "?width=9223372036854775807"} {
		if _, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: waveformURI(id) + query}); err == nil {
			t.Fatalf("accepted invalid query %s", query)
		}
	}
	for _, query := range []string{"?buckets=0", "?buckets=2049", "?width=100", "?buckets=10&buckets=20"} {
		if _, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: peaksURI(id) + query}); err == nil {
			t.Fatalf("accepted invalid binary query %s", query)
		}
	}
	selected := read(peaksURI(id)+"?start=2&end=5&buckets=3", peakMIME)
	if binary.LittleEndian.Uint64(selected[32:]) != 2 || binary.LittleEndian.Uint64(selected[40:]) != 5 || binary.LittleEndian.Uint32(selected[16:]) != 3 {
		t.Fatal("binary viewport missing", selected[:48])
	}
	if !reflect.DeepEqual(before, call(ctx, t, client, "history", args, false)) || !reflect.DeepEqual(infoBefore, call(ctx, t, client, "document_info", args, false)) {
		t.Fatal("resource read mutated history/metadata")
	}
	call(ctx, t, client, "apply_operation", map[string]any{"documentId": id, "operation": automation.Operation{Method: protocol.MethodProcessStart, Params: map[string]any{"operation": "gain", "gainDb": -6}}}, false)
	if bytes.Equal(peakData, read(peaksURI(id), peakMIME)) {
		t.Fatal("resource cached stale history")
	}
	call(ctx, t, client, "close_document", args, false)
	resources, err := client.ListResources(ctx, nil)
	if err != nil || len(resources.Resources) != 0 {
		t.Fatal("closed resources remain", resources, err)
	}
	templates, err = client.ListResourceTemplates(ctx, nil)
	if err != nil || len(templates.ResourceTemplates) != 0 {
		t.Fatal("closed templates remain", templates, err)
	}
	for _, uri := range []string{summaryURI(id), waveformURI(id), peaksURI(id), waveformURI(id) + "?width=100", peaksURI(id) + "?buckets=100"} {
		if _, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: uri}); err == nil {
			t.Fatal("closed resource readable", uri)
		}
	}
}

func TestWaveformRecordBoundOnFragmentedDocument(t *testing.T) {
	client, ctx := client(t, nil)
	id := open(ctx, t, client, writeFixture(t, t.TempDir()))
	chain := automation.Chain{Version: 1}
	// Sixteen doublings reuse the same ten-frame immutable block. This creates
	// 65536 independent peak records despite requesting only 1024 display pixels.
	for range 16 {
		chain.Operations = append(chain.Operations, automation.Operation{Method: protocol.MethodEditApply, Range: "document", Params: map[string]any{"operation": "duplicate"}})
	}
	call(ctx, t, client, "apply_chain", map[string]any{"documentId": id, "chain": chain}, false)
	before := call(ctx, t, client, "history", map[string]any{"documentId": id}, false)
	if _, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: waveformURI(id)}); err == nil {
		t.Fatal("unbounded fragmented waveform accepted")
	}
	result, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: waveformURI(id) + "?start=0&end=1000"})
	if err != nil {
		t.Fatal("narrower viewport did not recover", err)
	}
	if _, err := png.Decode(bytes.NewReader(result.Contents[0].Blob)); err != nil {
		t.Fatal(err)
	}
	result, err = client.ReadResource(ctx, &mcp.ReadResourceParams{URI: peaksURI(id)})
	if err != nil || binary.LittleEndian.Uint32(result.Contents[0].Blob[16:]) != 65536 {
		t.Fatal("bounded binary records missing", err)
	}
	if !reflect.DeepEqual(before, call(ctx, t, client, "history", map[string]any{"documentId": id}, false)) {
		t.Fatal("failed/valid resource read changed history")
	}
}
