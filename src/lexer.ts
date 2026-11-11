// Lexer. W3C XPath 1.0 section 3.7 (lexical structure), with the deviations upstream has, kept on purpose and
// marked Q-LEX-n (the upstream quirks it mirrors). One pass, O(expression length).

import { XPathSyntaxError } from './errors.ts';

export type TokenKind =
    | '('
    | ')'
    | '['
    | ']'
    | '@'
    | ','
    | '|'
    | '+'
    | '-'
    | '='
    | '!='
    | '<'
    | '<='
    | '>'
    | '>='
    | '$'
    | '.'
    | '..'
    | '::'
    | '/'
    | '//'
    | 'and'
    | 'or'
    | 'mod'
    | 'div'
    | 'multiply'
    | 'star'
    | 'literal'
    | 'number'
    | 'prefix-star'
    | 'qname'
    | 'function'
    | 'axis'
    | 'node-type'
    | 'pi-literal'
    | 'eof';

export interface Token {
    readonly kind: TokenKind;
    readonly value: string;
}

// Tokens after which `*` is a name test and `and`/`or`/`mod`/`div` are names (XPath 1.0 section 3.7, first rule).
// Q-LEX-1: upstream's list has no ',' and no '$', so `f(1, *)` and `$div` do not parse there. Kept.
const OPERAND_EXPECTED_AFTER: ReadonlySet<TokenKind> = new Set<TokenKind>([
    '@',
    '::',
    '(',
    '[',
    'and',
    'or',
    'mod',
    'div',
    'multiply',
    '/',
    '//',
    '|',
    '+',
    '-',
    '=',
    '!=',
    '<',
    '<=',
    '>',
    '>='
]);

const NAME_START = /[\p{L}_]/u;
const NAME_CHAR = /[\p{L}\p{N}\p{M}._\-·]/u;

function isNameStart(code: number, ch: string): boolean {
    if (code < 128) return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95;
    return NAME_START.test(ch);
}

function isNameChar(code: number, ch: string): boolean {
    if (code < 128) {
        return (
            (code >= 97 && code <= 122) ||
            (code >= 65 && code <= 90) ||
            (code >= 48 && code <= 57) ||
            code === 95 ||
            code === 45 ||
            code === 46
        );
    }
    return NAME_CHAR.test(ch);
}

function isDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}

export function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    const n = source.length;
    let pos = 0;
    let previous: TokenKind | null = null;
    const push = (kind: TokenKind, value: string): void => {
        tokens.push({ kind, value });
        previous = kind;
    };
    const nameEnd = (from: number): number => {
        let end = from;
        while (end < n && isNameChar(source.charCodeAt(end), source.charAt(end))) end++;
        return end;
    };

    while (pos < n) {
        const code = source.charCodeAt(pos);
        const ch = source.charAt(pos);
        if (code === 32 || code === 9 || code === 13 || code === 10) {
            pos++;
            continue;
        }
        // Q-LEX-2: a NUL outside a string literal ends the expression in upstream (it uses NUL as its end marker).
        if (code === 0) break;
        switch (ch) {
            case '(':
            case ')':
            case '[':
            case ']':
            case '@':
            case ',':
            case '|':
            case '+':
            case '-':
            case '=':
            case '$':
                push(ch, ch);
                pos++;
                continue;
            case '.': {
                const next = source.charCodeAt(pos + 1);
                if (next === 46) {
                    push('..', '..');
                    pos += 2;
                } else if (isDigit(next)) {
                    let end = pos + 2;
                    while (isDigit(source.charCodeAt(end))) end++;
                    push('number', source.slice(pos, end));
                    pos = end;
                } else {
                    push('.', '.');
                    pos++;
                }
                continue;
            }
            case "'":
            case '"': {
                const close = source.indexOf(ch, pos + 1);
                if (close === -1) throw new XPathSyntaxError(`Unterminated string literal: ${source.slice(pos)}`);
                push('literal', source.slice(pos + 1, close));
                pos = close + 1;
                continue;
            }
            case '*':
                // `previous` is null only before the first token.
                if (previous !== null && !OPERAND_EXPECTED_AFTER.has(previous)) push('multiply', ch);
                else push('star', ch);
                pos++;
                continue;
            case ':':
                if (source.charAt(pos + 1) === ':') {
                    push('::', '::');
                    pos += 2;
                    continue;
                }
                throw new XPathSyntaxError(`Unexpected character ${ch}`);
            case '/':
                if (source.charAt(pos + 1) === '/') {
                    push('//', '//');
                    pos += 2;
                } else {
                    push('/', '/');
                    pos++;
                }
                continue;
            case '!':
                if (source.charAt(pos + 1) === '=') {
                    push('!=', '!=');
                    pos += 2;
                    continue;
                }
                throw new XPathSyntaxError(`Unexpected character ${ch}`);
            case '<':
            case '>':
                if (source.charAt(pos + 1) === '=') {
                    push(ch === '<' ? '<=' : '>=', `${ch}=`);
                    pos += 2;
                } else {
                    push(ch, ch);
                    pos++;
                }
                continue;
            default:
                break;
        }
        if (isDigit(code)) {
            let end = pos + 1;
            while (isDigit(source.charCodeAt(end))) end++;
            // Q-LEX-3: `1.` is not a Number in upstream (the grammar says it is); the dot is lexed on its own.
            if (source.charCodeAt(end) === 46 && isDigit(source.charCodeAt(end + 1))) {
                end += 2;
                while (isDigit(source.charCodeAt(end))) end++;
            }
            push('number', source.slice(pos, end));
            pos = end;
            continue;
        }
        if (isNameStart(code, ch)) {
            let end = nameEnd(pos + 1);
            let name = source.slice(pos, end);
            if (
                previous !== null &&
                !OPERAND_EXPECTED_AFTER.has(previous) &&
                (name === 'and' || name === 'or' || name === 'mod' || name === 'div')
            ) {
                push(name, name);
                pos = end;
                continue;
            }
            if (source.charAt(end) === ':') {
                const after = source.charAt(end + 1);
                if (after === '*') {
                    push('prefix-star', name);
                    pos = end + 2;
                    continue;
                }
                if (after !== '' && isNameStart(source.charCodeAt(end + 1), after)) {
                    end = nameEnd(end + 2);
                    name = source.slice(pos, end);
                    // Q-LEX-4: no white space is skipped between a name and `(` or `::` (the grammar allows it).
                    push(source.charAt(end) === '(' ? 'function' : 'qname', name);
                    pos = end;
                    continue;
                }
                if (after === ':') {
                    push('axis', name);
                    pos = end;
                    continue;
                }
            }
            if (source.charAt(end) === '(') {
                if (name === 'comment' || name === 'text' || name === 'node') push('node-type', name);
                else if (name === 'processing-instruction')
                    push(source.charAt(end + 1) === ')' ? 'node-type' : 'pi-literal', name);
                else push('function', name);
            } else {
                push('qname', name);
            }
            pos = end;
            continue;
        }
        throw new XPathSyntaxError(`Unexpected character ${ch}`);
    }
    tokens.push({ kind: 'eof', value: '[EOF]' });
    return tokens;
}
