package engine

import (
	"bytes"
	"encoding/binary"
	"math"
	"os"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestMP3MonoAndGaplessAlignment(t *testing.T) {
	for _, tc := range []struct {
		name           string
		channels, rate int
		frames         int64
		reference      string
	}{
		{"tone", 2, 44100, 4097, "tone"},
		{"tone-mono", 1, 44100, 4097, "tone-mono"},
		{"tone-mono-22k", 1, 22050, 2049, ""},
		{"tone-crc", 2, 44100, 4097, ""},
		{"tone-mono-vbr", 1, 44100, 4097, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input, err := os.ReadFile("testdata/codecs/" + tc.name + ".mp3")
			if err != nil {
				t.Fatal(err)
			}
			e := New()
			info, err := e.openDocument(protocol.DocumentOpenParams{Name: "misleading.wav"}, input)
			if err != nil {
				t.Fatal(err)
			}
			if info.Channels != tc.channels || info.SampleRate != tc.rate || info.Frames != tc.frames || info.Format != "mp3" || e.historyResult().Dirty {
				t.Fatalf("info %+v", info)
			}
			if tc.reference == "" {
				return
			}
			reference, err := os.ReadFile("testdata/codecs/" + tc.reference + "-mp3.s16le")
			if err != nil {
				t.Fatal(err)
			}
			if len(reference) != int(tc.frames)*tc.channels*2 {
				t.Fatal("reference duration")
			}
			samples := codecSamples(t, e)
			for ch := range samples {
				for frame, sample := range samples[ch] {
					want := int16(binary.LittleEndian.Uint16(reference[(frame*tc.channels+ch)*2:]))
					// Independent decoder implementations round PCM16 by at most two codes.
					if math.Abs(float64(sample)*32768-float64(want)) > 2 {
						t.Fatalf("ch %d frame %d: got %g, reference %d", ch, frame, sample*32768, want)
					}
				}
			}
		})
	}
}

func TestMP3UntaggedMonoPreservesDecodedInterval(t *testing.T) {
	input, err := os.ReadFile("testdata/codecs/tone-mono.mp3")
	if err != nil {
		t.Fatal(err)
	}
	input, err = skipID3(input)
	if err != nil {
		t.Fatal(err)
	}
	// This independent fixture has a 182-byte MPEG-1 Info frame at 56 kb/s.
	size := 144 * 56000 / 44100
	if string(input[21:25]) != "Info" {
		t.Fatal("fixture header changed")
	}
	e := New()
	info, err := e.openDocument(protocol.DocumentOpenParams{}, input[size:])
	if err != nil {
		t.Fatal(err)
	}
	if info.Channels != 1 || info.Frames != 5760 {
		t.Fatalf("untagged %+v", info)
	}
}

func TestMP3MalformedGaplessHeaderIsAtomic(t *testing.T) {
	input, err := skipID3(codecFixture(t, "mp3"))
	if err != nil {
		t.Fatal(err)
	}
	tag := bytes.Index(input, []byte("Info"))
	encoder := bytes.Index(input, []byte("Lavc"))
	for _, mutation := range []func([]byte){
		func(p []byte) { binary.BigEndian.PutUint32(p[tag+8:], 0) },
		func(p []byte) { binary.BigEndian.PutUint32(p[tag+8:], 100) },
		func(p []byte) { p[encoder+21], p[encoder+22], p[encoder+23] = 255, 255, 255 },
		func(p []byte) { p[encoder+21], p[encoder+22], p[encoder+23] = 0x24, 0, 1 },
	} {
		e := New()
		if _, err := e.openDocument(protocol.DocumentOpenParams{}, codecFixture(t, "wav")); err != nil {
			t.Fatal(err)
		}
		before := e.editResult(false)
		samples := codecSamples(t, e)
		broken := append([]byte(nil), input...)
		mutation(broken)
		if _, err := e.openDocument(protocol.DocumentOpenParams{}, broken); err == nil {
			t.Fatal("malformed gapless metadata accepted")
		}
		if !reflect.DeepEqual(before, e.editResult(false)) {
			t.Fatal("failed import changed state")
		}
		assertCodecSamples(t, e, samples)
	}
}

func TestMP3HeaderBounds(t *testing.T) {
	for _, version := range []int{3, 2, 0} {
		for _, mono := range []bool{false, true} {
			for _, crc := range []bool{false, true} {
				h := uint32(0xffe00000 | version<<19 | 1<<17 | 7<<12)
				if !crc {
					h |= 1 << 16
				}
				if mono {
					h |= 3 << 6
				}
				rate, side, samples := 44100, 32, 1152
				if mono {
					side = 17
				}
				if version != 3 {
					rate = 22050
					side = 17
					samples = 576
					if mono {
						side = 9
					}
				}
				if version == 0 {
					rate = 11025
				}
				coefficient, bitrate := 144, 96000
				if version != 3 {
					coefficient, bitrate = 72, 56000
				}
				p := make([]byte, coefficient*bitrate/rate)
				binary.BigEndian.PutUint32(p, h)
				offset := 4 + side
				copy(p[offset:], "Xing")
				binary.BigEndian.PutUint32(p[offset+4:], 1)
				binary.BigEndian.PutUint32(p[offset+8:], 10)
				copy(p[offset+12:], "LAME3.100")
				p[offset+12+21], p[offset+12+22], p[offset+12+23] = 0x24, 0x04, 0x3f
				info, err := inspectMP3(p)
				if err != nil || !info.gapless || info.tagFrames != int64(samples) || info.audioFrames != int64(10*samples) || info.delay != 576 || info.padding != 1087 {
					t.Fatalf("version %d mono %v crc %v: %+v %v", version, mono, crc, info, err)
				}
				for _, end := range []int{0, 3, offset + 8, len(p) - 1} {
					if _, err := inspectMP3(p[:end]); err == nil {
						t.Fatalf("accepted truncated header %d", end)
					}
				}
			}
		}
	}
}

func TestMP3GaplessTrimAcrossStorageBlocks(t *testing.T) {
	input, err := os.ReadFile("testdata/codecs/tone-mono-long.mp3")
	if err != nil {
		t.Fatal(err)
	}
	e := New()
	info, err := e.openDocument(protocol.DocumentOpenParams{}, input)
	if err != nil {
		t.Fatal(err)
	}
	if info.Channels != 1 || info.Frames != 129701 {
		t.Fatalf("long import %+v", info)
	}
	samples := codecSamples(t, e)[0]
	// Independently trimmed FFmpeg PCM16 probes cover the initial delay, storage
	// seams and the tail, where padding straddles two decoded storage blocks.
	for _, probe := range []struct {
		frame int
		code  int16
	}{
		{0, 275},
		{1, 1213},
		{2, 2448},
		{3, 3638},
		{4, 4758},
		{100, -282},
		{64430, -16106},
		{64431, -15443},
		{64432, -14719},
		{65535, -14337},
		{65536, -13527},
		{129699, 6234},
		{129700, 5513},
	} {
		if math.Abs(float64(samples[probe.frame])*32768-float64(probe.code)) > 2 {
			t.Fatalf("frame %d: %g != %d", probe.frame, samples[probe.frame]*32768, probe.code)
		}
	}
}
