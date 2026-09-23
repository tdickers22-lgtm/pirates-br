/**
 * PIRATE NAMES (b1.2f, online-15). Shared so the server enforces it and the
 * menu can pre-validate with the exact same rules.
 *
 * Strangers read each other's names in every killfeed, scoreboard and share
 * card, so a name is cleaned and checked before anyone else sees it:
 *   1. NFKC (full-width, ligatures and styled maths letters fold to plain text),
 *   2. strip every Cc/Cf/Zl/Zp code point (bidi overrides, zero-width joiners,
 *      BOM, soft hyphen) and symbols (emoji, box drawing); more than two
 *      combining marks on one letter (zalgo) are dropped,
 *   3. collapse whitespace, 2-20 VISIBLE characters (grapheme clusters, so
 *      'José' written with a combining accent is 4, not 5), at least two
 *      letters or digits,
 *   4. a blocklist on a folded form (lowercase, accents off, leetspeak mapped,
 *      separators removed) with an allowlist for the Scunthorpe cases.
 * `dedupeName` gives the second 'Pirate4821' in one match ' (2)'.
 *
 * Consumers: LobbyServer.handleSetName (server), Match.createCrew (in-match
 * dedupe), scripts/test-names.mjs; the menu pre-validation is a b1.5 hook.
 */

export const NAME_MIN = 2;
export const NAME_MAX = 20;

/** The anonymous device id the menu keeps in localStorage and sends with
 *  set_name. 128 random bits in url-safe base64 or hex; the server only ever
 *  stores its sha256. */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export function isDeviceId(x: unknown): x is string {
  return typeof x === 'string' && DEVICE_ID_RE.test(x);
}

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'short' | 'blocked'; name: string };

type SegmenterLike = { segment(s: string): Iterable<{ segment: string }> };
let segmenter: SegmenterLike | null | undefined;
function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => SegmenterLike }).Segmenter;
    segmenter = Seg ? new Seg(undefined, { granularity: 'grapheme' }) : null;
  }
  if (!segmenter) return Array.from(s);
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

export function visibleLength(s: string): number {
  return graphemes(s).length;
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/gu;
const SYMBOL = /\p{S}/gu;
const ZALGO = /(\p{M}{2})\p{M}+/gu;
const SPACES = /[\s\p{Zs}\u3164\u115F\u1160\uFFA0]+/gu; // + Hangul fillers (blank-looking letters)
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

/** Normalisation only: what the name looks like after cleaning, before the
 *  length and blocklist checks. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, 512).normalize('NFKC');
  s = s.replace(INVISIBLE, '').replace(SYMBOL, '').replace(ZALGO, '$1');
  s = s.replace(SPACES, ' ').trim();
  const g = graphemes(s);
  if (g.length > NAME_MAX) s = g.slice(0, NAME_MAX).join('').trim();
  return s;
}

export function checkName(raw: unknown): NameCheck {
  const name = cleanName(raw);
  if (!name) return { ok: false, reason: 'empty', name };
  if (visibleLength(name) < NAME_MIN || (name.match(LETTER_OR_DIGIT)?.length ?? 0) < NAME_MIN) {
    return { ok: false, reason: 'short', name };
  }
  if (isBlockedName(name)) return { ok: false, reason: 'blocked', name };
  return { ok: true, name };
}

// ── the blocklist ────────────────────────────────────────────────────────────
// Stored rot13 so the source does not read as a list of slurs; decoded once.
const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
/** Matched anywhere in the separator-stripped name ('xXn1gg3rXx', 'f u c k'). */
const SUBSTRING = [
  'avttre', 'avttn', 'snttbg', 'ergneq', 'genaal', 'jrgonpx', 'gbjryurnq', 'enturnq', 'ornare',
  'phag', 'shpx', 'fuvg', 'nffubyr', 'ovgpu', 'juber', 'cbea', 'uvgyre', 'crqbcuvyr', 'zbyrfgre',
  'fyhg', 'wvtnobb',
].map(rot13);
/** Matched only as a whole word, or as the whole name ('Big D i c k'). */
const TOKEN = [
  'snt', 'fcvp', 'xvxr', 'pbba', 'tbbx', 'qlxr', 'cnxv', 'puvax', 'encr', 'encvfg', 'anmv', 'xxx',
  'nff', 'qvpx', 'pbpx', 'chffl', 'cravf', 'ihyin', 'phz', 'gjng', 'jnax', 'jnaxre', 'gvgf',
].map(rot13);
/** Innocent words that contain a blocked substring, removed before the
 *  substring pass (the Scunthorpe problem). */
const ALLOW = [
  'scunthorpe', 'shiitake', 'shitake', 'retardant', 'retardation', 'penistone', 'cockburn', 'hitchcock',
  'slutsk', 'cassandra', 'assassin', 'bassinet', 'classic', 'grasshopper', 'lightwater',
];

const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't', '€': 'e', '£': 'l',
};
const MARKS = /\p{M}/gu;

function fold(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFKD').replace(MARKS, '').toLowerCase()) out += LEET[ch] ?? ch;
  return out;
}

// 'n+i+g+g+e+r+': stretched letters still match, but 'Niger' (one g) does not.
const stretch = (w: string) => new RegExp(Array.from(w, (c) => `${c}+`).join(''));
const SUBSTRING_RE = SUBSTRING.map(stretch);
const TOKEN_RE = TOKEN.map((w) => new RegExp(`^${Array.from(w, (c) => `${c}+`).join('')}$`));

export function isBlockedName(name: string): boolean {
  const folded = fold(name);
  const tokens = folded.split(/[^\p{L}]+/u).filter(Boolean);
  // Substrings are searched per word, and across words only when the name is
  // spelled out in fragments ('f u c k', 'n.i.g.g.e.r'): joining 'Bass Hitter'
  // would invent a word nobody typed.
  const whole = tokens.join('');
  const hay = tokens.some((t) => t.length <= 2) ? [...tokens, whole] : tokens;
  for (let t of hay) {
    for (const ok of ALLOW) t = t.split(ok).join('');
    if (SUBSTRING_RE.some((re) => re.test(t))) return true;
  }
  return [...tokens, whole].some((t) => TOKEN_RE.some((re) => re.test(t)));
}

/** In-match dedupe: 'Pirate4821' twice becomes 'Pirate4821' and
 *  'Pirate4821 (2)'. Case-insensitive; the base is kept as typed. */
export function dedupeName(name: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${name} (${used.size + 1})`;
}
