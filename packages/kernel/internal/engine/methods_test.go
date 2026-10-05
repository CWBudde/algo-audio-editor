package engine

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestMethodRegistryCoversEveryProtocolMethod(t *testing.T) {
	if runtime.GOOS == "js" {
		// Native tests inspect declarations; the same registry is exercised by
		// the busy matrix and strict payload tests under actual V8/WASM.
		return
	}
	files, err := os.ReadDir("../protocol")
	if err != nil {
		t.Fatal(err)
	}
	declared := make(map[string]bool)
	for _, entry := range files {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), filepath.Join("../protocol", entry.Name()), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			value, ok := node.(*ast.ValueSpec)
			if !ok || len(value.Names) != 1 || !strings.HasPrefix(value.Names[0].Name, "Method") {
				return true
			}
			if len(value.Values) != 1 {
				t.Fatalf("method constant %s has no explicit wire spelling", value.Names[0].Name)
			}
			literal, ok := value.Values[0].(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				t.Fatalf("method constant %s is not a string", value.Names[0].Name)
			}
			var name string
			if err := json.Unmarshal([]byte(literal.Value), &name); err != nil {
				t.Fatal(err)
			}
			declared[name] = true
			if spec, ok := methodRegistry[name]; !ok || spec.decode == nil || spec.handle == nil {
				t.Errorf("protocol method %s lacks a registered decoder/handler", name)
			}
			return true
		})
	}
	for name := range methodRegistry {
		if !declared[name] {
			t.Errorf("registry method %s is absent from the protocol", name)
		}
	}
}

func TestMethodRegistryPreservesBusyMatrixAndPrecedence(t *testing.T) {
	// These independent behavior oracles preserve the previous lock contract,
	// including asymmetries such as seek, process.start and effects.ir.load.
	processingAllowed := strings.Fields("hello doc.memory doc.info doc.export edit.state edit.prepare-paste history.list selection.get selection.snap timeline.get timeline.export peaks.get engine.configure transport.stop transport.play process.start process.step process.stepBatch process.cancel process.commit process.exportCandidate effects.list effects.response effects.preview.meters meters.configure analysis.start analysis.step analysis.cancel analysis.spectrum")
	previewAllowed := strings.Fields("hello doc.memory doc.info doc.export edit.state edit.prepare-paste history.list selection.get selection.snap timeline.get timeline.export peaks.get engine.configure transport.play transport.stop transport.seek effects.list effects.response effects.preview.update effects.preview.stop effects.preview.meters effects.apply effects.ir.load meters.configure analysis.start analysis.step analysis.cancel analysis.spectrum")
	contains := func(values []string, name string) bool {
		for _, value := range values {
			if value == name {
				return true
			}
		}
		return false
	}
	names := []string{"unknown.method"}
	for name := range methodRegistry {
		names = append(names, name)
	}
	for _, processing := range []bool{false, true} {
		for _, preview := range []bool{false, true} {
			for _, name := range names {
				e := New()
				if processing {
					e.jobs.processJob = &processingJob{}
				}
				if preview {
					e.effectsState.effectPreview = &effectPreviewSession{}
				}
				_, err := e.dispatch(name, []byte(`123`), nil)
				want := "decode params"
				if _, known := methodRegistry[name]; !known {
					want = "unknown method"
				}
				if preview && !contains(previewAllowed, name) {
					want = "effect preview is active"
				}
				if processing && !contains(processingAllowed, name) {
					want = "processing job is active"
				}
				if err == nil || !strings.Contains(err.Error(), want) {
					t.Fatalf("%s processing=%v preview=%v: got %v want %s", name, processing, preview, err, want)
				}
			}
		}
	}
}

func TestRegistryRejectsUnknownAndTrailingPayloadFields(t *testing.T) {
	for _, test := range []struct{ method, payload string }{
		{protocol.MethodHello, `{"typo":true}`},
		{protocol.MethodDocumentInfo, `{"documentID":"foreign"}`},
		{protocol.MethodEngineConfigure, `{"sampleRate":48000,"channels":2,"typo":1}`},
		{protocol.MethodSelectionSet, `{"documentId":"id","start":0,"end":1,"channelMask":1,"unknown":0}`},
		{protocol.MethodProcessStart, `{"spectralMask":{"start":0,"end":1,"lowHz":0,"highHz":100,"unknown":0}}`},
		{protocol.MethodEffectsPreviewStart, `{"graph":{"nodes":[{"id":"fx","type":"gain","unknown":0}],"connections":[]}}`},
		{protocol.MethodHello, `{} {}`},
		{protocol.MethodHello, `{} trailing`},
		{protocol.MethodTransportStop, `[]`},
	} {
		e := New()
		e.bulkData = []byte("previous result")
		var result protocol.Response
		if err := json.Unmarshal(e.CallWithData(test.method, []byte(test.payload), []byte("input")), &result); err != nil {
			t.Fatal(err)
		}
		if result.OK || !strings.Contains(result.Error, test.method+": decode params:") || len(e.TakeData()) != 0 || e.callInputBytes != 0 {
			t.Fatalf("%s %s: %+v", test.method, test.payload, result)
		}
	}
	for _, payload := range []string{"", " \n\t", "{}", "null", " {} \n"} {
		var result protocol.Response
		if err := json.Unmarshal(New().Call(protocol.MethodHello, []byte(payload)), &result); err != nil || !result.OK {
			t.Fatalf("default no-argument payload %q: %+v/%v", payload, result, err)
		}
	}
}

func TestRegistryHandlerPanicKeepsBinaryBoundaryClean(t *testing.T) {
	previous := methodRegistry[protocol.MethodHello]
	defer func() { methodRegistry[protocol.MethodHello] = previous }()
	methodRegistry[protocol.MethodHello] = noParams(allowBoth, func(e *Engine) (protocol.HelloResult, error) {
		e.bulkData = []byte("partial output")
		panic("handler failure")
	})
	e := New()
	var result protocol.Response
	if err := json.Unmarshal(e.CallWithData(protocol.MethodHello, nil, []byte("input")), &result); err != nil {
		t.Fatal(err)
	}
	if result.OK || !strings.Contains(result.Error, "hello: panic: handler failure") || len(e.TakeData()) != 0 || e.callInputBytes != 0 {
		t.Fatalf("panic retained call-owned binary data: %+v", result)
	}
}
