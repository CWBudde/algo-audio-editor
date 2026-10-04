package engine

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func codecFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/codecs/tone." + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func codecSamples(t *testing.T, e *Engine) [][]float32 {
	t.Helper()
	out := make([][]float32, e.document.Channels())
	for ch := range out {
		c, _ := e.document.Channel(ch)
		out[ch] = make([]float32, e.document.Frames())
		c.Read(out[ch], 0)
	}
	return out
}

func assertCodecSamples(t *testing.T, e *Engine, want [][]float32) {
	t.Helper()
	got := codecSamples(t, e)
	if len(got) != len(want) {
		t.Fatal("channels")
	}
	for ch := range got {
		if len(got[ch]) != len(want[ch]) {
			t.Fatal("frames")
		}
		for i, v := range got[ch] {
			if v != want[ch][i] {
				t.Fatalf("ch %d frame %d: %v != %v", ch, i, v, want[ch][i])
			}
		}
	}
}

func TestIndependentCodecImports(t *testing.T) {
	reference := New()
	if _, err := reference.openDocument(protocol.DocumentOpenParams{}, codecFixture(t, "wav")); err != nil {
		t.Fatal(err)
	}
	want := codecSamples(t, reference)
	for _, format := range []string{"flac", "aiff", "aifc", "mp3"} {
		t.Run(format, func(t *testing.T) {
			e := New()
			info, err := e.openDocument(protocol.DocumentOpenParams{Name: "misleading.wav"}, codecFixture(t, format))
			if err != nil {
				t.Fatal(err)
			}
			if info.SampleRate != 44100 || info.Channels != 2 || info.Format != map[string]string{"flac": "flac", "aiff": "aiff", "aifc": "aiff", "mp3": "mp3"}[format] {
				t.Fatalf("info %+v", info)
			}
			if format != "mp3" {
				assertCodecSamples(t, e, want)
			} else {
				if info.Frames < 4097 {
					t.Fatalf("MP3 duration %+v", info)
				}
				var energy float64
				for _, v := range codecSamples(t, e)[0] {
					energy += float64(v) * float64(v)
				}
				if energy < 50 {
					t.Fatalf("MP3 signal energy %v", energy)
				}
			}
			if e.historyResult().Dirty {
				t.Fatal("import dirty")
			}
		})
	}
}

func TestLosslessCodecExportRoundTrips(t *testing.T) {
	for _, format := range []string{"flac", "aiff"} {
		for _, depth := range []int{8, 16, 24} {
			for _, channels := range []int{1, 2, 6} {
				t.Run(fmt.Sprintf("%s/%d-bit/%d-channel", format, depth, channels), func(t *testing.T) {
					pcm := make([]byte, 4097*channels*(depth/8))
					values := []int32{-1, 0, 1, int32(-(int64(1) << uint(depth-1))), int32((int64(1) << uint(depth-1)) - 1)}
					for i := 0; i < 4097*channels; i++ {
						v := values[i%len(values)]
						for j := 0; j < depth/8; j++ {
							b := byte(uint32(v) >> uint(j*8))
							if depth == 8 {
								b += 128
							}
							pcm[i*(depth/8)+j] = b
						}
					}
					e := New()
					if _, err := e.openDocument(protocol.DocumentOpenParams{Name: "source.wav"}, rawWAV(1, depth, channels, 44100, pcm, false)); err != nil {
						t.Fatal(err)
					}
					if depth == 8 {
						exact := make([]byte, 4097*channels*4)
						for channel := range channels {
							for frame := range 4097 {
								value := values[(frame*channels+channel)%len(values)]
								binary.LittleEndian.PutUint32(exact[(channel*4097+frame)*4:], math.Float32bits(float32(value)/128))
							}
						}
						if _, err := e.importBinaryDocumentMode(protocol.BinaryDocumentParams{Name: "source.wav", SampleRate: 44100, Channels: channels, Frames: 4097, NextAnchorID: 1}, exact, true); err != nil {
							t.Fatal(err)
						}
					}
					want := codecSamples(t, e)
					before := e.historyResult()
					info, err := e.exportDocument(protocol.DocumentExportParams{Format: format, BitDepth: depth})
					if err != nil {
						t.Fatal(err)
					}
					if info.Name != "source."+format {
						t.Fatal(info)
					}
					raw := e.TakeData()
					if e.historyResult().CurrentStateID != before.CurrentStateID || e.historyResult().Dirty != before.Dirty {
						t.Fatal("export changed history")
					}
					other := New()
					if _, err = other.openDocument(protocol.DocumentOpenParams{Name: info.Name}, raw); err != nil {
						t.Fatal(err)
					}
					assertCodecSamples(t, other, want)
				})
			}
		}
	}
}

func TestCodecFailuresPreserveDocument(t *testing.T) {
	e := New()
	_, err := e.openDocument(protocol.DocumentOpenParams{}, codecFixture(t, "wav"))
	if err != nil {
		t.Fatal(err)
	}
	id := e.editor.documentID
	want := codecSamples(t, e)
	for _, format := range []string{"aiff", "flac"} {
		input := codecFixture(t, format)
		for _, p := range [][]byte{input[:len(input)/2], input[:len(input)-8]} {
			if _, err = e.openDocument(protocol.DocumentOpenParams{}, p); err == nil {
				t.Fatal("accepted truncation", format)
			}
			if id != e.editor.documentID {
				t.Fatal("identity replaced")
			}
			assertCodecSamples(t, e, want)
		}
	}
	for _, p := range [][]byte{[]byte("ID3"), []byte("unknown"), []byte("FORM"), {255, 251}} {
		if _, err = e.openDocument(protocol.DocumentOpenParams{}, p); err == nil {
			t.Fatal("invalid codec")
		}
	}
	// Oversized declared decoded length must fail before decoding/storing samples.
	p := append([]byte(nil), codecFixture(t, "flac")...)
	p[21] |= 15
	for i := 22; i < 26; i++ {
		p[i] = 255
	}
	if _, err = e.openDocument(protocol.DocumentOpenParams{}, p); err == nil {
		t.Fatal("unbounded FLAC")
	}
}

func TestFLACChecksumMismatch(t *testing.T) {
	e := New()
	p := append([]byte(nil), codecFixture(t, "flac")...)
	p[26] ^= 1
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, p); err == nil {
		t.Fatal("invalid decoded checksum accepted")
	}
}

func TestCodecID3AndUnsupportedExport(t *testing.T) {
	tag := []byte{'I', 'D', '3', 4, 0, 0, 0, 0, 0, 0}
	e := New()
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, append(tag, codecFixture(t, "flac")...)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "flac", BitDepth: 32}); err == nil {
		t.Fatal("FLAC 32 export")
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "aiff", BitDepth: 32, Float: true}); err == nil {
		t.Fatal("AIFF float")
	}
}

func TestBrowserPCMReplacement(t *testing.T) {
	e := New()
	_, err := e.openDocument(protocol.DocumentOpenParams{}, codecFixture(t, "wav"))
	if err != nil {
		t.Fatal(err)
	}
	id := e.editor.documentID
	p := protocol.BinaryDocumentParams{Name: "browser.opus", SampleRate: 48000, Channels: 1, Frames: 2, NextAnchorID: 1}
	raw := make([]byte, 8)
	binary.LittleEndian.PutUint32(raw, math.Float32bits(.25))
	binary.LittleEndian.PutUint32(raw[4:], math.Float32bits(-.75))
	if _, err = e.importBinaryDocument(p, raw); err == nil {
		t.Fatal("extraction must require empty editor")
	}
	if _, err = e.importBinaryDocumentMode(p, raw[:4], true); err == nil || e.editor.documentID != id {
		t.Fatal("invalid PCM replaced document")
	}
	info, err := e.importBinaryDocumentMode(p, raw, true)
	if err != nil {
		t.Fatal(err)
	}
	if info.DocumentID == id || info.Frames != 2 || e.historyResult().Dirty {
		t.Fatal(info)
	}
	assertCodecSamples(t, e, [][]float32{{.25, -.75}})
}

func FuzzCodecOpen(f *testing.F) {
	seed := New()
	if _, err := seed.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, 1, 48000, make([]byte, 32), false)); err != nil {
		f.Fatal(err)
	}
	for _, format := range []string{"flac", "aiff"} {
		if _, err := seed.exportDocument(protocol.DocumentExportParams{Format: format, BitDepth: 16}); err != nil {
			f.Fatal(err)
		}
		f.Add(seed.TakeData())
	}
	mp3, err := os.ReadFile("testdata/codecs/tone.mp3")
	if err != nil {
		f.Fatal(err)
	}
	f.Add(mp3[:min(128, len(mp3))])
	f.Fuzz(func(t *testing.T, p []byte) {
		if len(p) > 1<<20 {
			return
		}
		e := New()
		e.memory.limit = 32 << 20
		_, _ = e.openDocument(protocol.DocumentOpenParams{}, p)
	})
}
