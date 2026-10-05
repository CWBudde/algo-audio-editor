package ops

import (
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
)

func anchorDocument(t testing.TB, channels int) audiobuf.Document {
	t.Helper()
	samples := make([][]float32, channels)
	for i := range samples {
		samples[i] = []float32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	}
	doc := document(t, samples...)
	metadata := doc.Metadata()
	for i, frame := range []int64{0, 3, 5, 7, 10} {
		metadata.Timeline.Markers = append(metadata.Timeline.Markers, audiobuf.Marker{ID: int64(i + 1), Frame: frame, Name: "point", Color: audiobuf.DefaultAnchorColor})
	}
	for i, interval := range [][2]int64{{0, 3}, {1, 5}, {3, 7}, {5, 9}, {0, 10}} {
		metadata.Timeline.Regions = append(metadata.Timeline.Regions, audiobuf.Region{ID: int64(i + 6), Start: interval[0], End: interval[1], Name: "region", Color: audiobuf.DefaultAnchorColor})
	}
	metadata.Timeline.NextID = 11
	doc, err := doc.WithMetadata(metadata)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestOperationsTransformDocumentOwnedTimeline(t *testing.T) {
	source := anchorDocument(t, 2)
	clipDoc := anchorDocument(t, 2)
	clipboard, err := NewClipboard(clipDoc, Range{Start: 0, End: 2, ChannelMask: 3})
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name    string
		op      Operation
		points  [][2]int64
		regions [][3]int64
	}{
		{"delete all", Delete{Range{3, 7, 3}}, [][2]int64{{1, 0}, {4, 3}, {5, 6}}, [][3]int64{{6, 0, 3}, {7, 1, 3}, {9, 3, 5}, {10, 0, 6}}},
		{"insert all", InsertSilence{Range{3, 7, 3}, 2}, [][2]int64{{1, 0}, {2, 5}, {3, 7}, {4, 9}, {5, 12}}, [][3]int64{{6, 0, 3}, {7, 1, 7}, {8, 5, 9}, {9, 7, 11}, {10, 0, 12}}},
		{"duplicate all", Duplicate{Range{3, 7, 3}}, [][2]int64{{1, 0}, {2, 3}, {3, 5}, {4, 11}, {5, 14}}, [][3]int64{{6, 0, 3}, {7, 1, 5}, {8, 3, 7}, {9, 5, 13}, {10, 0, 14}}},
		{"paste insert all", Paste{Range{3, 7, 3}, clipboard, PasteInsert}, [][2]int64{{1, 0}, {2, 5}, {3, 7}, {4, 9}, {5, 12}}, [][3]int64{{6, 0, 3}, {7, 1, 7}, {8, 5, 9}, {9, 7, 11}, {10, 0, 12}}},
		{"paste replace all", Paste{Range{3, 7, 3}, clipboard, PasteReplace}, [][2]int64{{1, 0}, {4, 5}, {5, 8}}, [][3]int64{{6, 0, 3}, {7, 1, 3}, {9, 5, 7}, {10, 0, 8}}},
		{"crop ignores channel mask", Crop{Range{3, 7, 1}}, [][2]int64{{2, 0}, {3, 2}, {4, 4}}, [][3]int64{{7, 0, 2}, {8, 0, 4}, {9, 2, 4}, {10, 0, 4}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			before, samples := source.Metadata(), readDocument(t, source)
			result, err := tt.op.Apply(source)
			if err != nil {
				t.Fatal(err)
			}
			got := result.Metadata().Timeline
			if got.NextID != 11 || len(got.Markers) != len(tt.points) || len(got.Regions) != len(tt.regions) {
				t.Fatalf("counts/allocator %+v", got)
			}
			for i, p := range tt.points {
				if got.Markers[i].ID != p[0] || got.Markers[i].Frame != p[1] {
					t.Fatalf("marker %+v, want %v", got.Markers[i], p)
				}
			}
			for i, r := range tt.regions {
				if got.Regions[i].ID != r[0] || got.Regions[i].Start != r[1] || got.Regions[i].End != r[2] {
					t.Fatalf("region %+v, want %v", got.Regions[i], r)
				}
			}
			if !reflect.DeepEqual(source.Metadata(), before) {
				t.Fatal("edit mutated original metadata")
			}
			assertSamples(t, source, samples)
		})
	}
}

func TestSubsetAndNonRippleOperationsPreserveTimeline(t *testing.T) {
	for _, channels := range []int{2, 8} {
		source := anchorDocument(t, channels)
		clip, err := NewClipboard(source, Range{End: 2, ChannelMask: 1})
		if err != nil {
			t.Fatal(err)
		}
		all := (1 << channels) - 1
		for _, op := range []Operation{
			Delete{Range{3, 7, 1}},
			InsertSilence{Range{3, 7, 1}, 2},
			Duplicate{Range{3, 7, 1}},
			Paste{Range{3, 7, 1}, clip, PasteInsert},
			Paste{Range{3, 7, 1}, clip, PasteReplace},
			Paste{Range{9, 10, all}, clip, PasteMix},
			Mute{Range{3, 7, all}},
			SwapChannels{Range{3, 7, 3}},
		} {
			result, err := op.Apply(source)
			if err != nil {
				t.Fatalf("%T: %v", op, err)
			}
			if !reflect.DeepEqual(result.Metadata(), source.Metadata()) {
				t.Fatalf("%T changed global anchors with %d channels", op, channels)
			}
		}
	}
}

func TestTimelineEditFailureAndEOFInsertion(t *testing.T) {
	source := anchorDocument(t, 2)
	before := source.Metadata()
	if _, err := (Delete{Range{3, 11, 3}}).Apply(source); err == nil {
		t.Fatal("invalid delete accepted")
	}
	if !reflect.DeepEqual(source.Metadata(), before) {
		t.Fatal("failed edit mutated anchors")
	}
	result, err := (InsertSilence{Range{10, 10, 3}, 2}).Apply(source)
	if err != nil {
		t.Fatal(err)
	}
	got := result.Metadata().Timeline
	if got.Markers[4].Frame != 12 || got.Regions[4].End != 10 {
		t.Fatal("EOF point/end affinities incorrect", got)
	}
}
