//go:build !js

package mcpserver

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/url"
	"strconv"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/automation"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	peakMIME           = "application/vnd.algo-audio-editor.peaks"
	peakHeaderBytes    = 48
	maxWaveformRecords = 32768
)

type secondsSelectionArgs struct {
	documentArgs
	StartSeconds float64 `json:"startSeconds" jsonschema:"nonnegative seconds; rounded to nearest frame and clamped to the document end"`
	EndSeconds   float64 `json:"endSeconds" jsonschema:"exclusive end, at least startSeconds; rounded to nearest frame and clamped to the document end"`
	ChannelMask  int     `json:"channelMask" jsonschema:"nonzero channel bit mask, bit 0 selects channel 0"`
}

func (s *Session) registerInspectionTools() {
	addTool(s, "select_seconds", "Set a selection in seconds, rounded to nearest sample frame and clamped to the document end. Negative, reversed or nonfinite ranges fail. Channel masks follow select_range; selection changes do not add undo entries.", false,
		func(_ context.Context, input secondsSelectionArgs) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			if math.IsNaN(input.StartSeconds) || math.IsInf(input.StartSeconds, 0) || math.IsNaN(input.EndSeconds) || math.IsInf(input.EndSeconds, 0) || input.StartSeconds < 0 || input.EndSeconds < input.StartSeconds {
				return nil, fmt.Errorf("select_seconds: require finite 0 <= startSeconds <= endSeconds")
			}
			frame := func(seconds float64) int64 {
				if seconds >= float64(d.info.Frames)/float64(d.info.SampleRate) {
					return d.info.Frames
				}
				return min(d.info.Frames, int64(math.Round(seconds*float64(d.info.SampleRate))))
			}
			var result protocol.SelectionResult
			_, err = automation.Call(d.kernel, protocol.MethodSelectionSet, protocol.SelectionSetParams{DocumentID: d.info.DocumentID, SelectionRange: protocol.SelectionRange{Start: frame(input.StartSeconds), End: frame(input.EndSeconds), ChannelMask: input.ChannelMask}}, nil, &result)
			return external(d, result), err
		})
}

func waveformURI(id string) string      { return "aae://documents/" + id + "/waveform.png" }
func peaksURI(id string) string         { return "aae://documents/" + id + "/peaks" }
func waveformTemplate(id string) string { return waveformURI(id) + "{?channel,start,end,width,height}" }
func peaksTemplate(id string) string    { return peaksURI(id) + "{?channel,start,end,buckets}" }

func (s *Session) addInspectionResources(d *document) {
	for _, waveform := range []bool{true, false} {
		uri, template, mime, description := peaksURI(d.id), peaksTemplate(d.id), peakMIME, "Binary kernel min/max/RMS overview. Optional channel/start/end/buckets; defaults channel 0, full document, 1024 desired buckets. 48-byte AAEP v1 header then the peaks.get little-endian buffer; at most 16 MiB of peak records."
		if waveform {
			uri, template, mime, description = waveformURI(d.id), waveformTemplate(d.id), "image/png", "Waveform PNG drawn only from kernel peaks. Optional channel/start/end/width/height; defaults channel 0, full document, 1024x256. Width 64..2048, height 64..512; at most 32768 source peak records. Signed amplitude clipped visually to +/-1."
		}
		handler := func(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			current, err := s.get(d.id)
			if err != nil {
				return nil, mcp.ResourceNotFoundError(request.Params.URI)
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			data, err := inspectionData(current, request.Params.URI, waveform)
			if err != nil {
				return nil, err
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: request.Params.URI, MIMEType: mime, Blob: data}}}, nil
		}
		s.server.AddResource(&mcp.Resource{URI: uri, Name: d.id + " " + mime, MIMEType: mime, Description: description}, handler)
		s.server.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: template, Name: d.id + " " + mime, MIMEType: mime, Description: description}, handler)
	}
}

func inspectionData(d *document, uri string, waveform bool) ([]byte, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return nil, fmt.Errorf("overview: URI: %w", err)
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return nil, fmt.Errorf("overview: query: %w", err)
	}
	allowed := map[string]bool{"channel": true, "start": true, "end": true, "buckets": !waveform, "width": waveform, "height": waveform}
	for key, values := range q {
		if !allowed[key] || len(values) != 1 {
			return nil, fmt.Errorf("overview: unsupported or repeated query field %q", key)
		}
	}
	read := func(key string, fallback int64) (int64, error) {
		if !q.Has(key) {
			return fallback, nil
		}
		value, err := strconv.ParseInt(q.Get(key), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("overview: %s must be an integer: %w", key, err)
		}
		return value, nil
	}
	channel, err := read("channel", 0)
	if err != nil {
		return nil, err
	}
	start, err := read("start", 0)
	if err != nil {
		return nil, err
	}
	end, err := read("end", d.info.Frames)
	if err != nil {
		return nil, err
	}
	width, err := read("width", 1024)
	if err != nil {
		return nil, err
	}
	height, err := read("height", 256)
	if err != nil {
		return nil, err
	}
	buckets, err := read("buckets", 1024)
	if err != nil {
		return nil, err
	}
	if channel < 0 || channel >= int64(d.info.Channels) || start < 0 || end < start || end > d.info.Frames || width < 64 || width > 2048 || height < 64 || height > 512 || buckets < 1 || buckets > 2048 {
		return nil, fmt.Errorf("overview: require a valid channel and frame range, width 64..2048, height 64..512, buckets 1..2048")
	}
	if waveform {
		buckets = width
	}
	var info protocol.PeaksGetInfo
	data, err := automation.Call(d.kernel, protocol.MethodPeaksGet, protocol.PeaksGetParams{Channel: int(channel), StartFrame: start, EndFrame: end, Buckets: int(buckets)}, nil, &info)
	if err != nil {
		return nil, err
	}
	if info.Count < 0 || info.Count > 16*1024*1024/24 || len(data) != info.Count*24 {
		return nil, fmt.Errorf("overview: invalid or excessive kernel peak buffer")
	}
	if waveform {
		if info.Count > maxWaveformRecords {
			return nil, fmt.Errorf("overview: waveform exceeds %d kernel peak records; request a narrower frame range", maxWaveformRecords)
		}
		return drawWaveform(data, info.Count, start, end, int(width), int(height))
	}
	// Fixed 48-byte little-endian header: AAEP, uint32 version/rate/channel/count/
	// reserved, uint64 framesPerBucket/start/end; followed by unmodified peaks.get.
	result := make([]byte, peakHeaderBytes+len(data))
	copy(result, "AAEP")
	binary.LittleEndian.PutUint32(result[4:], 1)
	binary.LittleEndian.PutUint32(result[8:], uint32(d.info.SampleRate))
	binary.LittleEndian.PutUint32(result[12:], uint32(channel))
	binary.LittleEndian.PutUint32(result[16:], uint32(info.Count))
	binary.LittleEndian.PutUint64(result[24:], uint64(info.FramesPerBucket))
	binary.LittleEndian.PutUint64(result[32:], uint64(start))
	binary.LittleEndian.PutUint64(result[40:], uint64(end))
	copy(result[peakHeaderBytes:], data)
	return result, nil
}

// drawWaveform maps existing min/max/RMS summaries to pixels; it never reads
// samples or calculates audio summaries. Peak positions/frame counts preserve
// the kernel's cached bucket geometry, which can extend beyond the viewport.
func drawWaveform(data []byte, count int, start, end int64, width, height int) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	background, axis, peak, rms := color.RGBA{19, 17, 25, 255}, color.RGBA{72, 62, 86, 255}, color.RGBA{245, 155, 69, 255}, color.RGBA{143, 108, 211, 255}
	for y := range height {
		for x := range width {
			img.SetRGBA(x, y, background)
		}
	}
	for x := range width {
		img.SetRGBA(x, height/2, axis)
	}
	if end > start {
		pixelY := func(value float64) int {
			return int(math.Round((1 - math.Max(-1, math.Min(1, value))) * float64(height-1) / 2))
		}
		for i := range count {
			lo := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[i*12:])))
			hi := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[i*12+4:])))
			energy := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[i*12+8:])))
			position := math.Float64frombits(binary.LittleEndian.Uint64(data[count*16+i*8:]))
			frames := float64(binary.LittleEndian.Uint32(data[count*12+i*4:]))
			if math.IsNaN(lo) || math.IsInf(lo, 0) || math.IsNaN(hi) || math.IsInf(hi, 0) || math.IsNaN(energy) || math.IsInf(energy, 0) || math.IsNaN(position) || math.IsInf(position, 0) {
				continue
			}
			x0 := max(0, int(math.Floor((position-float64(start))/float64(end-start)*float64(width))))
			x1 := min(width-1, int(math.Ceil((position+frames-float64(start))/float64(end-start)*float64(width)))-1)
			for x := x0; x <= x1; x++ {
				for y := pixelY(hi); y <= pixelY(lo); y++ {
					img.SetRGBA(x, y, peak)
				}
				for y := max(pixelY(hi), pixelY(energy)); y <= min(pixelY(lo), pixelY(-energy)); y++ {
					img.SetRGBA(x, y, rms)
				}
			}
		}
	}
	var output bytes.Buffer
	if err := png.Encode(&output, img); err != nil {
		return nil, fmt.Errorf("overview: encode PNG: %w", err)
	}
	return output.Bytes(), nil
}
