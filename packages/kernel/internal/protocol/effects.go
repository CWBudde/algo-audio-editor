package protocol

// EffectGraph uses the upstream effectchain JSON graph format. Parameter values
// are flat numbers, strings or booleans; audio/IR samples never enter JSON.
type EffectGraph struct {
	Nodes       []EffectNode       `json:"nodes"`
	Connections []EffectConnection `json:"connections"`
}

// EffectNode configures an upstream effect instance in a graph.
type EffectNode struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Bypassed bool           `json:"bypassed,omitempty"`
	Params   map[string]any `json:"params"`
}

// EffectConnection routes one graph node’s output port to another node’s input port.
type EffectConnection struct {
	From          string `json:"from"`
	To            string `json:"to"`
	FromPortIndex int    `json:"fromPortIndex,omitempty"`
	ToPortIndex   int    `json:"toPortIndex,omitempty"`
}

// EffectOption names one selectable string parameter value.
type EffectOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// EffectParameterDescriptor describes a control’s type, units, limits and default value.
type EffectParameterDescriptor struct {
	ID            string         `json:"id"`
	Label         string         `json:"label"`
	Unit          string         `json:"unit"`
	Type          string         `json:"type"`
	Min           float64        `json:"min"`
	Max           float64        `json:"max"`
	Default       float64        `json:"default"`
	Scale         string         `json:"scale"`
	Step          float64        `json:"step"`
	DefaultString string         `json:"defaultString,omitempty"`
	Options       []EffectOption `json:"options,omitempty"`
}

// EffectFactoryPreset names a set of upstream numeric and string parameter values.
type EffectFactoryPreset struct {
	ID   string             `json:"id"`
	Name string             `json:"name"`
	Num  map[string]float64 `json:"num"`
	Str  map[string]string  `json:"str"`
}

// EffectDescriptor describes an effect’s controls, presets and presentation category.
type EffectDescriptor struct {
	ID          string                      `json:"id"`
	Name        string                      `json:"name"`
	Category    string                      `json:"category"`
	ChannelMode string                      `json:"channelMode"`
	View        string                      `json:"view"`
	Parameters  []EffectParameterDescriptor `json:"parameters"`
	Presets     []EffectFactoryPreset       `json:"presets"`
}

// EffectsListParams selects the sample rate used to resolve effect control limits.
type EffectsListParams struct {
	SampleRate float64 `json:"sampleRate,omitempty"`
}

// EffectsListResult returns the upstream effect catalogue.
type EffectsListResult struct {
	Effects []EffectDescriptor `json:"effects"`
}

// EffectsPreviewParams starts or updates a private graph preview over a selection.
type EffectsPreviewParams struct {
	SelectionResult
	Graph     EffectGraph `json:"graph"`
	Wet       *float64    `json:"wet,omitempty"`
	Bypass    bool        `json:"bypass,omitempty"`
	PreviewID string      `json:"previewId,omitempty"`
}

// EffectsPreviewResult reports the active preview’s selection and wet/bypass state.
type EffectsPreviewResult struct {
	SelectionResult
	PreviewID string  `json:"previewId"`
	Wet       float64 `json:"wet"`
	Bypass    bool    `json:"bypass"`
}

// EffectsSessionParams identifies an active effect preview within a document.
type EffectsSessionParams struct {
	DocumentID string `json:"documentId"`
	PreviewID  string `json:"previewId"`
}

// EffectsStopResult reports whether an effect preview was stopped.
type EffectsStopResult struct {
	Stopped bool `json:"stopped"`
}

// EffectsMetersResult reports per-channel input and output peak/RMS preview meters.
type EffectsMetersResult struct {
	DocumentID string    `json:"documentId"`
	PreviewID  string    `json:"previewId"`
	Frames     int64     `json:"frames"`
	InputPeak  []float64 `json:"inputPeak"`
	InputRMS   []float64 `json:"inputRms"`
	OutputPeak []float64 `json:"outputPeak"`
	OutputRMS  []float64 `json:"outputRms"`
}

// EffectsResponseParams requests a frequency response or static dynamics transfer curve.
type EffectsResponseParams struct {
	Mode       string         `json:"mode,omitempty"`
	Graph      *EffectGraph   `json:"graph,omitempty"`
	EffectID   string         `json:"effectId,omitempty"`
	Params     map[string]any `json:"params,omitempty"`
	SampleRate float64        `json:"sampleRate,omitempty"`
	Points     int            `json:"points,omitempty"`
}

// EffectsResponseInfo describes Count little-endian float64 x/y pairs. Frequency uses Hz/magnitude
// dB; level uses input/output dB from the upstream static dynamics transfer.
type EffectsResponseInfo struct {
	Axis      string `json:"axis"`
	Count     int    `json:"count"`
	DataBytes int    `json:"dataBytes"`
}

// EffectsIRLoadParams names separately supplied impulse-response file bytes.
type EffectsIRLoadParams struct {
	DocumentID string `json:"documentId"`
	Name       string `json:"name"`
}

// EffectsIRInfo describes a retained, decoded impulse response.
type EffectsIRInfo struct {
	IRID       int    `json:"irId"`
	Name       string `json:"name"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
	Frames     int64  `json:"frames"`
}

// EffectsIRRemoveParams identifies a retained impulse response to remove.
type EffectsIRRemoveParams struct {
	DocumentID string `json:"documentId"`
	IRID       int    `json:"irId"`
}

// EffectsIRRemoveResult reports whether an impulse response was removed.
type EffectsIRRemoveResult struct {
	Removed bool `json:"removed"`
}
