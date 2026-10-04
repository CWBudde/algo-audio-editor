package audiobuf

import (
	"fmt"
	"maps"
	"slices"
)

// Metadata holds the display name, file tags and typed timeline. Documents
// copy maps and anchor lists on input/output, preserving snapshot ownership.
type Metadata struct {
	Name     string
	Tags     map[string]string
	Timeline Timeline
	// WAVChunks retains bounded non-audio container metadata.
	WAVChunks []FileChunk
}

// FileChunk is opaque container metadata; sample data is never stored here.
type FileChunk struct {
	ID   [4]byte
	Data []byte
}

func (m Metadata) clone() Metadata {
	m.Tags = maps.Clone(m.Tags)
	m.WAVChunks = slices.Clone(m.WAVChunks)
	for i := range m.WAVChunks {
		m.WAVChunks[i].Data = slices.Clone(m.WAVChunks[i].Data)
	}
	m.Timeline = m.Timeline.clone()

	return m
}

// Document is an immutable value containing equal-length audio channels,
// a sample rate in hertz and metadata. The zero value denotes no document.
type Document struct {
	channels   []Channel
	sampleRate int
	metadata   Metadata
}

// NewDocument shares channel storage and copies channels and metadata.
func NewDocument(channels []Channel, sampleRate int, metadata Metadata) (Document, error) {
	if sampleRate <= 0 {
		return Document{}, fmt.Errorf("document.new: sample rate %d must be positive", sampleRate)
	}
	if len(channels) == 0 {
		return Document{}, fmt.Errorf("document.new: at least one channel is required")
	}
	for i, channel := range channels {
		if channel.Frames() != channels[0].Frames() {
			return Document{}, fmt.Errorf("document.new: channel %d has %d frames, want %d", i, channel.Frames(), channels[0].Frames())
		}
	}

	metadata = metadata.clone()
	if metadata.Timeline.NextID == 0 {
		metadata.Timeline.NextID = 1
	}
	if err := metadata.Timeline.Validate(channels[0].Frames()); err != nil {
		return Document{}, fmt.Errorf("document.new: timeline: %w", err)
	}
	return Document{channels: slices.Clone(channels), sampleRate: sampleRate, metadata: metadata}, nil
}

// Frames returns the number of frames in each channel.
func (d Document) Frames() int64 {
	if len(d.channels) == 0 {
		return 0
	}

	return d.channels[0].Frames()
}

// Channels returns the channel count.
func (d Document) Channels() int { return len(d.channels) }

// SampleRate returns the sample rate in hertz.
func (d Document) SampleRate() int { return d.sampleRate }

// Metadata returns a copy of the document's metadata.
func (d Document) Metadata() Metadata { return d.metadata.clone() }

// Channel returns a channel value sharing immutable blocks.
func (d Document) Channel(index int) (Channel, error) {
	if index < 0 || index >= len(d.channels) {
		return Channel{}, fmt.Errorf("document.channel: index %d outside [0, %d)", index, len(d.channels))
	}

	return d.channels[index], nil
}

// WithMetadata returns a new snapshot with copied metadata and shared audio.
func (d Document) WithMetadata(metadata Metadata) (Document, error) {
	metadata = metadata.clone()
	if metadata.Timeline.NextID == 0 {
		metadata.Timeline.NextID = 1
	}
	if err := metadata.Timeline.Validate(d.Frames()); err != nil {
		return d, fmt.Errorf("document.withMetadata: timeline: %w", err)
	}
	d.metadata = metadata

	return d, nil
}

// Slice selects the same frame range across all channels. Audio blocks and
// immutable metadata are shared wherever possible.
func (d Document) Slice(start, end int64) (Document, error) {
	if len(d.channels) == 0 {
		return Document{}, fmt.Errorf("document.slice: no document")
	}

	total := d.Frames()
	channels := make([]Channel, len(d.channels))
	for i, channel := range d.channels {
		part, err := channel.Slice(start, end)
		if err != nil {
			return Document{}, fmt.Errorf("document.slice: channel %d: %w", i, err)
		}
		channels[i] = part
	}
	d.channels = channels
	timeline, err := d.metadata.Timeline.Crop(total, start, end)
	if err != nil {
		return Document{}, fmt.Errorf("document.slice: timeline: %w", err)
	}
	d.metadata.Timeline = timeline

	return d, nil
}

// Concat appends a document with the same sample rate and channel count,
// retaining the left document's metadata and sharing all audio blocks.
func (d Document) Concat(other Document) (Document, error) {
	if len(d.channels) == 0 || len(d.channels) != len(other.channels) || d.sampleRate != other.sampleRate {
		return Document{}, fmt.Errorf("document.concat: incompatible formats (%d Hz/%d channels and %d Hz/%d channels)",
			d.sampleRate, len(d.channels), other.sampleRate, len(other.channels))
	}

	channels := make([]Channel, len(d.channels))
	for i, channel := range d.channels {
		channels[i] = channel.Concat(other.channels[i])
	}
	d.channels = channels

	return d, nil
}
