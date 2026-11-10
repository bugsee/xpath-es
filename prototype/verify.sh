#!/bin/sh
# The correctness part of run-all.sh on the final sources, plus the runs with every fast path forced off (SLOW=1).
set -u
cd "$(dirname "$0")"
S="$(cd ../.. && pwd)"
R=results/final
mkdir -p "$R"
./check.sh > "$R/check.txt" 2>&1
for seed in 11 22 33 44; do
    (cd "$S/forks/review" && FORK="$S/xpath-es/prototype/src/compat.ts" node fuzz2.js xmldom08 2500 "$seed") > "$R/fuzz2.xmldom08.$seed.txt" 2>&1 &
done
node test/fuzz.ts xmldom08 1500 101 > "$R/fuzz.xmldom08.txt" 2>&1 &
SLOW=1 node test/fuzz.ts xmldom08 1500 101 > "$R/fuzz.xmldom08.slow.txt" 2>&1 &
node test/fuzz.ts xmldom06 1500 101 > "$R/fuzz.xmldom06.txt" 2>&1 &
node test/fuzz.ts xmldom08 300 202 all > "$R/fuzz.xmldom08.corpus.txt" 2>&1 &
SLOW=1 node test/fuzz.ts xmldom08 300 202 all > "$R/fuzz.xmldom08.corpus.slow.txt" 2>&1 &
wait
for seed in 1 2 3 4 5 6; do node test/fuzz-expr.ts xmldom08 60 100 "$seed" > "$R/fuzz-expr.xmldom08.$seed.txt" 2>&1 & done
node test/fuzz-expr.ts xmldom08 60 100 8 ns > "$R/fuzz-expr.xmldom08.8.ns.txt" 2>&1 &
node test/fuzz-expr.ts xmldom08 60 100 9 ns > "$R/fuzz-expr.xmldom08.9.ns.txt" 2>&1 &
SLOW=1 node test/fuzz-expr.ts xmldom08 60 100 10 > "$R/fuzz-expr.xmldom08.10.slow.txt" 2>&1 &
SLOW=1 node test/fuzz-expr.ts xmldom08 60 100 11 ns > "$R/fuzz-expr.xmldom08.11.ns.slow.txt" 2>&1 &
node test/fuzz-expr.ts xmldom06 60 100 7 > "$R/fuzz-expr.xmldom06.7.txt" 2>&1 &
wait
for dom in xmldom08 xmldom06 xmldom09 jsdom happy linkedom; do node test/smoke.ts "$dom" | tail -1; done > "$R/smoke.txt" 2>&1
SLOW=1 node test/smoke.ts xmldom08 | tail -1 > "$R/smoke.slow.txt" 2>&1
node test/mutation.ts > "$R/mutation.txt" 2>&1
node "$S/mocha11/node_modules/mocha/bin/mocha.js" --require "$PWD/test/upstream-suite-preload.ts" "$S/forks/xpath-up/test.js" > "$R/upstream-suite.txt" 2>&1
node bench/e2e.ts 20 > "$R/e2e.md" 2>&1
ENGINES=xpath-es node bench/hostile.ts > "$R/hostile.xpath-es.md" 2>&1
echo done > "$R/verify.done"
