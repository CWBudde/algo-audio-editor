package engine

import (
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/memory"
)

// memoryBudget is the sole owner of the editor's storage allowance. A zero
// limit uses the production ceiling; tests can exercise exhaustion cheaply.
type memoryBudget struct{ limit int64 }

func (b memoryBudget) capacity() int64 {
	if b.limit > 0 {
		return min(b.limit, memory.StorageLimit)
	}
	return memory.StorageLimit
}

func (e *Engine) retainedStorage() int64 {
	documents := []audiobuf.Document{e.document}
	if e.history != nil {
		documents = e.history.Documents()
	}
	if job := e.processJob; job != nil && job.reservedBytes == 0 && job.candidate.Channels() > 0 {
		documents = append(documents, job.candidate)
	}
	stats := audiobuf.CountMemoryWithWindows(documents, e.clipboard.Windows()...)
	bytes := stats.SampleBytes + stats.PeakBytes + int64(stats.UniqueBlocks)*128 + int64(stats.BlockReferences)*16 + e.impulseBytes + int64(cap(e.bulkData))
	if job := e.processJob; job != nil {
		// This reservation includes future blocks as well as partial/ready
		// output. Counting its actual blocks again would double-charge them.
		bytes += job.reservedBytes
	}
	return bytes
}

func (e *Engine) availableStorage() int64 {
	return max(int64(0), e.memory.capacity()-e.retainedStorage())
}

func (e *Engine) checkStorage(method string, extra int64) error {
	available := e.availableStorage()
	if extra < 0 || extra > available {
		return fmt.Errorf("%s: memory budget exceeded (need %d additional bytes, %d available of %d)", method, extra, available, e.memory.capacity())
	}
	return nil
}

// CheckInputSize gates the bridge's whole-file Go allocation before bytes are
// copied out of JS. CallWithData repeats this check for native/direct callers.
func (e *Engine) CheckInputSize(method string, bytes int64) error {
	return e.checkStorage(method, bytes)
}

// decodedStorage includes samples, three peak levels and conservative block/
// list overhead. The block size is supplied by the decoder, including short
// FLAC frames, instead of assuming all codecs produce full-sized blocks.
func decodedStorage(frames int64, channels, blockFrames int) int64 {
	if frames < 0 || channels < 1 || channels > MaxChannels || blockFrames < 1 || frames > memory.StorageLimit/4/int64(channels) {
		return math.MaxInt64
	}
	blocks := (frames + int64(blockFrames) - 1) / int64(blockFrames)
	peaks := int64(0)
	full, tail := frames/int64(blockFrames), frames%int64(blockFrames)
	for _, size := range []int64{256, 4096, 65536} {
		peaks += (full*((int64(blockFrames)+size-1)/size) + (tail+size-1)/size) * 16
	}
	return (frames*4 + peaks + blocks*160) * int64(channels)
}

func (e *Engine) checkDecodedStorage(frames int64, channels, blockFrames, inputBytes int) error {
	bytes := decodedStorage(frames, channels, blockFrames)
	available := e.availableStorage()
	if bytes > available || max(int64(inputBytes), e.callInputBytes) > available-bytes {
		return fmt.Errorf("doc.open: decoded audio and input exceed memory budget")
	}
	return nil
}

// Processing factories enforce a sample limit before allocating candidates.
// Twice that amount reserves peaks/list overhead, short boundary blocks and
// partial candidates for the lifetime of the job, including analysis phases.
func (e *Engine) processStorageLimit() int64 {
	return max(int64(1), e.availableStorage()/2)
}

func (e *Engine) reserveProcess(method string, samples int64) (int64, error) {
	if samples < 0 || samples > e.availableStorage()/2 {
		return 0, fmt.Errorf("%s: candidate exceeds memory budget", method)
	}
	bytes := samples * 2
	if samples > 0 {
		// Result assembly can copy two source boundaries per channel.
		bytes += decodedStorage(min(e.document.Frames(), 2*audiobuf.BlockFrames), e.document.Channels(), audiobuf.BlockFrames)
	}
	return bytes, e.checkStorage(method, bytes)
}

// Every export buffer must also fit a signed WASM int. Growing codec writers
// charge both old and replacement capacity during reallocation.
func (e *Engine) exportStorageLimit() int64 {
	return min(e.availableStorage(), int64(math.MaxInt32))
}
