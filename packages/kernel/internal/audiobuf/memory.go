package audiobuf

// MemoryStats reports sample and cached peak storage retained by snapshots.
// It excludes block-list, metadata and Go runtime overhead. CountMemory is an
// accounting operation, not a render-path operation.
type MemoryStats struct {
	SampleBytes     int64
	PeakBytes       int64
	UniqueBlocks    int
	BlockReferences int
}

// CountMemory counts blocks by pointer identity across every supplied document,
// including repeated blocks within a channel. Pass all retained snapshots
// (current document, history and clipboard) to count samples and cached peaks once.
// Go GC manages lifetimes; explicit reference counts are unnecessary.
func CountMemory(documents ...Document) MemoryStats {
	seen := make(map[*Block]struct{})
	var stats MemoryStats
	for _, document := range documents {
		for _, channel := range document.channels {
			for _, block := range channel.blocks {
				stats.BlockReferences++
				if _, exists := seen[block]; exists {
					continue
				}
				seen[block] = struct{}{}
				stats.UniqueBlocks++
				stats.SampleBytes += int64(block.Frames()) * 4
				for _, level := range block.peaks {
					stats.PeakBytes += int64(len(level)) * peakSummaryBytes
				}
			}
		}
	}

	return stats
}
