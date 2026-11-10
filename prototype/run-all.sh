#!/bin/sh
# Reproduces the measured results of the prototype. Runs the TypeScript sources directly (node >= 22.18).
# Fuzzers run in parallel first; the benchmarks run afterwards, alone, one process at a time.
set -u
cd "$(dirname "$0")"
S="$(cd ../.. && pwd)"
R=results
mkdir -p "$R"

./check.sh > "$R/check.txt" 2>&1

# 1. Differential fuzzing against upstream 0.0.36.
#    a. the pre-existing fuzzer, unmodified, with the prototype as FORK (xmldom 0.8, four seeds)
for seed in 11 22 33 44; do
    (cd "$S/forks/review" && FORK="$S/xpath-es/prototype/src/compat.ts" node fuzz2.js xmldom08 2500 "$seed") > "$R/fuzz2.xmldom08.$seed.txt" 2>&1 &
done
#    b. the TypeScript fuzzer with classification, every DOM
for dom in xmldom08 xmldom06 xmldom09 jsdom happy linkedom; do
    SAMPLES=1 node test/fuzz.ts "$dom" 1500 101 > "$R/fuzz.$dom.txt" 2>&1 &
done
#    c. the whole corpus (consumer expressions, quirk probes) on random documents, xmldom 0.8
node test/fuzz.ts xmldom08 300 202 all > "$R/fuzz.xmldom08.corpus.txt" 2>&1 &
wait
#    d. random expressions from the grammar, xmldom 0.8 and 0.6 (the last two seeds with the namespace axis)
for seed in 1 2 3 4 5 6; do node test/fuzz-expr.ts xmldom08 40 60 "$seed" > "$R/fuzz-expr.xmldom08.$seed.txt" 2>&1 & done
node test/fuzz-expr.ts xmldom06 40 60 7 > "$R/fuzz-expr.xmldom06.7.txt" 2>&1 &
node test/fuzz-expr.ts xmldom08 40 60 8 ns > "$R/fuzz-expr.xmldom08.8.ns.txt" 2>&1 &
node test/fuzz-expr.ts xmldom08 40 60 9 ns > "$R/fuzz-expr.xmldom08.9.ns.txt" 2>&1 &
wait

# 2. Fixed suites.
for dom in xmldom08 xmldom06 xmldom09 jsdom happy linkedom; do node test/smoke.ts "$dom" | tail -1; done > "$R/smoke.txt" 2>&1
node test/mutation.ts > "$R/mutation.txt" 2>&1
node "$S/mocha11/node_modules/mocha/bin/mocha.js" --require "$PWD/test/upstream-suite-preload.ts" "$S/forks/xpath-up/test.js" > "$R/upstream-suite.txt" 2>&1

# 3. Benchmarks, alone.
node bench/saml-fixtures.ts > "$R/saml-fixtures.txt" 2>&1
node bench/e2e.ts 200 > "$R/e2e.md" 2>&1
node bench/consumers.ts > "$R/consumers.md" 2>&1
node bench/micro.ts > "$R/micro.md" 2>&1
node bench/index-access.ts > "$R/index-access.md" 2>&1
node bench/hostile.ts > "$R/hostile.md" 2>&1
echo done > "$R/run-all.done"
