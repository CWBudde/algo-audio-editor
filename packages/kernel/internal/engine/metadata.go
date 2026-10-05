package engine

import (
	"fmt"
	"maps"
	"strings"
	"unicode/utf8"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

const maxTagBytes = 64 << 10

func validateTags(tags map[string]string) (map[string]string, error) {
	result := make(map[string]string, len(tags))
	total := 0
	fields := wavTagFields(nil)
	for key, value := range tags {
		if _, ok := fields[key]; !ok {
			return nil, fmt.Errorf("metadata.set: unknown tag %q", key)
		}
		if !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
			return nil, fmt.Errorf("metadata.set: %s requires UTF-8 text without NUL", key)
		}
		total += len(value)
		if total > maxTagBytes {
			return nil, fmt.Errorf("metadata.set: tags exceed the %d-byte budget", maxTagBytes)
		}
		if value != "" {
			result[key] = value
		}
	}
	return result, nil
}

func (e *Engine) metadataResult() protocol.MetadataResult {
	metadata := e.doc.document.Metadata()
	tags := metadata.Tags
	if tags == nil {
		tags = map[string]string{}
	}
	chunks := make([]string, 0, len(metadata.WAVChunks))
	size := 0
	for _, chunk := range metadata.WAVChunks {
		name := string(chunk.ID[:])
		if name == "LIST" && len(chunk.Data) >= 4 {
			name += "/" + string(chunk.Data[:4])
		}
		chunks = append(chunks, name)
		size += 8 + len(chunk.Data) + len(chunk.Data)%2
	}
	return protocol.MetadataResult{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: tags, PreservedBytes: size, Chunks: chunks}
}

func (e *Engine) getMetadata(p protocol.MetadataGetParams) (protocol.MetadataResult, error) {
	if err := e.validateDocumentID(protocol.MethodMetadataGet, p.DocumentID); err != nil {
		return protocol.MetadataResult{}, err
	}
	return e.metadataResult(), nil
}

func (e *Engine) setMetadata(p protocol.MetadataSetParams) (protocol.MetadataMutationResult, error) {
	const method = protocol.MethodMetadataSet
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.MetadataMutationResult{}, err
	}
	if e.historyState.history == nil || p.StateID == "" || p.StateID != e.historyState.history.CurrentID() {
		return protocol.MetadataMutationResult{}, fmt.Errorf("%s: stale or invalid history state", method)
	}
	tags, err := validateTags(p.Tags)
	if err != nil {
		return protocol.MetadataMutationResult{}, err
	}
	metadata := e.doc.document.Metadata()
	changed := !maps.Equal(tags, metadata.Tags)
	if changed {
		metadata.Tags = tags
		// Validate export before publishing a history entry, including unknown chunks.
		if _, _, err := encodeWAVMetadata(metadata, e.doc.document.Frames()); err != nil {
			return protocol.MetadataMutationResult{}, fmt.Errorf("%s: export metadata: %w", method, err)
		}
		document, err := e.doc.document.WithMetadata(metadata)
		if err != nil {
			return protocol.MetadataMutationResult{}, fmt.Errorf("%s: snapshot: %w", method, err)
		}
		staged, err := e.historyState.history.StagePush("Edit metadata", historySnapshot{document: e.doc.document, editor: e.doc.editor}, historySnapshot{document: document, editor: e.doc.editor})
		if err != nil {
			return protocol.MetadataMutationResult{}, fmt.Errorf("%s: history: %w", method, err)
		}
		e.doc.document, e.historyState.history = document, staged
	}
	return protocol.MetadataMutationResult{MetadataResult: e.metadataResult(), History: e.historyResult(), Changed: changed}, nil
}
