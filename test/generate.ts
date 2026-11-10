// Random documents (the generator of forks/review/fuzz2.js) and random expressions (from the XPath 1.0 grammar).

export type Random = () => number;

function pick<T>(random: Random, items: readonly T[], fallback: T): T {
    return items[Math.floor(random() * items.length)] ?? fallback;
}

const NAMES = ['a', 'b', 'c', 'p:d', 'q:e'];

function attributes(random: Random): string {
    let text = '';
    if (random() < 0.35) text += ' x="1"';
    if (random() < 0.25) text += ' y="2"';
    if (random() < 0.15) text += ` id="i${Math.floor(random() * 5)}"`;
    if (random() < 0.12) text += ` xmlns:n${Math.floor(random() * 3)}="urn:n"`;
    if (random() < 0.08) text += ` xmlns="urn:def${Math.floor(random() * 2)}"`;
    if (random() < 0.1) text += ' p:z="3"';
    return text;
}

function content(random: Random, depth: number, maxDepth: number, width: number): string {
    let out = '';
    const count = Math.floor(random() * width);
    for (let i = 0; i < count; i++) {
        const r = random();
        if (r < 0.5 && depth < maxDepth) {
            const name = pick(random, NAMES, 'a');
            out += `<${name}${attributes(random)}>${content(random, depth + 1, maxDepth, width)}</${name}>`;
        } else if (r < 0.65) out += `<${pick(random, NAMES, 'a')}${attributes(random)}/>`;
        else if (r < 0.75) out += `text${i}`;
        else if (r < 0.82) out += '<![CDATA[cd]]>';
        else if (r < 0.91) out += '<!--c-->';
        else out += '<?pi d?>';
    }
    return out;
}

export function documentText(random: Random): string {
    const mode = random();
    let body: string;
    if (mode < 0.1) {
        const depth = 20 + Math.floor(random() * 60);
        body = '<a x="1">'.repeat(depth) + content(random, 0, 2, 5) + '</a>'.repeat(depth);
    } else if (mode < 0.2) body = content(random, 0, 1, 40);
    else body = content(random, 0, 5, 7);
    const before = random() < 0.3 ? '<?top pi?><!--top-->' : '';
    const after = random() < 0.3 ? '<!--end--><?end pi?>' : '';
    return `${before}<r xmlns:p="urn:p" xmlns:q="urn:q"${attributes(random)}>${body}</r>${after}`;
}

// ---- expressions ----

const AXES = [
    'child',
    'child',
    'child',
    'descendant',
    'descendant-or-self',
    'parent',
    'ancestor',
    'ancestor-or-self',
    'following-sibling',
    'preceding-sibling',
    'following',
    'preceding',
    'attribute',
    'self'
];
const TESTS = [
    '*',
    '*',
    'a',
    'b',
    'c',
    'node()',
    'node()',
    'text()',
    'comment()',
    'processing-instruction()',
    "processing-instruction('pi')",
    'd',
    'A'
];
const ATTRIBUTE_TESTS = ['*', 'x', 'y', 'id', 'X'];
const STRINGS = ["'a'", "'1'", "''", "'text1'", '"i1"', "'x y'", "'urn:p'"];
const NUMBERS = ['0', '1', '2', '3', '1.5', '.5', '10'];

export interface ExpressionOptions {
    /** Include the namespace axis (upstream cannot order most of its results). */
    readonly namespaceAxis: boolean;
}

export function makeExpressionGenerator(random: Random, options: ExpressionOptions): () => string {
    const one = <T>(items: readonly T[], fallback: T): T => pick(random, items, fallback);

    function step(depth: number): string {
        const r = random();
        if (r < 0.06) return '.';
        if (r < 0.12) return '..';
        let axis = one(AXES, 'child');
        if (options.namespaceAxis && random() < 0.04) axis = 'namespace';
        const test = axis === 'attribute' ? one(ATTRIBUTE_TESTS, '*') : one(TESTS, '*');
        const head =
            axis === 'child' && random() < 0.8
                ? test
                : axis === 'attribute' && random() < 0.8
                  ? `@${test}`
                  : `${axis}::${test}`;
        let predicates = '';
        while (depth < 3 && random() < 0.3) predicates += `[${predicate(depth + 1)}]`;
        return head + predicates;
    }

    function path(depth: number): string {
        let out = random() < 0.5 ? (random() < 0.5 ? '/' : '//') : '';
        const count = 1 + Math.floor(random() * 3);
        for (let i = 0; i < count; i++) {
            if (i > 0) out += random() < 0.25 ? '//' : '/';
            out += step(depth);
        }
        return out;
    }

    function nodeSet(depth: number): string {
        const r = random();
        if (depth >= 3 || r < 0.7) return path(depth);
        if (r < 0.82) return `${path(depth)} | ${path(depth)}`;
        if (r < 0.92) return `(${nodeSet(depth + 1)})[${predicate(depth + 1)}]`;
        if (r < 0.96) return `(${nodeSet(depth + 1)})/${step(depth + 1)}`;
        return `id(${random() < 0.5 ? "'i1 i3'" : nodeSet(depth + 1)})`;
    }

    function string(depth: number): string {
        const r = random();
        if (depth >= 3 || r < 0.3) return one(STRINGS, "''");
        if (r < 0.42) return `local-name(${random() < 0.5 ? '' : nodeSet(depth + 1)})`;
        if (r < 0.52) return `name(${random() < 0.5 ? '' : nodeSet(depth + 1)})`;
        if (r < 0.58) return `namespace-uri(${random() < 0.5 ? '' : nodeSet(depth + 1)})`;
        if (r < 0.68) return `string(${random() < 0.3 ? '' : any(depth + 1)})`;
        if (r < 0.74) return `concat(${string(depth + 1)}, ${string(depth + 1)})`;
        if (r < 0.79)
            return `substring(${string(depth + 1)}, ${number(depth + 1)}${random() < 0.5 ? '' : `, ${number(depth + 1)}`})`;
        if (r < 0.84) return `substring-before(${string(depth + 1)}, ${string(depth + 1)})`;
        if (r < 0.88) return `substring-after(${string(depth + 1)}, ${string(depth + 1)})`;
        if (r < 0.93) return `normalize-space(${random() < 0.5 ? '' : string(depth + 1)})`;
        return `translate(${string(depth + 1)}, ${string(depth + 1)}, ${string(depth + 1)})`;
    }

    function number(depth: number): string {
        const r = random();
        if (depth >= 3 || r < 0.3) return one(NUMBERS, '1');
        if (r < 0.4) return 'position()';
        if (r < 0.48) return 'last()';
        if (r < 0.6) return `count(${nodeSet(depth + 1)})`;
        if (r < 0.66) return `string-length(${random() < 0.5 ? '' : string(depth + 1)})`;
        if (r < 0.72) return `number(${random() < 0.3 ? '' : any(depth + 1)})`;
        if (r < 0.76) return `sum(${nodeSet(depth + 1)})`;
        if (r < 0.82) return `${one(['floor', 'ceiling', 'round'], 'round')}(${number(depth + 1)})`;
        if (r < 0.86) return `-${number(depth + 1)}`;
        return `${number(depth + 1)} ${one(['+', '-', '*', 'div', 'mod'], '+')} ${number(depth + 1)}`;
    }

    function boolean(depth: number): string {
        const r = random();
        if (depth >= 3 || r < 0.1) return one(['true()', 'false()'], 'true()');
        if (r < 0.4) return `${any(depth + 1)} ${one(['=', '=', '!=', '<', '<=', '>', '>='], '=')} ${any(depth + 1)}`;
        if (r < 0.5) return `${boolean(depth + 1)} ${one(['and', 'or'], 'and')} ${boolean(depth + 1)}`;
        if (r < 0.6) return `not(${any(depth + 1)})`;
        if (r < 0.68) return `boolean(${any(depth + 1)})`;
        if (r < 0.8) return `contains(${string(depth + 1)}, ${string(depth + 1)})`;
        if (r < 0.9) return `starts-with(${string(depth + 1)}, ${string(depth + 1)})`;
        if (r < 0.93) return `lang(${string(depth + 1)})`;
        return `(${boolean(depth + 1)})`;
    }

    function any(depth: number): string {
        const r = random();
        if (r < 0.45) return nodeSet(depth);
        if (r < 0.65) return string(depth);
        if (r < 0.85) return number(depth);
        return boolean(depth);
    }

    function predicate(depth: number): string {
        const r = random();
        if (r < 0.3)
            return one(
                ['1', '2', 'last()', 'position() = 2', 'position() < 3', 'last() - 1', 'position() mod 2 = 1'],
                '1'
            );
        if (r < 0.55) return nodeSet(depth);
        if (r < 0.9) return boolean(depth);
        return any(depth);
    }

    return () => any(0);
}
