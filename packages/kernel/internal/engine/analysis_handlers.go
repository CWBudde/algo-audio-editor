package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func (e *Engine) cancelAnalysis(p protocol.AnalysisJobParams) (protocol.AnalysisJobResult, error) {
	const method = protocol.MethodAnalysisCancel
	if e.analysis.cancelledAnalysis != nil && e.analysis.cancelledAnalysis.JobID == p.JobID && e.analysis.cancelledAnalysis.DocumentID == p.DocumentID {
		return *e.analysis.cancelledAnalysis, nil
	}
	if job := e.analysis.analysisJob; job != nil && job.result.JobID == p.JobID && job.result.DocumentID == p.DocumentID {
		result := job.result
		result.State = protocol.JobCancelled
		result.DataBytes = 0
		e.analysis.analysisJob = nil
		e.analysis.cancelledAnalysis = &result
		return result, nil
	}
	if job := e.analysis.spectrumJob; job != nil && job.result.JobID == p.JobID && job.documentID == p.DocumentID {
		result := protocol.AnalysisJobResult{SelectionResult: protocol.SelectionResult{DocumentID: p.DocumentID}, JobID: p.JobID, Kind: protocol.AnalysisSpectrum, State: protocol.JobCancelled, SampleRate: int(job.result.SampleRate), Channels: make([]int, job.result.Channels)}
		for c := range result.Channels {
			result.Channels[c] = c
		}
		e.analysis.spectrumJob = nil
		e.analysis.cancelledAnalysis = &result
		return result, nil
	}
	job, err := e.activeAnalysis(method, p)
	if err != nil {
		return protocol.AnalysisJobResult{}, err
	}
	result := job.result
	result.State = protocol.JobCancelled
	result.DataBytes = 0
	e.analysis.analysisJob = nil
	e.analysis.cancelledAnalysis = &result
	return result, nil
}

func (e *Engine) stepAnalysis(p protocol.AnalysisJobParams) (protocol.AnalysisJobResult, error) {
	const method = protocol.MethodAnalysisStep
	job, err := e.activeAnalysis(method, p)
	if err != nil {
		return protocol.AnalysisJobResult{}, err
	}
	if job.result.State != protocol.JobReady {
		job.result.DataBytes = 0
		if err := job.step(); err != nil {
			e.analysis.analysisJob = nil
			return protocol.AnalysisJobResult{}, fmt.Errorf("%s: %w", method, err)
		}
	}
	result := job.result
	if result.State != protocol.JobReady && p.IncludeData != nil {
		result.DataBytes = 0
		if *p.IncludeData && result.Kind == protocol.AnalysisSpectrogram && result.CompletedColumns > 0 {
			result.DataBytes = len(job.data)
		}
	}
	if result.DataBytes > 0 {
		e.bulkData = append([]byte(nil), job.data...)
		if job.cacheKey != "" && job.result.State == protocol.JobReady {
			e.cacheAnalysisTile(job)
		}
	}
	return result, nil
}
