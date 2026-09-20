/**
 * Minimal YAML reader for jev-dispatch config files.
 *
 * The spec for this plugin is written in YAML, so config.yaml is accepted, but
 * pulling in a YAML dependency would break the zero-dependency constraint we
 * inherited from otel-agent. This reader therefore covers a deliberately small
 * subset and throws on anything outside it, so a file that would be misread is
 * rejected instead of silently misinterpreted.
 *
 * Supported: nested block mappings (2+ space indent), block sequences of
 * scalars and of inline mappings, inline flow sequences, `key:` with an empty
 * value meaning an empty mapping, quoted and bare scalars, null/true/false,
 * numbers, `#` comments, and `---` document start.
 *
 * Not supported (throws): anchors, aliases, tags, multi-line scalars (| >),
 * flow mappings, multiple documents, tab indentation.
 */

const UNSUPPORTED = [
  // An anchor or alias in key OR value position. Requiring a word character
  // after the sigil keeps shell values such as `npm test && npm run lint` and
  // `rm -f *.tmp` from being mistaken for one.
  [/(^\s*|:\s+|^\s*-\s+)[&*][A-Za-z0-9_-]+(\s|$)/, 'anchors and aliases'],
  [/(^\s*|:\s+|^\s*-\s+)!!?[A-Za-z]/, 'tags'],
  [/:\s*[|>][-+0-9]*\s*$/, 'block scalars (| and >)'],
];

function fail(lineNo, message) {
  throw new Error(`config YAML: line ${lineNo}: ${message}`);
}

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === '') return null;
  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;

  const quote = text[0];
  if (quote === '"' || quote === "'") {
    if (text.length < 2 || text[text.length - 1] !== quote) fail(lineNo, 'unterminated quoted scalar');
    const body = text.slice(1, -1);
    if (quote === "'") return body.replace(/''/g, "'");
    return body.replace(/\\(["\\/nrtb])/g, (_, c) =>
      ({ n: '\n', r: '\r', t: '\t', b: '\b', '"': '"', '\\': '\\', '/': '/' }[c]));
  }

  if (text[0] === '[') {
    if (text[text.length - 1] !== ']') fail(lineNo, 'unterminated flow sequence');
    return splitFlow(text.slice(1, -1), lineNo).map((part) => parseScalar(part, lineNo));
  }
  if (text[0] === '{') fail(lineNo, 'flow mappings are not supported; use a nested block mapping');

  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Split a flow-sequence body on commas that are not inside quotes or brackets. */
function splitFlow(body, lineNo) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (quote) fail(lineNo, 'unterminated quoted scalar in flow sequence');
  if (depth !== 0) fail(lineNo, 'unbalanced brackets in flow sequence');
  if (current.trim() !== '' || parts.length > 0) parts.push(current);
  return parts.filter((part) => part.trim() !== '');
}

/** Strip a trailing `# comment`, respecting quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function tokenize(source) {
  const lines = [];
  source.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNo = index + 1;
    if (rawLine.includes('\t') && /^\s*\t/.test(rawLine)) fail(lineNo, 'tab indentation is not supported');
    const line = stripComment(rawLine);
    if (line.trim() === '') return;
    if (line.trim() === '---') return;
    if (line.trim() === '...') return;
    for (const [pattern, what] of UNSUPPORTED) {
      if (pattern.test(line)) fail(lineNo, `${what} are not supported`);
    }
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim(), lineNo });
  });
  return lines;
}

/** Parse a `key: value` head, returning [key, rest] or null when not a mapping entry. */
function splitKey(text, lineNo) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return [parseScalar(text.slice(0, i), lineNo), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseBlock(lines, start, indent) {
  const first = lines[start];
  if (first.text.startsWith('- ') || first.text === '-') {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

function parseMapping(lines, start, indent) {
  const result = {};
  let i = start;
  while (i < lines.length && lines[i].indent >= indent) {
    const line = lines[i];
    if (line.indent > indent) fail(line.lineNo, 'unexpected indentation');
    const entry = splitKey(line.text, line.lineNo);
    if (!entry) fail(line.lineNo, `expected "key: value", got ${JSON.stringify(line.text)}`);
    const [key, rest] = entry;
    if (typeof key !== 'string' || key === '') fail(line.lineNo, 'mapping keys must be non-empty strings');

    if (rest !== '') {
      result[key] = parseScalar(rest, line.lineNo);
      i += 1;
      continue;
    }
    const next = lines[i + 1];
    if (!next || (next.indent <= indent && !next.text.startsWith('-'))) {
      result[key] = {};
      i += 1;
      continue;
    }
    // A sequence may sit at the same indent as its key, a mapping may not.
    const childIndent = next.text.startsWith('-') && next.indent === indent ? indent : next.indent;
    if (childIndent < indent || (childIndent === indent && !next.text.startsWith('-'))) {
      result[key] = {};
      i += 1;
      continue;
    }
    const [value, consumedTo] = parseBlock(lines, i + 1, childIndent);
    result[key] = value;
    i = consumedTo;
  }
  return [result, i];
}

function parseSequence(lines, start, indent) {
  const result = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- '))) {
    const line = lines[i];
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') {
      const next = lines[i + 1];
      if (!next || next.indent <= indent) { result.push(null); i += 1; continue; }
      const [value, consumedTo] = parseBlock(lines, i + 1, next.indent);
      result.push(value);
      i = consumedTo;
      continue;
    }
    const entry = splitKey(rest, line.lineNo);
    if (entry) {
      // `- key: value` starts an inline mapping whose siblings are indented to `key`.
      const itemIndent = indent + 2;
      const synthetic = [{ indent: itemIndent, text: rest, lineNo: line.lineNo }];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= itemIndent && !(lines[j].indent === indent && lines[j].text.startsWith('-'))) {
        synthetic.push(lines[j]);
        j += 1;
      }
      const [value] = parseMapping(synthetic, 0, itemIndent);
      result.push(value);
      i = j;
      continue;
    }
    result.push(parseScalar(rest, line.lineNo));
    i += 1;
  }
  return [result, i];
}

/** Parse a YAML document from the supported subset. Throws on unsupported syntax. */
export function parseYaml(source) {
  const lines = tokenize(source);
  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return value;
}
