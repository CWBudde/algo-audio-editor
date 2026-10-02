package engine

import (
	"fmt"
	"io"
	"math"
)

// memoryWriteSeeker permits overwrite of existing bytes and bounded appends.
// WAV seeks only back into its headers and then to the end after finalization.
type memoryWriteSeeker struct {
	data  []byte
	pos   int
	limit int
}

func (w *memoryWriteSeeker) Write(data []byte) (int, error) {
	if len(data) > w.limit-w.pos {
		return 0, fmt.Errorf("wav.write: write exceeds file size limit %d", w.limit)
	}
	end := w.pos + len(data)
	if end > len(w.data) {
		w.data = append(w.data, make([]byte, end-len(w.data))...)
	}
	copy(w.data[w.pos:end], data)
	w.pos = end
	return len(data), nil
}

func (w *memoryWriteSeeker) Seek(offset int64, whence int) (int64, error) {
	pos, err := boundedSeek(int64(w.pos), int64(len(w.data)), offset, whence)
	if err != nil {
		return int64(w.pos), fmt.Errorf("wav.write: seek: %w", err)
	}
	w.pos = int(pos)
	return pos, nil
}

// wavReadSeeker presents a normalized header followed by a borrowed data slice.
// Filtering unrelated chunks prevents the codec allocating from metadata sizes.
type wavReadSeeker struct {
	header []byte
	data   []byte
	pos    int64
}

func (r *wavReadSeeker) Read(dst []byte) (int, error) {
	if len(dst) == 0 {
		return 0, nil
	}
	if r.pos >= int64(len(r.header))+int64(len(r.data)) {
		return 0, io.EOF
	}
	n := 0
	if r.pos < int64(len(r.header)) {
		n = copy(dst, r.header[r.pos:])
		r.pos += int64(n)
	}
	if n < len(dst) && r.pos >= int64(len(r.header)) {
		copied := copy(dst[n:], r.data[r.pos-int64(len(r.header)):])
		n += copied
		r.pos += int64(copied)
	}
	return n, nil
}

func (r *wavReadSeeker) Seek(offset int64, whence int) (int64, error) {
	pos, err := boundedSeek(r.pos, int64(len(r.header))+int64(len(r.data)), offset, whence)
	if err != nil {
		return r.pos, fmt.Errorf("wav.read: seek: %w", err)
	}
	r.pos = pos
	return pos, nil
}

func boundedSeek(current, length, offset int64, whence int) (int64, error) {
	var base int64
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		base = current
	case io.SeekEnd:
		base = length
	default:
		return current, fmt.Errorf("invalid seek origin %d", whence)
	}
	if offset < -base || offset > math.MaxInt64-base || base+offset > length {
		return current, fmt.Errorf("offset %d from %d is outside [0, %d]", offset, base, length)
	}
	return base + offset, nil
}
