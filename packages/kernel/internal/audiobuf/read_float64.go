package audiobuf

// ReadFloat64 copies and widens frames from start across block boundaries
// without allocating. It has the same bounds/count semantics as Read: invalid
// starts copy nothing, and any unfilled destination tail stays untouched.
// This only moves representations into caller-owned storage; it never exposes
// or modifies immutable samples and performs no signal processing.
func (c Channel) ReadFloat64(dst []float64, start int64) int {
	if start < 0 || start >= c.Frames() || len(dst) == 0 {
		return 0
	}

	i, n := c.blockAt(start), 0
	for i < len(c.blocks) && n < len(dst) {
		offset := int(start - c.offsets[i])
		count := min(len(dst)-n, len(c.blocks[i].samples)-offset)
		in := c.blocks[i].samples[offset : offset+count]
		out := dst[n : n+count]
		frame := 0
		// Bounded groups avoid redundant per-sample bounds checks on WASM.
		for ; frame+8 <= len(in); frame += 8 {
			src, target := in[frame:frame+8], out[frame:frame+8]
			target[0], target[1], target[2], target[3] = float64(src[0]), float64(src[1]), float64(src[2]), float64(src[3])
			target[4], target[5], target[6], target[7] = float64(src[4]), float64(src[5]), float64(src[6]), float64(src[7])
		}
		for ; frame < len(in); frame++ {
			out[frame] = float64(in[frame])
		}
		n += count
		start = c.offsets[i+1]
		i++
	}
	return n
}
