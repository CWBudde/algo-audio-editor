//go:build !js

package mcpserver

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/automation"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func fixtureWAV() []byte {
	// Independent float WAV container and the reviewed half-gain vectors from
	// Phase 3.2. No production codec/DSP computes these input or expected bits.
	bits := []uint32{0xc0400000, 0xbf800000, 0xbe800000, 0x80000000, 0, 0x3e000000, 0x3f000000, 0x3f800000, 0x40400000, 0x4640e6b6}
	data := make([]byte, 44+len(bits)*4)
	copy(data, "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)-8))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 3)
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[24:], 48000)
	binary.LittleEndian.PutUint32(data[28:], 48000*4)
	binary.LittleEndian.PutUint16(data[32:], 4)
	binary.LittleEndian.PutUint16(data[34:], 32)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], uint32(len(bits)*4))
	for i, value := range bits {
		binary.LittleEndian.PutUint32(data[44+i*4:], value)
	}
	return data
}

func client(t *testing.T, roots []string) (*mcp.ClientSession, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	policy, err := automation.NewFilePolicy(roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(policy.Close)
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	server, err := New(policy).Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	session, err := mcp.NewClient(&mcp.Implementation{Name: "acceptance-test", Version: "1"}, nil).Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session, ctx
}

func call(t *testing.T, ctx context.Context, client *mcp.ClientSession, name string, args any, wantError bool) map[string]any {
	t.Helper()
	result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: protocol error: %v", name, err)
	}
	if result.IsError != wantError {
		content, _ := json.Marshal(result.Content)
		t.Fatalf("%s: IsError=%t, expected %t: %s / %#v", name, result.IsError, wantError, content, result.StructuredContent)
	}
	data, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var output map[string]any
	if err := json.Unmarshal(data, &output); err != nil {
		t.Fatal(err)
	}
	return output
}

func writeFixture(t *testing.T, directory string) string {
	t.Helper()
	path := filepath.Join(directory, "input.wav")
	if err := os.WriteFile(path, fixtureWAV(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func open(t *testing.T, ctx context.Context, client *mcp.ClientSession, path string) string {
	t.Helper()
	result := call(t, ctx, client, "open_document", map[string]any{"path": path}, false)
	return result["document"].(map[string]any)["documentId"].(string)
}

func TestMCPCLIAndUIProtocolParity(t *testing.T) {
	directory := t.TempDir()
	path := writeFixture(t, directory)
	client, ctx := client(t, []string{directory})
	id := open(t, ctx, client, path)
	args := map[string]any{"documentId": id}
	stats := call(t, ctx, client, "get_statistics", args, false)
	if stats["state"] != "ready" || len(stats["statistics"].([]any)) != 1 {
		t.Fatal("statistics missing", stats)
	}
	chain := automation.Chain{Version: 1, Operations: []automation.Operation{
		{Method: protocol.MethodProcessStart, Params: map[string]any{"operation": "gain", "gainDb": -6.020599913279624}},
		{Method: protocol.MethodProcessStart, Params: map[string]any{"operation": "reverse"}},
	}}
	result := call(t, ctx, client, "apply_chain", map[string]any{"documentId": id, "chain": chain}, false)
	if result["applied"] != float64(2) {
		t.Fatal(result)
	}
	mcpOutput := filepath.Join(directory, "mcp.wav")
	call(t, ctx, client, "export_document", map[string]any{"documentId": id, "path": mcpOutput, "format": "wav", "bitDepth": 32, "float": true}, false)

	chainData, err := json.Marshal(chain)
	if err != nil {
		t.Fatal(err)
	}
	chainPath := filepath.Join(directory, "chain.json")
	if err := os.WriteFile(chainPath, chainData, 0o600); err != nil {
		t.Fatal(err)
	}
	cliOutput := filepath.Join(directory, "cli.wav")
	if err := automation.RunCLI(ctx, []string{"--input", path, "--output", cliOutput, "--chain", chainPath, "--allow-write", directory, "--bit-depth", "32", "--float"}, new(bytes.Buffer), new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}

	// Drive the actual UI operation method sequence independently of Apply.
	e := engine.New()
	var info protocol.DocumentInfoResult
	if _, err := automation.Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: "input.wav"}, fixtureWAV(), &info); err != nil {
		t.Fatal(err)
	}
	for _, op := range chain.Operations {
		params := map[string]any{"documentId": info.DocumentID, "start": 0, "end": info.Frames, "channelMask": 1}
		for key, value := range op.Params {
			params[key] = value
		}
		var job protocol.ProcessJobResult
		if _, err := automation.Call(e, protocol.MethodProcessStart, params, nil, &job); err != nil {
			t.Fatal(err)
		}
		jp := protocol.ProcessJobParams{DocumentID: info.DocumentID, JobID: job.JobID}
		for job.State == "running" {
			if _, err := automation.Call(e, protocol.MethodProcessStep, jp, nil, &job); err != nil {
				t.Fatal(err)
			}
		}
		var committed protocol.EditResult
		if _, err := automation.Call(e, protocol.MethodProcessCommit, jp, nil, &committed); err != nil {
			t.Fatal(err)
		}
		info = committed.Document
	}
	uiData, err := automation.Call(e, protocol.MethodDocumentExport, protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{mcpOutput, cliOutput} {
		data, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(data, uiData) {
			t.Fatalf("%s differs from UI protocol: %v", path, err)
		}
	}
	// Verify the exported samples against reviewed bits, not just another path
	// through the same engine. Use the kernel's bounded binary PCM endpoint.
	var history protocol.HistoryListResult
	if _, err := automation.Call(e, protocol.MethodHistoryList, protocol.HistoryListParams{DocumentID: info.DocumentID}, nil, &history); err != nil {
		t.Fatal(err)
	}
	pcm, err := automation.Call(e, protocol.MethodDocumentReadPCM, protocol.PCMReadParams{DocumentID: info.DocumentID, StateID: history.CurrentStateID, Frames: 10, ChannelMask: 1}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []uint32{0xbfc00000, 0xbf000000, 0xbe000000, 0x80000000, 0, 0x3d800000, 0x3e800000, 0x3f000000, 0x3fc00000, 0x45c0e6b6}
	slices.Reverse(want)
	for i, bits := range want {
		if got := binary.LittleEndian.Uint32(pcm[i*4:]); got != bits {
			t.Fatalf("sample %d=%08x, want %08x", i, got, bits)
		}
	}
	h := call(t, ctx, client, "history", args, false)
	if !h["canUndo"].(bool) || len(h["entries"].([]any)) != 3 {
		t.Fatal("missing undo entries", h)
	}
	call(t, ctx, client, "undo", args, false)
	call(t, ctx, client, "undo", args, false)
	call(t, ctx, client, "redo", args, false)
	call(t, ctx, client, "redo", args, false)
	call(t, ctx, client, "save_document", map[string]any{"documentId": id, "path": mcpOutput, "format": "wav", "bitDepth": 32, "float": true, "overwrite": true}, false)
	if call(t, ctx, client, "history", args, false)["dirty"] != false {
		t.Fatal("successful save did not mark history clean")
	}
}

func TestSessionIsolationResourcesDryRunAndFailureRecovery(t *testing.T) {
	directory := t.TempDir()
	client, ctx := client(t, nil)
	path := writeFixture(t, directory)
	one, two := open(t, ctx, client, path), open(t, ctx, client, path)
	if one == two {
		t.Fatal("reused routing id")
	}
	args := map[string]any{"documentId": one}
	before := call(t, ctx, client, "history", args, false)
	operation := automation.Operation{Method: protocol.MethodProcessStart, Params: map[string]any{"operation": "gain", "gainDb": -6}}
	dry := call(t, ctx, client, "apply_operation", map[string]any{"documentId": one, "operation": operation, "dryRun": true}, false)
	if dry["candidate"].(map[string]any)["state"] != "ready" || !reflect.DeepEqual(before, call(t, ctx, client, "history", args, false)) {
		t.Fatal("dry run mutated history", dry)
	}
	call(t, ctx, client, "apply_operation", map[string]any{"documentId": one, "operation": operation}, false)
	graph := protocol.EffectGraph{
		Nodes:       []protocol.EffectNode{{ID: "_input", Type: "_input", Params: map[string]any{}}, {ID: "fx", Type: "ringmod", Params: map[string]any{"carrierHz": 750.0, "mix": 1.0}}, {ID: "_output", Type: "_output", Params: map[string]any{}}},
		Connections: []protocol.EffectConnection{{From: "_input", To: "fx"}, {From: "fx", To: "_output"}},
	}
	effectArgs := map[string]any{"documentId": two, "graph": graph, "dryRun": true}
	call(t, ctx, client, "apply_effect", effectArgs, false)
	if call(t, ctx, client, "history", map[string]any{"documentId": two}, false)["dirty"] != false {
		t.Fatal("dry effect changed second document")
	}
	effectArgs["dryRun"] = false
	call(t, ctx, client, "apply_effect", effectArgs, false)
	call(t, ctx, client, "undo", map[string]any{"documentId": two}, false)
	if call(t, ctx, client, "history", map[string]any{"documentId": two}, false)["dirty"] != false {
		t.Fatal("second document changed")
	}
	chain := automation.Chain{Version: 1, Operations: []automation.Operation{operation, {Method: protocol.MethodProcessStart, Params: map[string]any{"operation": "gain", "gainDb": 500}}}}
	failed := call(t, ctx, client, "apply_chain", map[string]any{"documentId": one, "chain": chain}, true)
	if failed["result"].(map[string]any)["applied"] != float64(1) || !strings.Contains(failed["error"].(string), "operation 1 failed") {
		t.Fatal("partial chain did not report completed prefix", failed)
	}
	call(t, ctx, client, "apply_operation", map[string]any{"documentId": one, "operation": operation}, false)
	call(t, ctx, client, "apply_operation", map[string]any{"documentId": one, "operation": automation.Operation{Method: protocol.MethodProcessStart, Params: map[string]any{"operation": "gain", "gain_dB": -6}}}, true)
	call(t, ctx, client, "export_document", map[string]any{"documentId": one, "path": filepath.Join(directory, "denied.wav"), "format": "wav", "bitDepth": 16}, true)
	if _, err := os.Stat(filepath.Join(directory, "denied.wav")); !os.IsNotExist(err) {
		t.Fatal("read-only server wrote a file", err)
	}
	resources, err := client.ListResources(ctx, nil)
	if err != nil || len(resources.Resources) != 2 {
		t.Fatal("summary resources missing", resources, err)
	}
	resource, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: summaryURI(one)})
	if err != nil || !strings.Contains(resource.Contents[0].Text, one) {
		t.Fatal("resource has wrong routing identity", resource, err)
	}
	call(t, ctx, client, "close_document", args, false)
	call(t, ctx, client, "document_info", args, true)
	if _, err := client.ReadResource(ctx, &mcp.ReadResourceParams{URI: summaryURI(one)}); err == nil {
		t.Fatal("closed resource survived")
	}
}

func TestGoldenToolDiscoveryAndProtocolSchemas(t *testing.T) {
	client, ctx := client(t, nil)
	tools, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
		if tool.InputSchema == nil || tool.Annotations == nil {
			t.Fatalf("%s has no schema/annotations", tool.Name)
		}
	}
	slices.Sort(names)
	want := []string{"apply_chain", "apply_effect", "apply_operation", "close_document", "detect_clipping", "document_info", "export_document", "get_statistics", "history", "list_documents", "list_effects", "list_operations", "open_document", "redo", "save_document", "select_range", "undo"}
	if !reflect.DeepEqual(names, want) {
		t.Fatal("tool surface changed; update the reference deliberately", names)
	}
	// Snapshot the actual advertised input schemas, not hand-written replicas.
	// Updating is explicit: UPDATE_MCP_SCHEMAS=1 just test-go.
	type toolSchema struct {
		Name   string `json:"name"`
		Schema any    `json:"inputSchema"`
	}
	var goldenTools []toolSchema
	for _, tool := range tools.Tools {
		goldenTools = append(goldenTools, toolSchema{tool.Name, tool.InputSchema})
	}
	slices.SortFunc(goldenTools, func(a, b toolSchema) int { return strings.Compare(a.Name, b.Name) })
	encoded, err := json.MarshalIndent(goldenTools, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	goldenPath := "testdata/tools.json"
	if os.Getenv("UPDATE_MCP_SCHEMAS") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(goldenPath, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatal(err)
	}
	var goldenObject, actualObject any
	if err := json.Unmarshal(golden, &goldenObject); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &actualObject); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(goldenObject, actualObject) {
		t.Fatalf("advertised tool schemas changed; review and regenerate the golden: %v", err)
	}
	schemas := call(t, ctx, client, "list_operations", map[string]any{}, false)
	if schemas["protocolVersion"] != float64(protocol.Version) {
		t.Fatal("schema ABI drift", schemas)
	}
	for method, schema := range schemas["methods"].(map[string]any) {
		props := schema.(map[string]any)["properties"].(map[string]any)
		if _, ok := props["documentId"]; ok {
			t.Fatal("adapter identity leaked into payload schema")
		}
		// The real engine must recognize each advertised dispatch method.
		var envelope protocol.Response
		if err := json.Unmarshal(engine.New().Call(method, nil), &envelope); err != nil || strings.Contains(envelope.Error, "unknown method") {
			t.Fatal("advertised method missing from kernel", method, err, envelope)
		}
		if method == protocol.MethodEffectsApply {
			continue
		}
		for _, operation := range props["operation"].(map[string]any)["enum"].([]any) {
			e := engine.New()
			var info protocol.DocumentInfoResult
			if _, err := automation.Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: "input.wav"}, fixtureWAV(), &info); err != nil {
				t.Fatal(err)
			}
			_, err := automation.Call(e, method, map[string]any{"documentId": info.DocumentID, "start": 0, "end": 10, "channelMask": 1, "operation": operation}, nil, nil)
			if err != nil && (strings.Contains(err.Error(), "unsupported operation") || strings.Contains(err.Error(), "unknown operation")) {
				t.Fatal("advertised operation missing from engine", method, operation, err)
			}
		}
	}
	// Processing fields (including restoration) come from the real protocol.
	processProps := schemas["methods"].(map[string]any)[protocol.MethodProcessStart].(map[string]any)["properties"].(map[string]any)
	for _, name := range []string{"operation", "gainDb", "target", "sampleRate", "spectralMask", "noiseProfile", "durationRatio"} {
		if processProps[name] == nil {
			t.Fatal("missing processing parameter schema", name)
		}
	}
	effects := call(t, ctx, client, "list_effects", map[string]any{"limit": 1}, false)
	if len(effects["effects"].([]any)) != 1 || effects["total"].(float64) <= 1 {
		t.Fatal("effect discovery/pagination failed", effects)
	}
	call(t, ctx, client, "list_effects", map[string]any{"limit": 21}, true)
	prompts, err := client.ListPrompts(ctx, nil)
	if err != nil || len(prompts.Prompts) != 3 {
		t.Fatal("workflow prompts missing", prompts, err)
	}
	if _, err := client.GetPrompt(ctx, &mcp.GetPromptParams{Name: "mastering_check"}); err != nil {
		t.Fatal(err)
	}
}

func TestStructuralSelectionClippingAndSaveFailures(t *testing.T) {
	directory := t.TempDir()
	client, ctx := client(t, []string{directory})
	id := open(t, ctx, client, writeFixture(t, directory))
	args := map[string]any{"documentId": id}
	before := call(t, ctx, client, "history", args, false)
	clip := call(t, ctx, client, "detect_clipping", map[string]any{"documentId": id, "threshold": 1}, false)
	if clip["markerCount"].(float64) == 0 || !reflect.DeepEqual(before, call(t, ctx, client, "history", args, false)) {
		t.Fatal("clipping read mutated history or lost clips", clip)
	}
	call(t, ctx, client, "select_range", map[string]any{"documentId": id, "range": protocol.SelectionRange{Start: 1, End: 9, ChannelMask: 1}}, false)
	call(t, ctx, client, "select_range", map[string]any{"documentId": id, "range": protocol.SelectionRange{Start: 1, End: 99, ChannelMask: 1}}, true)
	crop := automation.Operation{Method: protocol.MethodEditApply, Params: map[string]any{"operation": "crop"}}
	call(t, ctx, client, "apply_operation", map[string]any{"documentId": id, "operation": crop, "dryRun": true}, true)
	result := call(t, ctx, client, "apply_operation", map[string]any{"documentId": id, "operation": crop}, false)
	if result["document"].(map[string]any)["frames"] != float64(8) {
		t.Fatal("failed selection changed the valid crop range", result)
	}
	call(t, ctx, client, "save_document", map[string]any{"documentId": id, "path": filepath.Join(directory, "missing", "output.wav"), "format": "wav", "bitDepth": 16}, true)
	if call(t, ctx, client, "history", args, false)["dirty"] != true {
		t.Fatal("failed save marked history clean")
	}
	call(t, ctx, client, "save_document", map[string]any{"documentId": id, "path": filepath.Join(directory, "output.wav"), "format": "wav", "bitDepth": 16, "scope": "selection"}, true)
	call(t, ctx, client, "undo", args, false)
	info := call(t, ctx, client, "document_info", args, false)
	if info["document"].(map[string]any)["frames"] != float64(10) {
		t.Fatal("crop did not undo", info)
	}
}

func TestStdioProcess(t *testing.T) {
	// The test executable acts as a real native stdio child process. os.Exit
	// prevents the testing harness from appending non-MCP output to stdout.
	if os.Getenv("AAE_MCP_TEST_CHILD") == "1" {
		policy, err := automation.NewFilePolicy(nil)
		if err != nil {
			os.Exit(2)
		}
		if err := New(policy).Run(context.Background(), &mcp.StdioTransport{}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(3)
		}
		policy.Close()
		os.Exit(0)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestStdioProcess$")
	cmd.Env = append(os.Environ(), "AAE_MCP_TEST_CHILD=1")
	stderr := new(bytes.Buffer)
	cmd.Stderr = stderr
	session, err := mcp.NewClient(&mcp.Implementation{Name: "stdio-test"}, nil).Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatal(err, stderr.String())
	}
	defer func() { _ = session.Close() }()
	id := open(t, ctx, session, writeFixture(t, t.TempDir()))
	stats := call(t, ctx, session, "get_statistics", map[string]any{"documentId": id}, false)
	peak := stats["statistics"].([]any)[0].(map[string]any)["peak"].(float64)
	if peak != float64(math.Float32frombits(0x4640e6b6)) {
		t.Fatal("stdio statistics mismatch", peak)
	}
}
