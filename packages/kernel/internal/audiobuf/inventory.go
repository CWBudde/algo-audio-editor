package audiobuf

// BlockInventory is an immutable inventory of distinct sample and cached-peak
// backing blocks. It is safe to share between immutable snapshot owners. The
// zero value describes a document without retained blocks.
type BlockInventory struct {
	blocks map[*Block]int64
	stats  MemoryStats
}

// BlockInventory inventories one snapshot once, including blocks repeated
// within or across channels. Cached peaks are immutable and owned by the block.
// Inventory construction is an accounting operation, never a render operation.
func (d Document) BlockInventory() BlockInventory {
	return NewBlockInventory([]Document{d})
}

// NewBlockInventory inventories distinct storage in documents and fractional
// clipboard windows. Windows own their whole backing blocks, just as documents
// do. Reference counts include every occurrence, while byte charges are unique.
func NewBlockInventory(documents []Document, windows ...Window) BlockInventory {
	inventory := BlockInventory{blocks: make(map[*Block]int64)}
	count := func(channel Channel) {
		for _, block := range channel.blocks {
			inventory.stats.BlockReferences++
			if _, exists := inventory.blocks[block]; exists {
				continue
			}
			bytes := int64(block.Frames()) * 4
			inventory.stats.SampleBytes += bytes
			for _, level := range block.peaks {
				peakBytes := int64(len(level)) * peakSummaryBytes
				bytes += peakBytes
				inventory.stats.PeakBytes += peakBytes
			}
			inventory.stats.UniqueBlocks++
			inventory.blocks[block] = bytes
		}
	}
	for _, document := range documents {
		for _, channel := range document.channels {
			count(channel)
		}
	}
	for _, window := range windows {
		count(window.channel)
	}
	return inventory
}

// MemoryStats returns the cached standalone accounting for this inventory.
func (i BlockInventory) MemoryStats() MemoryStats { return i.stats }

// Blocks visits each unique backing block and its sample plus cached-peak byte
// charge. Block identity is exposed for ownership accounting, never its samples
// or inventory map. Returning false stops iteration.
func (i BlockInventory) Blocks(yield func(*Block, int64) bool) {
	for block, bytes := range i.blocks {
		if !yield(block, bytes) {
			return
		}
	}
}
