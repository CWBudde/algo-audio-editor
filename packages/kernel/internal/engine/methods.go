package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/effects"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// Every method's payload decoder, handler and busy permissions live together.
// Missing flags reject the method while the corresponding private job is active.
type busyPolicy uint8

const (
	allowProcessing busyPolicy = 1 << iota
	allowEffects
	allowBoth = allowProcessing | allowEffects
)

type methodSpec struct {
	busy   busyPolicy
	decode func(string, []byte) (any, error)
	handle func(*Engine, any, []byte) (any, error)
}

func typedMethod[P, R any](busy busyPolicy, handler func(*Engine, P) (R, error)) methodSpec {
	return binaryMethod(busy, func(e *Engine, p P, _ []byte) (R, error) { return handler(e, p) })
}

func binaryMethod[P, R any](busy busyPolicy, handler func(*Engine, P, []byte) (R, error)) methodSpec {
	return methodSpec{
		busy: busy,
		decode: func(method string, payload []byte) (any, error) {
			var p P
			if err := decode(method, payload, &p); err != nil {
				return nil, err
			}
			return p, nil
		},
		handle: func(e *Engine, p any, input []byte) (any, error) { return handler(e, p.(P), input) },
	}
}

func noParams[R any](busy busyPolicy, handler func(*Engine) (R, error)) methodSpec {
	return typedMethod(busy, func(e *Engine, _ struct{}) (R, error) { return handler(e) })
}

var methodRegistry = map[string]methodSpec{
	protocol.MethodHello:           noParams(allowBoth, func(e *Engine) (protocol.HelloResult, error) { return e.hello(), nil }),
	protocol.MethodDocumentMemory:  noParams(allowBoth, func(e *Engine) (protocol.DocumentMemoryResult, error) { return e.documentMemory(), nil }),
	protocol.MethodDocumentInfo:    noParams(allowBoth, (*Engine).documentInfo),
	protocol.MethodEditState:       noParams(allowBoth, func(e *Engine) (protocol.ClipboardInfo, error) { return e.clipboardInfo(), nil }),
	protocol.MethodTransportStop:   noParams(allowBoth, func(e *Engine) (protocol.TransportResult, error) { return e.stopDocument(), nil }),
	protocol.MethodEngineConfigure: typedMethod(allowBoth, (*Engine).configure),
	protocol.MethodToneConfigure:   typedMethod(0, (*Engine).configureTone),
	protocol.MethodMetersConfigure: typedMethod(allowBoth, (*Engine).configureMeters),
	protocol.MethodDocumentOpen:    binaryMethod(0, (*Engine).openDocument),
	protocol.MethodDocumentOpenPCM: binaryMethod(0, func(e *Engine, p protocol.BinaryDocumentParams, input []byte) (protocol.DocumentInfoResult, error) {
		return e.importBinaryDocumentMode(p, input, true)
	}),
	protocol.MethodDocumentNew: typedMethod(0, (*Engine).newDocument),
	protocol.MethodDocumentImportBinary: binaryMethod(0, func(e *Engine, p protocol.BinaryDocumentParams, input []byte) (protocol.DocumentInfoResult, error) {
		return e.importBinaryDocumentMode(p, input, false)
	}),
	protocol.MethodDocumentExport:  typedMethod(allowBoth, (*Engine).exportDocument),
	protocol.MethodDocumentReadPCM: typedMethod(0, (*Engine).readPCM),
	protocol.MethodPeaksGet:        typedMethod(allowBoth, (*Engine).getPeaks),
	protocol.MethodMetadataGet:     typedMethod(0, (*Engine).getMetadata),
	protocol.MethodMetadataSet:     typedMethod(0, (*Engine).setMetadata),
	protocol.MethodTransportPlay:   typedMethod(allowBoth, (*Engine).playDocument),
	protocol.MethodTransportSeek:   typedMethod(allowEffects, (*Engine).seekDocument),
	protocol.MethodSelectionGet:    typedMethod(allowBoth, (*Engine).getSelection),
	protocol.MethodSelectionSet:    typedMethod(0, (*Engine).setSelection),
	protocol.MethodSelectionSnap:   typedMethod(allowBoth, (*Engine).snapSelection),
	protocol.MethodTimelineGet:     typedMethod(allowBoth, (*Engine).getTimeline),
	protocol.MethodMarkersAdd:      typedMethod(0, (*Engine).addMarker),
	protocol.MethodRegionsAdd:      typedMethod(0, (*Engine).addRegion),
	protocol.MethodMarkersUpdate:   typedMethod(0, (*Engine).updateMarker),
	protocol.MethodRegionsUpdate:   typedMethod(0, (*Engine).updateRegion),
	protocol.MethodMarkersRemove: typedMethod(0, func(e *Engine, p protocol.TimelineRemoveParams) (protocol.TimelineMutationResult, error) {
		return e.removeAnchor(protocol.MethodMarkersRemove, p)
	}),
	protocol.MethodRegionsRemove: typedMethod(0, func(e *Engine, p protocol.TimelineRemoveParams) (protocol.TimelineMutationResult, error) {
		return e.removeAnchor(protocol.MethodRegionsRemove, p)
	}),
	protocol.MethodTimelineExport: typedMethod(allowBoth, (*Engine).exportTimeline),
	protocol.MethodEditApply:      typedMethod(0, (*Engine).applyEdit),
	protocol.MethodPreparePaste:   typedMethod(allowBoth, (*Engine).preparePaste),
	protocol.MethodHistoryList:    typedMethod(allowBoth, (*Engine).listHistory),
	protocol.MethodHistoryJump: typedMethod(0, func(e *Engine, p protocol.HistoryJumpParams) (protocol.EditResult, error) {
		return e.navigateHistory(protocol.MethodHistoryJump, p.DocumentID, p.StateID)
	}),
	protocol.MethodEditUndo: typedMethod(0, func(e *Engine, p protocol.HistoryListParams) (protocol.EditResult, error) {
		return e.navigateHistory(protocol.MethodEditUndo, p.DocumentID, "")
	}),
	protocol.MethodEditRedo: typedMethod(0, func(e *Engine, p protocol.HistoryListParams) (protocol.EditResult, error) {
		return e.navigateHistory(protocol.MethodEditRedo, p.DocumentID, "")
	}),
	protocol.MethodMarkSaved:              typedMethod(0, (*Engine).markSaved),
	protocol.MethodProcessStart:           binaryMethod(allowProcessing, (*Engine).startProcess),
	protocol.MethodProcessStep:            typedMethod(allowProcessing, (*Engine).stepProcess),
	protocol.MethodProcessStepBatch:       typedMethod(allowProcessing, (*Engine).stepProcessBatch),
	protocol.MethodProcessCancel:          typedMethod(allowProcessing, (*Engine).cancelProcess),
	protocol.MethodProcessCommit:          typedMethod(allowProcessing, (*Engine).commitProcess),
	protocol.MethodProcessExportCandidate: typedMethod(allowProcessing, (*Engine).exportCandidate),
	protocol.MethodAnalysisStart:          typedMethod(allowBoth, (*Engine).startAnalysis),
	protocol.MethodAnalysisStep:           typedMethod(allowBoth, (*Engine).stepAnalysis),
	protocol.MethodAnalysisCancel:         typedMethod(allowBoth, (*Engine).cancelAnalysis),
	protocol.MethodAnalysisCommit: typedMethod(0, func(e *Engine, p protocol.AnalysisJobParams) (protocol.EditResult, error) {
		job, err := e.activeAnalysis(protocol.MethodAnalysisCommit, p)
		if err != nil {
			return protocol.EditResult{}, err
		}
		return e.commitAnalysis(job)
	}),
	protocol.MethodAnalysisSpectrum: typedMethod(allowBoth, (*Engine).playbackSpectrum),
	protocol.MethodEffectsList: typedMethod(allowBoth, func(e *Engine, p protocol.EffectsListParams) (protocol.EffectsListResult, error) {
		rate, err := e.effectsRate(p.SampleRate)
		if err != nil {
			return protocol.EffectsListResult{}, fmt.Errorf("effects.list: sample rate: %w", err)
		}
		descriptors, err := effects.Descriptors(rate)
		if err != nil {
			return protocol.EffectsListResult{}, fmt.Errorf("effects.list: descriptors: %w", err)
		}
		return protocol.EffectsListResult{Effects: descriptors}, nil
	}),
	protocol.MethodEffectsResponse: typedMethod(allowBoth, (*Engine).effectResponse),
	protocol.MethodEffectsPreviewStart: typedMethod(0, func(e *Engine, p protocol.EffectsPreviewParams) (protocol.EffectsPreviewResult, error) {
		return e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
	}),
	protocol.MethodEffectsPreviewUpdate: typedMethod(allowEffects, func(e *Engine, p protocol.EffectsPreviewParams) (protocol.EffectsPreviewResult, error) {
		return e.startEffectPreview(protocol.MethodEffectsPreviewUpdate, p)
	}),
	protocol.MethodEffectsPreviewStop: typedMethod(allowEffects, func(e *Engine, p protocol.EffectsSessionParams) (protocol.EffectsStopResult, error) {
		if _, err := e.activeEffectSession(protocol.MethodEffectsPreviewStop, p); err != nil {
			return protocol.EffectsStopResult{}, err
		}
		e.discardEffectPreview()
		return protocol.EffectsStopResult{Stopped: true}, nil
	}),
	protocol.MethodEffectsPreviewMeters: typedMethod(allowBoth, func(e *Engine, p protocol.EffectsSessionParams) (protocol.EffectsMetersResult, error) {
		session, err := e.activeEffectSession(protocol.MethodEffectsPreviewMeters, p)
		if err != nil {
			return protocol.EffectsMetersResult{}, err
		}
		return e.effectMeters(session), nil
	}),
	protocol.MethodEffectsApply:    typedMethod(allowEffects, (*Engine).applyEffects),
	protocol.MethodEffectsIRLoad:   binaryMethod(allowEffects, (*Engine).loadImpulseResponse),
	protocol.MethodEffectsIRRemove: typedMethod(0, (*Engine).removeImpulseResponse),
}

func (e *Engine) dispatch(method string, payload, input []byte) (any, error) {
	spec, known := methodRegistry[method]
	// Preserve busy-error precedence even for unknown methods and bad payloads.
	if e.jobs.processJob != nil && spec.busy&allowProcessing == 0 {
		return nil, fmt.Errorf("%s: processing job is active", method)
	}
	if e.effectsState.effectPreview != nil && spec.busy&allowEffects == 0 {
		return nil, fmt.Errorf("%s: effect preview is active", method)
	}
	if !known {
		return nil, fmt.Errorf("unknown method %q", method)
	}
	p, err := spec.decode(method, payload)
	if err != nil {
		return nil, err
	}
	return spec.handle(e, p, input)
}
