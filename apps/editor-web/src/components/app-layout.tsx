import { lazy, Suspense, useCallback, useState } from "react";
import { AboutStatusDialog } from "@/components/about-status-dialog";
import { AnalysisControls } from "@/components/analysis-controls";
import { AppMenubar } from "@/components/app-menubar";
import { EditToolbar, PasteConversionDialog } from "@/components/edit-toolbar";
import { HistoryPanel } from "@/components/history-panel";
import { IconAction } from "@/components/icon-action";
import { LivePlaybackMeters } from "@/components/live-playback-meters";
import { SpectrumPanel } from "@/components/spectrum-panel";
import { StatusBar } from "@/components/status-bar";
import { TransportBar } from "@/components/transport-bar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WaveformPlaceholder } from "@/components/waveform-placeholder";
import { WaveformView } from "@/components/waveform-view";
import type { useAppController } from "@/hooks/use-app-controller";
import { Redo2, Undo2 } from "@/lib/icons";

const AutomationDialog = lazy(() =>
  import("@/components/automation-dialog").then((module) => ({ default: module.AutomationDialog })),
);
const BatchDialog = lazy(() =>
  import("@/components/batch-dialog").then((module) => ({ default: module.BatchDialog })),
);
const AnalysisDialog = lazy(() =>
  import("@/components/analysis-dialog").then((module) => ({ default: module.AnalysisDialog })),
);
const MetadataDialog = lazy(() =>
  import("@/components/metadata-dialog").then((module) => ({ default: module.MetadataDialog })),
);
const EffectsDialog = lazy(() =>
  import("@/components/effects-dialog").then((module) => ({ default: module.EffectsDialog })),
);
const ExportDialog = lazy(() =>
  import("@/components/export-dialog").then((module) => ({ default: module.ExportDialog })),
);
const ProcessDialog = lazy(() =>
  import("@/components/process-dialog").then((module) => ({ default: module.ProcessDialog })),
);
const CommandPalette = lazy(() =>
  import("@/components/command-palette").then((module) => ({ default: module.CommandPalette })),
);

export function AppLayout({ controller }: { controller: ReturnType<typeof useAppController> }) {
  const [controlsHost, setControlsHost] = useState<HTMLFieldSetElement | null>(null);
  const {
    analysis,
    timelineOptions,
    resetMeters,
    automation,
    batch,
    busy,
    changeSpectralSettings,
    client,
    commands,
    desktop,
    doc,
    edit,
    editSnapshot,
    effects,
    engine,
    execute,
    exporting,
    fileInput,
    finishConfirmation,
    follow,
    history,
    informationButton,
    informationOpen,
    kernel,
    loop,
    memory,
    metadata,
    metersOpen,
    paletteOpen,
    pastePlan,
    playing,
    position,
    processing,
    readPosition,
    runEdit,
    seek,
    selection,
    selectionEditor,
    setFollow,
    setInformationOpen,
    setLoop,
    setMetersOpen,
    setPaletteOpen,
    setSilenceValue,
    setSpectralSelection,
    setSpectrumOpen,
    silenceValue,
    spectralSettings,
    spectralView,
    spectrumOpen,
    transportBar,
    waveformView,
  } = controller;
  const closeInformation = useCallback(() => setInformationOpen(false), [setInformationOpen]);
  const closeSpectrum = useCallback(() => setSpectrumOpen(false), [setSpectrumOpen]);
  const closeMeters = useCallback(() => setMetersOpen(false), [setMetersOpen]);
  const play = useCallback(() => execute("transport.toggle-playback"), [execute]);
  const stop = useCallback(() => execute("transport.stop"), [execute]);
  const undo = useCallback(() => execute("edit.undo"), [execute]);
  const redo = useCallback(() => execute("edit.redo"), [execute]);
  const information = useCallback(() => execute("help.about"), [execute]);
  const confirmPaste = useCallback(() => finishConfirmation(true), [finishConfirmation]);
  const cancelPaste = useCallback(() => finishConfirmation(false), [finishConfirmation]);
  return (
    <TooltipProvider>
      <div
        className="editor-shell flex h-dvh flex-col bg-background text-foreground"
        data-kernel-state={kernel.status}
      >
        <header className="editor-header flex h-9 shrink-0 min-w-0 items-center gap-2 border-b px-3">
          <img
            src={`${import.meta.env.BASE_URL}app-icon.png`}
            alt=""
            className="size-6 shrink-0 rounded-md"
          />
          <span className="hidden shrink-0 pr-2 text-xs font-semibold tracking-tight md:inline">
            algo-audio-editor
          </span>
          {!desktop.native && (
            <span className="hidden shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground lg:inline">
              Development
            </span>
          )}
          {!desktop.native && <AppMenubar commands={commands} onExecute={execute} />}
          {automation.recording && (
            <button
              type="button"
              className="ml-auto shrink-0 rounded border border-destructive px-2 py-1 text-xs text-destructive"
              disabled={busy}
              onClick={() => execute("file.stop-recording")}
            >
              Recording macro · Stop
            </button>
          )}
        </header>
        {kernel.status === "error" && (
          <p
            role="alert"
            className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          >
            Audio kernel unavailable: {kernel.error}. Reload the editor to restart it; unsaved
            changes may be lost.
          </p>
        )}
        {globalThis.crossOriginIsolated === false && (
          <p role="alert" className="border-b px-3 py-2 text-sm">
            Audio playback requires cross-origin isolation. Allow service workers for this site,
            disable extensions that block them, then reload. If your browser or private mode blocks
            isolation, use a regular window in a current browser or the desktop app.
          </p>
        )}
        <fieldset
          ref={setControlsHost}
          className="editor-toolbar flex min-h-9 shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b px-2 py-1"
          aria-label="Editor actions"
          data-testid="primary-controls"
        >
          <TransportBar
            frameless
            commands={commands}
            onExecute={execute}
            ref={transportBar}
            ready={engine !== undefined && !busy && Boolean(doc.info?.frames)}
            playing={playing}
            loop={loop}
            follow={follow}
            position={position}
            sampleRate={doc.info?.sampleRate ?? 48000}
            readPosition={readPosition}
            onPlay={play}
            onStop={stop}
            onLoopChange={setLoop}
            onFollowChange={setFollow}
          />
          <fieldset
            aria-label="Undo and redo"
            className="editor-tool-band flex shrink-0 items-center gap-0.5 border-l pl-1"
          >
            {(
              [
                ["edit.undo", Undo2, "Undo"],
                ["edit.redo", Redo2, "Redo"],
              ] as const
            ).map(([id, icon, label]) => {
              const command = commands.find((item) => item.id === id);
              return (
                <IconAction
                  key={id}
                  icon={icon}
                  label={label}
                  disabled={!command?.enabled}
                  onClick={() => execute(id)}
                  shortcutLabel={command?.shortcutLabel}
                  ariaShortcut={command?.ariaShortcut}
                />
              );
            })}
          </fieldset>
          <EditToolbar
            frameless
            commands={commands}
            onExecute={execute}
            info={doc.info}
            selection={selection}
            clipboard={edit.clipboard}
            busy={busy}
            silenceValue={silenceValue}
            onSilenceValueChange={setSilenceValue}
            onRun={(operation, _range, frames) => runEdit(operation, frames)}
          />
          {doc.info && (
            <HistoryPanel
              frameless
              commands={commands}
              onExecute={execute}
              history={history.history}
              busy={busy}
              onUndo={undo}
              onRedo={redo}
              onJump={(stateId) => {
                void history.jump(stateId);
              }}
            />
          )}
        </fieldset>
        <input
          ref={fileInput}
          type="file"
          accept=".wav,.flac,.aif,.aiff,.aifc,.mp3,.ogg,.opus,.m4a,.aac,audio/*"
          className="hidden"
          data-testid="audio-file-input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) doc.openFile(file);
          }}
        />
        <main
          className="editor-workspace relative flex min-h-0 flex-1 flex-col overflow-auto"
          data-testid="document-drop-zone"
          aria-busy={busy}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) doc.openFile(file);
          }}
        >
          {doc.info && spectralView !== "waveform" && (
            <div className="studio-section shrink-0 border-b px-2 py-1">
              <AnalysisControls
                showAveraging={false}
                settings={spectralSettings}
                onChange={changeSpectralSettings}
                disabled={Boolean(analysis.view)}
              />
            </div>
          )}
          {busy && (
            <p
              role="status"
              className="absolute right-4 top-4 z-30 rounded border bg-popover px-2 py-1 text-xs text-muted-foreground"
            >
              Working on document…
            </p>
          )}
          {doc.info && client ? (
            <WaveformView
              controlsHost={controlsHost}
              commands={commands}
              onExecute={execute}
              ref={waveformView}
              client={client}
              info={doc.info}
              timelineOptions={timelineOptions}
              onExportTimeline={doc.exportTimeline}
              position={position}
              playing={playing}
              follow={follow}
              onSeek={seek}
              readPosition={readPosition}
              disabled={busy}
              selectionEditor={selectionEditor}
              initialEdit={editSnapshot?.client === client ? editSnapshot.result : undefined}
              spectralView={spectralView}
              onSpectralSelectionChange={setSpectralSelection}
              spectralSettings={spectralSettings}
              analysisPaused={Boolean(
                analysis.view || effects.view || processing.view || exporting.view || busy,
              )}
              analysisStateId={history.history?.currentStateId}
            />
          ) : (
            <WaveformPlaceholder
              disabled={!client || busy}
              onOpen={doc.open}
              onDemo={doc.openDemo}
            />
          )}
        </main>
        {doc.info && (spectrumOpen || metersOpen) && (
          <div
            className="analysis-dock"
            data-testid="analysis-dock"
            data-dual={Boolean(client && spectrumOpen && selection && metersOpen)}
          >
            {client && spectrumOpen && selection && (
              <SpectrumPanel
                client={client}
                info={doc.info}
                selection={selection}
                settings={spectralSettings}
                onSettings={changeSpectralSettings}
                playing={playing}
                paused={Boolean(
                  analysis.view || effects.view || processing.view || exporting.view || busy,
                )}
                onClose={closeSpectrum}
                stateId={history.history?.currentStateId}
              />
            )}
            {metersOpen && (
              <LivePlaybackMeters
                client={client}
                info={doc.info}
                onReset={resetMeters}
                onClose={closeMeters}
              />
            )}
          </div>
        )}
        <StatusBar
          info={doc.info}
          dirty={history.history?.dirty}
          onInformation={information}
          informationDisabled={
            paletteOpen || !commands.find((command) => command.id === "help.about")?.enabled
          }
          informationRef={informationButton}
        />
      </div>
      <Toaster theme="dark" />
      {automation.open && (
        <Suspense fallback={<p role="status">Opening…</p>}>
          <AutomationDialog
            automation={automation}
            canReplay={Boolean(client && doc.info && !busy)}
          />
        </Suspense>
      )}
      {batch.open && (
        <Suspense fallback={<p role="status">Opening…</p>}>
          <BatchDialog batch={batch} />
        </Suspense>
      )}
      {analysis.view && (
        <Suspense fallback={<p role="status">Opening…</p>}>
          <AnalysisDialog
            view={analysis.view}
            onCancel={analysis.cancel}
            onCommit={analysis.commit}
          />
        </Suspense>
      )}
      {metadata.view && (
        <Suspense fallback={<p role="status">Opening…</p>}>
          <MetadataDialog
            view={metadata.view}
            onCancel={metadata.cancel}
            onCommit={metadata.commit}
          />
        </Suspense>
      )}
      <AboutStatusDialog
        open={informationOpen}
        onClose={closeInformation}
        kernel={kernel}
        sampleRate={engine?.sampleRate}
        engine={engine}
        memory={memory}
        fallbackFocusRef={informationButton}
      />
      {paletteOpen && (
        <Suspense fallback={<p role="status">Opening…</p>}>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            commands={commands}
            onExecute={execute}
          />
        </Suspense>
      )}
      <PasteConversionDialog plan={pastePlan} onConfirm={confirmPaste} onCancel={cancelPaste} />
      {effects.view && (
        <Suspense fallback={<p role="status">Opening…</p>}>
          <EffectsDialog
            view={effects.view}
            descriptors={effects.descriptors}
            presets={effects.presets}
            client={client}
            catalogError={effects.catalogError}
            onChange={effects.change}
            onPreview={effects.preview}
            onStopPreview={effects.stopPreview}
            onApply={effects.apply}
            onCancel={effects.cancel}
            onLoadIR={effects.loadIR}
            onSavePreset={effects.savePreset}
            onDeletePreset={effects.deletePreset}
            onLoadPreset={effects.loadPreset}
          />
        </Suspense>
      )}
      {exporting.view && (
        <Suspense fallback={<p role="status">Opening…</p>}>
          <ExportDialog
            view={exporting.view}
            onSettingsChange={exporting.setSettings}
            onExport={exporting.submit}
            onCancel={exporting.cancel}
          />
        </Suspense>
      )}
      {processing.view && (
        <Suspense fallback={<p role="status">Opening…</p>}>
          <ProcessDialog
            view={processing.view}
            onParameterTextChange={processing.setParameterText}
            onOperationChange={processing.setOperation}
            onSettingsChange={processing.setSettings}
            onPreview={processing.preview}
            onStopPreview={processing.stopPreview}
            onApply={processing.apply}
            onCancel={processing.cancel}
          />
        </Suspense>
      )}
    </TooltipProvider>
  );
}
