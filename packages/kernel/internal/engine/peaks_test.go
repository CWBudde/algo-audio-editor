package engine

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func engineWithDocument(t *testing.T, frames int) (*Engine, []float32) {
	t.Helper()
	samples := make([]float32, frames)
	for i := range samples {
		samples[i] = float32(i%7-3) / 4
	}
	e := New()
	var err error
	e.doc.document, err = audiobuf.NewDocument([]audiobuf.Channel{audiobuf.NewChannel(samples)}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}

	return e, samples
}

func TestPeaksGetBinary(t *testing.T) {
	for _, tt := range []struct {
		name         string
		frames       int
		start, end   int64
		buckets      int
		level, count int
	}{
		{"raw", 10, 0, 10, 2, 5, 2},
		{"single samples", 10, 2, 5, 2000, 1, 3},
		{"cached 256", 1024, 0, 1024, 4, 256, 4},
		{"cached 4096", 8192, 0, 8192, 2, 4096, 2},
		{"cached 65536", 2 * audiobuf.BlockFrames, 0, 2 * audiobuf.BlockFrames, 2, 65536, 2},
		{"clipped viewport", 1024, 100, 511, 1, 256, 2},
		{"empty viewport", 10, 2, 2, 1, 1, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e, samples := engineWithDocument(t, tt.frames)
			params := protocol.PeaksGetParams{Channel: 0, StartFrame: tt.start, EndFrame: tt.end, Buckets: tt.buckets}
			resp := call(t, e, protocol.MethodPeaksGet, mustJSON(t, params))
			if !resp.OK {
				t.Fatalf("peaks.get: %s", resp.Error)
			}
			var info protocol.PeaksGetInfo
			if err := json.Unmarshal(resp.Result, &info); err != nil {
				t.Fatal(err)
			}
			if info.Count != tt.count || info.FramesPerBucket != int64(tt.level) || info.DataBytes != tt.count*24 {
				t.Fatalf("metadata = %+v, want level %d, count %d", info, tt.level, tt.count)
			}
			if strings.Contains(string(resp.Result), "[") {
				t.Fatal("bulk arrays were serialized as JSON")
			}
			data := e.TakeData()
			if len(data) != info.DataBytes {
				t.Fatalf("binary bytes = %d, metadata says %d", len(data), info.DataBytes)
			}
			for i := range info.Count {
				start := int(math.Float64frombits(binary.LittleEndian.Uint64(data[16*info.Count+8*i:])))
				frames := int(binary.LittleEndian.Uint32(data[12*info.Count+4*i:]))
				if frames <= 0 || frames > tt.level || start < 0 || start+frames > len(samples) {
					t.Fatalf("invalid represented range [%d,%d)", start, start+frames)
				}
				lo, hi := samples[start], samples[start]
				var energy float64
				for _, sample := range samples[start : start+frames] {
					lo, hi = min(lo, sample), max(hi, sample)
					energy += float64(sample) * float64(sample)
				}
				want := [3]float32{lo, hi, float32(math.Sqrt(energy / float64(frames)))}
				for j := range want {
					got := math.Float32frombits(binary.LittleEndian.Uint32(data[12*i+4*j:]))
					if math.Abs(float64(got-want[j])) > 1e-6 {
						t.Fatalf("bucket %d statistic %d = %v, want %v", i, j, got, want[j])
					}
				}
			}
			if len(e.TakeData()) != 0 {
				t.Fatal("binary result was returned twice")
			}
		})
	}
}

func TestPeaksGetErrorsClearBinaryData(t *testing.T) {
	for _, tt := range []struct{ name, payload, want string }{
		{"malformed", "{", "decode params"},
		{"fractional frame", `{"startFrame":1.5}`, "decode params"},
		{"channel", `{"channel":1,"startFrame":0,"endFrame":10,"buckets":1}`, "channel"},
		{"negative start", `{"startFrame":-1,"endFrame":10,"buckets":1}`, "range"},
		{"reversed", `{"startFrame":5,"endFrame":3,"buckets":1}`, "range"},
		{"past end", `{"endFrame":11,"buckets":1}`, "range"},
		{"zero buckets", `{"endFrame":10,"buckets":0}`, "buckets"},
		{"too many buckets", `{"endFrame":10,"buckets":8193}`, "buckets"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := engineWithDocument(t, 10)
			good := call(t, e, protocol.MethodPeaksGet, `{"endFrame":10,"buckets":1}`)
			if !good.OK {
				t.Fatalf("initial peaks.get: %s", good.Error)
			}
			bad := call(t, e, protocol.MethodPeaksGet, tt.payload)
			if bad.OK || !strings.Contains(bad.Error, tt.want) {
				t.Fatalf("error = %q, want %q", bad.Error, tt.want)
			}
			if len(e.TakeData()) != 0 {
				t.Fatal("rejected call exposed previous binary data")
			}
		})
	}
	if resp := call(t, New(), protocol.MethodPeaksGet, `{"endFrame":10,"buckets":1}`); resp.OK || !strings.Contains(resp.Error, "no document") {
		t.Fatalf("absent document: %+v", resp)
	}
	e, _ := engineWithDocument(t, 10)
	call(t, e, protocol.MethodPeaksGet, `{"endFrame":10,"buckets":1}`)
	call(t, e, protocol.MethodHello, "")
	if len(e.TakeData()) != 0 {
		t.Fatal("control call retained previous binary data")
	}
}
