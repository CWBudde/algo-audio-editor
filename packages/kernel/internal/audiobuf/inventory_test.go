package audiobuf

import "testing"

func TestBlockInventoryMatchesMemoryOracle(t *testing.T) {
	full, err := NewBlock(make([]float32, BlockFrames))
	if err != nil {
		t.Fatal(err)
	}
	tail, err := NewBlock([]float32{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	channel, err := NewChannelFromBlocks([]*Block{full, full, tail})
	if err != nil {
		t.Fatal(err)
	}
	document, err := NewDocument([]Channel{channel, channel}, 48000, Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name     string
		document Document
	}{
		{"empty", Document{}},
		{"repeated within and across channels", document},
	} {
		t.Run(tt.name, func(t *testing.T) {
			inventory := tt.document.BlockInventory()
			seen := make(map[*Block]bool)
			var bytes int64
			for block, charge := range inventory.Blocks {
				if seen[block] || charge <= 0 {
					t.Fatal("duplicate or invalid block charge")
				}
				seen[block] = true
				bytes += charge
			}
			oracle := CountMemory(tt.document)
			if inventory.MemoryStats() != oracle {
				t.Fatalf("cached stats=%+v; oracle=%+v", inventory.MemoryStats(), oracle)
			}
			if len(seen) != oracle.UniqueBlocks || bytes != oracle.SampleBytes+oracle.PeakBytes {
				t.Fatalf("inventory blocks=%d bytes=%d; oracle=%+v", len(seen), bytes, oracle)
			}
			visits := 0
			for range inventory.Blocks {
				visits++
				break
			}
			if visits != min(1, oracle.UniqueBlocks) {
				t.Fatal("iteration failed to stop")
			}
		})
	}
}
