// mend: one patch tool for every AI edit format (SPEC.md v1).
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), applies it to a tree of text files, all or nothing.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under its own line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A line at a matching tier: 0 exact, 1 trailing whitespace ignored, 2 both ends ignored. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Every position where O matches the file's lines at the tier, occurrences may overlap. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(file[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at least once, with its positions; strict tries tier 0 only. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier += 1) {
    const pos = occurrences(file, o, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/**
 * The replacement lines for a matched block: context lines are the file's own
 * matched lines, never the patch's; at tier 2 every other line is re-indented
 * from O's leading whitespace to the file's.
 * `n` holds {text, ctx} per line, `oCtxAt` maps each context line of N to its
 * index inside O, so the file's line at that spot can be used.
 */
function buildReplacement(n: { text: string; ctx: boolean }[], oCtxAt: number[], file: string[], at: number, tier: number, oFirst: string): string[] {
  const out: string[] = [];
  const f = leadingWs(file[at] ?? '');
  const p = leadingWs(oFirst);
  for (let i = 0; i < n.length; i += 1) {
    const e = n[i]!;
    if (e.ctx) {
      out.push(file[at + oCtxAt[i]!]!);
      continue;
    }
    if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) {
      out.push(f + e.text.slice(p.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/** The index inside O of each context line of N, in N's order. */
function contextMap(oKinds: string[], nKinds: string[]): number[] {
  const oCtx: number[] = [];
  oKinds.forEach((k, i) => {
    if (k === 'ctx') oCtx.push(i);
  });
  const map: number[] = [];
  let c = 0;
  nKinds.forEach((k) => {
    if (k === 'ctx') {
      map.push(oCtx[c]!);
      c += 1;
    } else {
      map.push(-1);
    }
  });
  return map;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };
interface Hunk {
  a: number;
  body: BodyLine[];
  lineNo: number;
}
interface Section {
  startLine: number;
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameOld: string | null;
  renameNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` header line, null for /dev/null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function bsAfterLastCtxOrNew(h: Hunk): boolean {
  for (let i = h.body.length - 1; i >= 0; i -= 1) {
    const b = h.body[i]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      return i + 1 < h.body.length && h.body[i + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Apply one hunk to a file; `d` is the running line-count delta of earlier hunks. */
function applyHunk(f: FileLines, h: Hunk, d: number, strict: boolean, path: string): FileLines {
  const oEntries: { text: string; kind: 'ctx' | 'old' }[] = [];
  const nEntries: { text: string; kind: 'ctx' | 'new' }[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      oEntries.push({ text: b.text, kind: 'ctx' });
      nEntries.push({ text: b.text, kind: 'ctx' });
    } else if (b.kind === 'old') {
      oEntries.push({ text: b.text, kind: 'old' });
    } else if (b.kind === 'new') {
      nEntries.push({ text: b.text, kind: 'new' });
    }
  }
  const oLines = oEntries.map((e) => e.text);
  if (oLines.length === 0) {
    const at = Math.min(h.a + d, f.lines.length);
    const lines = [...f.lines.slice(0, at), ...nEntries.map((e) => e.text), ...f.lines.slice(at)];
    let final = f.final;
    if (at === f.lines.length) final = !bsAfterLastCtxOrNew(h);
    return { lines, br: f.br, final };
  }
  const found = findTier(f.lines, oLines, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.pos[0]!;
  let best = Math.abs(at - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      at = p;
      best = dist;
    }
  }
  const cmap = contextMap(
    oEntries.map((e) => e.kind),
    nEntries.map((e) => e.kind),
  );
  const repl = buildReplacement(
    nEntries.map((e) => ({ text: e.text, ctx: e.kind === 'ctx' })),
    cmap,
    f.lines,
    at,
    found.tier,
    oLines[0]!,
  );
  const lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oLines.length)];
  let final = f.final;
  if (at + oLines.length === f.lines.length) final = !bsAfterLastCtxOrNew(h);
  return { lines, br: f.br, final };
}

/** One section's edit: creation, deletion, move or change of one path. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameOld ?? sec.gitOld ?? undefined;
  const newP = sec.newPath !== undefined ? sec.newPath : sec.renameNew ?? sec.gitNew ?? undefined;
  const isCreate = sec.creation || sec.oldPath === null;
  const isDelete = !isCreate && (sec.deletion || sec.newPath === null);
  return (tree) => {
    for (const p of [oldP, newP]) {
      if (typeof p === 'string' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate) {
      const np = newP as string;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') plus.push(b.text);
        }
      }
      let endsBreak = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = sec.hunks[hi]!;
        if (h.body.some((b) => b.kind === 'new')) {
          endsBreak = !bsAfterLastCtxOrNew(h);
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (endsBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const op = oldP as string;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP as string;
    const np = newP as string;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const isMove = op !== np;
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    let f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const oLen = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'old').length;
      const nLen = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'new').length;
      f = applyHunk(f, h, d, strict, op);
      d += nLen - oLen;
    }
    const content = joinFile(f);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, content);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, content);
    }
  };
}

/** Parse the patch's unified sections into edits. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let section: Section | null = null;
  const startSection = (lineNo: number): void => {
    section = {
      startLine: lineNo,
      gitOld: null,
      gitNew: null,
      oldPath: undefined,
      newPath: undefined,
      renameOld: null,
      renameNew: null,
      creation: false,
      deletion: false,
      hunks: [],
    };
    sections.push(section);
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection(i + 1);
      section!.gitOld = m[1]!;
      section!.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section && section.hunks.length === 0 && section.oldPath === undefined && section.newPath === undefined) {
        section.oldPath = headerPath(l);
        section.newPath = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      startSection(i + 1);
      section!.oldPath = headerPath(l);
      section!.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!section) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [], lineNo: i + 1 };
      section.hunks.push(hunk);
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '' });
          i += 1;
        } else if (b.startsWith(' ')) {
          hunk.body.push({ kind: 'ctx', text: b.slice(1) });
          i += 1;
        } else if (b.startsWith('-')) {
          hunk.body.push({ kind: 'old', text: b.slice(1) });
          i += 1;
        } else if (b.startsWith('+')) {
          hunk.body.push({ kind: 'new', text: b.slice(1) });
          i += 1;
        } else if (b.startsWith('\\')) {
          hunk.body.push({ kind: 'bs', text: b });
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (section && section.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        section.newPath = headerPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        section.renameOld = l.slice('rename from '.length);
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        section.renameNew = l.slice('rename to '.length);
        i += 1;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        section.creation = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        section.deletion = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameOld ?? sec.gitOld ?? undefined;
    const newP = sec.newPath !== undefined ? sec.newPath : sec.renameNew ?? sec.gitNew ?? undefined;
    if (oldP === undefined || newP === undefined) {
      throw new Exit2(`error: parse ${sec.hunks.length > 0 ? sec.hunks[0]!.lineNo : sec.startLine}`);
    }
    edits.push(sectionEdit(sec, strict));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const repl = buildReplacement(
      newLines.map((t) => ({ text: t, ctx: false })),
      newLines.map(() => -1),
      f.lines,
      at,
      found.tier,
      oldLines[0]!,
    );
    const lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (eq < 0 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  endOfFile: boolean;
  body: BodyLine[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first tier at which O occurs at or after `from`, with those positions. */
function findTierFrom(file: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier += 1) {
    const pos = occurrences(file, o, tier).filter((p) => p >= from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTierFrom(f.lines, [ch.anchor], cursor, strict);
        if (!found) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const oEntries: { text: string; kind: 'ctx' | 'old' }[] = [];
      const nEntries: { text: string; kind: 'ctx' | 'new' }[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          oEntries.push({ text: b.text, kind: 'ctx' });
          nEntries.push({ text: b.text, kind: 'ctx' });
        } else if (b.kind === 'old') {
          oEntries.push({ text: b.text, kind: 'old' });
        } else if (b.kind === 'new') {
          nEntries.push({ text: b.text, kind: 'new' });
        }
      }
      const oLines = oEntries.map((e) => e.text);
      if (oLines.length === 0) {
        const at = ch.endOfFile ? f.lines.length : cursor;
        const nLines = nEntries.map((e) => e.text);
        f = { lines: [...f.lines.slice(0, at), ...nLines, ...f.lines.slice(at)], br: f.br, final: f.final };
        cursor = at + nLines.length;
        continue;
      }
      const found = findTierFrom(f.lines, oLines, cursor, strict);
      if (!found) throw new Fail('no-match', path);
      let at = found.pos[0]!;
      if (ch.endOfFile) {
        // Only an occurrence ending at the file's last line is eligible, so the
        // tier is the first with one of those, not the first with any occurrence.
        let endAt: number | undefined;
        let endTier = found.tier;
        for (let tier = 0; tier < (strict ? 1 : 3); tier += 1) {
          const ends = occurrences(f.lines, oLines, tier).filter((p) => p >= cursor && p + oLines.length === f.lines.length);
          if (ends.length > 0) {
            endAt = ends[0];
            endTier = tier;
            break;
          }
        }
        if (endAt === undefined) throw new Fail('no-match', path);
        at = endAt;
        const cmap = contextMap(
          oEntries.map((e) => e.kind),
          nEntries.map((e) => e.kind),
        );
        const repl = buildReplacement(
          nEntries.map((e) => ({ text: e.text, ctx: e.kind === 'ctx' })),
          cmap,
          f.lines,
          at,
          endTier,
          oLines[0]!,
        );
        f = { lines: [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oLines.length)], br: f.br, final: f.final };
        cursor = at + repl.length;
        continue;
      }
      const cmap = contextMap(
        oEntries.map((e) => e.kind),
        nEntries.map((e) => e.kind),
      );
      const repl = buildReplacement(
        nEntries.map((e) => ({ text: e.text, ctx: e.kind === 'ctx' })),
        cmap,
        f.lines,
        at,
        found.tier,
        oLines[0]!,
      );
      f = { lines: [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oLines.length)], br: f.br, final: f.final };
      cursor = at + repl.length;
    }
    const content = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, content);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, content);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b) || b.trim() === '*** End Patch') break;
        if (b.startsWith('+')) {
          fileLines.push(b.slice(1));
          i += 1;
        } else if (b === '') {
          fileLines.push('');
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      edits.push(v4aDeleteEdit(path));
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const path = l.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const endChunk = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b) || b.trim() === '*** End Patch') break;
        if (b.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (b.trim() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${i + 1}`);
          cur.endOfFile = true;
          endChunk();
          i += 1;
          continue;
        }
        if (b.startsWith('@@')) {
          endChunk();
          cur = { anchor: b.slice(2).trim() === '' ? null : b.slice(2).trim(), endOfFile: false, body: [] };
          i += 1;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (!cur) cur = { anchor: null, endOfFile: false, body: [] };
          if (b === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (b.startsWith(' ')) cur.body.push({ kind: 'ctx', text: b.slice(1) });
          else if (b.startsWith('-')) cur.body.push({ kind: 'old', text: b.slice(1) });
          else cur.body.push({ kind: 'new', text: b.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk();
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.body.length > 0) {
          const lastBody = tail.body[tail.body.length - 1]!;
          if (lastBody.kind === 'ctx' && lastBody.text === '') tail.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4) and the run (sections 1, 2, 10)*/
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const seenR = new Set<string>();
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const key = `${oldP}\0${newP}`;
    if (seenR.has(key)) continue;
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      seenR.add(key);
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
