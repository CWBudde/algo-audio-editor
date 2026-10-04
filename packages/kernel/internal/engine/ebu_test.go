package engine

import (
	"bytes"
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/measure/loudness"
)

// Published vectors remain external: the EBU distribution terms do not permit
// bundling their WAV files in this repository. The actual editor codec, render
// path, reusable binary meter payload and cooperative statistics job are tested.
func TestPublishedEBUOutputMeterAndOfflineStatistics(t *testing.T) {
	directory := os.Getenv("AAE_EBU_TEST_SET")
	if directory == "" {
		t.Skip("set AAE_EBU_TEST_SET to the externally supplied EBU loudness test-set directory")
	}
	if !filepath.IsAbs(directory) {
		t.Fatal("AAE_EBU_TEST_SET must be an absolute directory")
	}
	tests := []struct {
		name                               string
		integrated, programmeLRA, truePeak float64
		anchor, boolTP                     bool
	}{
		{"seq-3341-1-16bit.wav", -23, 0, 0, true, false},
		{"seq-3341-2-16bit.wav", -33, 0, 0, true, false},
		{"seq-3341-5-16bit-v02.wav", -23, 0, 0, false, false},
		{"seq-3341-6-5channels-16bit.wav", -23, 0, 0, false, false},
		{"seq-3341-6-6channels-WAVEEX-16bit.wav", -23, 0, 0, false, false},
		{"seq-3341-7_seq-3342-5-24bit.wav", -23, 5, 0, false, false},
		{"seq-3341-2011-8_seq-3342-6-24bit-v02.wav", -23, 15, 0, false, false},
		{"seq-3341-16-24bit.wav.wav", 0, 0, -6, false, true},
		{"seq-3341-17-24bit.wav.wav", 0, 0, -6, false, true},
		{"seq-3341-19-24bit.wav.wav", 0, 0, 3, false, true},
		{"seq-3341-20-24bit.wav.wav", 0, 0, 0, false, true},
		{"seq-3341-21-24bit.wav.wav", 0, 0, 0, false, true},
		{"seq-3341-22-24bit.wav.wav", 0, 0, 0, false, true},
		{"seq-3341-23-24bit.wav.wav", 0, 0, 0, false, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := os.ReadFile(filepath.Join(directory, test.name))
			if err != nil {
				t.Fatal(err)
			}
			e := New()
			info, err := e.openDocument(protocol.DocumentOpenParams{Name: test.name}, encoded)
			if test.name == "seq-3341-6-6channels-WAVEEX-16bit.wav" {
				// The published fixture's RIFF length omits its12-byte fact chunk.
				// Production import must reject it. Only this known test fixture
				// gets an explicit in-memory container-length correction; neither
				// the external file nor any format/sample bytes are changed.
				if err == nil || !strings.Contains(err.Error(), `truncated "data" chunk at 72`) {
					t.Fatal("original malformed EBU container must be rejected", err)
				}
				if len(encoded) != 11520080 || string(encoded[:4]) != "RIFF" || string(encoded[8:16]) != "WAVEfmt " || binary.LittleEndian.Uint32(encoded[4:8]) != 11520060 || binary.LittleEndian.Uint32(encoded[16:20]) != 40 || string(encoded[60:64]) != "fact" || binary.LittleEndian.Uint32(encoded[64:68]) != 4 || string(encoded[72:76]) != "data" || binary.LittleEndian.Uint32(encoded[76:80]) != 11520000 || len(encoded[80:]) != 11520000 {
					t.Fatal("published fixture differs from the known12-byte parent-length defect")
				}
				corrected := bytes.Clone(encoded)
				binary.LittleEndian.PutUint32(corrected[4:8], uint32(len(corrected)-8))
				if !bytes.Equal(corrected[:4], encoded[:4]) || !bytes.Equal(corrected[8:], encoded[8:]) {
					t.Fatal("fixture correction changed source audio or format")
				}
				t.Log("original published6ch container rejected; corrected only RIFF parent length in test memory (+12 bytes for existing fact chunk), preserving all PCM bytes")
				info, err = e.openDocument(protocol.DocumentOpenParams{Name: test.name}, corrected)
			}
			if err != nil {
				t.Fatal("actual editor WAV import", err)
			}
			if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: float64(info.SampleRate), Channels: info.Channels}); err != nil {
				t.Fatal(err)
			}
			if _, err := e.configureMeters(protocol.MetersConfigureParams{}); err != nil {
				t.Fatal(err)
			}
			weights := make([]float64, info.Channels)
			for c := range weights {
				weights[c] = 1
			}
			switch info.Channels {
			case 5:
				weights[3] = 1.41
				weights[4] = 1.41
			case 6:
				weights[3] = 0
				weights[4] = 1.41
				weights[5] = 1.41
			}
			ref, err := loudness.NewStreamingMeter(loudness.IntegratedConfig{SampleRate: float64(info.SampleRate), Channels: info.Channels, ChannelWeights: weights, MaxFrames: info.Frames})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := e.playDocument(protocol.TransportPlayParams{}); err != nil {
				t.Fatal(err)
			}
			output := make([]float32, 257*info.Channels)
			for {
				n := e.Render(output)
				if err := ref.ProcessInterleaved32(output[:n*info.Channels]); err != nil {
					t.Fatal(err)
				}
				if n < 257 {
					break
				}
			}
			values := meterValues(t, e)
			reading := ref.Snapshot()
			if values[2] != float64(info.Frames) || values[14] != 0 {
				t.Fatal("actual rendered frames or meter failure", values[:16])
			}
			for i, expected := range []float64{reading.Momentary, reading.ShortTerm, reading.Integrated, reading.LRA} {
				actual := values[4+i]
				if math.IsNaN(actual) || math.IsNaN(expected) || (math.IsInf(actual, 0) || math.IsInf(expected, 0)) && actual != expected || !math.IsInf(actual, 0) && !math.IsInf(expected, 0) && math.Abs(actual-expected) > 1e-10 {
					t.Fatalf("actual output snapshot slot%d got%.12f reference%.12f", 4+i, values[4+i], expected)
				}
			}
			if test.boolTP {
				for c := range info.Channels {
					db := 20 * math.Log10(values[protocol.MetersChannelOffset+c*protocol.MetersChannelStride+3])
					if math.IsNaN(db) || math.IsInf(db, 0) || db < test.truePeak-.4 || db > test.truePeak+.2 {
						t.Fatalf("published truepeak channel%d got%.6fdBTP expected%.1f +.2/-.4", c, db, test.truePeak)
					}
				}
			} else {
				if math.IsNaN(values[6]) || math.IsInf(values[6], 0) || math.Abs(values[6]-test.integrated) > .1 {
					t.Fatalf("published integrated%.6f expected%.1f±.1", values[6], test.integrated)
				}
				if test.anchor {
					for _, slot := range []int{4, 5} {
						if math.IsNaN(values[slot]) || math.IsInf(values[slot], 0) || math.Abs(values[slot]-test.integrated) > .1 {
							t.Fatalf("published M/Sslot%d got%.6f", slot, values[slot])
						}
					}
				}
				if test.programmeLRA > 0 && (math.IsNaN(values[7]) || math.IsInf(values[7], 0) || math.Abs(values[7]-test.programmeLRA) > 1) {
					t.Fatalf("published programmeLRA %.6f expected%.1f±1", values[7], test.programmeLRA)
				}
			}
			p := analysisParams(e, "statistics", 0, info.Frames, (1<<info.Channels)-1)
			r, err := e.startAnalysis(p)
			if err != nil {
				t.Fatal(err)
			}
			r, _ = finishAnalysis(t, e, r)
			if math.IsNaN(reading.Integrated) || math.IsInf(reading.Integrated, 0) || r.IntegratedLUFS == nil || math.IsNaN(*r.IntegratedLUFS) || math.IsInf(*r.IntegratedLUFS, 0) || math.Abs(*r.IntegratedLUFS-reading.Integrated) > 1e-10 {
				t.Fatal("offline actual statistics differs from output meter", r.IntegratedLUFS, reading.Integrated)
			}
			t.Logf("rendered%d M%.6f S%.6f I%.6f LRA%.6f", info.Frames, values[4], values[5], values[6], values[7])
		})
	}
}
