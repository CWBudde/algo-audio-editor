package audiobuf

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	MaxAnchors               = 4096
	MaxAnchorNameBytes       = 256
	MaxAnchorID        int64 = math.MaxUint32
	DefaultAnchorColor       = "#a78bfa"
)

type Marker struct {
	ID    int64
	Frame int64
	Name  string
	Color string
}

type Region struct {
	ID         int64
	Start, End int64
	Name       string
	Color      string
}

// Timeline is immutable document metadata. NextID is a shared marker/region
// allocator; MaxAnchorID+1 is its exhausted sentinel and survives undo snapshots.
type Timeline struct {
	Markers []Marker
	Regions []Region
	NextID  int64
}

func (t Timeline) clone() Timeline {
	t.Markers, t.Regions = slices.Clone(t.Markers), slices.Clone(t.Regions)
	return t
}

func ValidateAnchorName(name string) error {
	if name == "" || strings.TrimSpace(name) != name || len(name) > MaxAnchorNameBytes || !utf8.ValidString(name) || strings.ContainsRune(name, 0) {
		return fmt.Errorf("name must be nonempty, trimmed UTF-8 without NUL and at most %d bytes", MaxAnchorNameBytes)
	}
	return nil
}

func ValidateAnchorColor(color string) error {
	if len(color) != 7 || color[0] != '#' {
		return fmt.Errorf("color must be canonical #rrggbb")
	}
	for _, digit := range color[1:] {
		if (digit < '0' || digit > '9') && (digit < 'a' || digit > 'f') {
			return fmt.Errorf("color must be canonical #rrggbb")
		}
	}
	return nil
}

func (t Timeline) Validate(frames int64) error {
	if len(t.Markers)+len(t.Regions) > MaxAnchors || t.NextID < 1 || t.NextID > MaxAnchorID+1 {
		return fmt.Errorf("invalid anchor count or next identity")
	}
	seen := make(map[int64]struct{}, len(t.Markers)+len(t.Regions))
	validate := func(id int64, name, color string) error {
		if id < 1 || id > MaxAnchorID || id >= t.NextID {
			return fmt.Errorf("anchor identity %d must be positive, uint32 and below NextID", id)
		}
		if _, exists := seen[id]; exists {
			return fmt.Errorf("duplicate anchor identity %d", id)
		}
		seen[id] = struct{}{}
		if err := ValidateAnchorName(name); err != nil {
			return err
		}
		return ValidateAnchorColor(color)
	}
	for _, marker := range t.Markers {
		if marker.Frame < 0 || marker.Frame > frames || marker.Frame > 1<<53-1 {
			return fmt.Errorf("marker %d frame %d outside JS-safe document bounds", marker.ID, marker.Frame)
		}
		if err := validate(marker.ID, marker.Name, marker.Color); err != nil {
			return fmt.Errorf("marker %d: %w", marker.ID, err)
		}
	}
	for _, region := range t.Regions {
		if region.Start < 0 || region.Start >= region.End || region.End > frames || region.End > 1<<53-1 {
			return fmt.Errorf("region %d outside nonempty JS-safe document bounds", region.ID)
		}
		if err := validate(region.ID, region.Name, region.Color); err != nil {
			return fmt.Errorf("region %d: %w", region.ID, err)
		}
	}
	return nil
}

// Splice removes [start,end), then inserts frames at start. Points in removed
// audio disappear; region remnants exclude inserted audio unless they span it.
// Point/start boundaries stick right, region ends stick left at insertion.
func (t Timeline) Splice(total, start, end, inserted int64) (Timeline, error) {
	if start < 0 || end < start || end > total || inserted < 0 || total-(end-start) > 1<<53-1 || inserted > (1<<53-1)-(total-(end-start)) {
		return Timeline{}, fmt.Errorf("timeline.splice: invalid or overflowing frame range")
	}
	if err := t.Validate(total); err != nil {
		return Timeline{}, fmt.Errorf("timeline.splice: source: %w", err)
	}
	result := Timeline{NextID: t.NextID}
	if len(t.Markers) > 0 {
		result.Markers = make([]Marker, 0, len(t.Markers))
	}
	if len(t.Regions) > 0 {
		result.Regions = make([]Region, 0, len(t.Regions))
	}
	removed := end - start
	position := func(p int64) int64 {
		switch {
		case p <= start:
			return p
		case p < end:
			return start
		default:
			return p - removed
		}
	}
	for _, marker := range t.Markers {
		if marker.Frame >= start && marker.Frame < end {
			continue
		}
		if marker.Frame >= end {
			marker.Frame -= removed
		}
		if marker.Frame >= start {
			marker.Frame += inserted
		}
		result.Markers = append(result.Markers, marker)
	}
	for _, region := range t.Regions {
		region.Start, region.End = position(region.Start), position(region.End)
		if region.Start == region.End {
			continue
		}
		if region.Start >= start {
			region.Start += inserted
		}
		if region.End > start {
			region.End += inserted
		}
		result.Regions = append(result.Regions, region)
	}
	return result, nil
}

// Crop intersects regions and keeps closed-boundary points, including the new
// EOF marker at end. Every retained coordinate is rebased by start.
func (t Timeline) Crop(total, start, end int64) (Timeline, error) {
	if start < 0 || end < start || end > total {
		return Timeline{}, fmt.Errorf("timeline.crop: invalid frame range")
	}
	if err := t.Validate(total); err != nil {
		return Timeline{}, fmt.Errorf("timeline.crop: source: %w", err)
	}
	result := Timeline{NextID: t.NextID}
	if len(t.Markers) > 0 {
		result.Markers = make([]Marker, 0, len(t.Markers))
	}
	if len(t.Regions) > 0 {
		result.Regions = make([]Region, 0, len(t.Regions))
	}
	for _, marker := range t.Markers {
		if marker.Frame >= start && marker.Frame <= end {
			marker.Frame -= start
			result.Markers = append(result.Markers, marker)
		}
	}
	for _, region := range t.Regions {
		region.Start, region.End = max(region.Start, start), min(region.End, end)
		if region.Start < region.End {
			region.Start, region.End = region.Start-start, region.End-start
			result.Regions = append(result.Regions, region)
		}
	}
	return result, nil
}
