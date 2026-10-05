package engine

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/wav"
)

func TestWAVMetadataErrorsRetainUpstreamCause(t *testing.T) {
	// An incomplete LIST header produces wav's private metadata sentinel.
	// Recover the sentinel through Unwrap and verify every adapter retains it.
	chunk := audiobuf.FileChunk{ID: wav.CIDList, Data: []byte("adtlbroken")}
	err := wav.DecodeAssociatedDataChunk(wav.NewDecoder(bytes.NewReader(nil)), metadataChunk(chunk))
	if err == nil {
		t.Fatal("fixture did not reject malformed associated metadata")
	}
	cause := err
	for errors.Unwrap(cause) != nil {
		cause = errors.Unwrap(cause)
	}
	_, decodeErr := decodeWAVMetadata([]audiobuf.FileChunk{chunk}, audiobuf.Timeline{})
	_, _, encodeErr := encodeWAVMetadata(audiobuf.Metadata{Timeline: audiobuf.Timeline{NextID: 1}, WAVChunks: []audiobuf.FileChunk{chunk}}, 1)
	_, selectionErr := selectionWAVChunks([]audiobuf.FileChunk{chunk})
	for _, err := range []error{decodeErr, encodeErr, selectionErr} {
		if err == nil || !strings.HasPrefix(err.Error(), "wav.metadata:") || !errors.Is(err, cause) {
			t.Fatalf("metadata adapter lost context or upstream cause: %v", err)
		}
	}
}
