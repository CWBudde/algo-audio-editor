// Package ops implements immutable, application-level audio edits. Operations
// share unchanged storage; DSP and codecs remain in the tagged algo-* libraries.
package ops

import (
	"fmt"
	"math/bits"
	"slices"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/memory"
	"github.com/cwbudde/algo-dsp/dsp/signal"
)

const maxSafeFrames = 1<<53 - 1

// MaxMixOutputBytes limits newly materialized selected-channel float32 samples
// per paste-mix. Shared insert/replace storage is not subject to this budget.
const MaxMixOutputBytes int64 = memory.StorageLimit

// Range uses document frames and a positive bit mask (bit zero is channel zero).
type Range struct {
	Start, End  int64
	ChannelMask int
}

// Operation returns a new snapshot. Errors return the unchanged input document.
type Operation interface {
	Apply(audiobuf.Document) (audiobuf.Document, error)
}

// Delete removes selected frames from selected channels.
type Delete struct{ Range Range }

// Crop retains the selected time interval in every channel.
type Crop struct{ Range Range }

// Mute replaces selected samples with silence.
type Mute struct{ Range Range }

// Duplicate inserts a copy of the selected interval.
type Duplicate struct{ Range Range }

// SwapChannels exchanges selected channel audio.
type SwapChannels struct{ Range Range }

// InsertSilence inserts silent frames at the selection start.
type InsertSilence struct {
	Range  Range
	Frames int64
}

// PasteMode selects insertion, replacement or mixing of clipboard audio.
type PasteMode string

// Clipboard paste modes control insertion, replacement and mixing.
const (
	// PasteInsert inserts clipboard audio without replacing source frames.
	PasteInsert  PasteMode = "insert"
	PasteReplace PasteMode = "replace"
	PasteMix     PasteMode = "mix"
)

// Paste places clipboard audio according to its range and mode.
type Paste struct {
	Range     Range
	Clipboard Clipboard
	Mode      PasteMode
}

// Clipboard packs selected channels in ascending source-channel order. Only
// touched original blocks are retained, including uncopied fractional edges.
type Clipboard struct {
	windows    []audiobuf.Window
	sampleRate int
}

// NewClipboard retains shared immutable windows from a document selection.
func NewClipboard(document audiobuf.Document, selected Range) (Clipboard, error) {
	if err := validate(document, selected, true); err != nil {
		return Clipboard{}, fmt.Errorf("ops.copy: %w", err)
	}
	windows := make([]audiobuf.Window, 0, bits.OnesCount(uint(selected.ChannelMask)))
	for i := range document.Channels() {
		if selected.ChannelMask&(1<<i) == 0 {
			continue
		}
		channel, err := document.Channel(i)
		if err != nil {
			return Clipboard{}, fmt.Errorf("ops.copy: channel %d: %w", i, err)
		}
		window, err := channel.Window(selected.Start, selected.End)
		if err != nil {
			return Clipboard{}, fmt.Errorf("ops.copy: window %d: %w", i, err)
		}
		windows = append(windows, window)
	}
	return Clipboard{windows: windows, sampleRate: document.SampleRate()}, nil
}

// Copy is the value-operation spelling of NewClipboard; it changes no document.
func Copy(document audiobuf.Document, selected Range) (Clipboard, error) {
	return NewClipboard(document, selected)
}

// SampleRate returns the clipboard sample rate in Hz.
func (c Clipboard) SampleRate() int { return c.sampleRate }

// Channels returns the number of clipboard channels.
func (c Clipboard) Channels() int { return len(c.windows) }

// Frames returns the number of audio frames.
func (c Clipboard) Frames() int64 {
	if len(c.windows) == 0 {
		return 0
	}
	return c.windows[0].Frames()
}

// Window returns a selected clipboard channel window.
func (c Clipboard) Window(channel int) (audiobuf.Window, error) {
	if channel < 0 || channel >= len(c.windows) {
		return audiobuf.Window{}, fmt.Errorf("clipboard.window: channel %d outside [0, %d)", channel, len(c.windows))
	}
	return c.windows[channel], nil
}

// Windows returns a copy of the shared clipboard window list.
func (c Clipboard) Windows() []audiobuf.Window { return slices.Clone(c.windows) }

func (c Clipboard) Read(dst []float32, channel int, start int64) int {
	if channel < 0 || channel >= len(c.windows) {
		return 0
	}
	return c.windows[channel].Read(dst, start)
}

func validate(document audiobuf.Document, selected Range, nonempty bool) error {
	if document.Channels() < 1 || document.Channels() > 8 || document.SampleRate() <= 0 || document.Frames() > maxSafeFrames {
		return fmt.Errorf("invalid document format or non-JS-safe duration")
	}
	if selected.Start < 0 || selected.End < selected.Start || selected.End > document.Frames() {
		return fmt.Errorf("range [%d, %d) outside [0, %d)", selected.Start, selected.End, document.Frames())
	}
	if nonempty && selected.Start == selected.End {
		return fmt.Errorf("a nonempty selection is required")
	}
	if selected.ChannelMask <= 0 || selected.ChannelMask&((1<<document.Channels())-1) != selected.ChannelMask {
		return fmt.Errorf("invalid channel mask %d for %d channels", selected.ChannelMask, document.Channels())
	}
	return nil
}

func splice(channel audiobuf.Channel, start, end int64, middle audiobuf.Channel) (audiobuf.Channel, error) {
	if channel.Frames()-(end-start)+middle.Frames() > maxSafeFrames {
		return audiobuf.Channel{}, fmt.Errorf("result exceeds JS-safe frame limit")
	}
	left, err := channel.Slice(0, start)
	if err != nil {
		return audiobuf.Channel{}, fmt.Errorf("prefix: %w", err)
	}
	right, err := channel.Slice(end, channel.Frames())
	if err != nil {
		return audiobuf.Channel{}, fmt.Errorf("suffix: %w", err)
	}
	return left.Concat(middle).Concat(right), nil
}

// editChannels keeps unselected sample positions unchanged. Ripple edits of a
// subset pad the shorter channels at EOF so every channel retains equal length.
func editChannels(document audiobuf.Document, selected Range, metadata audiobuf.Metadata, edit func(audiobuf.Channel, int) (audiobuf.Channel, error)) (audiobuf.Document, error) {
	channels := make([]audiobuf.Channel, document.Channels())
	var frames int64
	for i := range channels {
		channel, err := document.Channel(i)
		if err != nil {
			return document, fmt.Errorf("channel %d: %w", i, err)
		}
		if selected.ChannelMask&(1<<i) != 0 {
			channel, err = edit(channel, i)
			if err != nil {
				return document, fmt.Errorf("channel %d: %w", i, err)
			}
		}
		channels[i] = channel
		frames = max(frames, channel.Frames())
	}
	padding := make(map[int64]audiobuf.Channel)
	for i, channel := range channels {
		if extra := frames - channel.Frames(); extra > 0 {
			silence, exists := padding[extra]
			if !exists {
				var err error
				silence, err = audiobuf.NewSilence(extra)
				if err != nil {
					return document, fmt.Errorf("pad channel %d: %w", i, err)
				}
				padding[extra] = silence
			}
			channels[i] = channel.Concat(silence)
		}
	}
	result, err := audiobuf.NewDocument(channels, document.SampleRate(), metadata)
	if err != nil {
		return document, fmt.Errorf("document: %w", err)
	}
	return result, nil
}

func rippleMetadata(document audiobuf.Document, selected Range, start, end, inserted int64) (audiobuf.Metadata, error) {
	metadata := document.Metadata()
	if selected.ChannelMask == (1<<document.Channels())-1 {
		var err error
		metadata.Timeline, err = metadata.Timeline.Splice(document.Frames(), start, end, inserted)
		if err != nil {
			return audiobuf.Metadata{}, fmt.Errorf("shift timeline: %w", err)
		}
	}
	return metadata, nil
}

// Apply returns an immutable document with this edit applied.
func (op Delete) Apply(document audiobuf.Document) (audiobuf.Document, error) {
	if err := validate(document, op.Range, true); err != nil {
		return document, fmt.Errorf("ops.delete: %w", err)
	}
	metadata, err := rippleMetadata(document, op.Range, op.Range.Start, op.Range.End, 0)
	if err != nil {
		return document, fmt.Errorf("ops.delete: %w", err)
	}
	result, err := editChannels(document, op.Range, metadata, func(channel audiobuf.Channel, _ int) (audiobuf.Channel, error) {
		return splice(channel, op.Range.Start, op.Range.End, audiobuf.Channel{})
	})
	if err != nil {
		return document, fmt.Errorf("ops.delete: %w", err)
	}
	return result, nil
}

// Apply returns an immutable document with this edit applied.
// Crop always applies the time range to every channel, regardless of the mask.
func (op Crop) Apply(document audiobuf.Document) (audiobuf.Document, error) {
	if err := validate(document, op.Range, true); err != nil {
		return document, fmt.Errorf("ops.crop: %w", err)
	}
	result, err := document.Slice(op.Range.Start, op.Range.End)
	if err != nil {
		return document, fmt.Errorf("ops.crop: %w", err)
	}
	return result, nil
}

// Apply returns an immutable document with this edit applied.
// InsertSilence inserts at Start; End does not replace a selected range.
func (op InsertSilence) Apply(document audiobuf.Document) (audiobuf.Document, error) {
	if err := validate(document, op.Range, false); err != nil {
		return document, fmt.Errorf("ops.insertSilence: %w", err)
	}
	if op.Frames <= 0 || op.Frames > maxSafeFrames-document.Frames() {
		return document, fmt.Errorf("ops.insertSilence: positive duration must keep the result JS-safe")
	}
	silence, err := audiobuf.NewSilence(op.Frames)
	if err != nil {
		return document, fmt.Errorf("ops.insertSilence: %w", err)
	}
	metadata, err := rippleMetadata(document, op.Range, op.Range.Start, op.Range.Start, op.Frames)
	if err != nil {
		return document, fmt.Errorf("ops.insertSilence: %w", err)
	}
	result, err := editChannels(document, op.Range, metadata, func(channel audiobuf.Channel, _ int) (audiobuf.Channel, error) {
		return splice(channel, op.Range.Start, op.Range.Start, silence)
	})
	if err != nil {
		return document, fmt.Errorf("ops.insertSilence: %w", err)
	}
	return result, nil
}

// Apply returns an immutable document with this edit applied.
func (op Mute) Apply(document audiobuf.Document) (audiobuf.Document, error) {
	if err := validate(document, op.Range, true); err != nil {
		return document, fmt.Errorf("ops.mute: %w", err)
	}
	silence, err := audiobuf.NewSilence(op.Range.End - op.Range.Start)
	if err != nil {
		return document, fmt.Errorf("ops.mute: %w", err)
	}
	result, err := editChannels(document, op.Range, document.Metadata(), func(channel audiobuf.Channel, _ int) (audiobuf.Channel, error) {
		return splice(channel, op.Range.Start, op.Range.End, silence)
	})
	if err != nil {
		return document, fmt.Errorf("ops.mute: %w", err)
	}
	return result, nil
}

// Apply returns an immutable document with this edit applied.
func (op Duplicate) Apply(document audiobuf.Document) (audiobuf.Document, error) {
	clipboard, err := NewClipboard(document, op.Range)
	if err != nil {
		return document, fmt.Errorf("ops.duplicate: %w", err)
	}
	result, err := (Paste{Range: Range{Start: op.Range.End, End: op.Range.End, ChannelMask: op.Range.ChannelMask}, Clipboard: clipboard, Mode: PasteInsert}).Apply(document)
	if err != nil {
		return document, fmt.Errorf("ops.duplicate: %w", err)
	}
	return result, nil
}

// Apply returns an immutable document with this edit applied.
func (op SwapChannels) Apply(document audiobuf.Document) (audiobuf.Document, error) {
	if err := validate(document, op.Range, false); err != nil {
		return document, fmt.Errorf("ops.swapChannels: %w", err)
	}
	if bits.OnesCount(uint(op.Range.ChannelMask)) != 2 {
		return document, fmt.Errorf("ops.swapChannels: exactly two selected channels are required")
	}
	selected := op.Range
	if selected.Start == selected.End {
		selected.Start, selected.End = 0, document.Frames()
	}
	indices := [2]int{}
	count := 0
	for i := range document.Channels() {
		if selected.ChannelMask&(1<<i) != 0 {
			indices[count], count = i, count+1
		}
	}
	parts := [2]audiobuf.Channel{}
	for i, index := range indices {
		channel, err := document.Channel(index)
		if err != nil {
			return document, fmt.Errorf("ops.swapChannels: channel %d: %w", index, err)
		}
		parts[i], err = channel.Slice(selected.Start, selected.End)
		if err != nil {
			return document, fmt.Errorf("ops.swapChannels: range %d: %w", index, err)
		}
	}
	result, err := editChannels(document, selected, document.Metadata(), func(channel audiobuf.Channel, i int) (audiobuf.Channel, error) {
		other := parts[0]
		if i == indices[0] {
			other = parts[1]
		}
		return splice(channel, selected.Start, selected.End, other)
	})
	if err != nil {
		return document, fmt.Errorf("ops.swapChannels: %w", err)
	}
	return result, nil
}

// Apply returns an immutable document with this edit applied.
func (op Paste) Apply(document audiobuf.Document) (audiobuf.Document, error) {
	if err := validate(document, op.Range, false); err != nil {
		return document, fmt.Errorf("ops.paste: %w", err)
	}
	clipboard := op.Clipboard
	selectedCount := bits.OnesCount(uint(op.Range.ChannelMask))
	if clipboard.Frames() <= 0 || clipboard.SampleRate() != document.SampleRate() || (clipboard.Channels() != 1 && clipboard.Channels() != selectedCount) {
		return document, fmt.Errorf("ops.paste: clipboard must be nonempty with matching rate and channel layout (or mono)")
	}
	end := op.Range.End
	switch op.Mode {
	case PasteInsert:
		end = op.Range.Start
	case PasteReplace:
	case PasteMix:
		if err := validateMixBudget(clipboard.Frames(), selectedCount); err != nil {
			return document, fmt.Errorf("ops.paste: %w", err)
		}
		end = min(document.Frames(), op.Range.Start+clipboard.Frames())
	default:
		return document, fmt.Errorf("ops.paste: unsupported mode %q", op.Mode)
	}
	if document.Frames()-(end-op.Range.Start)+clipboard.Frames() > maxSafeFrames {
		return document, fmt.Errorf("ops.paste: result exceeds JS-safe frame limit")
	}
	parts := make([]audiobuf.Channel, clipboard.Channels())
	if op.Mode != PasteMix {
		for i := range parts {
			var err error
			parts[i], err = clipboard.windows[i].Materialize()
			if err != nil {
				return document, fmt.Errorf("ops.paste: materialize channel %d: %w", i, err)
			}
		}
	}
	packed := 0
	metadata := document.Metadata()
	if op.Mode != PasteMix {
		var err error
		metadata, err = rippleMetadata(document, op.Range, op.Range.Start, end, clipboard.Frames())
		if err != nil {
			return document, fmt.Errorf("ops.paste: %w", err)
		}
	}
	result, err := editChannels(document, op.Range, metadata, func(channel audiobuf.Channel, _ int) (audiobuf.Channel, error) {
		index := packed
		packed++
		if clipboard.Channels() == 1 {
			index = 0
		}
		middle := parts[index]
		if op.Mode == PasteMix {
			var err error
			middle, err = mix(channel, op.Range.Start, clipboard.windows[index])
			if err != nil {
				return audiobuf.Channel{}, err
			}
		}
		return splice(channel, op.Range.Start, end, middle)
	})
	if err != nil {
		return document, fmt.Errorf("ops.paste: %w", err)
	}
	return result, nil
}

func validateMixBudget(frames int64, channels int) error {
	// Divide before multiplying: even hostile frame counts cannot overflow.
	if frames < 0 || channels < 1 || channels > 8 || frames > MaxMixOutputBytes/4/int64(channels) {
		return fmt.Errorf("materialized mix output for %d frames/%d channels exceeds the %d-byte budget", frames, channels, MaxMixOutputBytes)
	}
	return nil
}

func mix(channel audiobuf.Channel, start int64, window audiobuf.Window) (audiobuf.Channel, error) {
	// Movement scratch is bounded to two mono float32 blocks. Summation is
	// delegated upstream, with no clipping or local sample arithmetic.
	left, right := make([]float32, audiobuf.BlockFrames), make([]float32, audiobuf.BlockFrames)
	blocks := make([]*audiobuf.Block, 0, int((window.Frames()+audiobuf.BlockFrames-1)/audiobuf.BlockFrames))
	for offset := int64(0); offset < window.Frames(); offset += audiobuf.BlockFrames {
		count := int(min(int64(audiobuf.BlockFrames), window.Frames()-offset))
		clear(left[:count])
		channel.Read(left[:count], start+offset)
		if n := window.Read(right[:count], offset); n != count {
			return audiobuf.Channel{}, fmt.Errorf("mix: clipboard read %d of %d frames", n, count)
		}
		if err := signal.AddInto32(left[:count], left[:count], right[:count]); err != nil {
			return audiobuf.Channel{}, fmt.Errorf("mix: add: %w", err)
		}
		block, err := audiobuf.NewBlock(left[:count])
		if err != nil {
			return audiobuf.Channel{}, fmt.Errorf("mix: block: %w", err)
		}
		blocks = append(blocks, block)
	}
	channel, err := audiobuf.NewChannelFromBlocks(blocks)
	if err != nil {
		return audiobuf.Channel{}, fmt.Errorf("mix: channel: %w", err)
	}
	return channel, nil
}
