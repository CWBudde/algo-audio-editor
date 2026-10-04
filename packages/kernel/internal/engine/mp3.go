package engine

import (
	"encoding/binary"
	"fmt"
)

// The decoder always emits stereo 16-bit PCM. These fields describe the source
// format and the sample interval to retain, independently of that output format.
type mp3Info struct {
	channels                               int
	tagBytes                               int
	tagFrames, delay, padding, audioFrames int64
	hasCount, gapless                      bool
}

// inspectMP3 reads the first Layer III frame, Xing/Info flags and optional LAME
// extension without searching arbitrary compressed bytes for tag signatures.
// Gapless fields follow LAME's VbrTag.c; the 529-sample decoder delay follows
// https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mp3dec.c.
func inspectMP3(input []byte) (mp3Info, error) {
	var info mp3Info
	if len(input) < 4 {
		return info, fmt.Errorf("doc.open: truncated MP3 header")
	}
	h := binary.BigEndian.Uint32(input)
	version, layer, bitrateIndex, rateIndex := (h>>19)&3, (h>>17)&3, (h>>12)&15, (h>>10)&3
	if h&0xffe00000 != 0xffe00000 || version == 1 || layer != 1 || bitrateIndex == 0 || bitrateIndex == 15 || rateIndex == 3 || h&3 == 2 {
		return info, fmt.Errorf("doc.open: unsupported MP3 frame header")
	}
	info.channels = 2
	if (h>>6)&3 == 3 {
		info.channels = 1
	}
	rate := []int{44100, 48000, 32000}[rateIndex]
	bitrates := []int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320}
	coefficient, samples, side := 144, 1152, 32
	if info.channels == 1 {
		side = 17
	}
	if version != 3 {
		rate /= 2
		if version == 0 {
			rate /= 2
		}
		bitrates = []int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}
		coefficient, samples, side = 72, 576, 17
		if info.channels == 1 {
			side = 9
		}
	}
	size := coefficient*bitrates[bitrateIndex]*1000/rate + int((h>>9)&1)
	if size > len(input) || size < 4+side {
		return info, fmt.Errorf("doc.open: truncated MP3 first frame")
	}
	frame := input[:size]
	offset := 4 + side
	// LAME keeps Xing at the no-CRC offset even in protected frames.
	// See libmp3lame/VbrTag.c: the tag overlaps the last two side-info bytes.
	if offset+8 > len(frame) {
		return info, nil
	}
	tag := string(frame[offset : offset+4])
	if tag != "Xing" && tag != "Info" {
		return info, nil
	}
	info.tagFrames = int64(samples)
	info.tagBytes = size
	flags := binary.BigEndian.Uint32(frame[offset+4 : offset+8])
	if flags&^uint32(15) != 0 {
		return info, fmt.Errorf("doc.open: invalid Xing flags")
	}
	offset += 8
	for _, field := range []struct {
		flag uint32
		size int
	}{{1, 4}, {2, 4}, {4, 100}, {8, 4}} {
		if flags&field.flag == 0 {
			continue
		}
		if offset+field.size > len(frame) {
			return info, fmt.Errorf("doc.open: truncated Xing fields")
		}
		if field.flag == 1 {
			count := binary.BigEndian.Uint32(frame[offset : offset+4])
			if count == 0 {
				return info, fmt.Errorf("doc.open: empty Xing frame count")
			}
			info.audioFrames = int64(count) * int64(samples)
			info.hasCount = true
		}
		offset += field.size
	}
	if offset+4 > len(frame) {
		return info, nil
	}
	encoder := string(frame[offset : offset+4])
	if encoder != "LAME" && encoder != "Lavc" && encoder != "Lavf" {
		return info, nil
	}
	if offset+24 > len(frame) {
		return info, fmt.Errorf("doc.open: truncated LAME delay/padding")
	}
	trim := frame[offset+21 : offset+24]
	info.delay = int64(trim[0])<<4 | int64(trim[1]>>4)
	info.padding = int64(trim[1]&15)<<8 | int64(trim[2])
	// A zero-filled encoder extension has no usable gapless information.
	if info.delay == 0 && info.padding == 0 {
		return info, nil
	}
	if info.padding < 529 || info.hasCount && info.delay+info.padding >= info.audioFrames {
		return info, fmt.Errorf("doc.open: invalid LAME delay/padding")
	}
	info.gapless = true
	return info, nil
}
