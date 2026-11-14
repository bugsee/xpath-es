// Hostile-document benchmark table: every case on every chosen engine (ENGINES=upstream,candidate by default), each
// in its own process with a hard time limit, so a quadratic engine is killed and shown as "> limit" instead of
// hanging the run. The pass/fail gate is test/hostile.ts; this prints numbers.
//
//   node bench/hostile.ts [case#]
//   ENGINES=upstream,candidate HOSTILE_KILL_MS=120000 node bench/hostile.ts

import { spawnSync } from 'node:child_process';
import { KiB, CASES } from './hostile-cases.ts';
import { chosenEngines } from './engines.ts';
import { isMeasurement } from './hostile-run.ts';

const killAfterMs = Number(process.env['HOSTILE_KILL_MS'] ?? 60_000);
const runner = new URL('./hostile-run.ts', import.meta.url).pathname;
const chosen = chosenEngines();
const only = process.argv[2] === undefined ? null : Number(process.argv[2]);

console.log(`| # | case | document | results | ${chosen.join(' | ')} | same result |`);
console.log(`|---|---|---|---|${chosen.map(() => '---:').join('|')}|---|`);
CASES.forEach((item, at) => {
    if (only !== null && only !== at) return;
    const cells: string[] = [];
    const digests = new Set<string>();
    let size = '?';
    for (const engine of chosen) {
        const child = spawnSync(process.execPath, [runner, engine, String(at)], {
            timeout: killAfterMs,
            killSignal: 'SIGKILL',
            encoding: 'utf8'
        });
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(child.stdout);
        } catch {
            parsed = null;
        }
        if (isMeasurement(parsed)) {
            cells.push(`${parsed.ms < 10 ? parsed.ms.toFixed(2) : parsed.ms.toFixed(0)} ms`);
            digests.add(parsed.digest);
            size = String(parsed.size);
        } else {
            cells.push(child.error === undefined ? 'failed' : `> ${killAfterMs / 1000} s (killed)`);
        }
    }
    const finished = cells.every((cell) => cell.endsWith('ms'));
    const same = digests.size === 1 ? (finished ? 'yes' : 'yes (of those that finished)') : 'NO';
    const expression = item.expression.length > 60 ? `${item.expression.slice(0, 57)}...` : item.expression;
    console.log(
        `| ${at} | ${item.name}: \`${expression}\` | ${(item.xml().length / KiB).toFixed(0)} KiB | ${size} | ${cells.join(' | ')} | ${same} |`
    );
});
