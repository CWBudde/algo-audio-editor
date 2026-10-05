package engine

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/wav"
	"github.com/go-audio/audio"
	"github.com/go-audio/riff"
)

// Mapping only: text and associated-data codecs belong to the tagged wav module.
func wavTagFields(m *wav.Metadata) map[string]*string {
	if m == nil {
		m = &wav.Metadata{}
	}
	return map[string]*string{
		"title": &m.Title, "artist": &m.Artist, "album": &m.Product,
		"comment": &m.Comments, "copyright": &m.Copyright, "date": &m.CreationDate,
		"genre": &m.Genre, "track": &m.TrackNbr, "engineer": &m.Engineer,
		"technician": &m.Technician, "keywords": &m.Keywords, "medium": &m.Medium,
		"subject": &m.Subject, "software": &m.Software, "source": &m.Source, "location": &m.Location,
	}
}

var infoTagKeys = map[string]string{
	"INAM": "title", "IART": "artist", "IPRD": "album", "ICMT": "comment",
	"ICOP": "copyright", "ICRD": "date", "IGNR": "genre", "ITRK": "track", "itrk": "track",
	"IENG": "engineer", "ITCH": "technician", "IKEY": "keywords", "IMED": "medium",
	"ISBJ": "subject", "ISFT": "software", "ISRC": "source", "IARL": "location",
}

func metadataChunk(chunk audiobuf.FileChunk) *riff.Chunk {
	return &riff.Chunk{ID: chunk.ID, Size: len(chunk.Data), R: bytes.NewReader(chunk.Data)}
}

func wavTags(chunks []audiobuf.FileChunk) (map[string]string, error) {
	decoder := wav.NewDecoder(bytes.NewReader(nil))
	for _, chunk := range chunks {
		if chunk.ID == wav.CIDList && len(chunk.Data) >= 4 && string(chunk.Data[:4]) == "INFO" {
			if err := wav.DecodeListChunk(decoder, metadataChunk(chunk)); err != nil {
				return nil, fmt.Errorf("wav.metadata: INFO: %w", err)
			}
		}
	}
	tags := map[string]string{}
	if decoder.Metadata != nil {
		for key, field := range wavTagFields(decoder.Metadata) {
			text := *field
			// RIFF INFO has no mandatory Unicode encoding. Preserve original bytes;
			// expose a Latin-1 fallback only for strings that are not valid UTF-8.
			if !utf8.ValidString(text) {
				var b strings.Builder
				for _, value := range []byte(text) {
					b.WriteRune(rune(value))
				}
				text = b.String()
			}
			if text != "" {
				tags[key] = text
			}
		}
	}
	return validateTags(tags)
}

func decodeWAVMetadata(chunks []audiobuf.FileChunk, timeline audiobuf.Timeline) (audiobuf.Metadata, error) {
	tags, err := wavTags(chunks)
	if err != nil {
		return audiobuf.Metadata{}, fmt.Errorf("wav.metadata: decode: %w", err)
	}
	decoder := wav.NewDecoder(bytes.NewReader(nil))
	for _, chunk := range chunks {
		if chunk.ID == wav.CIDBext {
			if len(chunk.Data) < 602 {
				return audiobuf.Metadata{}, fmt.Errorf("wav.metadata: bext requires at least 602 bytes")
			}
			if err := wav.DecodeBroadcastChunk(decoder, metadataChunk(chunk)); err != nil {
				return audiobuf.Metadata{}, fmt.Errorf("wav.metadata: bext: %w", err)
			}
		}
		if chunk.ID == wav.CIDList && len(chunk.Data) >= 4 && string(chunk.Data[:4]) == "adtl" {
			if err := wav.DecodeAssociatedDataChunk(decoder, metadataChunk(chunk)); err != nil {
				return audiobuf.Metadata{}, fmt.Errorf("wav.metadata: decode: %w", err)
			}
		}
	}
	// The timeline importer remaps foreign cue zero to one unused positive ID.
	// Identify that new ID by comparing the retained label/region references.
	if decoder.Metadata != nil && decoder.Metadata.AssociatedData != nil {
		associated := decoder.Metadata.AssociatedData
		used := map[uint32]bool{}
		hasZero := false
		for _, label := range associated.Labels {
			used[label.CuePointID] = true
			hasZero = hasZero || label.CuePointID == 0
		}
		for _, region := range associated.Regions {
			used[region.CuePointID] = true
			hasZero = hasZero || region.CuePointID == 0
		}
		for _, note := range associated.Notes {
			hasZero = hasZero || note.CuePointID == 0
		}
		if hasZero {
			// Cue-only zero may have no label: choose the identity absent from all
			// original positive cues supplied separately by the importer below.
			for _, chunk := range chunks {
				if chunk.ID == wav.CIDCue {
					cues := wav.NewDecoder(bytes.NewReader(nil))
					if err := wav.DecodeCueChunk(cues, metadataChunk(chunk)); err != nil {
						return audiobuf.Metadata{}, fmt.Errorf("wav.metadata: decode: %w", err)
					}
					for _, cue := range cues.Metadata.CuePoints {
						used[binary.LittleEndian.Uint32(cue.ID[:])] = true
					}
				}
			}
			var zero uint32
			for _, marker := range timeline.Markers {
				if !used[uint32(marker.ID)] { // #nosec G115 -- The imported/encoded timeline passed Timeline.Validate (IDs 1..MaxUint32).
					zero = uint32(marker.ID) // #nosec G115 -- The imported/encoded timeline passed Timeline.Validate (IDs 1..MaxUint32).
				}
			}
			for _, region := range timeline.Regions {
				if !used[uint32(region.ID)] { // #nosec G115 -- The imported/encoded timeline passed Timeline.Validate (IDs 1..MaxUint32).
					zero = uint32(region.ID) // #nosec G115 -- The imported/encoded timeline passed Timeline.Validate (IDs 1..MaxUint32).
				}
			}
			if zero != 0 {
				for i := range associated.Notes {
					if associated.Notes[i].CuePointID == 0 {
						associated.Notes[i].CuePointID = zero
					}
				}
				for i := range associated.Regions {
					if associated.Regions[i].CuePointID == 0 {
						associated.Regions[i].CuePointID = zero
					}
				}
			}
		}
		active := map[uint32]bool{}
		for _, marker := range timeline.Markers {
			active[uint32(marker.ID)] = true // #nosec G115 -- The imported/encoded timeline passed Timeline.Validate (IDs 1..MaxUint32).
		}
		for _, region := range timeline.Regions {
			active[uint32(region.ID)] = true // #nosec G115 -- The imported/encoded timeline passed Timeline.Validate (IDs 1..MaxUint32).
		}
		for _, note := range associated.Notes {
			if !active[note.CuePointID] {
				return audiobuf.Metadata{}, fmt.Errorf("wav.metadata: note references missing cue %d", note.CuePointID)
			}
		}
		// Labels and lengths come from the current timeline. Store only supplements.
		associated.Labels = nil
		supplement, err := wav.EncodeAssociatedDataChunk(associated)
		if err != nil {
			return audiobuf.Metadata{}, fmt.Errorf("wav.metadata: decode: %w", err)
		}
		retained := make([]audiobuf.FileChunk, 0, len(chunks))
		for _, chunk := range chunks {
			if chunk.ID == wav.CIDCue || (chunk.ID == wav.CIDList && len(chunk.Data) >= 4 && string(chunk.Data[:4]) == "adtl") {
				continue
			}
			retained = append(retained, chunk)
		}
		chunks = append(retained, audiobuf.FileChunk{ID: supplement.ID, Data: supplement.Data})
	} else {
		chunks = slices.DeleteFunc(chunks, func(chunk audiobuf.FileChunk) bool { return chunk.ID == wav.CIDCue })
	}
	return audiobuf.Metadata{Tags: tags, Timeline: timeline, WAVChunks: chunks}, nil
}

// Encode INFO through the library's public Encoder; recover only its metadata
// chunks from a bounded zero-frame WAV. No PCM processing or codec is copied.
func encodeInfoTags(tags map[string]string) ([]byte, error) {
	if len(tags) == 0 {
		return nil, nil
	}
	m := &wav.Metadata{}
	for key, field := range wavTagFields(m) {
		*field = tags[key]
	}
	writer := &memoryWriteSeeker{limit: maxTimelineMetadataBytes + 44}
	encoder := wav.NewEncoder(writer, 48000, 16, 1, 1)
	encoder.Metadata = m
	if err := encoder.Write(&audio.Float32Buffer{Format: &audio.Format{SampleRate: 48000, NumChannels: 1}}); err != nil {
		return nil, fmt.Errorf("wav.metadata: codec: %w", err)
	}
	if err := encoder.Close(); err != nil {
		return nil, fmt.Errorf("wav.metadata: codec: %w", err)
	}
	for pos := 12; pos < len(writer.data); {
		size := int(binary.LittleEndian.Uint32(writer.data[pos+4:]))
		if string(writer.data[pos:pos+4]) == "LIST" {
			return slices.Clone(writer.data[pos+8 : pos+8+size]), nil
		}
		pos += 8 + size + size%2
	}
	return nil, fmt.Errorf("wav.metadata: INFO encoder emitted no list")
}

func encodeWAVMetadata(metadata audiobuf.Metadata, frames int64) ([]wav.RawChunk, int64, error) {
	chunks, _, err := encodeWAVTimeline(metadata.Timeline, frames)
	if err != nil {
		return nil, 0, fmt.Errorf("wav.metadata: encode: %w", err)
	}
	original, err := wavTags(metadata.WAVChunks)
	if err != nil {
		return nil, 0, fmt.Errorf("wav.metadata: encode: %w", err)
	}
	changed := map[string]string{}
	for key := range wavTagFields(nil) {
		if original[key] != metadata.Tags[key] {
			changed[key] = metadata.Tags[key]
		}
	}
	newInfo, err := encodeInfoTags(changed)
	if err != nil {
		return nil, 0, fmt.Errorf("wav.metadata: encode: %w", err)
	}
	associated := &wav.AssociatedData{}
	for i, chunk := range chunks {
		if chunk.ID == wav.CIDList && string(chunk.Data[:4]) == "adtl" {
			decoder := wav.NewDecoder(bytes.NewReader(nil))
			if err := wav.DecodeAssociatedDataChunk(decoder, &riff.Chunk{ID: chunk.ID, Size: len(chunk.Data), R: bytes.NewReader(chunk.Data)}); err != nil {
				return nil, 0, fmt.Errorf("wav.metadata: encode: %w", err)
			}
			associated = decoder.Metadata.AssociatedData
			chunks = slices.Delete(chunks, i, i+1)
			break
		}
	}
	active := map[uint32]bool{}
	for _, marker := range metadata.Timeline.Markers {
		active[uint32(marker.ID)] = true // #nosec G115 -- The imported/encoded timeline passed Timeline.Validate (IDs 1..MaxUint32).
	}
	for _, region := range metadata.Timeline.Regions {
		active[uint32(region.ID)] = true // #nosec G115 -- The imported/encoded timeline passed Timeline.Validate (IDs 1..MaxUint32).
	}
	for _, chunk := range metadata.WAVChunks {
		raw := wav.RawChunk{ID: chunk.ID, Data: chunk.Data}
		if chunk.ID == wav.CIDList && len(chunk.Data) >= 4 {
			switch string(chunk.Data[:4]) {
			case "INFO":
				if len(changed) > 0 {
					// Upstream decoding already validates nested lengths/padding. Retain
					// original records verbatim except fields explicitly changed by the user.
					payload := []byte("INFO")
					for pos := 4; pos < len(chunk.Data); {
						n := int(binary.LittleEndian.Uint32(chunk.Data[pos+4:]))
						end := pos + 8 + n + n%2
						if _, replacing := changed[infoTagKeys[string(chunk.Data[pos:pos+4])]]; !replacing {
							payload = append(payload, chunk.Data[pos:end]...)
						}
						pos = end
					}
					if len(payload) == 4 {
						continue
					}
					raw.Data = payload
				}
			case "adtl":
				decoder := wav.NewDecoder(bytes.NewReader(nil))
				if err := wav.DecodeAssociatedDataChunk(decoder, metadataChunk(chunk)); err != nil {
					return nil, 0, fmt.Errorf("wav.metadata: encode: %w", err)
				}
				extras := decoder.Metadata.AssociatedData
				for _, note := range extras.Notes {
					if active[note.CuePointID] {
						associated.Notes = append(associated.Notes, note)
					}
				}
				for i, region := range associated.Regions {
					for _, original := range extras.Regions {
						if original.CuePointID == region.CuePointID {
							original.SampleLength = region.SampleLength
							associated.Regions[i] = original
							break
						}
					}
				}
				associated.UnknownSubchunks = append(associated.UnknownSubchunks, extras.UnknownSubchunks...)
				continue
			}
		}
		chunks = append(chunks, raw)
	}
	if len(newInfo) > 4 {
		chunks = append(chunks, wav.RawChunk{ID: wav.CIDList, Data: newInfo})
	}
	if len(associated.Labels)+len(associated.Notes)+len(associated.Regions)+len(associated.UnknownSubchunks) > 0 {
		chunk, err := wav.EncodeAssociatedDataChunk(associated)
		if err != nil {
			return nil, 0, fmt.Errorf("wav.metadata: encode: %w", err)
		}
		chunks = append(chunks, chunk)
	}
	var size int64
	for i := range chunks {
		length := len(chunks[i].Data)
		if length > maxTimelineMetadataBytes {
			return nil, 0, fmt.Errorf("wav.metadata: metadata exceeds the %d-byte budget", maxTimelineMetadataBytes)
		}
		size += 8 + int64(length) + int64(length%2)
		if size > maxTimelineMetadataBytes {
			return nil, 0, fmt.Errorf("wav.metadata: metadata exceeds the %d-byte budget", maxTimelineMetadataBytes)
		}
		chunks[i].Size = uint32(length)
		chunks[i].Order = i
	}
	return chunks, size, nil
}

// Partial exports cannot interpret opaque metadata's original file references.
func selectionWAVChunks(chunks []audiobuf.FileChunk) ([]audiobuf.FileChunk, error) {
	result := make([]audiobuf.FileChunk, 0, len(chunks))
	for _, chunk := range chunks {
		if chunk.ID != wav.CIDList || len(chunk.Data) < 4 {
			continue
		}
		switch string(chunk.Data[:4]) {
		case "INFO":
			result = append(result, chunk)
		case "adtl":
			decoder := wav.NewDecoder(bytes.NewReader(nil))
			if err := wav.DecodeAssociatedDataChunk(decoder, metadataChunk(chunk)); err != nil {
				return nil, fmt.Errorf("wav.metadata: codec: %w", err)
			}
			associated := decoder.Metadata.AssociatedData
			associated.UnknownSubchunks = nil
			encoded, err := wav.EncodeAssociatedDataChunk(associated)
			if err != nil {
				return nil, fmt.Errorf("wav.metadata: codec: %w", err)
			}
			result = append(result, audiobuf.FileChunk{ID: encoded.ID, Data: encoded.Data})
		}
	}
	return result, nil
}
