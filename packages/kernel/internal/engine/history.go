package engine

import (
	"fmt"
	"math"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/history"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/memory"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

const (
	maxHistoryEntries       = 100
	maxHistoryBytes   int64 = memory.StorageLimit
)

type historySnapshot struct {
	document audiobuf.Document
	editor   editorState
}

func cloneEditor(editor editorState) editorState {
	return editor
}

func newDocumentHistory(document audiobuf.Document, editor editorState) (*history.History[historySnapshot], error) {
	limits := history.Limits{MaxEntries: maxHistoryEntries, MaxBytes: maxHistoryBytes}
	return history.New(historySnapshot{document: document, editor: cloneEditor(editor)}, "Opened", limits, func(snapshot historySnapshot) audiobuf.Document { return snapshot.document })
}

func (e *Engine) newDocumentHistory(document audiobuf.Document, editor editorState) (*history.History[historySnapshot], error) {
	h, err := newDocumentHistory(document, editor)
	if err != nil {
		return nil, err
	}
	if err := h.SetLimits(history.Limits{MaxEntries: maxHistoryEntries, MaxBytes: e.memory.capacity()}); err != nil {
		return nil, err
	}
	return h, nil
}

func (e *Engine) historyResult() protocol.HistoryListResult {
	result := protocol.HistoryListResult{DocumentID: e.doc.editor.documentID, Entries: make([]protocol.HistoryEntry, 0), MaxEntries: maxHistoryEntries}
	if e.historyState.history == nil {
		return result
	}
	states := e.historyState.history.States()
	entries := e.historyState.history.Entries()
	for i, state := range states {
		label := e.historyState.history.BaseLabel()
		if i > 0 {
			label = entries[i-1].Label
		}
		result.Entries = append(result.Entries, protocol.HistoryEntry{StateID: state.ID, Label: label})
	}
	result.RetainedBytes = e.historyState.history.RetainedBytes()
	result.CurrentStateID, result.SavedStateID = e.historyState.history.CurrentID(), e.historyState.history.SavedID()
	result.Dirty, result.CanUndo, result.CanRedo = e.historyState.history.Dirty(), e.historyState.history.CanUndo(), e.historyState.history.CanRedo()
	result.MaxBytes = e.historyState.history.Limits().MaxBytes
	return result
}

func (e *Engine) listHistory(p protocol.HistoryListParams) (protocol.HistoryListResult, error) {
	if err := e.validateDocumentID(protocol.MethodHistoryList, p.DocumentID); err != nil {
		return protocol.HistoryListResult{}, err
	}
	return e.historyResult(), nil
}

func (e *Engine) markSaved(p protocol.MarkSavedParams) (protocol.HistoryListResult, error) {
	if err := e.validateDocumentID(protocol.MethodMarkSaved, p.DocumentID); err != nil {
		return protocol.HistoryListResult{}, err
	}
	if e.historyState.history == nil {
		return protocol.HistoryListResult{}, fmt.Errorf("%s: history is not initialized", protocol.MethodMarkSaved)
	}
	if err := e.historyState.history.MarkSaved(p.StateID); err != nil {
		return protocol.HistoryListResult{}, fmt.Errorf("%s: %w", protocol.MethodMarkSaved, err)
	}
	return e.historyResult(), nil
}

func (e *Engine) navigateHistory(method, documentID, stateID string) (protocol.EditResult, error) {
	if err := e.validateDocumentID(method, documentID); err != nil {
		return protocol.EditResult{}, err
	}
	if e.historyState.history == nil {
		return protocol.EditResult{}, fmt.Errorf("%s: history is not initialized", method)
	}
	if method == protocol.MethodHistoryJump && stateID == e.historyState.history.CurrentID() {
		return e.editResult(false), nil
	}
	if e.doc.documentSequence == math.MaxUint64 {
		return protocol.EditResult{}, fmt.Errorf("%s: document identity exhausted", method)
	}
	staged := e.historyState.history.Clone()
	if err := staged.ReplaceCurrent(historySnapshot{document: e.doc.document, editor: cloneEditor(e.doc.editor)}); err != nil {
		return protocol.EditResult{}, fmt.Errorf("%s: capture current controls: %w", method, err)
	}
	var snapshot historySnapshot
	var err error
	switch method {
	case protocol.MethodEditUndo:
		snapshot, err = staged.Undo()
	case protocol.MethodEditRedo:
		snapshot, err = staged.Redo()
	case protocol.MethodHistoryJump:
		snapshot, err = staged.Jump(stateID)
	default:
		return protocol.EditResult{}, fmt.Errorf("unknown history method %q", method)
	}
	if err != nil {
		return protocol.EditResult{}, fmt.Errorf("%s: %w", method, err)
	}
	e.historyState.history = staged
	e.doc.document = snapshot.document
	e.doc.editor = cloneEditor(snapshot.editor)
	e.doc.documentSequence++
	e.doc.editor.documentID = fmt.Sprintf("doc-%d", e.doc.documentSequence)
	e.playback.transport, e.playback.source = nil, sourceStopped
	return e.editResult(true), nil
}

func editHistoryLabel(operation protocol.OperationName) string {
	switch operation {
	case protocol.OperationSpectralAttenuate:
		return "Attenuate spectral selection"
	case protocol.OperationSpectralRemove:
		return "Remove spectral selection"
	case protocol.OperationSpectralHeal:
		return "Heal spectral selection"
	case protocol.OperationNoiseReduce:
		return "Noise reduction"
	case protocol.OperationRemoveClicks:
		return "Remove clicks and pops"
	case protocol.OperationDeclip:
		return "Repair clipped audio"
	case protocol.OperationTimeStretch:
		return "Time stretch"
	case protocol.OperationRemoveHum:
		return "Remove mains hum"
	}

	return strings.ReplaceAll(string(operation), "-", " ")
}
