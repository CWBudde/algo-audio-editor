package engine

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"math/big"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func timelineSeconds(frame int64, rate int) string {
	return new(big.Rat).SetFrac64(frame, int64(rate)).FloatString(9)
}

func (e *Engine) exportTimeline(p protocol.TimelineExportParams) (protocol.DocumentExportInfo, error) {
	const method = protocol.MethodTimelineExport
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.DocumentExportInfo{}, err
	}
	if p.Format != "csv" && p.Format != "labels" {
		return protocol.DocumentExportInfo{}, fmt.Errorf("%s: unsupported format %q", method, p.Format)
	}
	type record struct {
		kind           string
		id, start, end int64
		name, color    string
	}
	timeline := e.doc.document.Metadata().Timeline
	records := make([]record, 0, len(timeline.Markers)+len(timeline.Regions))
	for _, marker := range timeline.Markers {
		records = append(records, record{"marker", marker.ID, marker.Frame, marker.Frame, marker.Name, marker.Color})
	}
	for _, region := range timeline.Regions {
		records = append(records, record{"region", region.ID, region.Start, region.End, region.Name, region.Color})
	}
	slices.SortFunc(records, func(a, b record) int {
		if a.start < b.start {
			return -1
		}
		if a.start > b.start {
			return 1
		}
		if a.id < b.id {
			return -1
		}
		if a.id > b.id {
			return 1
		}
		return 0
	})
	var buffer bytes.Buffer
	if p.Format == "csv" {
		writer := csv.NewWriter(&buffer)
		if err := writer.Write([]string{"kind", "id", "name", "color", "start_frame", "end_frame", "start_seconds", "end_seconds"}); err != nil {
			return protocol.DocumentExportInfo{}, fmt.Errorf("%s: header: %w", method, err)
		}
		for _, item := range records {
			if err := writer.Write([]string{item.kind, strconv.FormatInt(item.id, 10), item.name, item.color, strconv.FormatInt(item.start, 10), strconv.FormatInt(item.end, 10), timelineSeconds(item.start, e.doc.document.SampleRate()), timelineSeconds(item.end, e.doc.document.SampleRate())}); err != nil {
				return protocol.DocumentExportInfo{}, fmt.Errorf("%s: CSV: %w", method, err)
			}
		}
		writer.Flush()
		if err := writer.Error(); err != nil {
			return protocol.DocumentExportInfo{}, fmt.Errorf("%s: CSV: %w", method, err)
		}
	} else {
		for _, item := range records {
			if strings.ContainsAny(item.name, "\t\r\n") {
				return protocol.DocumentExportInfo{}, fmt.Errorf("%s: label name cannot contain tab, CR or LF", method)
			}
			if _, err := fmt.Fprintf(&buffer, "%s\t%s\t%s\n", timelineSeconds(item.start, e.doc.document.SampleRate()), timelineSeconds(item.end, e.doc.document.SampleRate()), item.name); err != nil {
				return protocol.DocumentExportInfo{}, fmt.Errorf("%s: labels: %w", method, err)
			}
		}
	}
	name := e.doc.document.Metadata().Name
	name = strings.TrimSuffix(name, path.Ext(name))
	if name == "" {
		name = "Untitled"
	}
	mime, suffix := "text/csv", ".markers.csv"
	if p.Format == "labels" {
		mime, suffix = "text/plain", ".labels.txt"
	}
	e.bulkData = buffer.Bytes()
	return protocol.DocumentExportInfo{Name: name + suffix, MimeType: mime, DataBytes: len(e.bulkData)}, nil
}
