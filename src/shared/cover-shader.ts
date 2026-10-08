/**
 * Legacy custom covers: a deliberately small GLSL surface language from before recipes. Saved
 * covers keep rendering, and already-installed harnesses may still author one through
 * `project.setCoverShader`; new covers are recipes (cover-recipe.ts). The host owns the lens and GPU work.
 */
export type CoverShaderVersion = 1 | 2;
const FUNCTIONS = new Set(
  "vec2 vec3 vec4 abs min max clamp mix smoothstep step sin cos floor ceil fract mod pow sqrt exp log length distance dot normalize noise".split(
    " ",
  ),
);
/** The limits of a cover surface: its length, statements, nesting and function calls. */
const MAX_SURFACE_CHARS = 2400;
const MAX_STATEMENTS = 25;
const MAX_NESTING = 16;
const MAX_CALLS = 64;

/** The whole surface's shape: its size, its characters, and one statement per semicolon. */
function surfaceStatements(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SURFACE_CHARS)
    throw new Error("Cover surface must contain 1–2400 characters of GLSL.");
  if (!/^[\w\s.,+*/();=\-]+$/.test(value) || /\/\*|\/\/|\+\+|--/.test(value))
    throw new Error("Use only straight-line declarations and a final return; no comments, blocks or loops.");
  const statements = value.trim().split(";");
  if (statements.pop()?.trim() || statements.length > MAX_STATEMENTS)
    throw new Error("End each statement with a semicolon; use at most 24 declarations and a return.");
  return statements;
}

/** The nesting after one token: deeper after `(`, shallower after `)`, within bounds. */
function nestingAfter(token: string, depth: number): number {
  if (token === "(") {
    if (depth + 1 > MAX_NESTING) throw new Error("Cover expressions may nest at most 16 levels.");
    return depth + 1;
  }
  if (token === ")") {
    if (depth - 1 < 0) throw new Error("Unbalanced cover expression.");
    return depth - 1;
  }
  return depth;
}

/** Checks a name: a call of a supported function, or a known variable. Returns the calls so far. */
function checkName(token: string, called: boolean, variables: ReadonlySet<string>, calls: number): number {
  if (!called) {
    if (!variables.has(token))
      throw new Error(`Unknown cover variable: ${token}. Inputs are p (vec3), time and seed (float).`);
    return calls;
  }
  if (!FUNCTIONS.has(token) || calls + 1 > MAX_CALLS)
    throw new Error("Use at most 64 calls to supported GLSL math functions.");
  return calls + 1;
}

/** Checks one expression's tokens; returns how many function calls it made in all so far. */
function checkExpression(expression: string, variables: ReadonlySet<string>, callsBefore: number): number {
  const tokens = expression.match(/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z_]\w*|[^\s]/g) ?? [];
  let depth = 0;
  let calls = callsBefore;
  for (let j = 0; j < tokens.length; j++) {
    const token = tokens[j] ?? "";
    depth = nestingAfter(token, depth);
    if (token === "=") throw new Error("Assignments are allowed only in declarations.");
    const swizzle = tokens[j - 1] === "." && /^[xyzwrgba]{1,4}$/.test(token);
    if (/^[a-zA-Z_]/.test(token) && !swizzle) calls = checkName(token, tokens[j + 1] === "(", variables, calls);
  }
  if (depth) throw new Error("Unbalanced cover expression.");
  return calls;
}

/** No blocks, loops, functions, samplers, directives or writes to renderer-owned state. */
export function validateCoverSurface(value: unknown): asserts value is string {
  const statements = surfaceStatements(value);
  const variables = new Set(["p", "time", "seed"]);
  let calls = 0;
  statements.forEach((raw, i) => {
    const statement = raw.trim();
    const declaration = /^(?:float|vec[234])\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\s*=\s*(.+)$/s.exec(statement);
    const returned = /^return\s+(.+)$/s.exec(statement);
    const last = i === statements.length - 1;
    const expression = last ? returned?.[1] : declaration?.[2];
    if (expression === undefined)
      throw new Error("Use float/vec2/vec3/vec4 declarations followed by one final return of a vec3 color.");
    calls = checkExpression(expression, variables, calls);
    if (!declaration) return;
    const name = declaration[1];
    if (variables.has(name) || FUNCTIONS.has(name) || name.startsWith("gl_"))
      throw new Error(`Reserved or duplicate cover variable: ${name}.`);
    variables.add(name);
  });
}

export const COVER_VERTEX = `attribute vec2 position;
varying vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;

export function coverFragment(surface: string, version: CoverShaderVersion = 2): string {
  validateCoverSurface(surface);
  return `precision highp float;
varying vec2 uv;
uniform float u_time;
uniform float u_seed;
float hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
vec3 surfaceColor(vec3 p, float time, float seed) { ${surface} }
${
  version === 1
    ? `void main() {
  vec2 q = (uv * 2.0 - 1.0) * 1.015;
  float r = dot(q, q);
  if (r >= 1.0) { gl_FragColor = vec4(0.0); return; }
  vec3 n = vec3(q, sqrt(1.0-r));
  float a = u_time * 0.09;
  vec3 p = vec3(n.x*cos(a)+n.z*sin(a), n.y, -n.x*sin(a)+n.z*cos(a));
  vec3 color = clamp(surfaceColor(p, u_time, u_seed), 0.0, 1.0);
  float light = 0.34 + 0.66 * max(dot(n, normalize(vec3(-0.6,0.8,1.5))), 0.0);
  float shine = pow(max(dot(n, normalize(vec3(-0.5,0.7,2.8))), 0.0), 28.0) * 0.13;
  gl_FragColor = vec4(color * light + shine, 1.0-smoothstep(0.97,1.0,r));
}`
    : `void main() {
  vec2 q = uv * 2.0 - 1.0;
  vec3 p = vec3(q * (0.7 + 0.3 * dot(q, q)), 0.0);
  gl_FragColor = vec4(clamp(surfaceColor(p, u_time, u_seed), 0.0, 1.0), 1.0);
}`
}`;
}
