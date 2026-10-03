package engine

import (
	"fmt"
	"math"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/history"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

const (
	maxHistoryEntries       = 100
	minHistoryBytes   int64 = 512 << 20
)

type historySnapshot struct {
	document audiobuf.Document
	editor   editorState
}

func cloneEditor(editor editorState) editorState {
	return editor
}

func newDocumentHistory(document audiobuf.Document, editor editorState) (*history.History[historySnapshot], error) {
	stats := audiobuf.CountMemory(document)
	bytes := stats.SampleBytes + stats.PeakBytes
	limits := history.Limits{MaxEntries: maxHistoryEntries, MaxBytes: max(minHistoryBytes, bytes*2)}
	return history.New(historySnapshot{document: document, editor: cloneEditor(editor)}, "Opened", limits, func(snapshot historySnapshot) audiobuf.Document { return snapshot.document })
}

func (e *Engine) historyResult() protocol.HistoryListResult {
	result := protocol.HistoryListResult{DocumentID: e.editor.documentID, Entries: make([]protocol.HistoryEntry, 0), MaxEntries: maxHistoryEntries}
	if e.history == nil {
		return result
	}
	states := e.history.States()
	entries := e.history.Entries()
	for i, state := range states {
		label := e.history.BaseLabel()
		if i > 0 {
			label = entries[i-1].Label
		}
		result.Entries = append(result.Entries, protocol.HistoryEntry{StateID: state.ID, Label: label})
	}
	result.RetainedBytes = e.history.RetainedBytes()
	result.CurrentStateID, result.SavedStateID = e.history.CurrentID(), e.history.SavedID()
	result.Dirty, result.CanUndo, result.CanRedo = e.history.Dirty(), e.history.CanUndo(), e.history.CanRedo()
	result.MaxBytes = e.history.Limits().MaxBytes
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
	if e.history == nil {
		return protocol.HistoryListResult{}, fmt.Errorf("%s: history is not initialized", protocol.MethodMarkSaved)
	}
	if err := e.history.MarkSaved(p.StateID); err != nil {
		return protocol.HistoryListResult{}, fmt.Errorf("%s: %w", protocol.MethodMarkSaved, err)
	}
	return e.historyResult(), nil
}

func (e *Engine) navigateHistory(method, documentID, stateID string) (protocol.EditResult, error) {
	if err := e.validateDocumentID(method, documentID); err != nil {
		return protocol.EditResult{}, err
	}
	if e.history == nil {
		return protocol.EditResult{}, fmt.Errorf("%s: history is not initialized", method)
	}
	if method == protocol.MethodHistoryJump && stateID == e.history.CurrentID() {
		return e.editResult(false), nil
	}
	if e.documentSequence == math.MaxUint64 {
		return protocol.EditResult{}, fmt.Errorf("%s: document identity exhausted", method)
	}
	staged := e.history.Clone()
	if err := staged.ReplaceCurrent(historySnapshot{document: e.document, editor: cloneEditor(e.editor)}); err != nil {
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
	e.history = staged
	e.document = snapshot.document
	e.editor = cloneEditor(snapshot.editor)
	e.documentSequence++
	e.editor.documentID = fmt.Sprintf("doc-%d", e.documentSequence)
	e.transport, e.source = nil, sourceStopped
	return e.editResult(true), nil
}

func editHistoryLabel(operation string) string {
	return strings.ReplaceAll(operation, "-", " ")
}
