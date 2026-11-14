'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Project a C4-PlantUML source into an editable draw.io file, a first draft for a presentation.
 *
 * Working diagrams stay Mermaid and PlantUML; this copy exists so a person can arrange it by hand in
 * draw.io, with their own product icons on the elements. It is never the source of truth: the
 * `.puml` is, and `render-drawio.sh` refuses to overwrite a copy that was edited since it was written.
 *
 * Parsing is `c4-project.ts`'s own, so the two projectors refuse the same sources: an unrecognized
 * macro stops the projection naming macro, file and line, rather than dropping an element.
 *
 * The layout is a fixed grid, with no layout library: the same source and the same icons always give
 * byte-identical output, and every id derives from an element alias. The grid is a starting point,
 * not a drawing: a person moves things.
 *
 * Icons: DoFlow ships none and downloads none (logos are trademarks with mixed licences). They are
 * looked up by file name in a folder the caller names. A style value cannot hold `;`, so an icon is
 * written as `data:image/png,<base64>` with no `;base64` marker, which draw.io's loader re-inserts.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, Refused } = require('./c4-project.ts');
const { sha16 } = require('./scaffold/fingerprint.ts');

const MAX_ICON_BYTES = 256 * 1024;
const ICON_TYPES: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png' };

// Grid, in draw.io units. A slot is the cell an element owns; its shape sits inside it, and a shape
// with its label underneath (a person, an icon) gets a taller slot to leave room for the text.
const SLOT_W = 200;
const BOX_H = 100;
const LABELLED_H = 150;
const ICON_SIZE = 80;
const ACTOR_W = 50;
const GAP = 40;
const PAD = 30;
const HEADER = 30;
const ORIGIN = 40;
const MIN_BOUNDARY_W = 240;

const xmlAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const htmlText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Positional arguments after the alias and label, named in macro order; `$name=value` overrides by name. */
function fields(args: string[], names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  for (const a of args.slice(2)) {
    const named = /^\$([A-Za-z]+)=([\s\S]*)$/.exec(a);
    if (named) out[named[1]] = named[2];
    else { if (pos < names.length) out[names[pos]] = a; pos += 1; }
  }
  return out;
}

/** Person and System take (descr, sprite, tags); Container and Component put a technology first. */
const elementFields = (macro: string, args: string[]) =>
  fields(args, /^(Person|System)/.test(macro) ? ['descr', 'sprite', 'tags'] : ['techn', 'descr', 'sprite', 'tags']);

/**
 * File-name keys to look an icon up by, best first: the sprite, then each technology segment (split on
 * `,` and `/`) as a whole phrase and then word by word from the last, so `Apache Kafka` tries
 * `apachekafka` then `kafka`.
 */
function iconKeys(sprite: string | undefined, technology: string | undefined): string[] {
  const keys: string[] = [];
  const add = (s: string) => { const k = normalise(s); if (k && !keys.includes(k)) keys.push(k); };
  if (sprite) add(sprite);
  for (const segment of (technology || '').split(/[,/]/)) {
    add(segment);
    const words = segment.split(/\s+/).filter(Boolean);
    for (let i = words.length - 1; i >= 0; i -= 1) add(words[i]);
  }
  return keys;
}

const inside = (root: string, real: string): boolean => {
  const rel = path.relative(root, real);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Icon lookup over one folder. The folder, and each file in it after symlinks are followed, must sit
 * inside one of `roots` (the checkout): `--icons` is caller input and an icon is read into the output.
 * A missing folder is no icons, not an error.
 */
function makeIconResolver(dir: string, roots: string[]): { lookup: (keys: string[]) => { hit: any; skipped: any[] } } {
  let real: string;
  try { real = fs.realpathSync(dir); } catch { return { lookup: () => ({ hit: null, skipped: [] }) }; }
  const realRoots = roots.map((r: string) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
  if (!realRoots.some((r: string) => inside(r, real))) throw new Refused(`icons folder ${dir} resolves outside the checkout`);
  const names = new Map<string, string>();
  for (const name of fs.readdirSync(real).sort()) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  const lookup = (keys: string[]) => {
    const skipped: any[] = [];
    for (const key of keys) {
      for (const ext of ['svg', 'png']) {
        const file = names.get(`${key}.${ext}`);
        if (!file) continue;
        try {
          const target = fs.realpathSync(path.join(real, file));
          if (!realRoots.some((r: string) => inside(r, target))) { skipped.push({ file, why: 'outside the checkout' }); continue; }
          const stat = fs.statSync(target);
          if (!stat.isFile()) { skipped.push({ file, why: 'not a file' }); continue; }
          if (stat.size > MAX_ICON_BYTES) { skipped.push({ file, why: `larger than ${MAX_ICON_BYTES / 1024} KB` }); continue; }
          return { hit: { file, uri: `data:${ICON_TYPES[ext]},${fs.readFileSync(target).toString('base64')}` }, skipped };
        } catch { skipped.push({ file, why: 'unreadable' }); }
      }
    }
    return { hit: null, skipped };
  };
  return { lookup };
}

const FILL = { own: 'fillColor=#dae8fc;strokeColor=#6c8ebf;', external: 'fillColor=#e6e6e6;strokeColor=#666666;fontColor=#333333;' };

function project(text: string, opts: { sourcePath?: string; name?: string; icons?: any } = {}): { xml: string; counts: any; icons: any } {
  const sourcePath = opts.sourcePath || '<source>';
  const name = opts.name || 'C4';
  const parsed = parse(text, sourcePath);
  const icons: any = { used: [], missing: [], skipped: [] };

  const elementIds = new Map<string, string>();
  const boundaryIds = new Map<string, string>();
  const parentOf = new Map<string, string | null>();
  const elements = new Map<string, any>(parsed.elements.map((e: any) => [e.alias, e]));

  const layoutNode = (item: any, parent: string | null): any => {
    if (item.element) {
      const el = elements.get(item.element);
      const f = elementFields(el.macro, el.args);
      const kind = /^Person/.test(el.macro) ? 'person' : /Db(_Ext)?$/.test(el.macro) ? 'db' : /Queue(_Ext)?$/.test(el.macro) ? 'queue' : 'box';
      const keys = iconKeys(f.sprite, f.techn);
      let icon: any = null;
      if (opts.icons && keys.length) {
        const found = opts.icons.lookup(keys);
        for (const s of found.skipped) icons.skipped.push({ element: el.alias, ...s });
        icon = found.hit;
        if (icon) icons.used.push({ element: el.alias, file: icon.file });
        else icons.missing.push({ element: el.alias, keys });
      } else if (keys.length) icons.missing.push({ element: el.alias, keys });
      const own = FILL[/_Ext$/.test(el.macro) ? 'external' : 'own'];
      const label = [`<b>${htmlText(el.args[1])}</b>`, f.techn ? htmlText(`[${f.techn}]`) : '', f.descr ? htmlText(f.descr) : ''].filter(Boolean).join('<br>');
      let style: string; let gw = SLOT_W; let gh = BOX_H; let slotH = BOX_H;
      if (icon) {
        style = `shape=image;image=${icon.uri};verticalLabelPosition=bottom;verticalAlign=top;imageAspect=0;aspect=fixed;html=1;`;
        gw = ICON_SIZE; gh = ICON_SIZE; slotH = LABELLED_H;
      } else if (kind === 'person') {
        style = `shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;${own}`;
        gw = ACTOR_W; gh = ICON_SIZE; slotH = LABELLED_H;
      } else if (kind === 'db') style = `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;${own}`;
      else style = `rounded=1;whiteSpace=wrap;html=1;${own}`;
      elementIds.set(el.alias, `el-${el.alias}`);
      parentOf.set(el.alias, parent);
      return { id: `el-${el.alias}`, label, style, w: SLOT_W, h: slotH, gx: (SLOT_W - gw) / 2, gw, gh };
    }
    const b = item.boundary;
    boundaryIds.set(b.alias, `bd-${b.alias}`);
    parentOf.set(b.alias, parent);
    const kids = b.items.map((child: any) => layoutNode(child, b.alias));
    const grid = pack(kids);
    return {
      id: `bd-${b.alias}`, boundary: true, label: htmlText(b.label), kids, grid,
      w: Math.max(MIN_BOUNDARY_W, grid.w + 2 * PAD), h: HEADER + PAD + grid.h + PAD,
    };
  };

  const pack = (nodes: any[]): { at: Array<{ x: number; y: number }>; w: number; h: number } => {
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodes.length))));
    const at: Array<{ x: number; y: number }> = [];
    let x = 0; let y = 0; let rowH = 0; let w = 0;
    nodes.forEach((n: any, i: number) => {
      if (i > 0 && i % cols === 0) { x = 0; y += rowH + GAP; rowH = 0; }
      at.push({ x, y });
      x += n.w; w = Math.max(w, x); x += GAP;
      rowH = Math.max(rowH, n.h);
    });
    return { at, w, h: y + rowH };
  };

  const roots = parsed.roots.map((item: any) => layoutNode(item, null));
  const top = pack(roots);

  const lines: string[] = [];
  const cell = (node: any, x: number, y: number, parent: string) => {
    if (node.boundary) {
      lines.push(`        <mxCell id="${xmlAttr(node.id)}" value="${xmlAttr(node.label)}" style="swimlane;startSize=30;html=1;" vertex="1" parent="${xmlAttr(parent)}">`,
        `          <mxGeometry x="${x}" y="${y}" width="${node.w}" height="${node.h}" as="geometry"/>`, '        </mxCell>');
      node.kids.forEach((kid: any, i: number) => cell(kid, PAD + node.grid.at[i].x, HEADER + PAD + node.grid.at[i].y, node.id));
    } else {
      lines.push(`        <mxCell id="${xmlAttr(node.id)}" value="${xmlAttr(node.label)}" style="${xmlAttr(node.style)}" vertex="1" parent="${xmlAttr(parent)}">`,
        `          <mxGeometry x="${x + node.gx}" y="${y}" width="${node.gw}" height="${node.gh}" as="geometry"/>`, '        </mxCell>');
    }
  };
  roots.forEach((node: any, i: number) => cell(node, ORIGIN + top.at[i].x, ORIGIN + top.at[i].y, '1'));

  const chain = (alias: string): string[] => {
    const out: string[] = [];
    for (let p = parentOf.get(alias) ?? null; p; p = parentOf.get(p) ?? null) out.push(p);
    return out;
  };
  parsed.edges.forEach((e: any, i: number) => {
    for (const end of [e.from, e.to]) {
      if (!elementIds.has(end) && !boundaryIds.has(end)) {
        throw new Refused(`${sourcePath}:${e.lineno}: ${e.macro} names '${end}', which no element or boundary in this source defines`);
      }
    }
    const f = fields(e.args, ['label', 'techn', 'descr']);
    const label = [f.label ? htmlText(f.label) : '', f.techn ? htmlText(`[${f.techn}]`) : ''].filter(Boolean).join('<br>');
    const toChain = new Set(chain(e.to));
    const common = chain(e.from).find((a: string) => toChain.has(a));
    const style = `edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;${e.bi ? 'startArrow=block;' : ''}`;
    const id = `rel-${i + 1}-${e.from}-${e.to}`;
    lines.push(`        <mxCell id="${xmlAttr(id)}" value="${xmlAttr(label)}" style="${style}" edge="1" parent="${common ? `bd-${xmlAttr(common)}` : '1'}" source="${xmlAttr(elementIds.get(e.from) ?? boundaryIds.get(e.from) as string)}" target="${xmlAttr(elementIds.get(e.to) ?? boundaryIds.get(e.to) as string)}">`,
      '          <mxGeometry relative="1" as="geometry"/>', '        </mxCell>');
  });

  const xml = [
    '<mxfile>',
    `  <diagram id="${xmlAttr(`c4-${name.replace(/[^A-Za-z0-9_.-]/g, '-')}`)}" name="${xmlAttr(name)}">`,
    '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">',
    '      <root>',
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
    ...lines,
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '',
  ].join('\n');
  return { xml, counts: { elements: parsed.elements.length, boundaries: boundaryIds.size, edges: parsed.edges.length }, icons };
}

/** A viewable copy next to the `.drawio`, when a draw.io binary is installed. Never fails the render. */
function exportSvg(input: string, output: string, timeoutSec: number): { status: string; command: string; reason?: string } {
  const bin = process.env.DOFLOW_DRAWIO || 'drawio';
  const args = ['-x', '-f', 'svg', '-e', '--embed-svg-images', '-o', output, input];
  const command = `${bin} ${args.join(' ')}`;
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutSec * 1000, killSignal: 'SIGKILL' });
  if (r.error && r.error.code === 'ENOENT') return { status: 'skipped', command, reason: `${bin} is not on PATH` };
  if (r.error && r.error.code === 'ETIMEDOUT') return { status: 'failed', command, reason: `timed out after ${timeoutSec}s` };
  if (r.error) return { status: 'failed', command, reason: r.error.message };
  if (r.status !== 0 || !fs.existsSync(output)) return { status: 'failed', command, reason: `exit ${r.status}: ${String(r.stderr || '').trim().split('\n')[0]}` };
  return { status: 'exported', command };
}

/**
 * Write `<outDir>/<level>.drawio` for each source. A `.drawio` that differs from what was written last
 * time is left alone without `force`: the sha of the generated text sits in `<level>.drawio.sha`, a
 * sidecar rather than a line in the file because draw.io rewrites the whole file on save and keeps
 * nothing it does not know. No sidecar, or a file that no longer matches it, reads as hand-edited.
 */
function renderLevels(o: { srcDir: string; outDir: string; level?: string; iconsDir: string; roots: string[]; base: string; force?: boolean; timeoutSec?: number }): any {
  const rel = (p: string) => path.relative(o.base, p).split(path.sep).join('/');
  const resolver = makeIconResolver(o.iconsDir, o.roots);
  const stems = fs.readdirSync(o.srcDir).filter((f: string) => f.endsWith('.puml')).map((f: string) => f.slice(0, -5)).sort();
  const wanted = o.level ? stems.filter((s: string) => s === o.level) : stems;
  if (o.level && !wanted.length) throw new TypeError(`no ${o.level}.puml in ${rel(o.srcDir)} (found: ${stems.join(', ') || 'none'})`);
  const levels: any[] = [];
  for (const stem of wanted) {
    const source = path.join(o.srcDir, `${stem}.puml`);
    const out = path.join(o.outDir, `${stem}.drawio`);
    const sidecar = `${out}.sha`;
    const level: any = { level: stem, source: rel(source), file: rel(out) };
    levels.push(level);
    let made: any;
    try { made = project(fs.readFileSync(source, 'utf8'), { sourcePath: rel(source), name: stem, icons: resolver }); }
    catch (err: any) {
      if (!(err instanceof Refused)) throw err;
      Object.assign(level, { status: 'refused-source', message: err.message });
      continue;
    }
    Object.assign(level, { counts: made.counts, icons: made.icons });
    if (!made.counts.elements) { Object.assign(level, { status: 'skipped', message: 'no C4 elements in this source' }); continue; }
    const existing = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    const recorded = fs.existsSync(sidecar) ? fs.readFileSync(sidecar, 'utf8').trim() : '';
    if (existing !== null && existing !== made.xml && !o.force && sha16(existing) !== recorded) {
      Object.assign(level, { status: 'refused-overwrite', message: `${rel(out)} was edited since it was generated; left untouched. Re-run with --force to replace it` });
      continue;
    }
    fs.mkdirSync(o.outDir, { recursive: true });
    if (existing !== made.xml) {
      const tmp = `${out}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, made.xml);
      fs.renameSync(tmp, out);
    }
    fs.writeFileSync(sidecar, `${sha16(made.xml)}\n`);
    level.status = existing === made.xml ? 'unchanged' : 'written';
    level.export = { file: rel(`${out}.svg`), ...exportSvg(out, `${out}.svg`, o.timeoutSec || 60) };
  }
  const failed = levels.filter((l: any) => l.status === 'refused-source' || l.status === 'refused-overwrite');
  return { ok: failed.length === 0, written: levels.some((l: any) => l.status === 'written' || l.status === 'unchanged'), dir: rel(o.outDir), iconsDir: rel(o.iconsDir), levels };
}

module.exports = { project, renderLevels, makeIconResolver, iconKeys, exportSvg, MAX_ICON_BYTES };

if (require.main === module) {
  const usage = 'usage: drawio-project.ts --src-dir <dir> --out-dir <dir> --icons <dir> --base <dir> --root <dir> [--root <dir>...] [--level <name>] [--timeout <seconds>] [--force]\n';
  const args: any = { root: [] };
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--root') args.root.push(process.argv[++i]);
    else if (/^--(src-dir|out-dir|icons|base|level|timeout)$/.test(a)) args[a.slice(2)] = process.argv[++i];
    else { process.stderr.write(usage); process.exit(2); }
  }
  if (!args['src-dir'] || !args['out-dir'] || !args.icons || !args.base || !args.root.length) { process.stderr.write(usage); process.exit(2); }
  const timeoutSec = args.timeout === undefined ? 60 : Number(args.timeout);
  if (!(timeoutSec > 0)) { process.stderr.write(`drawio-project: --timeout must be a positive number of seconds, got: ${args.timeout}\n`); process.exit(2); }
  let result: any;
  try {
    result = renderLevels({ srcDir: args['src-dir'], outDir: args['out-dir'], level: args.level, iconsDir: args.icons, roots: args.root, base: args.base, force: args.force, timeoutSec });
  } catch (err: any) {
    process.stderr.write(`drawio-project: ${err.message}\n`);
    process.exit(err instanceof Refused ? 1 : err instanceof TypeError ? 2 : 1);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
