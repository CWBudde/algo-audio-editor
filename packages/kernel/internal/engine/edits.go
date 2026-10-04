package engine

import (
	"fmt"
	"math"
	"math/bits"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func (e *Engine) clipboardInfo() protocol.ClipboardInfo {
	info := protocol.ClipboardInfo{Available: e.clipboard.Channels() > 0, SampleRate: e.clipboard.SampleRate(), Channels: e.clipboard.Channels(), Frames: e.clipboard.Frames()}
	if info.Available {
		info.Version = fmt.Sprintf("clip-%d", e.clipboardSequence)
	}
	return info
}

func (e *Engine) preparePaste(p protocol.PreparePasteParams) (protocol.PastePlan, error) {
	const method = protocol.MethodPreparePaste
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.PastePlan{}, err
	}
	if err := e.validateChannelMask(method, p.ChannelMask); err != nil {
		return protocol.PastePlan{}, err
	}
	clip := e.clipboardInfo()
	if !clip.Available || p.ClipboardVersion == "" || p.ClipboardVersion != clip.Version {
		return protocol.PastePlan{}, fmt.Errorf("%s: missing or stale clipboard version", method)
	}
	frames, err := clipboardOutputFrames(clip.Frames, clip.SampleRate, e.document.SampleRate())
	if err != nil {
		return protocol.PastePlan{}, fmt.Errorf("%s: %w", method, err)
	}
	targetChannels := bits.OnesCount(uint(p.ChannelMask))
	return protocol.PastePlan{ConversionRequired: clip.SampleRate != e.document.SampleRate() || clip.Channels != targetChannels, SourceRate: clip.SampleRate, TargetRate: e.document.SampleRate(), SourceChannels: clip.Channels, TargetChannels: targetChannels, Frames: frames, ClipboardVersion: clip.Version}, nil
}

func (e *Engine) editResult(changed bool) protocol.EditResult {
	// applyEdit has already validated that a document is open.
	document, _ := e.documentInfo()
	return protocol.EditResult{Document: document, Selection: e.selectionResult(), Timeline: e.timelineResult(), Clipboard: e.clipboardInfo(), Changed: changed, History: e.historyResult()}
}

// applyEdit stages every fallible operation before publishing any engine state.
// Explicit selection payloads avoid races with independently queued selection.set.
func (e *Engine) applyEdit(p protocol.EditApplyParams) (protocol.EditResult, error) {
	const method = protocol.MethodEditApply
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.EditResult{}, err
	}
	if err := e.validateEditorRange(method, p.Start, p.End); err != nil {
		return protocol.EditResult{}, err
	}
	if err := e.validateChannelMask(method, p.ChannelMask); err != nil {
		return protocol.EditResult{}, err
	}
	selected := ops.Range{Start: p.Start, End: p.End, ChannelMask: p.ChannelMask}
	selection := p.SelectionRange
	clip := e.clipboard
	copying := p.Operation == "copy" || p.Operation == "cut"
	if copying {
		if e.clipboardSequence == math.MaxUint64 {
			return protocol.EditResult{}, fmt.Errorf("%s: clipboard identity exhausted", method)
		}
		var err error
		clip, err = ops.NewClipboard(e.document, selected)
		if err != nil {
			return protocol.EditResult{}, fmt.Errorf("%s: %w", method, err)
		}
	}
	// Edits share whole blocks but may copy fractional boundaries. Reserve
	// those before any conversion or operation publishes newly owned audio.
	extra := decodedStorage(min(e.document.Frames(), 6*audiobuf.BlockFrames), e.document.Channels(), audiobuf.BlockFrames)
	if p.Operation == "copy" || p.Operation == "swap-channels" {
		extra = 0
	}
	if err := e.checkStorage(method, extra); err != nil {
		return protocol.EditResult{}, err
	}
	var operation ops.Operation
	changed := true
	switch p.Operation {
	case "copy":
		changed = false
	case "delete", "cut":
		operation = ops.Delete{Range: selected}
		selection.End = selection.Start
		changed = p.Start != p.End
	case "crop":
		operation = ops.Crop{Range: selected}
		selection.Start, selection.End = 0, p.End-p.Start
	case "mute":
		operation = ops.Mute{Range: selected}
		changed = p.Start != p.End
	case "duplicate":
		operation = ops.Duplicate{Range: selected}
		selection.Start, selection.End = p.End, p.End+(p.End-p.Start)
		changed = p.Start != p.End
	case "swap-channels":
		if bits.OnesCount(uint(p.ChannelMask)) != 2 {
			return protocol.EditResult{}, fmt.Errorf("%s: swap requires exactly two selected channels", method)
		}
		operation = ops.SwapChannels{Range: selected}
		changed = e.document.Frames() != 0
	case "insert-silence":
		if p.Frames == nil || *p.Frames <= 0 || *p.Frames > maxEditorFrame-e.document.Frames() {
			return protocol.EditResult{}, fmt.Errorf("%s: positive silence duration must keep the result JS-safe", method)
		}
		extra += decodedStorage(min(*p.Frames, 2*audiobuf.BlockFrames), 1, audiobuf.BlockFrames)
		extra += (*p.Frames/audiobuf.BlockFrames + 1) * int64(e.document.Channels()) * 32
		if err := e.checkStorage(method, extra); err != nil {
			return protocol.EditResult{}, err
		}
		operation = ops.InsertSilence{Range: selected, Frames: *p.Frames}
		selection.End = p.Start + *p.Frames
	case "paste-insert", "paste-replace", "paste-mix":
		plan, err := e.preparePaste(protocol.PreparePasteParams{DocumentID: p.DocumentID, ChannelMask: p.ChannelMask, ClipboardVersion: p.ClipboardVersion})
		if err != nil {
			return protocol.EditResult{}, fmt.Errorf("%s: %w", method, err)
		}
		if plan.ConversionRequired && !p.Convert {
			return protocol.EditResult{}, fmt.Errorf("%s: sample-rate/channel conversion requires explicit confirmation", method)
		}
		// Check result duration before conversion allocates any sample storage.
		resultFrames := e.document.Frames() + plan.Frames
		if p.Operation == "paste-replace" {
			resultFrames -= p.End - p.Start
		}
		if p.Operation == "paste-mix" {
			resultFrames = max(e.document.Frames(), p.Start+plan.Frames)
		}
		if resultFrames > maxEditorFrame {
			return protocol.EditResult{}, fmt.Errorf("%s: result exceeds JS-safe frame limit", method)
		}
		if plan.ConversionRequired {
			storage := decodedStorage(plan.Frames, plan.TargetChannels, audiobuf.BlockFrames)
			if err := e.checkStorage(method, storage); err != nil {
				return protocol.EditResult{}, err
			}
			extra += storage
		}
		if p.Operation == "paste-mix" {
			storage := decodedStorage(plan.Frames, plan.TargetChannels, audiobuf.BlockFrames)
			if err := e.checkStorage(method, storage); err != nil {
				return protocol.EditResult{}, err
			}
			extra += storage
		} else if !plan.ConversionRequired {
			// Clipboard windows share original blocks; materializing a
			// fractional edge for insert/replace may copy up to two blocks.
			extra += decodedStorage(min(plan.Frames, 2*audiobuf.BlockFrames), plan.TargetChannels, audiobuf.BlockFrames)
		}
		if err := e.checkStorage(method, extra); err != nil {
			return protocol.EditResult{}, err
		}
		if plan.ConversionRequired {
			clip, err = convertClipboard(clip, plan.TargetRate, plan.TargetChannels)
			if err != nil {
				return protocol.EditResult{}, fmt.Errorf("%s: %w", method, err)
			}
		}
		mode := ops.PasteInsert
		if p.Operation == "paste-replace" {
			mode = ops.PasteReplace
		}
		if p.Operation == "paste-mix" {
			mode = ops.PasteMix
		}
		operation = ops.Paste{Range: selected, Clipboard: clip, Mode: mode}
		selection.End = p.Start + plan.Frames
	default:
		return protocol.EditResult{}, fmt.Errorf("%s: unknown operation %q", method, p.Operation)
	}
	if changed && e.documentSequence == math.MaxUint64 {
		return protocol.EditResult{}, fmt.Errorf("%s: document identity exhausted", method)
	}
	document := e.document
	editor := cloneEditor(e.editor)
	stagedHistory := e.history
	if changed {
		var err error
		document, err = operation.Apply(document)
		if err != nil {
			return protocol.EditResult{}, fmt.Errorf("%s: %w", method, err)
		}
	}
	selection.Start, selection.End = min(selection.Start, document.Frames()), min(selection.End, document.Frames())
	editor.selection = selection
	if changed {
		if stagedHistory == nil {
			var err error
			stagedHistory, err = e.newDocumentHistory(e.document, e.editor)
			if err != nil {
				return protocol.EditResult{}, fmt.Errorf("%s: initialize history: %w", method, err)
			}
		}
		before := cloneEditor(e.editor)
		before.selection = p.SelectionRange
		var err error
		stagedHistory, err = stagedHistory.StagePush(editHistoryLabel(p.Operation), historySnapshot{document: e.document, editor: before}, historySnapshot{document: document, editor: cloneEditor(editor)})
		if err != nil {
			return protocol.EditResult{}, fmt.Errorf("%s: retain undo history: %w", method, err)
		}
	}
	if copying {
		e.clipboard = clip
		e.clipboardSequence++
	}
	if changed {
		e.document, e.history = document, stagedHistory
		e.documentSequence++
		editor.documentID = fmt.Sprintf("doc-%d", e.documentSequence)
		e.transport, e.source = nil, sourceStopped
	}
	e.editor = editor
	return e.editResult(changed), nil
}
