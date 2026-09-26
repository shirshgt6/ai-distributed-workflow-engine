/**
 * SAFE CALCULATOR: a tiny recursive-descent parser for arithmetic.
 *
 * NEVER eval() / new Function() model output: "2+2" today, "process.exit()"
 * or "require('child_process')" tomorrow. This parser only understands:
 *   numbers, + - * / % ^, parentheses, unary minus
 * Anything else (letters, brackets, quotes...) is a syntax error.
 *
 * Grammar (precedence low -> high):
 *   expr   := term (("+" | "-") term)*
 *   term   := factor (("*" | "/" | "%") factor)*
 *   factor := unary ("^" factor)?          (right-associative power)
 *   unary  := "-" unary | primary
 *   primary:= number | "(" expr ")"
 */
export function evaluateArithmetic(input) {
  const src = String(input);
  if (src.length > 200) throw new Error("expression too long (max 200 chars)");
  if (!/^[\d\s.+\-*/%^()]+$/.test(src)) throw new Error("only numbers and + - * / % ^ ( ) are allowed");

  let pos = 0;
  const peek = () => src[pos];
  const skip = () => {
    while (src[pos] === " ") pos++;
  };

  function number() {
    skip();
    const m = /^\d+(\.\d+)?/.exec(src.slice(pos));
    if (!m) throw new Error(`expected a number at position ${pos}`);
    pos += m[0].length;
    return Number(m[0]);
  }
  function primary() {
    skip();
    if (peek() === "(") {
      pos++;
      const v = expr();
      skip();
      if (peek() !== ")") throw new Error("missing closing parenthesis");
      pos++;
      return v;
    }
    return number();
  }
  function unary() {
    skip();
    if (peek() === "-") {
      pos++;
      return -unary();
    }
    return primary();
  }
  function factor() {
    const base = unary();
    skip();
    if (peek() === "^") {
      pos++;
      const exp = factor();
      if (Math.abs(exp) > 100) throw new Error("exponent too large");
      return base ** exp;
    }
    return base;
  }
  function term() {
    let v = factor();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "*" && op !== "/" && op !== "%") return v;
      pos++;
      const r = factor();
      if ((op === "/" || op === "%") && r === 0) throw new Error("division by zero");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "+" && op !== "-") return v;
      pos++;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
  }

  const value = expr();
  skip();
  if (pos !== src.length) throw new Error(`unexpected "${src[pos]}" at position ${pos}`);
  if (!Number.isFinite(value)) throw new Error("result is not a finite number");
  return Number(value.toPrecision(15));
}
