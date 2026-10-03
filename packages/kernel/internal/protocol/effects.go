package protocol

// EffectGraph uses the upstream effectchain JSON graph format. Parameter values
// are flat numbers, strings or booleans; audio/IR samples never enter JSON.
type EffectGraph struct {
	Nodes       []EffectNode       `json:"nodes"`
	Connections []EffectConnection `json:"connections"`
}
type EffectNode struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Bypassed bool           `json:"bypassed,omitempty"`
	Params   map[string]any `json:"params"`
}
type EffectConnection struct {
	From          string `json:"from"`
	To            string `json:"to"`
	FromPortIndex int    `json:"fromPortIndex,omitempty"`
	ToPortIndex   int    `json:"toPortIndex,omitempty"`
}
type EffectOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}
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
type EffectFactoryPreset struct {
	ID   string             `json:"id"`
	Name string             `json:"name"`
	Num  map[string]float64 `json:"num"`
	Str  map[string]string  `json:"str"`
}
type EffectDescriptor struct {
	ID          string                      `json:"id"`
	Name        string                      `json:"name"`
	Category    string                      `json:"category"`
	ChannelMode string                      `json:"channelMode"`
	View        string                      `json:"view"`
	Parameters  []EffectParameterDescriptor `json:"parameters"`
	Presets     []EffectFactoryPreset       `json:"presets"`
}
type EffectsListParams struct {
	SampleRate float64 `json:"sampleRate,omitempty"`
}
type EffectsListResult struct {
	Effects []EffectDescriptor `json:"effects"`
}
type EffectsPreviewParams struct {
	SelectionResult
	Graph     EffectGraph `json:"graph"`
	Wet       *float64    `json:"wet,omitempty"`
	Bypass    bool        `json:"bypass,omitempty"`
	PreviewID string      `json:"previewId,omitempty"`
}
type EffectsPreviewResult struct {
	SelectionResult
	PreviewID string  `json:"previewId"`
	Wet       float64 `json:"wet"`
	Bypass    bool    `json:"bypass"`
}
type EffectsSessionParams struct {
	DocumentID string `json:"documentId"`
	PreviewID  string `json:"previewId"`
}
type EffectsStopResult struct {
	Stopped bool `json:"stopped"`
}
type EffectsMetersResult struct {
	DocumentID string    `json:"documentId"`
	PreviewID  string    `json:"previewId"`
	Frames     int64     `json:"frames"`
	InputPeak  []float64 `json:"inputPeak"`
	InputRMS   []float64 `json:"inputRms"`
	OutputPeak []float64 `json:"outputPeak"`
	OutputRMS  []float64 `json:"outputRms"`
}
type EffectsResponseParams struct {
	Mode       string         `json:"mode,omitempty"`
	Graph      *EffectGraph   `json:"graph,omitempty"`
	EffectID   string         `json:"effectId,omitempty"`
	Params     map[string]any `json:"params,omitempty"`
	SampleRate float64        `json:"sampleRate,omitempty"`
	Points     int            `json:"points,omitempty"`
}

// Data holds Count little-endian float64 x/y pairs. Frequency uses Hz/magnitude
// dB; level uses input/output dB from the upstream static dynamics transfer.
type EffectsResponseInfo struct {
	Axis      string `json:"axis"`
	Count     int    `json:"count"`
	DataBytes int    `json:"dataBytes"`
}
type EffectsIRLoadParams struct {
	DocumentID string `json:"documentId"`
	Name       string `json:"name"`
}
type EffectsIRInfo struct {
	IRID       int    `json:"irId"`
	Name       string `json:"name"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
	Frames     int64  `json:"frames"`
}
type EffectsIRRemoveParams struct {
	DocumentID string `json:"documentId"`
	IRID       int    `json:"irId"`
}
type EffectsIRRemoveResult struct {
	Removed bool `json:"removed"`
}
