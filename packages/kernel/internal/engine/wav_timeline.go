package engine

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/wav"
	"github.com/go-audio/riff"
)

const maxTimelineMetadataBytes = 2 << 20

var timelineExtensionID = [4]byte{'a', 'e', 'M', 'D'}

// Only selected, structurally validated payloads reach upstream chunk codecs.
// PCM is never read by a metadata decoder. General metadata has its own bounded
// Phase 6.3 mapping in wav_metadata.go.
type wavTimelineChunk struct {
	id   [4]byte
	data []byte
}

type wavAnchorColor struct {
	ID    int64  `json:"id"`
	Color string `json:"color"`
}

// Standard cue/labl/ltxt carry names and positions. This small application-owned
// extension carries only colors and the identity allocator, absent from RIFF's
// standard annotation schema; it is not a replacement for cue/adtl.
type wavTimelineExtension struct {
	Version int              `json:"version"`
	NextID  int64            `json:"nextId"`
	Colors  []wavAnchorColor `json:"colors"`
}

func (l *wavLayout) addTimelineChunk(id [4]byte, body []byte) error {
	l.timelineBytes += 8 + len(body) + len(body)%2
	if l.timelineBytes > maxTimelineMetadataBytes {
		return fmt.Errorf("wav.inspect: timeline metadata exceeds the %d-byte budget", maxTimelineMetadataBytes)
	}
	l.timelineChunks = append(l.timelineChunks, wavTimelineChunk{id: id, data: body})
	return nil
}

func decodeTimelineExtension(data []byte) (wavTimelineExtension, error) {
	var result wavTimelineExtension
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return result, fmt.Errorf("wav.timeline: decode color extension: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return result, fmt.Errorf("wav.timeline: color extension must contain one JSON value")
	}
	if result.Version != 1 || len(result.Colors) > audiobuf.MaxAnchors || result.NextID < 1 || result.NextID > audiobuf.MaxAnchorID+1 {
		return result, fmt.Errorf("wav.timeline: unsupported color extension version or invalid count/identity")
	}
	return result, nil
}

func decodeWAVTimeline(chunks []wavTimelineChunk, frames int64) (audiobuf.Timeline, error) {
	result := audiobuf.Timeline{NextID: 1}
	decoder := wav.NewDecoder(bytes.NewReader(nil))
	var extension *wavTimelineExtension
	seenCue := false
	for _, part := range chunks {
		chunk := &riff.Chunk{ID: part.id, Size: len(part.data), R: bytes.NewReader(part.data)}
		switch part.id {
		case wav.CIDCue:
			if seenCue {
				return result, fmt.Errorf("wav.timeline: multiple cue chunks")
			}
			seenCue = true
			if err := wav.DecodeCueChunk(decoder, chunk); err != nil {
				return result, fmt.Errorf("wav.timeline: decode cue: %w", err)
			}
		case wav.CIDList:
			if err := wav.DecodeAssociatedDataChunk(decoder, chunk); err != nil {
				return result, fmt.Errorf("wav.timeline: decode associated data: %w", err)
			}
		case timelineExtensionID:
			if extension != nil {
				return result, fmt.Errorf("wav.timeline: multiple color extensions")
			}
			value, err := decodeTimelineExtension(part.data)
			if err != nil {
				return result, err
			}
			extension = &value
		}
	}
	metadata := decoder.Metadata
	if metadata == nil {
		metadata = &wav.Metadata{}
	}
	if len(metadata.CuePoints) > audiobuf.MaxAnchors {
		return result, fmt.Errorf("wav.timeline: cue count exceeds %d anchors", audiobuf.MaxAnchors)
	}
	points := make(map[uint32]*wav.CuePoint, len(metadata.CuePoints))
	var highestID int64
	for _, point := range metadata.CuePoints {
		if point == nil || point.DataChunkID != [4]byte{'d', 'a', 't', 'a'} || point.ChunkStart != 0 || point.BlockStart != 0 || int64(point.SampleOffset) > frames {
			return result, fmt.Errorf("wav.timeline: cue must reference an in-range uncompressed data frame")
		}
		id := binary.LittleEndian.Uint32(point.ID[:])
		if _, exists := points[id]; exists {
			return result, fmt.Errorf("wav.timeline: duplicate cue identity %d", id)
		}
		points[id] = point
		highestID = max(highestID, int64(id))
	}
	// Foreign WAV cue zero is legal; document IDs are positive. Remap only that
	// cue to an unused identity, preserving every positive cue ID and its links.
	zeroID := highestID + 1
	if zeroID > audiobuf.MaxAnchorID {
		zeroID = 1
		for points[uint32(zeroID)] != nil {
			zeroID++
		}
	}
	names := make(map[uint32]string)
	regions := make(map[uint32]wav.CueRegion)
	if metadata.AssociatedData != nil {
		for _, label := range metadata.AssociatedData.Labels {
			if points[label.CuePointID] == nil {
				return result, fmt.Errorf("wav.timeline: label references missing cue %d", label.CuePointID)
			}
			if _, exists := names[label.CuePointID]; exists {
				return result, fmt.Errorf("wav.timeline: duplicate label for cue %d", label.CuePointID)
			}
			names[label.CuePointID] = label.Text
		}
		for _, region := range metadata.AssociatedData.Regions {
			if points[region.CuePointID] == nil {
				return result, fmt.Errorf("wav.timeline: region references missing cue %d", region.CuePointID)
			}
			if _, exists := regions[region.CuePointID]; exists {
				return result, fmt.Errorf("wav.timeline: duplicate region for cue %d", region.CuePointID)
			}
			regions[region.CuePointID] = region
		}
	}
	colors := make(map[int64]string)
	if extension != nil {
		for _, entry := range extension.Colors {
			color := strings.ToLower(entry.Color)
			if entry.ID < 1 || entry.ID > audiobuf.MaxAnchorID || points[uint32(entry.ID)] == nil {
				return result, fmt.Errorf("wav.timeline: color references missing or invalid cue %d", entry.ID)
			}
			if _, exists := colors[entry.ID]; exists {
				return result, fmt.Errorf("wav.timeline: duplicate color for cue %d", entry.ID)
			}
			if err := audiobuf.ValidateAnchorColor(color); err != nil {
				return result, fmt.Errorf("wav.timeline: cue %d color: %w", entry.ID, err)
			}
			colors[entry.ID] = color
		}
	}
	for _, point := range metadata.CuePoints {
		cueID := binary.LittleEndian.Uint32(point.ID[:])
		id := int64(cueID)
		if id == 0 {
			id = zeroID
		}
		result.NextID = max(result.NextID, id+1)
		region, hasRegion := regions[cueID]
		hasRegion = hasRegion && region.SampleLength > 0
		name := strings.TrimSpace(names[cueID])
		if name == "" && hasRegion {
			name = strings.TrimSpace(region.Text)
		}
		if name == "" {
			kind := "Marker"
			if hasRegion {
				kind = "Region"
			}
			name = fmt.Sprintf("%s %d", kind, id)
		}
		color := colors[id]
		if color == "" {
			color = audiobuf.DefaultAnchorColor
		}
		start := int64(point.SampleOffset)
		if hasRegion {
			result.Regions = append(result.Regions, audiobuf.Region{ID: id, Start: start, End: start + int64(region.SampleLength), Name: name, Color: color})
		} else {
			result.Markers = append(result.Markers, audiobuf.Marker{ID: id, Frame: start, Name: name, Color: color})
		}
	}
	if extension != nil {
		if extension.NextID < result.NextID {
			return result, fmt.Errorf("wav.timeline: color extension would reuse an existing cue identity")
		}
		result.NextID = extension.NextID
	}
	if err := result.Validate(frames); err != nil {
		return result, fmt.Errorf("wav.timeline: validate annotations: %w", err)
	}
	return result, nil
}

// Encode chunks using the tagged WAV library, not an application copy of RIFF
// cue/adtl codecs. The byte count includes all upstream alignment and headers.
func encodeWAVTimeline(timeline audiobuf.Timeline, frames int64) ([]wav.RawChunk, int64, error) {
	if err := timeline.Validate(frames); err != nil {
		return nil, 0, fmt.Errorf("wav.timeline: validate annotations: %w", err)
	}
	if len(timeline.Markers)+len(timeline.Regions) == 0 && timeline.NextID == 1 {
		return nil, 0, nil
	}
	cues := make([]*wav.CuePoint, 0, len(timeline.Markers)+len(timeline.Regions))
	associated := &wav.AssociatedData{}
	extension := wavTimelineExtension{Version: 1, NextID: timeline.NextID, Colors: make([]wavAnchorColor, 0, cap(cues))}
	add := func(id, frame int64, name, color string) error {
		if frame < 0 || frame > math.MaxUint32 {
			return fmt.Errorf("wav.timeline: cue frame exceeds the uint32 WAV annotation limit")
		}
		point := &wav.CuePoint{DataChunkID: [4]byte{'d', 'a', 't', 'a'}, SampleOffset: uint32(frame)}
		binary.LittleEndian.PutUint32(point.ID[:], uint32(id)) // #nosec G115 -- Timeline.Validate bounds every cue ID to 1..MaxUint32.
		cues = append(cues, point)
		associated.Labels = append(associated.Labels, wav.CueLabel{CuePointID: uint32(id), Text: name}) // #nosec G115 -- Timeline.Validate bounds cue IDs.
		extension.Colors = append(extension.Colors, wavAnchorColor{ID: id, Color: color})
		return nil
	}
	for _, marker := range timeline.Markers {
		if err := add(marker.ID, marker.Frame, marker.Name, marker.Color); err != nil {
			return nil, 0, err
		}
	}
	for _, region := range timeline.Regions {
		if region.End-region.Start < 0 || region.End-region.Start > math.MaxUint32 {
			return nil, 0, fmt.Errorf("wav.timeline: region length exceeds the uint32 WAV annotation limit")
		}
		if err := add(region.ID, region.Start, region.Name, region.Color); err != nil {
			return nil, 0, err
		}
		associated.Regions = append(associated.Regions, wav.CueRegion{CuePointID: uint32(region.ID), SampleLength: uint32(region.End - region.Start), PurposeID: [4]byte{'r', 'g', 'n', ' '}, CodePage: 65001}) // #nosec G115 -- Timeline.Validate bounds the ID; the region length is checked above.
	}
	colors, err := json.Marshal(extension)
	if err != nil {
		return nil, 0, fmt.Errorf("wav.timeline: encode color extension: %w", err)
	}
	chunks := []wav.RawChunk{{ID: timelineExtensionID, Data: colors}}
	if len(cues) > 0 {
		cue, err := wav.EncodeCueChunk(cues)
		if err != nil {
			return nil, 0, fmt.Errorf("wav.timeline: encode cue: %w", err)
		}
		adtl, err := wav.EncodeAssociatedDataChunk(associated)
		if err != nil {
			return nil, 0, fmt.Errorf("wav.timeline: encode associated data: %w", err)
		}
		chunks = append(chunks, cue, adtl)
	}
	var size int64
	for i := range chunks {
		length := len(chunks[i].Data)
		if length > maxTimelineMetadataBytes {
			return nil, 0, fmt.Errorf("wav.timeline: encoded annotations exceed the %d-byte budget", maxTimelineMetadataBytes)
		}
		size += 8 + int64(length) + int64(length%2)
		if size > maxTimelineMetadataBytes {
			return nil, 0, fmt.Errorf("wav.timeline: encoded annotations exceed the %d-byte budget", maxTimelineMetadataBytes)
		}
		chunks[i].Size = uint32(length)
		chunks[i].Order = i
	}
	return chunks, size, nil
}
