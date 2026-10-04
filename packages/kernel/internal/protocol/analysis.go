package protocol

const (
	MethodMetersConfigure    = "meters.configure"
	MethodAnalysisStart      = "analysis.start"
	MethodAnalysisStep       = "analysis.step"
	MethodAnalysisCancel     = "analysis.cancel"
	MethodAnalysisCommit     = "analysis.commit"
	MethodAnalysisSpectrum   = "analysis.spectrum"
	MetersDataBytes          = 1536
	MetersFloat64Count       = 192
	MetersChannelOffset      = 16
	MetersChannelStride      = 4
	MetersGoniometerOffset   = 64
	MetersGoniometerCapacity = 64
)

type MetersConfigureParams struct {
	Enabled *bool `json:"enabled,omitempty"`
	Reset   bool  `json:"reset,omitempty"`
}
type MetersConfigureResult struct {
	Enabled    bool `json:"enabled"`
	ByteLength int  `json:"byteLength"`
	Version    int  `json:"version"`
}

// Meter payload is little-endian Float64[192]: version/channels/frames/rate,
// M/S/I/LRA/correlation/goniometer count, reserved to16, then8channel tuples
// of linear peak/RMS/hold/truepeak, reserved to64, then64mid/side pairs.
// Slots10/11 are maxM/maxS,12 is LRAstable,13 is measured loudness frames,
// 14 is failure(0none,1nonfinite,2capacity,3arithmetic),15 availability(M1,S2,I4,LRA8).
// Nonfinite loudness means no gated measurement; the transport is unchanged.
type AnalysisStartParams struct {
	SelectionResult
	Kind      string  `json:"kind"`
	FFTSize   int     `json:"fftSize,omitempty"`
	Window    string  `json:"window,omitempty"`
	Averaging int     `json:"averaging,omitempty"`
	Smoothing float64 `json:"smoothing,omitempty"`
	HopSize   int     `json:"hopSize,omitempty"`
	MinHz     float64 `json:"minHz,omitempty"`
	MaxHz     float64 `json:"maxHz,omitempty"`
	Threshold float64 `json:"threshold,omitempty"`
	Channel   int     `json:"channel,omitempty"`
	Width     int     `json:"width,omitempty"`
	Height    int     `json:"height,omitempty"`
	MinDB     float64 `json:"minDB,omitempty"`
	MaxDB     float64 `json:"maxDB,omitempty"`
	ColorMap  string  `json:"colorMap,omitempty"`
}
type AnalysisJobParams struct {
	DocumentID string `json:"documentId"`
	JobID      string `json:"jobId"`
	// Running tiles emit on completed columns by default. Explicit false skips
	// binary copying; true requests the current image. Ready results always emit.
	IncludeData *bool `json:"includeData,omitempty"`
}
type ChannelStatistics struct {
	Channel        int      `json:"channel"`
	Peak           float64  `json:"peak"`
	RMS            float64  `json:"rms"`
	DC             float64  `json:"dc"`
	CrestDB        *float64 `json:"crestDB"`
	ZeroCrossings  int64    `json:"zeroCrossings"`
	ClippedSamples int64    `json:"clippedSamples"`
}
type AnalysisJobResult struct {
	SelectionResult
	JobID            string              `json:"jobId"`
	Kind             string              `json:"kind"`
	State            string              `json:"state"`
	ProcessedFrames  int64               `json:"processedFrames"`
	TotalFrames      int64               `json:"totalFrames"`
	SampleRate       int                 `json:"sampleRate"`
	DataBytes        int                 `json:"dataBytes"`
	Channels         []int               `json:"channels"`
	FFTSize          int                 `json:"fftSize,omitempty"`
	Bins             int                 `json:"bins,omitempty"`
	Width            int                 `json:"width,omitempty"`
	Height           int                 `json:"height,omitempty"`
	CompletedColumns int                 `json:"completedColumns,omitempty"`
	Records          int                 `json:"records,omitempty"`
	Statistics       []ChannelStatistics `json:"statistics,omitempty"`
	IntegratedLUFS   *float64            `json:"integratedLUFS"`
	MarkerCount      int                 `json:"markerCount,omitempty"`
}

// Spectrum binary output is channel-major Float64 pairs (frequencyHz, levelDB).
// Pitch binary output is Float64 tuples (physicalChannel, sourceFrame, Hz, confidence).
// Spectrogram output is row-major RGBA8, lowfrequency at bottom.
// Every FFT/4 hop contributes mean power within its pixel; windows use document
// context, so tile boundaries do not zero-pad or change the resulting image.
type AnalysisSpectrumParams struct {
	JobID     string  `json:"jobId,omitempty"`
	Source    string  `json:"source"`
	FFTSize   int     `json:"fftSize,omitempty"`
	Window    string  `json:"window,omitempty"`
	Averaging int     `json:"averaging,omitempty"`
	Smoothing float64 `json:"smoothing,omitempty"`
}
type AnalysisSpectrumResult struct {
	DocumentID string  `json:"documentId"`
	JobID      string  `json:"jobId"`
	State      string  `json:"state"`
	Source     string  `json:"source"`
	SampleRate float64 `json:"sampleRate"`
	Channels   int     `json:"channels"`
	FFTSize    int     `json:"fftSize"`
	Bins       int     `json:"bins"`
	DataBytes  int     `json:"dataBytes"`
}
