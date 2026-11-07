/**
 * Sanitising helpers for UNTRUSTED text (supplier titles/descriptions and
 * LLM output derived from them) before it reaches a prompt, a log line or a
 * public storefront.
 */

// C0/C1 control chars except tab/newline, bidi overrides/isolates, zero-width.
const UNSAFE_RANGES = [
  '\\u0000-\\u0008',
  '\\u000B\\u000C',
  '\\u000E-\\u001F',
  '\\u007F-\\u009F',
  '\\u200B-\\u200F',
  '\\u2028\\u2029',
  '\\u202A-\\u202E',
  '\\u2060-\\u2064',
  '\\u2066-\\u2069',
  '\\uFEFF',
];
const UNSAFE_CHARS = new RegExp(`[${UNSAFE_RANGES.join('')}]`, 'g');

export function stripUnsafeChars(input: string): string {
  return input.replace(UNSAFE_CHARS, '');
}

/** Single-line plain text, length-capped (e.g. product titles, tags). */
export function cleanLine(input: string, maxLen: number): string {
  // Bound the work first: the tag-strip regex is quadratic on `<<<<...`, so
  // a megabyte of hostile supplier text must not reach it.
  return stripUnsafeChars(input.slice(0, maxLen * 8))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'strong',
  'b',
  'em',
  'i',
  'h2',
  'h3',
  'h4',
  'span',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);

/**
 * Allow-list HTML sanitiser for product descriptions. Keeps a small set of
 * formatting tags with NO attributes; drops script/style/iframe content
 * entirely; escapes everything else. Deliberately strict: a storefront
 * description needs paragraphs and lists, not links or media.
 */
export function sanitizeHtml(input: string, maxLen = 20000): string {
  let html = stripUnsafeChars(input.slice(0, maxLen * 2));
  // Remove dangerous elements together with their content.
  html = html.replace(
    /<\s*(script|style|iframe|object|embed|svg|math|template|noscript|form)\b[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi,
    '',
  );
  // `|$`: an unclosed element/comment swallows the rest (as a browser would)
  // and keeps these regexes linear instead of quadratic on `<script <script`.
  html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  // The tag regex is quadratic on `x<x<x<...` when no `>` follows. Nothing
  // after the last `>` can be a tag, so split there and treat the tail as text.
  const lastGt = html.lastIndexOf('>');
  const tail = html.slice(lastGt + 1);
  html = html.slice(0, lastGt + 1);
  // Re-emit allowed tags without attributes; escape all other markup.
  html = html.replace(
    /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g,
    (_m, slash, name) => {
      const tag = String(name).toLowerCase();
      return ALLOWED_TAGS.has(tag) ? `<${slash}${tag}>` : '';
    },
  );
  html += tail;
  // Any remaining stray angle brackets are text, not markup.
  html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Restore the allowed tags we just emitted (they were escaped by the step above).
  html = html.replace(/&lt;(\/?)([a-z0-9]+)&gt;/g, (m, slash, name) =>
    ALLOWED_TAGS.has(name) ? `<${slash}${name}>` : m,
  );
  return html.slice(0, maxLen).trim();
}
