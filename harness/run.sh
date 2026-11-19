#!/usr/bin/env bash
# Kalamos M1 acceptance harness.
#
# Runs, in order: npm test (vitest), cargo test, npm run test:e2e (Playwright),
# npm run bench (10k-line latency). Every step runs even if an earlier one
# fails; a summary is printed at the end and the script exits 1 if any failed.
#
# Usage: harness/run.sh            (from anywhere inside the repo)
# Env:   HARNESS_SKIP="cargo bench"  skip steps by name (space separated)
#        HARNESS_OUT=dir             where logs + bench.json go
#                                    (default: $TMPDIR/kalamos-harness — not
#                                    test-results/, which Playwright wipes)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="${HARNESS_OUT:-${TMPDIR:-/tmp}/kalamos-harness}"
OUT="${OUT%/}"
mkdir -p "$OUT"
SKIP=" ${HARNESS_SKIP:-} "

names=()
results=()
durations=()

run_step() {
  local name="$1"; shift
  if [[ "$SKIP" == *" $name "* ]]; then
    names+=("$name"); results+=("SKIP"); durations+=("-")
    echo "==> [$name] skipped"
    return
  fi
  echo "==> [$name] $*"
  mkdir -p "$OUT"
  local start end status
  start=$(date +%s)
  "$@" >"$OUT/$name.log" 2>&1
  status=$?
  end=$(date +%s)
  names+=("$name"); durations+=("$((end - start))s")
  if [[ $status -eq 0 ]]; then
    results+=("PASS")
  else
    results+=("FAIL($status)")
    echo "    last lines of $OUT/$name.log:"
    tail -n 15 "$OUT/$name.log" | sed 's/^/    | /'
  fi
}

bench_step() {
  # JSON on stdout → bench.json; progress on stderr → bench.log
  node tests/bench/run.mjs >"$OUT/bench.json" 2>"$OUT/bench.stderr.log"
  local status=$?
  cat "$OUT/bench.json"
  cat "$OUT/bench.stderr.log" >&2
  return $status
}

run_step unit  npm test
run_step cargo cargo test --manifest-path src-tauri/Cargo.toml
run_step e2e   npm run test:e2e
run_step bench bench_step

echo
echo "================ Kalamos M1 harness summary ================"
printf "%-8s %-10s %s\n" "step" "result" "time"
fail=0
for i in "${!names[@]}"; do
  printf "%-8s %-10s %s\n" "${names[$i]}" "${results[$i]}" "${durations[$i]}"
  [[ "${results[$i]}" == FAIL* ]] && fail=1
done

# One-line extracts so the summary is useful without opening logs.
if [[ -f "$OUT/unit.log" ]]; then
  grep -E "Tests +[0-9]" "$OUT/unit.log" | tail -n 1 | sed 's/^ */unit:   /'
fi
if [[ -f "$OUT/cargo.log" ]]; then
  grep -E "^test result:" "$OUT/cargo.log" | awk '{p+=$4; f+=$6} END {if (NR) printf "cargo:  %d passed, %d failed (%d suites)\n", p, f, NR}'
fi
if [[ -f "$OUT/e2e.log" ]]; then
  grep -E "^\s+[0-9]+ (passed|failed|skipped|flaky)" "$OUT/e2e.log" | tr -s ' ' | tr '\n' ' ' | sed 's/^/e2e:   /'; echo
fi
if [[ -s "$OUT/bench.json" ]]; then
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const s of r.scenarios) {
      console.log(`bench:  ${s.name.padEnd(13)} ${s.lines} lines  input p50 ${s.inputLatencyMs.p50} ms  p95 ${s.inputLatencyMs.p95} ms  open p50 ${s.openToFirstRenderMs.p50} ms  ${s.pass ? "PASS" : "FAIL"} (budget ${r.budgetMs} ms)`);
    }' "$OUT/bench.json"
fi
echo "logs: $OUT"
echo "============================================================"
exit $fail
