// This isolated evaluation program is copied into a temporary module by
// flac-evaluation.mjs. It is not imported by the editor or its kernel.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"

	"github.com/tphakala/go-flac/pcm"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func number(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		panic(err)
	}
	return n
}

func run(args []string) error {
	switch args[0] {
	case "generate":
		depth, channels, samples := number(args[1]), number(args[2]), number(args[3])
		width := (depth + 7) / 8
		buf := make([]byte, width*channels*samples)
		for i := range channels * samples {
			// Extrema, silence and deterministic nontrivial values; no floating DSP.
			var v int64
			switch i % 7 {
			case 0:
				v = -(int64(1) << (depth - 1))
			case 1:
				v = (int64(1) << (depth - 1)) - 1
			case 2:
				v = 0
			default:
				v = int64((uint64(i)*1664525+1013904223)&((uint64(1)<<depth)-1)) - (int64(1) << (depth - 1))
			}
			for b := range width {
				buf[i*width+b] = byte(v >> uint(8*b))
			}
		}
		return os.WriteFile(args[4], buf, 0o600)
	case "encode":
		src, err := os.Open(args[4])
		if err != nil {
			return err
		}
		defer src.Close()
		dst, err := os.Create(args[5])
		if err != nil {
			return err
		}
		defer dst.Close()
		enc, err := pcm.NewEncoder(dst, pcm.Config{SampleRate: 48000, BitDepth: number(args[1]), Channels: number(args[2]), TotalSamples: uint64(number(args[3])), CompressionLevel: 5})
		if err != nil {
			return err
		}
		if _, err = io.Copy(enc, src); err != nil {
			return err
		}
		return enc.Close()
	case "decode":
		src, err := os.Open(args[1])
		if err != nil {
			return err
		}
		defer src.Close()
		dec, err := pcm.NewDecoder(src)
		if err != nil {
			return err
		}
		dst, err := os.Create(args[2])
		if err != nil {
			return err
		}
		defer dst.Close()
		_, err = io.Copy(dst, dec)
		return err
	case "probe":
		return probe()
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func decode(data []byte) (int64, error) {
	dec, err := pcm.NewDecoder(bytes.NewReader(data))
	if err != nil {
		return 0, err
	}
	return io.Copy(io.Discard, dec)
}

func setTotal(data []byte, total uint64) {
	field := binary.BigEndian.Uint64(data[18:26])
	binary.BigEndian.PutUint64(data[18:26], field&^((uint64(1)<<36)-1)|total)
}

func probe() error {
	// A seekable encoder supplies the true MD5. Alter only metadata, not audio.
	f, err := os.CreateTemp("", "flac-probe-*.flac")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	enc, err := pcm.NewEncoder(f, pcm.Config{SampleRate: 48000, BitDepth: 16, Channels: 2, TotalSamples: 4097})
	if err != nil {
		return err
	}
	input := make([]byte, 4097*4)
	for i := range input {
		input[i] = byte(i * 37)
	}
	if _, err = enc.Write(input); err != nil {
		return err
	}
	if err = enc.Close(); err != nil {
		return err
	}
	data, err := os.ReadFile(f.Name())
	if err != nil {
		return err
	}
	type result struct {
		Name      string `json:"name"`
		Bytes     int64  `json:"bytes"`
		Error     string `json:"error"`
		Allocated uint64 `json:"allocatedBytes"`
	}
	results := []result{}
	check := func(name string, buf []byte) {
		runtime.GC()
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		n, err := decode(buf)
		runtime.ReadMemStats(&after)
		r := result{Name: name, Bytes: n, Allocated: after.TotalAlloc - before.TotalAlloc}
		if err != nil {
			r.Error = err.Error()
		}
		results = append(results, r)
	}
	check("valid", data)
	for _, total := range []uint64{0, 1, 4098, (uint64(1) << 36) - 1} {
		buf := bytes.Clone(data)
		setTotal(buf, total)
		check(fmt.Sprintf("declared-%d-md5", total), buf)
		clear(buf[26:42])
		check(fmt.Sprintf("declared-%d-zero-md5", total), buf)
	}
	buf := bytes.Clone(data)
	buf[26] ^= 1
	check("bad-md5", buf)
	buf = bytes.Clone(data)
	buf[len(buf)-1] ^= 1
	check("bad-frame-crc", buf)
	check("truncated-audio", data[:len(data)-1])
	check("truncated-metadata", data[:41])
	// Header advertises a maximal seek table, but there is no body. Allocation
	// must happen before even the first body byte is read in the tagged parser.
	buf = bytes.Clone(data[:42])
	buf[4] &= 0x7f
	buf = append(buf, 0x83, 0xff, 0xff, 0xff)
	check("truncated-max-seektable", buf)
	buf = bytes.Clone(data)
	field := binary.BigEndian.Uint64(buf[18:26])
	field = field &^ (uint64(7) << 41)
	binary.BigEndian.PutUint64(buf[18:26], field)
	check("declared-mono-stereo-frames", buf)
	buf = bytes.Clone(data)
	field = binary.BigEndian.Uint64(buf[18:26])
	field = field&^(((uint64(1)<<20)-1)<<44) | uint64(44100)<<44
	binary.BigEndian.PutUint64(buf[18:26], field)
	check("declared-44100-48000-frames", buf)
	buf = bytes.Clone(data)
	field = binary.BigEndian.Uint64(buf[18:26])
	field = field&^(uint64(31)<<36) | uint64(23)<<36
	binary.BigEndian.PutUint64(buf[18:26], field)
	clear(buf[26:42])
	check("declared-24bit-16bit-frames-zero-md5", buf)
	return json.NewEncoder(os.Stdout).Encode(results)
}
