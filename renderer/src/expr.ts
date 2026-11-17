// Safe evaluator for the formulas the model writes ("3x^2 - 2x + 1", "sin(x)/x", "x^2 + y^2 = 9").
// Parsed once into closures; never uses eval. Accepts the usual handwriting: implicit multiplication,
// ^ or ** for powers, unicode × · − π √ ², and "y = ..." / "f(x) = ..." prefixes.

export type Vars = Record<string, number>;
export type Compiled = (vars: Vars) => number;

const FUNCS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  cot: (x) => 1 / Math.tan(x),
  exp: Math.exp,
  ln: Math.log,
  log: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  hypot: Math.hypot,
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function normalize(src: string): string {
  return src
    .replace(/\*\*/g, '^')
    .replace(/[×·⋅∙]/g, '*')
    .replace(/[−–]/g, '-')
    .replace(/÷/g, '/')
    .replace(/π/g, ' pi ')
    .replace(/√/g, ' sqrt ')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3');
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\S))/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
    else if (m[3] !== undefined) {
      if (!'+-*/^(),!|'.includes(m[3])) throw new Error(`unexpected "${m[3]}"`);
      tokens.push({ t: 'op', v: m[3] });
    }
  }
  return tokens;
}

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  let r = 1;
  for (let i = 2; i <= n && r < Infinity; i++) r *= i;
  return r;
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[], private readonly vars: Set<string>) {}

  parse(): Compiled {
    const node = this.expr();
    if (this.i < this.tokens.length) throw new Error(`unexpected "${String(this.tokens[this.i].v)}"`);
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(v: string): boolean {
    const tok = this.peek();
    return tok?.t === 'op' && tok.v === v;
  }

  private expect(v: string): void {
    if (!this.isOp(v)) throw new Error(`expected "${v}"`);
    this.i++;
  }

  private expr(): Compiled {
    let left = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.i++] as { v: string }).v;
      const a = left;
      const b = this.term();
      left = op === '+' ? (s) => a(s) + b(s) : (s) => a(s) - b(s);
    }
    return left;
  }

  private startsAtom(): boolean {
    const tok = this.peek();
    return !!tok && (tok.t !== 'op' || tok.v === '(');
  }

  private term(): Compiled {
    let left = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = (this.tokens[this.i++] as { v: string }).v;
        const a = left;
        const b = this.unary();
        left = op === '*' ? (s) => a(s) * b(s) : (s) => a(s) / b(s);
      } else if (this.startsAtom()) {
        // Implicit multiplication: 2x, 3sin(x), (x+1)(x-1), x y
        const a = left;
        const b = this.power();
        left = (s) => a(s) * b(s);
      } else {
        return left;
      }
    }
  }

  private unary(): Compiled {
    if (this.isOp('-')) {
      this.i++;
      const a = this.unary();
      return (s) => -a(s);
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): Compiled {
    const base = this.postfix();
    if (!this.isOp('^')) return base;
    this.i++;
    const exp = this.unary(); // right-associative; allows 2^-x
    return (s) => Math.pow(base(s), exp(s));
  }

  private postfix(): Compiled {
    let a = this.atom();
    while (this.isOp('!')) {
      this.i++;
      const inner = a;
      a = (s) => factorial(inner(s));
    }
    return a;
  }

  private atom(): Compiled {
    const tok = this.tokens[this.i++];
    if (!tok) throw new Error('formula ends too early');
    if (tok.t === 'num') {
      const v = tok.v;
      return () => v;
    }
    if (tok.t === 'op') {
      if (tok.v === '(') {
        const inner = this.expr();
        this.expect(')');
        return inner;
      }
      if (tok.v === '|') {
        const inner = this.expr();
        this.expect('|');
        return (s) => Math.abs(inner(s));
      }
      throw new Error(`unexpected "${tok.v}"`);
    }
    return this.identifier(tok.v);
  }

  private identifier(name: string): Compiled {
    const lower = name.toLowerCase();
    if (this.vars.has(name)) return (s) => s[name];
    if (lower in FUNCS) return this.call(FUNCS[lower]);
    if (lower in CONSTS) {
      const v = CONSTS[lower];
      return () => v;
    }
    // "xy", "2pix", "sinx": split into known names, longest match first.
    const parts = this.split(name);
    if (!parts) throw new Error(`unknown name "${name}"`);
    const factors: Compiled[] = [];
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k];
      const fn = FUNCS[part.toLowerCase()];
      if (fn) {
        // Function glued to its argument: the rest of the identifier (and anything after) is the argument.
        const rest = parts.slice(k + 1);
        if (!rest.length) {
          factors.push(this.call(fn));
        } else {
          const arg = this.product(rest);
          factors.push((s) => fn(arg(s)));
        }
        break;
      }
      factors.push(this.product([part]));
    }
    return factors.reduce((a, b) => (s) => a(s) * b(s));
  }

  private product(names: string[]): Compiled {
    const parts = names.map((n): Compiled => {
      if (this.vars.has(n)) return (s) => s[n];
      const v = CONSTS[n.toLowerCase()];
      return () => v;
    });
    return parts.reduce((a, b) => (s) => a(s) * b(s));
  }

  private split(name: string): string[] | null {
    const known = [...this.vars, ...Object.keys(CONSTS), ...Object.keys(FUNCS)].sort((a, b) => b.length - a.length);
    const out: string[] = [];
    let rest = name;
    while (rest) {
      const hit = known.find((k) => rest.toLowerCase().startsWith(k.toLowerCase()) && (this.vars.has(k) ? rest.startsWith(k) : true));
      if (!hit) return null;
      out.push(rest.slice(0, hit.length));
      rest = rest.slice(hit.length);
    }
    return out;
  }

  private call(fn: (...args: number[]) => number): Compiled {
    if (this.isOp('(')) {
      this.i++;
      const args: Compiled[] = [this.expr()];
      while (this.isOp(',')) {
        this.i++;
        args.push(this.expr());
      }
      this.expect(')');
      if (args.length === 1) {
        const a = args[0];
        return (s) => fn(a(s));
      }
      return (s) => fn(...args.map((a) => a(s)));
    }
    // sin x, sin 2x: applies to the next factor, so "sin x^2" is sin(x^2).
    const arg = this.power();
    return (s) => fn(arg(s));
  }
}

const cache = new Map<string, Compiled>();

/** Compile a formula in the given variables. Throws Error with a short reason if it can't be read. */
export function compile(src: string, vars: string[] = ['x']): Compiled {
  const key = `${vars.join(',')}|${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let text = normalize(String(src ?? ''));
  // "y = x^2", "f(x) = x^2", "z = sin(x)": keep the right-hand side.
  const eq = text.indexOf('=');
  if (eq !== -1 && /^\s*[A-Za-z]\w*\s*(\([^)]*\))?\s*$/.test(text.slice(0, eq))) text = text.slice(eq + 1);
  if (text.includes('=')) throw new Error('use compileEquation for equations');
  if (!text.trim()) throw new Error('empty formula');
  const fn = new Parser(tokenize(text), new Set(vars)).parse();
  cache.set(key, fn);
  return fn;
}

/** "x^2 + y^2 = 9" -> f(x, y) = lhs - rhs, whose zero set is the curve. A bare expression means "= 0". */
export function compileEquation(src: string, vars: string[] = ['x', 'y']): Compiled {
  const text = normalize(String(src ?? ''));
  const sides = text.split('=');
  if (sides.length > 2) throw new Error('more than one "="');
  const lhs = compile(sides[0], vars);
  if (sides.length === 1) return lhs;
  const rhs = compile(sides[1], vars);
  return (s) => lhs(s) - rhs(s);
}
