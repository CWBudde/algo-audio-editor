package engine

import (
	"fmt"
	"math/rand/v2"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/dither"
)

func exportQuantizers(document audiobuf.Document, indices []int, p protocol.DocumentExportParams) ([]*dither.Quantizer, error) {
	kind, err := exportDither(p.Dither)
	if err != nil {
		return nil, err
	}
	if kind == dither.DitherNone && (p.NoiseShaping == "" || p.NoiseShaping == "none") {
		return nil, nil
	}
	shaping, err := exportShaping(p.NoiseShaping)
	if err != nil {
		return nil, err
	}
	quantizers := make([]*dither.Quantizer, len(indices))
	for index, sourceChannel := range indices {
		options := []dither.Option{dither.WithBitDepth(p.BitDepth), dither.WithDitherType(kind), shaping, dither.WithLimit(true), dither.WithPCMQuantization()}
		if p.Seed != nil {
			// Source-channel identity preserves a channel's reproducible stream
			// when exporting a subset. Every quantizer owns separate RNG/shaping.
			options = append(options, dither.WithRNG(rand.New(rand.NewPCG(uint64(*p.Seed), uint64(sourceChannel)+1))))
		}
		quantizers[index], err = dither.NewQuantizer(float64(document.SampleRate()), options...)
		if err != nil {
			return nil, fmt.Errorf("doc.export: prepare channel %d quantizer: %w", sourceChannel, err)
		}
	}
	return quantizers, nil
}

func exportDither(value string) (dither.DitherType, error) {
	switch value {
	case "", "none":
		return dither.DitherNone, nil
	case "rectangular":
		return dither.DitherRectangular, nil
	case "triangular":
		return dither.DitherTriangular, nil
	case "gaussian":
		return dither.DitherGaussian, nil
	case "fast-gaussian":
		return dither.DitherFastGaussian, nil
	default:
		return 0, fmt.Errorf("doc.export: unsupported dither %q", value)
	}
}

func exportShaping(value string) (dither.Option, error) {
	switch value {
	case "", "none":
		return dither.WithFIRPreset(dither.PresetNone), nil
	case "efb":
		return dither.WithFIRPreset(dither.PresetEFB), nil
	case "2sc":
		return dither.WithFIRPreset(dither.Preset2SC), nil
	case "9fc":
		return dither.WithFIRPreset(dither.Preset9FC), nil
	case "sbm":
		return dither.WithFIRPreset(dither.PresetSBM), nil
	case "sharp":
		return dither.WithSharpPreset(), nil
	default:
		return nil, fmt.Errorf("doc.export: unsupported noise shaping %q", value)
	}
}

// exportSource captures a private immutable view. Exports never stage an edit,
// mark a history state saved, or change the authoritative selection.
func (e *Engine) exportSource(p protocol.DocumentExportParams) (audiobuf.Document, []int, error) {
	if e.document.Channels() == 0 {
		return audiobuf.Document{}, nil, fmt.Errorf("doc.export: no document is open")
	}
	if p.DocumentID != "" {
		if err := e.validateDocumentID(protocol.MethodDocumentExport, p.DocumentID); err != nil {
			return audiobuf.Document{}, nil, err
		}
	}
	if (p.Format != "wav" && p.Format != "flac" && p.Format != "aiff") || (p.Format != "wav" && p.Float) || (p.Format == "flac" && p.BitDepth == 32) || (p.Float && p.BitDepth != 32 && p.BitDepth != 64) || (!p.Float && p.BitDepth != 8 && p.BitDepth != 16 && p.BitDepth != 24 && p.BitDepth != 32) {
		return audiobuf.Document{}, nil, fmt.Errorf("doc.export: unsupported format %q/%d bits/float=%t", p.Format, p.BitDepth, p.Float)
	}
	kind, err := exportDither(p.Dither)
	if err != nil {
		return audiobuf.Document{}, nil, err
	}
	if _, err := exportShaping(p.NoiseShaping); err != nil {
		return audiobuf.Document{}, nil, err
	}
	if p.Float && (kind != dither.DitherNone || (p.NoiseShaping != "" && p.NoiseShaping != "none")) {
		return audiobuf.Document{}, nil, fmt.Errorf("doc.export: dither and noise shaping require integer PCM")
	}
	start, end, mask := int64(0), e.document.Frames(), (1<<e.document.Channels())-1
	switch p.Scope {
	case "", "document":
	case "selection":
		selection := e.editor.selection
		if err := e.validateEditorRange(protocol.MethodDocumentExport, selection.Start, selection.End); err != nil {
			return audiobuf.Document{}, nil, err
		}
		if err := e.validateChannelMask(protocol.MethodDocumentExport, selection.ChannelMask); err != nil {
			return audiobuf.Document{}, nil, err
		}
		if selection.Start == selection.End {
			return audiobuf.Document{}, nil, fmt.Errorf("doc.export: selection must contain audio")
		}
		start, end, mask = selection.Start, selection.End, selection.ChannelMask
	default:
		return audiobuf.Document{}, nil, fmt.Errorf("doc.export: unsupported scope %q", p.Scope)
	}
	channels := make([]audiobuf.Channel, 0, e.document.Channels())
	indices := make([]int, 0, e.document.Channels())
	for index := range e.document.Channels() {
		if mask&(1<<index) == 0 {
			continue
		}
		channel, err := e.document.Channel(index)
		if err != nil {
			return audiobuf.Document{}, nil, fmt.Errorf("doc.export: channel %d: %w", index, err)
		}
		if !p.Float {
			if _, err := channel.FinitePeak(start, end); err != nil {
				return audiobuf.Document{}, nil, fmt.Errorf("doc.export: integer channel %d must be finite: %w", index, err)
			}
		}
		part, err := channel.Slice(start, end)
		if err != nil {
			return audiobuf.Document{}, nil, fmt.Errorf("doc.export: channel %d selection: %w", index, err)
		}
		channels, indices = append(channels, part), append(indices, index)
	}
	metadata := e.document.Metadata()
	if p.Scope == "selection" {
		// Opaque chunks may reference original file offsets/lengths. Partial
		// exports retain text tags and ID-filtered annotation supplements only.
		metadata.WAVChunks, err = selectionWAVChunks(metadata.WAVChunks)
		if err != nil {
			return audiobuf.Document{}, nil, fmt.Errorf("doc.export: selection metadata: %w", err)
		}
	}
	metadata.Timeline, err = metadata.Timeline.Crop(e.document.Frames(), start, end)
	if err != nil {
		return audiobuf.Document{}, nil, fmt.Errorf("doc.export: annotations: %w", err)
	}
	document, err := audiobuf.NewDocument(channels, e.document.SampleRate(), metadata)
	if err != nil {
		return audiobuf.Document{}, nil, fmt.Errorf("doc.export: view: %w", err)
	}
	return document, indices, nil
}
