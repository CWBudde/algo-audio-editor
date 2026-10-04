package engine

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/core"
	"github.com/cwbudde/algo-dsp/dsp/effects/pitch"
	"github.com/cwbudde/algo-dsp/dsp/spectrum"
	"github.com/cwbudde/algo-dsp/measure/loudness"
	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

const (
	analysisBlockFrames = 1024
	// pitchStepWork bounds the YIN work units of one analysis.step: a few
	// milliseconds in WASM, instead of one bridge round trip per 4096 units.
	pitchStepWork = 1 << 18
	// pitchJobStepLimit is the largest budget pitch.YINJob.Step accepts.
	pitchJobStepLimit   = 1 << 16
	analysisOutputLimit = 16 << 20
	analysisCacheBytes  = 8 << 20
)

type (
	clippedRun        struct{ start, end int64 }
	analysisTileCache struct {
		key    string
		data   []byte
		result protocol.AnalysisJobResult
	}
)

type analysisJob struct {
	result          protocol.AnalysisJobResult
	params          protocol.AnalysisStartParams
	document        audiobuf.Document
	stateID         string
	channels        []audiobuf.Channel
	statistics      []*timestats.Accumulator
	clips           []*timestats.ClipDetector
	clipRuns        []clippedRun
	loudness        *loudness.IntegratedAnalyzer
	planar          [][]float64
	spectrum        *spectrumAnalysis
	pitch           *pitch.YINDetector
	pitchJob        *pitch.YINJob
	pitchStarted    bool
	position        int64
	packed          int
	column          int
	encodedChannels int
	data            []byte
	cacheKey        string
}

func (e *Engine) dispatchAnalysis(method string, payload []byte) (any, error) {
	if method == protocol.MethodAnalysisStart {
		var p protocol.AnalysisStartParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.startAnalysis(p)
	}
	if method == protocol.MethodAnalysisSpectrum {
		var p protocol.AnalysisSpectrumParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.playbackSpectrum(p)
	}
	var p protocol.AnalysisJobParams
	if err := decode(method, payload, &p); err != nil {
		return nil, err
	}
	if method == protocol.MethodAnalysisCancel && e.cancelledAnalysis != nil && e.cancelledAnalysis.JobID == p.JobID && e.cancelledAnalysis.DocumentID == p.DocumentID {
		return *e.cancelledAnalysis, nil
	}
	if method == protocol.MethodAnalysisCancel {
		if job := e.analysisJob; job != nil && job.result.JobID == p.JobID && job.result.DocumentID == p.DocumentID {
			result := job.result
			result.State = "cancelled"
			result.DataBytes = 0
			e.analysisJob = nil
			e.cancelledAnalysis = &result
			return result, nil
		}
		if job := e.spectrumJob; job != nil && job.result.JobID == p.JobID && job.documentID == p.DocumentID {
			result := protocol.AnalysisJobResult{SelectionResult: protocol.SelectionResult{DocumentID: p.DocumentID}, JobID: p.JobID, Kind: "spectrum", State: "cancelled", SampleRate: int(job.result.SampleRate), Channels: make([]int, job.result.Channels)}
			for c := range result.Channels {
				result.Channels[c] = c
			}
			e.spectrumJob = nil
			e.cancelledAnalysis = &result
			return result, nil
		}
	}
	job, err := e.activeAnalysis(method, p)
	if err != nil {
		return nil, err
	}
	switch method {
	case protocol.MethodAnalysisCancel:
		result := job.result
		result.State = "cancelled"
		result.DataBytes = 0
		e.analysisJob = nil
		e.cancelledAnalysis = &result
		return result, nil
	case protocol.MethodAnalysisCommit:
		return e.commitAnalysis(job)
	default:
		if job.result.State != "ready" {
			job.result.DataBytes = 0
			if err := job.step(); err != nil {
				e.analysisJob = nil
				return nil, fmt.Errorf("%s: %w", method, err)
			}
		}
		result := job.result
		if result.State != "ready" && p.IncludeData != nil {
			result.DataBytes = 0
			if *p.IncludeData && result.Kind == "spectrogram" && result.CompletedColumns > 0 {
				result.DataBytes = len(job.data)
			}
		}
		if result.DataBytes > 0 {
			e.bulkData = append([]byte(nil), job.data...)
			if job.cacheKey != "" && job.result.State == "ready" {
				e.cacheAnalysisTile(job)
			}
		}
		return result, nil
	}
}

func (e *Engine) activeAnalysis(method string, p protocol.AnalysisJobParams) (*analysisJob, error) {
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return nil, err
	}
	job := e.analysisJob
	if job == nil || p.JobID == "" || job.result.JobID != p.JobID || e.history == nil || job.stateID != e.history.CurrentID() {
		return nil, fmt.Errorf("%s: stale analysis job", method)
	}
	return job, nil
}

func (e *Engine) startAnalysis(p protocol.AnalysisStartParams) (protocol.AnalysisJobResult, error) {
	const method = protocol.MethodAnalysisStart
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.AnalysisJobResult{}, err
	}
	if e.history == nil {
		return protocol.AnalysisJobResult{}, fmt.Errorf("%s: analysis history unavailable", method)
	}
	if e.analysisJob != nil && (e.analysisJob.result.State == "running" || e.analysisJob.result.Kind == "clipping") && e.analysisJob.stateID == e.history.CurrentID() && e.analysisJob.result.DocumentID == p.DocumentID {
		return protocol.AnalysisJobResult{}, fmt.Errorf("%s: analysis job is already active", method)
	}
	if err := e.validateEditorRange(method, p.Start, p.End); err != nil {
		return protocol.AnalysisJobResult{}, err
	}
	if err := e.validateChannelMask(method, p.ChannelMask); err != nil {
		return protocol.AnalysisJobResult{}, err
	}
	if p.Start == p.End {
		p.Start = 0
		p.End = e.document.Frames()
	}
	if p.End <= p.Start {
		return protocol.AnalysisJobResult{}, fmt.Errorf("%s: document is empty", method)
	}
	if e.analysisSequence == math.MaxUint64 {
		return protocol.AnalysisJobResult{}, fmt.Errorf("%s: analysis history or identity unavailable", method)
	}
	if p.Kind != "statistics" && p.Kind != "clipping" && p.Kind != "pitch" && p.Kind != "spectrum" && p.Kind != "spectrogram" {
		return protocol.AnalysisJobResult{}, fmt.Errorf("%s: unknown analysis kind", method)
	}
	job := &analysisJob{params: p, document: e.document, stateID: e.history.CurrentID(), position: p.Start, result: protocol.AnalysisJobResult{SelectionResult: p.SelectionResult, Kind: p.Kind, State: "running", TotalFrames: p.End - p.Start, SampleRate: e.document.SampleRate(), Channels: make([]int, 0)}}
	for c := range e.document.Channels() {
		if p.ChannelMask&(1<<c) != 0 {
			channel, _ := e.document.Channel(c)
			job.channels = append(job.channels, channel)
			job.result.Channels = append(job.result.Channels, c)
		}
	}
	var err error
	switch p.Kind {
	case "statistics", "clipping":
		job.planar = make([][]float64, len(job.channels))
		job.statistics = make([]*timestats.Accumulator, len(job.channels))
		if p.Threshold == 0 {
			p.Threshold = 1
		}
		if math.IsNaN(p.Threshold) || math.IsInf(p.Threshold, 0) || p.Threshold <= 0 {
			return protocol.AnalysisJobResult{}, fmt.Errorf("%s: invalid clipping threshold", method)
		}
		for c := range job.channels {
			job.planar[c] = make([]float64, analysisBlockFrames)
			job.statistics[c], err = timestats.NewAccumulator(job.result.TotalFrames)
			if err != nil {
				return protocol.AnalysisJobResult{}, err
			}
		}
		if p.Kind == "statistics" {
			weights, weightErr := loudness.BS1770ChannelWeights(e.document.Channels(), job.result.Channels)
			if weightErr != nil {
				return protocol.AnalysisJobResult{}, fmt.Errorf("%s: channel weights: %w", method, weightErr)
			}
			positive := false
			for _, weight := range weights {
				positive = positive || weight > 0
			}
			if positive {
				job.loudness, err = loudness.NewIntegratedAnalyzer(loudness.IntegratedConfig{SampleRate: float64(job.result.SampleRate), Channels: len(job.channels), ChannelWeights: weights, MaxFrames: job.result.TotalFrames})
			}
		} else {
			job.clips = make([]*timestats.ClipDetector, len(job.channels))
			for c := range job.clips {
				job.clips[c], err = timestats.NewClipDetector(p.Threshold)
				if err != nil {
					return protocol.AnalysisJobResult{}, err
				}
			}
		}
	case "pitch":
		if p.MinHz == 0 {
			p.MinHz = 60
		}
		if p.MaxHz == 0 {
			p.MaxHz = 1600
		}
		if math.IsNaN(p.MinHz) || math.IsInf(p.MinHz, 0) || math.IsNaN(p.MaxHz) || math.IsInf(p.MaxHz, 0) || p.MinHz < 20 || p.MaxHz <= p.MinHz || p.MaxHz > float64(job.result.SampleRate)/2 || 2*float64(job.result.SampleRate)/p.MinHz > 65536 {
			return protocol.AnalysisJobResult{}, fmt.Errorf("%s: pitch frequency range must be20Hz..Nyquist and bounded65536frames", method)
		}
		job.pitch, err = pitch.NewYINDetector(float64(job.result.SampleRate), pitch.WithYINFrequencyRange(p.MinHz, p.MaxHz))
		if err == nil {
			job.pitchJob, err = pitch.NewYINJob(job.pitch)
			if err != nil {
				return protocol.AnalysisJobResult{}, err
			}
			if p.HopSize == 0 {
				p.HopSize = max(1, job.pitch.FrameSize()/2)
			}
			if p.HopSize < 1 || p.HopSize > job.pitch.FrameSize() {
				return protocol.AnalysisJobResult{}, fmt.Errorf("%s: invalid pitch hop", method)
			}
			count := (job.result.TotalFrames + int64(p.HopSize) - 1) / int64(p.HopSize)
			if count > analysisOutputLimit/int64(len(job.channels)*32) {
				return protocol.AnalysisJobResult{}, fmt.Errorf("%s: pitch output exceeds16MiB", method)
			}
			job.planar = [][]float64{make([]float64, job.pitch.FrameSize())}
			job.data = make([]byte, 0, int(count)*len(job.channels)*32)
		}
	case "spectrum", "spectrogram":
		job.spectrum, err = newSpectrumAnalysis(float64(job.result.SampleRate), len(job.channels), p.FFTSize, p.Window, p.Averaging, p.Smoothing)
		if err == nil {
			p.FFTSize = job.spectrum.transform.NFFT()
			job.result.FFTSize = p.FFTSize
			job.result.Bins = job.spectrum.transform.Bins()
			if p.Kind == "spectrogram" {
				if p.Width < 1 || p.Width > 128 || p.Height < 1 || p.Height > 512 || p.Channel < 0 || p.Channel >= e.document.Channels() || p.ChannelMask&(1<<p.Channel) == 0 {
					return protocol.AnalysisJobResult{}, fmt.Errorf("%s: invalid bounded tile dimensions or channel", method)
				}
				if p.MinDB == 0 && p.MaxDB == 0 {
					p.MinDB = -100
				}
				if math.IsNaN(p.MinDB) || math.IsInf(p.MinDB, 0) || math.IsNaN(p.MaxDB) || math.IsInf(p.MaxDB, 0) || p.MinDB >= p.MaxDB || p.MinDB < -240 || p.MaxDB > 60 {
					return protocol.AnalysisJobResult{}, fmt.Errorf("%s: invalid spectrogram dB range", method)
				}
				if p.ColorMap == "" {
					p.ColorMap = "inferno"
				}
				if p.ColorMap != "inferno" && p.ColorMap != "viridis" && p.ColorMap != "grayscale" {
					return protocol.AnalysisJobResult{}, fmt.Errorf("%s: unknown colormap", method)
				}
				job.result.Width = p.Width
				job.result.Height = p.Height
				job.data = make([]byte, p.Width*p.Height*4)
				for packed, c := range job.result.Channels {
					if c == p.Channel {
						job.packed = packed
					}
				}
				key, _ := json.Marshal(p)
				job.cacheKey = p.DocumentID + "/" + job.stateID + "/" + string(key)
			}
		}
	}
	if err != nil {
		return protocol.AnalysisJobResult{}, fmt.Errorf("%s: prepare: %w", method, err)
	}
	job.params = p
	e.analysisSequence++
	job.result.JobID = fmt.Sprintf("analysis-%d", e.analysisSequence)
	if job.cacheKey != "" {
		for _, cached := range e.analysisCache {
			if cached.key == job.cacheKey {
				job.data = append([]byte(nil), cached.data...)
				job.result.State = "ready"
				job.result.ProcessedFrames = job.result.TotalFrames
				job.result.CompletedColumns = p.Width
				job.result.DataBytes = len(job.data)
				e.bulkData = append([]byte(nil), job.data...)
				break
			}
		}
	}
	e.analysisJob = job
	e.cancelledAnalysis = nil
	return job.result, nil
}

func (job *analysisJob) step() error {
	switch job.result.Kind {
	case "statistics", "clipping":
		return job.stepStatistics()
	case "pitch":
		return job.stepPitch()
	default:
		return job.stepSpectrum()
	}
}

func (job *analysisJob) stepStatistics() error {
	if job.position < job.params.End {
		n := int(min(int64(analysisBlockFrames), job.params.End-job.position))
		for c, channel := range job.channels {
			job.planar[c] = job.planar[c][:n]
			channel.ReadFloat64(job.planar[c], job.position)
			if err := job.statistics[c].Add(job.planar[c]); err != nil {
				return err
			}
			if job.clips != nil {
				if err := job.clips[c].Process(job.planar[c], job.position, job.emitClip); err != nil {
					return err
				}
			}
		}
		if len(job.clipRuns) > audiobuf.MaxAnchors {
			return fmt.Errorf("analysis.clipping: too many clipped regions")
		}
		if job.loudness != nil {
			if err := job.loudness.ProcessPlanar(job.planar); err != nil {
				return err
			}
		}
		job.position += int64(n)
		job.result.ProcessedFrames = job.position - job.params.Start
		return nil
	}
	if job.loudness != nil {
		done, err := job.loudness.FinishStep(1024)
		if err != nil && !errors.Is(err, loudness.ErrBelowGate) && !errors.Is(err, loudness.ErrTooShort) {
			return err
		}
		if err == nil && !done {
			return nil
		}
		if err == nil {
			r, err := job.loudness.Result()
			if err != nil {
				return err
			}
			job.result.IntegratedLUFS = finiteNumber(r.LUFS)
		}
	}
	job.result.Statistics = make([]protocol.ChannelStatistics, len(job.channels))
	for c, s := range job.statistics {
		r := s.Result()
		job.result.Statistics[c] = protocol.ChannelStatistics{Channel: job.result.Channels[c], Peak: r.Peak, RMS: r.RMS, DC: r.DC, CrestDB: finiteNumber(core.LinearToDB(r.CrestFactor)), ZeroCrossings: r.ZeroCrossings, ClippedSamples: r.ClippedSamples}
		if job.clips != nil {
			job.clips[c].Flush(job.emitClip)
		}
	}
	if len(job.clipRuns) > audiobuf.MaxAnchors {
		return fmt.Errorf("analysis.clipping: too many clipped regions")
	}
	job.mergeClips()
	job.result.MarkerCount = len(job.clipRuns)
	job.result.State = "ready"
	return nil
}

func finiteNumber(value float64) *float64 {
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return nil
	}
	return &value
}

func (job *analysisJob) emitClip(start, end int64) {
	if len(job.clipRuns) <= audiobuf.MaxAnchors {
		job.clipRuns = append(job.clipRuns, clippedRun{start, end})
	}
}

func (job *analysisJob) mergeClips() {
	sort.Slice(job.clipRuns, func(i, j int) bool { return job.clipRuns[i].start < job.clipRuns[j].start })
	n := 0
	for _, run := range job.clipRuns {
		if n > 0 && run.start <= job.clipRuns[n-1].end {
			job.clipRuns[n-1].end = max(job.clipRuns[n-1].end, run.end)
		} else {
			job.clipRuns[n] = run
			n++
		}
	}
	job.clipRuns = job.clipRuns[:n]
}

func (job *analysisJob) readWindow(channel int, center int64, input []float64) error {
	clear(input)
	start := center - int64(len(input)/2)
	end := start + int64(len(input))
	lower, upper := job.params.Start, job.params.End
	if job.result.Kind == "spectrogram" {
		lower = 0
		upper = job.document.Frames()
	}
	from, to := max(start, lower), min(end, upper)
	if to > from {
		n := int(to - from)
		offset := int(from - start)
		if job.channels[channel].ReadFloat64(input[offset:offset+n], from) != n {
			return fmt.Errorf("analysis: incomplete source window")
		}
	}
	for _, x := range input {
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return fmt.Errorf("analysis: nonfinite input")
		}
	}
	return nil
}

// stepPitch spends up to pitchStepWork YIN work units per analysis.step,
// finishing as many frames as fit. A default-range frame needs more than the
// budget, so a step still yields inside a frame.
func (job *analysisJob) stepPitch() error {
	for budget := pitchStepWork; budget > 0; {
		if job.position >= job.params.End {
			job.result.State = "ready"
			job.result.DataBytes = len(job.data)
			return nil
		}
		if !job.pitchStarted {
			if err := job.readWindow(job.packed, job.position, job.planar[0]); err != nil {
				return err
			}
			if err := job.pitchJob.Begin(job.planar[0]); err != nil {
				return err
			}
			job.pitchStarted = true
		}
		work := min(budget, pitchJobStepLimit)
		budget -= work
		done, err := job.pitchJob.Step(work)
		if err != nil {
			return err
		}
		if !done {
			continue
		}
		estimate, err := job.pitchJob.Result()
		if err != nil {
			return err
		}
		job.pitchStarted = false
		for _, value := range []float64{float64(job.result.Channels[job.packed]), float64(job.position), estimate.FrequencyHz, estimate.Confidence} {
			job.data = binary.LittleEndian.AppendUint64(job.data, math.Float64bits(value))
		}
		job.result.Records++
		job.packed++
		if job.packed == len(job.channels) {
			job.packed = 0
			job.position = min(job.params.End, job.position+int64(job.params.HopSize))
			job.result.ProcessedFrames = job.position - job.params.Start
		}
	}
	return nil
}

func (job *analysisJob) stepSpectrum() error {
	s := job.spectrum
	if job.result.Kind == "spectrogram" {
		if job.column == job.params.Width {
			job.result.State = "ready"
			job.result.DataBytes = len(job.data)
			return nil
		}
		columnStart := job.params.Start + job.result.TotalFrames*int64(job.column)/int64(job.params.Width)
		columnEnd := job.params.Start + job.result.TotalFrames*int64(job.column+1)/int64(job.params.Width)
		if s.count[job.packed] == 0 {
			hop := int64(s.transform.NFFT() / 4)
			job.position = ((columnStart + hop - 1) / hop) * hop
			if job.position >= columnEnd {
				job.position = columnStart + (columnEnd-columnStart)/2
			}
			s.accumulators[job.packed].Reset()
		}
		if err := job.readWindow(job.packed, job.position, s.input); err != nil {
			return err
		}
		if err := s.add(job.packed); err != nil {
			return err
		}
		job.position += int64(s.transform.NFFT() / 4)
		job.result.ProcessedFrames = min(job.result.TotalFrames, max(int64(0), job.position-job.params.Start))
		if job.position < columnEnd {
			return nil
		}
		levels, err := s.levels(job.packed)
		if err != nil {
			return err
		}
		for row := range job.params.Height {
			level := spectrogramRowLevel(levels, row, job.params.Height)
			position := (level - job.params.MinDB) / (job.params.MaxDB - job.params.MinDB)
			color := analysisColor(job.params.ColorMap, position)
			offset := (row*job.params.Width + job.column) * 4
			copy(job.data[offset:offset+4], color[:])
		}
		job.column++
		s.count[job.packed] = 0
		job.result.CompletedColumns = job.column
		job.result.ProcessedFrames = job.result.TotalFrames * int64(job.column) / int64(job.params.Width)
		job.result.DataBytes = len(job.data)
		return nil
	}
	if job.packed == 0 && (job.position >= job.params.End || s.count[0] >= s.averaging) {
		if job.data == nil {
			job.data = make([]byte, len(s.accumulators)*len(s.frequencies)*16)
		}
		if err := s.encodeChannel(job.encodedChannels, job.data); err != nil {
			return err
		}
		job.encodedChannels++
		if job.encodedChannels == len(job.channels) {
			job.result.State = "ready"
			job.result.DataBytes = len(job.data)
			job.result.ProcessedFrames = job.result.TotalFrames
		}
		return nil
	}
	count := min(int64(s.averaging), (job.result.TotalFrames+int64(s.transform.NFFT())-1)/int64(s.transform.NFFT()))
	center := job.params.Start + int64((float64(s.count[job.packed])+.5)*float64(job.result.TotalFrames)/float64(count))
	if err := job.readWindow(job.packed, center, s.input); err != nil {
		return err
	}
	if err := s.add(job.packed); err != nil {
		return err
	}
	job.packed++
	if job.packed == len(job.channels) {
		job.packed = 0
		job.position = job.params.Start + job.result.TotalFrames*int64(s.count[0])/count
		job.result.ProcessedFrames = job.position - job.params.Start
	}
	return nil
}

// spectrogramRowLevel preserves the strongest computed FFT bin in each display
// band. Every bin contributes when the image downsamples the spectrum; selecting
// just one bin per row would erase narrow tones between those sampled bins.
// Upsampling repeats bins, and the bottom and top bands include DC and Nyquist.
func spectrogramRowLevel(levels []float64, row, height int) float64 {
	band := height - 1 - row
	from := band * len(levels) / height
	to := max(from+1, (band+1)*len(levels)/height)
	level := levels[from]
	for _, candidate := range levels[from+1 : to] {
		level = max(level, candidate)
	}
	return level
}

func analysisColor(name string, x float64) [4]byte {
	x = max(0, min(1, x))
	if name == "grayscale" {
		v := byte(math.Round(255 * x))
		return [4]byte{v, v, v, 255}
	}
	var stops [5][3]float64
	if name == "viridis" {
		stops = [5][3]float64{{68, 1, 84}, {59, 82, 139}, {33, 145, 140}, {94, 201, 98}, {253, 231, 37}}
	} else {
		stops = [5][3]float64{{0, 0, 4}, {87, 16, 110}, {188, 55, 84}, {249, 142, 9}, {252, 255, 164}}
	}
	p := x * 4
	i := min(3, int(p))
	t := p - float64(i)
	return [4]byte{byte(math.Round(stops[i][0]*(1-t) + stops[i+1][0]*t)), byte(math.Round(stops[i][1]*(1-t) + stops[i+1][1]*t)), byte(math.Round(stops[i][2]*(1-t) + stops[i+1][2]*t)), 255}
}

func (e *Engine) cacheAnalysisTile(job *analysisJob) {
	for i, c := range e.analysisCache {
		if c.key == job.cacheKey {
			e.analysisCache = append(e.analysisCache[:i], e.analysisCache[i+1:]...)
			break
		}
	}
	e.analysisCache = append(e.analysisCache, analysisTileCache{key: job.cacheKey, data: append([]byte(nil), job.data...), result: job.result})
	bytes := 0
	for _, c := range e.analysisCache {
		bytes += len(c.data)
	}
	for len(e.analysisCache) > 32 || bytes > analysisCacheBytes {
		bytes -= len(e.analysisCache[0].data)
		e.analysisCache = e.analysisCache[1:]
	}
}

func (e *Engine) commitAnalysis(job *analysisJob) (protocol.EditResult, error) {
	if job.result.State != "ready" || job.result.Kind != "clipping" {
		return protocol.EditResult{}, fmt.Errorf("analysis.commit: only ready clipping detection can create markers")
	}
	if e.processJob != nil || e.effectPreview != nil {
		return protocol.EditResult{}, fmt.Errorf("analysis.commit: processing or effects preview is active")
	}
	if len(job.clipRuns) == 0 {
		e.analysisJob = nil
		return e.editResult(false), nil
	}
	timeline := e.document.Metadata().Timeline
	for _, run := range job.clipRuns {
		id, err := nextAnchor(timeline)
		if err != nil {
			return protocol.EditResult{}, err
		}
		timeline.NextID++
		timeline.Markers = append(timeline.Markers, audiobuf.Marker{ID: id, Frame: run.start, Name: fmt.Sprintf("Clipping (%d samples)", run.end-run.start), Color: "#ef4444"})
	}
	if _, err := e.commitTimeline(protocol.MethodAnalysisCommit, "Detect clipping", timeline, cloneEditor(e.editor)); err != nil {
		return protocol.EditResult{}, err
	}
	e.analysisJob = nil
	e.analysisCache = nil
	return e.editResult(true), nil
}

type playbackSpectrumJob struct {
	params                         protocol.AnalysisSpectrumParams
	result                         protocol.AnalysisSpectrumResult
	spectrum                       *spectrumAnalysis
	source                         []float32
	write, count, channel, encoded int
	stateID, documentID            string
	data                           []byte
}

func (e *Engine) playbackSpectrum(p protocol.AnalysisSpectrumParams) (protocol.AnalysisSpectrumResult, error) {
	if p.Source != "playback" {
		return protocol.AnalysisSpectrumResult{}, fmt.Errorf("analysis.spectrum: source must be playback")
	}
	stateID := ""
	if e.history != nil {
		stateID = e.history.CurrentID()
	}
	j := e.spectrumJob
	jobID := p.JobID
	p.JobID = ""
	compatible := j != nil && j.params == p && j.result.Channels == e.channels && j.result.SampleRate == e.sampleRate && j.documentID == e.editor.documentID && j.stateID == stateID
	if jobID != "" && (!compatible || j.result.JobID != jobID) {
		return protocol.AnalysisSpectrumResult{}, fmt.Errorf("analysis.spectrum: stale live spectrum job")
	}
	if jobID != "" && j.result.State == "ready" {
		e.bulkData = append([]byte(nil), j.data...)
		return j.result, nil
	}
	if jobID == "" {
		var s *spectrumAnalysis
		if compatible {
			s = j.spectrum
			clear(s.count)
		} else {
			var err error
			s, err = newSpectrumAnalysis(e.sampleRate, e.channels, p.FFTSize, p.Window, p.Averaging, p.Smoothing)
			if err != nil {
				return protocol.AnalysisSpectrumResult{}, err
			}
			for c := range s.accumulators {
				a, err := spectrum.NewPowerAverager(s.transform.Bins(), s.averaging)
				if err != nil {
					return protocol.AnalysisSpectrumResult{}, err
				}
				s.accumulators[c] = a
			}
		}
		if e.spectrumHistory == nil {
			e.spectrumHistory = make([]float32, playbackSpectrumFrames*e.channels)
			e.spectrumWrite = 0
			e.spectrumCount = 0
		}
		if e.analysisSequence == math.MaxUint64 {
			return protocol.AnalysisSpectrumResult{}, fmt.Errorf("analysis.spectrum: job identity exhausted")
		}
		e.analysisSequence++
		j = &playbackSpectrumJob{params: p, spectrum: s, source: append([]float32(nil), e.spectrumHistory...), write: e.spectrumWrite, count: e.spectrumCount, stateID: stateID, documentID: e.editor.documentID, data: make([]byte, e.channels*s.transform.Bins()*16), result: protocol.AnalysisSpectrumResult{DocumentID: e.editor.documentID, JobID: fmt.Sprintf("spectrum-%d", e.analysisSequence), State: "running", Source: "playback", SampleRate: e.sampleRate, Channels: e.channels, FFTSize: s.transform.NFFT(), Bins: s.transform.Bins()}}
		e.spectrumJob = j
	}
	s := j.spectrum
	if j.channel < e.channels {
		clear(s.input)
		count := min(len(s.input), j.count)
		for frame := range count {
			source := (j.write - count + frame + playbackSpectrumFrames) % playbackSpectrumFrames
			s.input[len(s.input)-count+frame] = float64(j.source[source*e.channels+j.channel])
		}
		if err := s.add(j.channel); err != nil {
			e.spectrumJob = nil
			return protocol.AnalysisSpectrumResult{}, err
		}
		j.channel++
		return j.result, nil
	}
	if err := s.encodeChannel(j.encoded, j.data); err != nil {
		e.spectrumJob = nil
		return protocol.AnalysisSpectrumResult{}, err
	}
	j.encoded++
	if j.encoded == e.channels {
		j.result.State = "ready"
		j.result.DataBytes = len(j.data)
		e.bulkData = append([]byte(nil), j.data...)
	}
	return j.result, nil
}
