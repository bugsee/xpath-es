// Parser: tokens -> immutable AST. W3C XPath 1.0 grammar, productions [1]-[39].
// Operator runs are parsed with loops (no recursion per operand); recursion happens only when the expression
// nests (parentheses, predicates, function arguments, unary minus) and is capped by `maxDepth`.

import type { Axis, BinaryOp, ChainLink, Expr, NodeTest, Step } from './ast.ts';
import { XPathLimitError, XPathSyntaxError } from './errors.ts';
import { tokenize } from './lexer.ts';
import type { Token, TokenKind } from './lexer.ts';

export interface ParseLimits {
    /** Longest expression accepted, in UTF-16 code units. */
    readonly maxLength: number;
    /** Deepest nesting of parentheses, predicates, function arguments and unary minus accepted. */
    readonly maxDepth: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = { maxLength: 1 << 20, maxDepth: 256 };

const AXES: ReadonlyMap<string, Axis> = new Map<string, Axis>([
    ['ancestor', 'ancestor'],
    ['ancestor-or-self', 'ancestor-or-self'],
    ['attribute', 'attribute'],
    ['child', 'child'],
    ['descendant', 'descendant'],
    ['descendant-or-self', 'descendant-or-self'],
    ['following', 'following'],
    ['following-sibling', 'following-sibling'],
    ['namespace', 'namespace'],
    ['parent', 'parent'],
    ['preceding', 'preceding'],
    ['preceding-sibling', 'preceding-sibling'],
    ['self', 'self']
]);

// One entry per binary precedence level above UnionExpr, loosest first (productions [21]-[26]).
const LEVELS: readonly ReadonlyMap<TokenKind, BinaryOp>[] = [
    new Map<TokenKind, BinaryOp>([
        ['=', '='],
        ['!=', '!=']
    ]),
    new Map<TokenKind, BinaryOp>([
        ['<', '<'],
        ['<=', '<='],
        ['>', '>'],
        ['>=', '>=']
    ]),
    new Map<TokenKind, BinaryOp>([
        ['+', '+'],
        ['-', '-']
    ]),
    new Map<TokenKind, BinaryOp>([
        ['multiply', '*'],
        ['div', 'div'],
        ['mod', 'mod']
    ])
];

const DESCENDANT_OR_SELF_NODE: Step = { axis: 'descendant-or-self', test: { kind: 'node' }, predicates: [] };
const EOF_TOKEN: Token = { kind: 'eof', value: '[EOF]' };

class Parser {
    readonly #tokens: readonly Token[];
    readonly #maxDepth: number;
    #pos = 0;
    #depth = 0;

    constructor(tokens: readonly Token[], maxDepth: number) {
        this.#tokens = tokens;
        this.#maxDepth = maxDepth;
    }

    parse(): Expr {
        const expr = this.#expr();
        if (this.#peek().kind !== 'eof') throw new XPathSyntaxError();
        return expr;
    }

    #peek(offset: number = 0): Token {
        return this.#tokens[this.#pos + offset] ?? EOF_TOKEN;
    }

    #accept(kind: TokenKind): boolean {
        if (this.#peek().kind !== kind) return false;
        this.#pos++;
        return true;
    }

    #expect(kind: TokenKind): Token {
        const token = this.#peek();
        if (token.kind !== kind) throw new XPathSyntaxError();
        this.#pos++;
        return token;
    }

    #nested<T>(parse: () => T): T {
        if (++this.#depth > this.#maxDepth)
            throw new XPathLimitError(`XPath expression nests deeper than ${this.#maxDepth} levels`);
        try {
            return parse();
        } finally {
            this.#depth--;
        }
    }

    // [14] Expr, [21] OrExpr
    #expr(): Expr {
        const first = this.#and();
        if (this.#peek().kind !== 'or') return first;
        const operands = [first];
        while (this.#accept('or')) operands.push(this.#and());
        return { kind: 'or', operands };
    }

    // [22] AndExpr
    #and(): Expr {
        const first = this.#binary(0);
        if (this.#peek().kind !== 'and') return first;
        const operands = [first];
        while (this.#accept('and')) operands.push(this.#binary(0));
        return { kind: 'and', operands };
    }

    // [23]-[26]: one loop per level; the recursion depth here is the constant number of levels.
    #binary(level: number): Expr {
        const ops = LEVELS[level];
        if (ops === undefined) return this.#unary();
        const first = this.#binary(level + 1);
        let op = ops.get(this.#peek().kind);
        if (op === undefined) return first;
        const rest: ChainLink[] = [];
        while (op !== undefined) {
            this.#pos++;
            rest.push({ op, operand: this.#binary(level + 1) });
            op = ops.get(this.#peek().kind);
        }
        return { kind: 'chain', first, rest };
    }

    // [27] UnaryExpr
    #unary(): Expr {
        if (this.#accept('-')) return this.#nested((): Expr => ({ kind: 'negate', operand: this.#unary() }));
        return this.#union();
    }

    // [18] UnionExpr
    #union(): Expr {
        const first = this.#path();
        if (this.#peek().kind !== '|') return first;
        const operands = [first];
        while (this.#accept('|')) operands.push(this.#path());
        return { kind: 'union', operands };
    }

    #startsPrimary(): boolean {
        const kind = this.#peek().kind;
        return kind === '$' || kind === '(' || kind === 'literal' || kind === 'number' || kind === 'function';
    }

    // [19] PathExpr, [20] FilterExpr
    #path(): Expr {
        if (!this.#startsPrimary()) return this.#locationPath();
        const primary = this.#primary();
        const filterPredicates = this.#predicates();
        const steps: Step[] = [];
        if (this.#accept('/')) {
            this.#relativePath(steps);
        } else if (this.#accept('//')) {
            steps.push(DESCENDANT_OR_SELF_NODE);
            this.#relativePath(steps);
        } else if (filterPredicates.length === 0) {
            return primary;
        }
        return { kind: 'path', filter: primary, filterPredicates, absolute: false, steps };
    }

    // [15] PrimaryExpr
    #primary(): Expr {
        const token = this.#peek();
        this.#pos++;
        switch (token.kind) {
            case '$':
                return { kind: 'variable', name: this.#expect('qname').value };
            case '(': {
                const inner = this.#nested((): Expr => this.#expr());
                this.#expect(')');
                return inner;
            }
            case 'literal':
                return { kind: 'literal', value: token.value };
            case 'number':
                return { kind: 'number', value: Number.parseFloat(token.value) };
            case 'function': {
                this.#expect('(');
                const args: Expr[] = [];
                if (!this.#accept(')')) {
                    do args.push(this.#nested((): Expr => this.#expr()));
                    while (this.#accept(','));
                    this.#expect(')');
                }
                return { kind: 'call', name: token.value, args };
            }
            default:
                throw new XPathSyntaxError();
        }
    }

    // [1] LocationPath, [2] AbsoluteLocationPath, [10] AbbreviatedAbsoluteLocationPath
    #locationPath(): Expr {
        const steps: Step[] = [];
        let absolute = false;
        if (this.#accept('/')) {
            absolute = true;
            if (this.#startsStep()) this.#relativePath(steps);
        } else if (this.#accept('//')) {
            absolute = true;
            steps.push(DESCENDANT_OR_SELF_NODE);
            this.#relativePath(steps);
        } else {
            this.#relativePath(steps);
        }
        return { kind: 'path', filter: null, filterPredicates: [], absolute, steps };
    }

    #startsStep(): boolean {
        const kind = this.#peek().kind;
        return (
            kind === '.' ||
            kind === '..' ||
            kind === '@' ||
            kind === 'axis' ||
            kind === 'star' ||
            kind === 'prefix-star' ||
            kind === 'qname' ||
            kind === 'node-type' ||
            kind === 'pi-literal'
        );
    }

    // [3] RelativeLocationPath, [11] AbbreviatedRelativeLocationPath
    #relativePath(steps: Step[]): void {
        for (;;) {
            steps.push(this.#step());
            if (this.#accept('/')) continue;
            if (this.#accept('//')) {
                steps.push(DESCENDANT_OR_SELF_NODE);
                continue;
            }
            return;
        }
    }

    // [4] Step, [12] AbbreviatedStep
    #step(): Step {
        if (this.#accept('.')) return { axis: 'self', test: { kind: 'node' }, predicates: [] };
        if (this.#accept('..')) return { axis: 'parent', test: { kind: 'node' }, predicates: [] };
        let axis: Axis = 'child';
        if (this.#accept('@')) {
            axis = 'attribute';
        } else if (this.#peek().kind === 'axis') {
            // Q-AXIS: an unknown axis name is not a syntax error upstream; the step selects nothing.
            axis = AXES.get(this.#peek().value) ?? 'unknown';
            this.#pos++;
            this.#expect('::');
        }
        const test = this.#nodeTest();
        return { axis, test, predicates: this.#predicates() };
    }

    // [7] NodeTest
    #nodeTest(): NodeTest {
        const token = this.#peek();
        this.#pos++;
        switch (token.kind) {
            case 'star':
                return { kind: 'any' };
            case 'prefix-star':
                return { kind: 'prefixAny', prefix: token.value };
            case 'qname': {
                const colon = token.value.indexOf(':');
                return colon === -1
                    ? { kind: 'name', prefix: null, localName: token.value, name: token.value }
                    : {
                          kind: 'name',
                          prefix: token.value.slice(0, colon),
                          localName: token.value.slice(colon + 1),
                          name: token.value
                      };
            }
            case 'node-type':
                this.#expect('(');
                this.#expect(')');
                if (token.value === 'text') return { kind: 'text' };
                if (token.value === 'comment') return { kind: 'comment' };
                if (token.value === 'node') return { kind: 'node' };
                return { kind: 'pi' };
            case 'pi-literal': {
                this.#expect('(');
                const target = this.#expect('literal').value;
                this.#expect(')');
                return { kind: 'piTarget', target };
            }
            default:
                throw new XPathSyntaxError();
        }
    }

    // [8] Predicate
    #predicates(): Expr[] {
        const predicates: Expr[] = [];
        while (this.#accept('[')) {
            predicates.push(this.#nested((): Expr => this.#expr()));
            this.#expect(']');
        }
        return predicates;
    }
}

export function parseXPath(source: string, limits: ParseLimits = DEFAULT_PARSE_LIMITS): Expr {
    if (source.length > limits.maxLength)
        throw new XPathLimitError(`XPath expression is longer than ${limits.maxLength} characters`);
    return new Parser(tokenize(source), limits.maxDepth).parse();
}
