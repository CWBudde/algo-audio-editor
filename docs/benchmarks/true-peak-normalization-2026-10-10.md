# True-peak normalization cost, 2026-10-10

Normalization measures the selected source's true peak since `feat(process): true-peak warning,
true-peak ceiling and automatic TPDF dither` (Phase 30). This records what that pass costs, so the
follow-up in Phase 16 has a baseline.

**Setup:** Apple M5 Pro (arm64), macOS 27.0.1, Go 1.27.1, Node 24.12.0 for js/wasm,
`algo-dsp v0.12.4`, a single iteration of `BenchmarkEngineNormalizeTenMinuteStereo` (ten minutes of
48 kHz stereo, whole-document normalization through the engine, commit included). "Before" is the
same tree with the change stashed.

```bash
cd packages/kernel
go test ./internal/engine -run '^$' -bench BenchmarkEngineNormalizeTenMinuteStereo -benchtime 3x -benchmem
GOOS=js GOARCH=wasm go test \
  -exec="env -i $(command -v node) --stack-size=8192 $(go env GOROOT)/lib/wasm/wasm_exec_node.js" \
  ./internal/engine -run '^$' -bench BenchmarkEngineNormalizeTenMinuteStereo -benchtime 1x
```

| Runtime | Operation | Before | After | Factor |
| --- | --- | ---: | ---: | ---: |
| native arm64 | peak | 0.094 s | 1.63 s | 17× |
| native arm64 | loudness | 0.23 s | 1.77 s | 7.7× |
| js/wasm (Node) | peak | 0.18 s | 5.5 s | 31× |
| js/wasm (Node) | loudness | 0.51 s | 5.9 s | 11× |

Allocations per run are unchanged (about 5,400). The added time is algo-dsp's scalar
`measure/truepeak` meter: a 48-tap BS.1770 interpolator that validates every block in one pass and
filters it in a second. In js/wasm ten minutes still normalize at about 100× real time, inside
Phase 16's ≥20× gate, but the slowdown is visible in the editor. Speeding the meter up belongs
upstream in algo-dsp (Phase 16).
