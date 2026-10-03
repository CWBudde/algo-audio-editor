package audiobuf

import (
	"reflect"
	"strings"
	"testing"
)

func testMarker(id, frame int64) Marker {
	return Marker{ID: id, Frame: frame, Name: "Marker", Color: DefaultAnchorColor}
}

func testRegion(id, start, end int64) Region {
	return Region{ID: id, Start: start, End: end, Name: "Region", Color: DefaultAnchorColor}
}

func TestTimelineValidationAndOwnership(t *testing.T) {
	metadata := Metadata{Timeline: Timeline{Markers: []Marker{testMarker(1, 3)}, Regions: []Region{testRegion(2, 1, 3)}, NextID: 3}}
	doc, err := NewDocument([]Channel{NewChannel([]float32{1, 2, 3})}, 48000, metadata)
	if err != nil {
		t.Fatal(err)
	}
	before := doc.Metadata()
	metadata.Timeline.Markers[0].Frame = 0
	metadata.Timeline.Regions[0].Name = "mutated input"
	output := doc.Metadata()
	output.Timeline.Markers[0].Name = "mutated output"
	output.Timeline.Regions[0].Start = 0
	if !reflect.DeepEqual(doc.Metadata(), before) {
		t.Fatal("timeline aliases input/output")
	}
	updated, err := doc.WithMetadata(output)
	if err != nil {
		t.Fatal(err)
	}
	output.Timeline.Markers[0].Name = "later mutation"
	if updated.Metadata().Timeline.Markers[0].Name != "mutated output" || !reflect.DeepEqual(doc.Metadata(), before) {
		t.Fatal("replacement aliases metadata or modifies source")
	}
	gotMemory, originalMemory := CountMemory(doc, updated), CountMemory(doc)
	if gotMemory.SampleBytes != originalMemory.SampleBytes || gotMemory.PeakBytes != originalMemory.PeakBytes || gotMemory.UniqueBlocks != originalMemory.UniqueBlocks {
		t.Fatal("metadata replacement copied audio/peak storage")
	}
	for _, tt := range []struct {
		name   string
		change func(*Timeline)
	}{
		{"zero ID", func(v *Timeline) { v.Markers[0].ID = 0 }},
		{"too large ID", func(v *Timeline) { v.Markers[0].ID = MaxAnchorID + 1 }},
		{"reused allocator", func(v *Timeline) { v.NextID = 2 }},
		{"negative allocator", func(v *Timeline) { v.NextID = -1 }},
		{"too large allocator", func(v *Timeline) { v.NextID = MaxAnchorID + 2 }},
		{"shared duplicate", func(v *Timeline) { v.Regions[0].ID = v.Markers[0].ID }},
		{"negative marker", func(v *Timeline) { v.Markers[0].Frame = -1 }},
		{"marker beyond EOF", func(v *Timeline) { v.Markers[0].Frame = 4 }},
		{"empty region", func(v *Timeline) { v.Regions[0].End = 1 }},
		{"region beyond EOF", func(v *Timeline) { v.Regions[0].End = 4 }},
		{"blank name", func(v *Timeline) { v.Markers[0].Name = "" }},
		{"untrimmed name", func(v *Timeline) { v.Markers[0].Name = " space " }},
		{"NUL name", func(v *Timeline) { v.Markers[0].Name = "a\x00b" }},
		{"invalid UTF8", func(v *Timeline) { v.Markers[0].Name = string([]byte{255}) }},
		{"long name", func(v *Timeline) { v.Markers[0].Name = strings.Repeat("é", 129) }},
		{"uppercase color", func(v *Timeline) { v.Markers[0].Color = "#AABBCC" }},
		{"invalid color", func(v *Timeline) { v.Markers[0].Color = "#12gg34" }},
		{"too many anchors", func(v *Timeline) { v.Markers = make([]Marker, MaxAnchors+1) }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			invalid := doc.Metadata()
			tt.change(&invalid.Timeline)
			returned, err := doc.WithMetadata(invalid)
			if err == nil || !reflect.DeepEqual(returned, doc) || !reflect.DeepEqual(doc.Metadata(), before) {
				t.Fatal("invalid metadata accepted or source changed", err)
			}
			if _, err := NewDocument([]Channel{NewChannel([]float32{1, 2, 3})}, 48000, invalid); err == nil {
				t.Fatal("constructor accepted invalid metadata")
			}
		})
	}
	valid := Timeline{Markers: []Marker{testMarker(MaxAnchorID, 0)}, NextID: MaxAnchorID + 1}
	if err := valid.Validate(0); err != nil {
		t.Fatal("exhausted allocator/empty EOF marker rejected", err)
	}
	valid.Markers[0].Name = strings.Repeat("é", 128)
	if err := valid.Validate(0); err != nil {
		t.Fatal("256-byte UTF8 name rejected", err)
	}
}

func TestTimelineSpliceBoundaries(t *testing.T) {
	points := []int64{0, 2, 3, 4, 5, 6, 7, 10}
	source := Timeline{NextID: 15}
	for i, p := range points {
		source.Markers = append(source.Markers, testMarker(int64(i+1), p))
	}
	for i, pair := range [][2]int64{{0, 3}, {3, 7}, {4, 5}, {1, 5}, {5, 9}, {0, 10}} {
		source.Regions = append(source.Regions, testRegion(int64(9+i), pair[0], pair[1]))
	}
	before := source.clone()
	for _, tt := range []struct {
		name                 string
		start, end, inserted int64
		markers              [][2]int64
		regions              [][3]int64
	}{
		{"delete", 3, 7, 0, [][2]int64{{1, 0}, {2, 2}, {7, 3}, {8, 6}}, [][3]int64{{9, 0, 3}, {12, 1, 3}, {13, 3, 5}, {14, 0, 6}}},
		{"insert", 3, 3, 2, [][2]int64{{1, 0}, {2, 2}, {3, 5}, {4, 6}, {5, 7}, {6, 8}, {7, 9}, {8, 12}}, [][3]int64{{9, 0, 3}, {10, 5, 9}, {11, 6, 7}, {12, 1, 7}, {13, 7, 11}, {14, 0, 12}}},
		{"replace", 3, 7, 2, [][2]int64{{1, 0}, {2, 2}, {7, 5}, {8, 8}}, [][3]int64{{9, 0, 3}, {12, 1, 3}, {13, 5, 7}, {14, 0, 8}}},
		{"delete all", 0, 10, 0, [][2]int64{{8, 0}}, nil},
		{"append", 10, 10, 2, [][2]int64{{1, 0}, {2, 2}, {3, 3}, {4, 4}, {5, 5}, {6, 6}, {7, 7}, {8, 12}}, [][3]int64{{9, 0, 3}, {10, 3, 7}, {11, 4, 5}, {12, 1, 5}, {13, 5, 9}, {14, 0, 10}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := source.Splice(10, tt.start, tt.end, tt.inserted)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Markers) != len(tt.markers) || len(got.Regions) != len(tt.regions) || got.NextID != source.NextID {
				t.Fatalf("unexpected anchor counts: %+v", got)
			}
			for i, expected := range tt.markers {
				if got.Markers[i].ID != expected[0] || got.Markers[i].Frame != expected[1] {
					t.Fatalf("marker %d %+v, want %v", i, got.Markers[i], expected)
				}
			}
			for i, expected := range tt.regions {
				if got.Regions[i].ID != expected[0] || got.Regions[i].Start != expected[1] || got.Regions[i].End != expected[2] {
					t.Fatalf("region %d %+v, want %v", i, got.Regions[i], expected)
				}
			}
			if err := got.Validate(10 - (tt.end - tt.start) + tt.inserted); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(source, before) {
				t.Fatal("splice mutated source")
			}
		})
	}
	for _, bounds := range [][4]int64{{10, -1, 0, 0}, {10, 5, 4, 0}, {10, 0, 11, 0}, {10, 0, 0, -1}, {1<<53 - 1, 0, 0, 1}} {
		if _, err := (Timeline{NextID: 1}).Splice(bounds[0], bounds[1], bounds[2], bounds[3]); err == nil {
			t.Fatal("invalid/overflowing splice accepted", bounds)
		}
	}
	long := int64(1<<32) + 17
	got, err := (Timeline{Markers: []Marker{testMarker(1, long)}, NextID: 2}).Splice(long, 3, 7, 11)
	if err != nil || got.Markers[0].Frame != long+7 {
		t.Fatal("int64 shift failed", got, err)
	}
}

func TestDocumentCropAndConcatTimeline(t *testing.T) {
	metadata := Metadata{Timeline: Timeline{Markers: []Marker{testMarker(1, 1), testMarker(2, 3), testMarker(3, 7), testMarker(4, 10)}, Regions: []Region{testRegion(5, 0, 3), testRegion(6, 1, 5), testRegion(7, 5, 10), testRegion(8, 7, 10)}, NextID: 9}}
	doc, err := NewDocument([]Channel{NewChannel(make([]float32, 10))}, 48000, metadata)
	if err != nil {
		t.Fatal(err)
	}
	cropped, err := doc.Slice(3, 7)
	if err != nil {
		t.Fatal(err)
	}
	want := Timeline{Markers: []Marker{testMarker(2, 0), testMarker(3, 4)}, Regions: []Region{testRegion(6, 0, 2), testRegion(7, 2, 4)}, NextID: 9}
	if !reflect.DeepEqual(cropped.Metadata().Timeline, want) {
		t.Fatalf("crop %+v, want %+v", cropped.Metadata().Timeline, want)
	}
	empty, err := doc.Slice(3, 3)
	if err != nil || len(empty.Metadata().Timeline.Markers) != 1 || empty.Metadata().Timeline.Markers[0].ID != 2 || len(empty.Metadata().Timeline.Regions) != 0 {
		t.Fatal("collapsed crop boundaries", err)
	}
	joined, err := cropped.Concat(doc)
	if err != nil || !reflect.DeepEqual(joined.Metadata().Timeline, want) {
		t.Fatal("concat imported or shifted right metadata", err)
	}
	if !reflect.DeepEqual(doc.Metadata(), metadata) {
		t.Fatal("crop mutated source")
	}
}
