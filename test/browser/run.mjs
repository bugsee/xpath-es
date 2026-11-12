// Runs test/browser/page.html in real browsers through Playwright, against the built dist/ (served over HTTP from this
// repository, because browsers refuse ES modules from file://).
//
//   npm run build && node test/browser/run.mjs [chromium] [firefox] [webkit]     default: chromium
//   npx playwright install chromium                                              once, to get the browser

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const launchers = { chromium, firefox, webkit };
const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : ['chromium'];
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.map': 'application/json' };

const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    // The oracle (upstream xpath, a devDependency) is served under a fixed name for the in-browser comparison.
    const pathname =
        url.pathname === '/upstream/xpath.js' ? '/node_modules/xpath/xpath.js' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(root, pathname));
    const allowed =
        file === path.join(root, 'node_modules/xpath/xpath.js') ||
        file.startsWith(path.join(root, 'dist') + path.sep) ||
        file.startsWith(path.join(root, 'test/browser') + path.sep);
    if (!allowed) {
        response.writeHead(404).end();
        return;
    }
    try {
        const body = await readFile(file);
        response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
        response.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
for (const name of names) {
    const launcher = launchers[name];
    if (launcher === undefined) throw new Error(`unknown browser ${name}`);
    const browser = await launcher.launch();
    try {
        const page = await browser.newPage();
        const problems = [];
        page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
        page.on(
            'console',
            (message) => message.type() === 'error' && problems.push(`console error: ${message.text()}`)
        );
        await page.goto(`${origin}/test/browser/page.html`);
        try {
            await page.waitForFunction(() => window.__xpathEs !== undefined, undefined, { timeout: 30_000 });
        } catch {
            console.log(`${name}: the page did not finish`);
            for (const problem of problems) console.log(`  ${problem}`);
            failed++;
            continue;
        }
        const results = await page.evaluate(() => window.__xpathEs);
        const bad = results.filter((result) => !result.ok);
        console.log(`${name} ${browser.version()}: ${results.length - bad.length} of ${results.length} checks passed`);
        for (const result of bad)
            console.log(`  FAIL ${result.name}\n    ${result.detail.split('\n').slice(0, 4).join('\n    ')}`);
        for (const problem of problems) console.log(`  ${problem}`);
        if (bad.length > 0 || problems.length > 0 || results.length === 0) failed++;
    } finally {
        await browser.close();
    }
}
server.close();
process.exitCode = failed === 0 ? 0 : 1;
