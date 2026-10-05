package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/testaudio"
)

func TestFLACFixtureBoundarySamples(t *testing.T) {
	checkFLACFixture(t, 2*testaudio.BlockFrames+17)
}

// This decodes and retains actual one-hour audio; budget arithmetic and
// repeated shared blocks cannot substitute for this acceptance run.
func TestFLACImportOneHour(t *testing.T) {
	if os.Getenv("AAE_LARGE_FILE_ACCEPTANCE") != "1" {
		t.Skip("opt in with just test-flac-hour; retains about 1.5 GiB")
	}
	checkFLACFixture(t, testaudio.HourFrames)
}

func checkFLACFixture(t *testing.T, frames int64) {
	t.Helper()
	file, err := os.Create(filepath.Join(t.TempDir(), "acceptance.flac"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	if err := testaudio.WriteFLAC(file, frames); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	input, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	e := New()
	started := time.Now()
	var response protocol.Response
	if err := json.Unmarshal(e.CallWithData(protocol.MethodDocumentOpen, []byte(`{"name":"acceptance.flac"}`), input), &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK {
		t.Fatal(response.Error)
	}
	var info protocol.DocumentInfoResult
	if err := json.Unmarshal(response.Result, &info); err != nil {
		t.Fatal(err)
	}
	if info.Frames != frames || info.Channels != 2 || info.SampleRate != testaudio.SampleRate || info.BitDepth != 24 || info.Format != "flac" {
		t.Fatalf("decoded format: %+v", info)
	}
	if result := e.historyResult(); result.Dirty || len(result.Entries) != 1 || result.RetainedBytes < frames*8 {
		t.Fatalf("initial history: %+v", result)
	}
	if e.retainedStorage() > e.memory.capacity() {
		t.Fatal("decoded storage exceeded shared ceiling")
	}
	scratch := make([]float32, testaudio.BlockFrames)
	for channel := range 2 {
		source, _ := e.doc.document.Channel(channel)
		for start := int64(0); start < frames; start += testaudio.BlockFrames {
			count := int(min(int64(len(scratch)), frames-start))
			if source.Read(scratch[:count], start) != count {
				t.Fatalf("short read channel %d frame %d", channel, start)
			}
			for i, value := range scratch[:count] {
				want := float32(testaudio.Sample(start+int64(i), channel)) / (1 << 23)
				if value != want {
					t.Fatalf("channel %d frame %d: %v != %v", channel, start+int64(i), value, want)
				}
			}
		}
	}
	t.Logf("actual FLAC import: frames=%d input_bytes=%d retained_bytes=%d import_and_validation=%s", frames, len(input), e.retainedStorage(), time.Since(started))
	// Exercise checksum corruption cheaply after the large document is loaded;
	// an invalid short input must preserve its identity and exact samples.
	bad, err := os.ReadFile("testdata/codecs/tone.flac")
	if err != nil {
		t.Fatal(err)
	}
	bad[26] ^= 1
	identity := info.DocumentID
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, bad); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("checksum corruption: %v", err)
	}
	if result, err := e.documentInfo(); err != nil || result.DocumentID != identity {
		t.Fatal("failed decode replaced one-hour document", err)
	}
}
