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
const { spawn, spawnSync } = require('node:child_process');
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
// Siblings joined by relations are laid out in columns by rank; the wider gap leaves room for a label.
const RANK_GAP = 120;
const MAX_PER_COLUMN = 4;
// A relation that passes over a column gets an empty slot in it to run through.
const SLOT_H = 20;
const MAX_ROUTE_SLOTS = 2000;
// Lanes for the upright part of a routed relation, inside the gap between two columns.
const LANE_EDGE = 18;
const LANE_STEP = 12;
/** Lanes beside a column and bands above a grid row for the paths turning out of one container, and how far apart bands sit. */
const EXIT_LANES = 7;
const GRID_BANDS = 5;
const BAND_STEP = 6;

// C0 controls other than tab, LF and CR are not legal in XML 1.0, even as a character reference.
const xmlAttr = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const htmlText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
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

  // How many relation ends may turn out of each container: every end below it of a relation that goes
  // beyond it. The space under a container's title is as tall as the bands those turns need.
  const holderOf = new Map<string, string | null>();
  const walk = (item: any, parent: string | null): void => {
    if (item.element) { holderOf.set(item.element, parent); return; }
    holderOf.set(item.boundary.alias, parent);
    for (const child of item.boundary.items) walk(child, item.boundary.alias);
  };
  for (const item of parsed.roots) walk(item, null);
  const above = (alias: string): string[] => { const out: string[] = []; for (let p = holderOf.get(alias) ?? null; p; p = holderOf.get(p) ?? null) out.push(p); return out; };
  const exits = new Map<string, number>();
  for (const e of parsed.edges) {
    if (!holderOf.has(e.from) || !holderOf.has(e.to)) continue;
    const [a, b] = [above(e.from), above(e.to)];
    for (const [mine, other] of [[a, b], [b, a]]) for (const c of mine) { if (other.includes(c)) break; exits.set(c, (exits.get(c) ?? 0) + 1); }
  }
  const topOf = (alias: string): number => Math.max(PAD, BAND_STEP * ((exits.get(alias) ?? 0) + 1));

  // Each shape's layout record, by alias; `place` on it says where its container put it (a column or a grid row).
  const nodeOf = new Map<string, any>();
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
      return nodeOf.set(el.alias, { id: `el-${el.alias}`, alias: el.alias, aliases: [el.alias], label, style, w: SLOT_W, h: slotH, gx: (SLOT_W - gw) / 2, gw, gh }).get(el.alias);
    }
    const b = item.boundary;
    boundaryIds.set(b.alias, `bd-${b.alias}`);
    parentOf.set(b.alias, parent);
    const kids = b.items.map((child: any) => layoutNode(child, b.alias));
    const top = topOf(b.alias);
    const grid = pack(kids, PAD, HEADER + top);
    return nodeOf.set(b.alias, {
      id: `bd-${b.alias}`, alias: b.alias, aliases: [b.alias, ...kids.flatMap((k: any) => k.aliases)], boundary: true, label: htmlText(b.label), kids, grid, top,
      w: Math.max(MIN_BOUNDARY_W, grid.w + 2 * PAD), h: HEADER + top + grid.h + PAD,
    }).get(b.alias);
  };

  // How each relation is drawn, by its index: the points it passes, in its container's coordinates,
  // and whether both ends are children of that container (only then are its sides pinned).
  const routes = new Map<number, { points: Array<{ x: number; y?: number }>; direct: boolean; back: boolean }>();
  let slotsLeft = MAX_ROUTE_SLOTS;

  // Children no relation joins keep the source-order grid. Joined children go in one column per rank,
  // a rank being the longest chain of relations that leads to the child, so a relation runs from a
  // column to a later one. A relation that passes over a column gets an empty slot in it and is routed
  // through that slot; the space between columns holds no shape, so it meets none on the way.
  // `ox`,`oy` is where this container puts its grid, for the route points.
  const pack = (nodes: any[], ox: number, oy: number): { at: Array<{ x: number; y: number }>; w: number; h: number } => {
    const owner = new Map<string, number>();
    nodes.forEach((n: any, i: number) => n.aliases.forEach((a: string) => owner.set(a, i)));
    const succs: number[][] = nodes.map(() => []);
    const links: Array<{ e: number; a: number; b: number }> = [];
    const linked = new Set<number>();
    parsed.edges.forEach((e: any, k: number) => {
      const a = owner.get(e.from); const b = owner.get(e.to);
      if (a === undefined || b === undefined || a === b) return;
      succs[a].push(b); links.push({ e: k, a, b }); linked.add(a); linked.add(b);
    });
    const at: Array<{ x: number; y: number }> = nodes.map(() => ({ x: 0, y: 0 }));
    const grid = (members: number[], y0: number): { w: number; bottom: number } => {
      const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(members.length))));
      let x = 0; let y = y0; let rowH = 0; let w = 0;
      members.forEach((i: number, k: number) => {
        if (k > 0 && k % cols === 0) { x = 0; y += rowH + GAP; rowH = 0; }
        at[i] = { x, y }; nodes[i].place = { row: y };
        x += nodes[i].w; w = Math.max(w, x); x += GAP;
        rowH = Math.max(rowH, nodes[i].h);
      });
      return { w, bottom: y + rowH };
    };
    const all = nodes.map((_: any, i: number) => i);
    if (!links.length) { const g = grid(all, 0); return { at, w: g.w, h: g.bottom }; }

    // Walking the relations from each child in source order, one that leads back to a child still
    // being walked closes a cycle and takes no part in ranking, so the child written first stays first.
    // The walk keeps its own stack: a chain may be longer than the call stack is deep.
    const kept: number[][] = nodes.map(() => []);
    const seen: number[] = nodes.map(() => 0);
    const done: number[] = [];
    for (const root of all) {
      if (seen[root] !== 0) continue;
      seen[root] = 1;
      const stack: Array<[number, number]> = [[root, 0]];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const i = frame[0];
        if (frame[1] < succs[i].length) {
          const s = succs[i][frame[1]++];
          if (seen[s] === 1) continue;
          kept[i].push(s);
          if (seen[s] === 0) { seen[s] = 1; stack.push([s, 0]); }
        } else { seen[i] = 2; done.push(i); stack.pop(); }
      }
    }
    const rank: number[] = nodes.map(() => 0);
    for (let k = done.length - 1; k >= 0; k--) for (const s of kept[done[k]]) rank[s] = Math.max(rank[s], rank[done[k]] + 1);

    const byRank: number[][] = [];
    for (const i of all) if (linked.has(i)) (byRank[rank[i]] ??= []).push(i);
    const columns: number[][] = [];
    const colOf = new Map<number, number>();
    for (const members of byRank) {
      for (let k = 0; members && k < members.length; k += MAX_PER_COLUMN) {
        const col = members.slice(k, k + MAX_PER_COLUMN);
        col.forEach((i: number) => colOf.set(i, columns.length));
        columns.push(col);
      }
    }
    // A slot per column a relation passes over, while the budget lasts; past it a relation is left to the router.
    const slots: number[] = columns.map(() => 0);
    const passes = links.map((l) => {
      const ca = colOf.get(l.a) as number; const cb = colOf.get(l.b) as number;
      const over = Math.abs(ca - cb) - 1;
      const through: Array<{ c: number; slot: number }> = [];
      if (over > 0 && over <= slotsLeft) {
        slotsLeft -= over;
        for (let c = ca + Math.sign(cb - ca); c !== cb; c += Math.sign(cb - ca)) through.push({ c, slot: slots[c]++ });
      }
      return { l, back: ca > cb, through };
    });
    const shapesH = (c: number): number => columns[c].reduce((sum, i) => sum + nodes[i].h, 0) + GAP * (columns[c].length - 1);
    const heightOf = (c: number): number => shapesH(c) + slots[c] * (GAP + SLOT_H);
    const h = Math.max(...columns.map((_, c) => heightOf(c)));
    // Which gaps each relation turns in: the one it enters each passed column from, then the one before its
    // target. A gap is as wide as the lanes its relations need, so no two of them share a lane.
    const gapOf = (c: number, back: boolean): number => (back ? c + 1 : c);
    const turnsIn = passes.map((p) => {
      const e = parsed.edges[p.l.e];
      const cb = colOf.get(p.l.b) as number;
      const direct = nodes[p.l.a].alias === e.from && nodes[p.l.b].alias === e.to;
      const neighbours = Math.abs((colOf.get(p.l.a) as number) - cb) === 1;
      const last = p.through.length || (neighbours && !direct) ? [gapOf(cb, p.back)] : [];
      return { direct, neighbours, gaps: [...p.through.map((t) => gapOf(t.c, p.back)), ...last] };
    });
    const gapW: number[] = columns.map(() => RANK_GAP);
    const wanted: number[] = columns.map(() => 0);
    for (const t of turnsIn) for (const g of t.gaps) wanted[g] += 1;
    wanted.forEach((n, g) => { gapW[g] = Math.max(RANK_GAP, Math.ceil((2 * LANE_EDGE + n * LANE_STEP) / LANE_STEP) * LANE_STEP); });
    const colX: number[] = []; const colW: number[] = []; const colTop: number[] = [];
    let x = 0; let w = 0;
    columns.forEach((col, c) => {
      colX[c] = x; colW[c] = Math.max(...col.map((i) => nodes[i].w)); colTop[c] = Math.round((h - heightOf(c)) / 2);
      let y = colTop[c];
      for (const i of col) { at[i] = { x, y }; nodes[i].place = { col: [x, x + colW[c]] }; y += nodes[i].h + GAP; }
      w = x + colW[c]; x = w + (gapW[c + 1] ?? 0);
    });
    // A routed relation turns only in the space between columns, never at a shape's own edge: one point
    // per column passed, in the gap it enters that column from, at the height of its slot there, then one
    // in the gap before its target. The corners between them are added when the relation is written.
    // Each relation that turns in a gap takes the next lane there, so two of them do not share a line.
    const lanes: number[] = columns.map(() => 0);
    const gapBefore = (c: number, back: boolean): number => {
      const gap = gapOf(c, back);
      return ox + colX[gap] - gapW[gap] + LANE_EDGE + lanes[gap]++ * LANE_STEP;
    };
    passes.forEach((p, n) => {
      const points: Array<{ x: number; y?: number }> = [];
      let y = 0;
      for (const t of p.through) {
        y = oy + colTop[t.c] + shapesH(t.c) + GAP + t.slot * (GAP + SLOT_H) + SLOT_H / 2;
        points.push({ x: gapBefore(t.c, p.back), y });
      }
      const { direct, neighbours } = turnsIn[n];
      if (points.length) points.push({ x: gapBefore(colOf.get(p.l.b) as number, p.back), y });
      // An end inside a child container has its own way out to draw, so it needs a lane here too.
      else if (neighbours && !direct) points.push({ x: gapBefore(colOf.get(p.l.b) as number, p.back) });
      // Left to the router and pinned only when its way is clear: two children in neighbouring columns.
      routes.set(p.l.e, { points, back: p.back, direct: direct && neighbours });
    });
    const rest = all.filter((i) => !linked.has(i));
    if (!rest.length) return { at, w, h };
    const g = grid(rest, h + GAP);
    return { at, w: Math.max(w, g.w), h: g.bottom };
  };


  const roots = parsed.roots.map((item: any) => layoutNode(item, null));
  const top = pack(roots, ORIGIN, ORIGIN);

  const lines: string[] = [];
  // Page coordinates of every shape, for the ends of a routed relation.
  const box = new Map<string, { x: number; y: number; w: number; h: number }>();
  const cell = (node: any, x: number, y: number, parent: string, px = 0, py = 0) => {
    box.set(node.alias, node.boundary ? { x: px + x, y: py + y, w: node.w, h: node.h } : { x: px + x + node.gx, y: py + y, w: node.gw, h: node.gh });
    if (node.boundary) {
      lines.push(`        <mxCell id="${xmlAttr(node.id)}" value="${xmlAttr(node.label)}" style="swimlane;startSize=30;html=1;" vertex="1" parent="${xmlAttr(parent)}">`,
        `          <mxGeometry x="${x}" y="${y}" width="${node.w}" height="${node.h}" as="geometry"/>`, '        </mxCell>');
      node.kids.forEach((kid: any, i: number) => cell(kid, PAD + node.grid.at[i].x, HEADER + node.top + node.grid.at[i].y, node.id, px + x, py + y));
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
  // Pinned sides, for a relation between two children of one container. One that runs against the
  // column order leaves and enters lower on the side, clear of a relation running the other way.
  const FORWARD = 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;';
  const BACK = 'exitX=0;exitY=0.75;entryX=1;entryY=0.75;';
  // The way from one end of a relation out of every container around it, up to the one both ends
  // share, in page coordinates: beside the shape into the clear space next to it, up to the clear band
  // above its column or grid row, along the band to the container's side; then the same one level up.
  // Returns the corners after the shape's own side, and the height the path is at when it gets out.
  const kidsOf = new Map<string, string[]>();
  for (const [alias, holder] of parentOf) if (holder) kidsOf.set(holder, [...(kidsOf.get(holder) ?? []), alias]);
  // The upright lanes (`x`) and level bands (`y`) already used by a written path, per container, in page
  // coordinates. A new path takes the first of its candidates no earlier path is on; when all are used
  // it shares one, which is the limit of a draft that keeps every container the size its shapes need.
  const claimed = new Map<string, { x: number[]; y: number[] }>();
  const claimsOf = (holder: string) => { if (!claimed.has(holder)) claimed.set(holder, { x: [], y: [] }); return claimed.get(holder) as { x: number[]; y: number[] }; };
  const free = (used: number[], candidates: number[]): number => candidates.find((v) => !used.some((u) => Math.abs(u - v) < 4)) ?? candidates[used.length % candidates.length];
  const steps = (from: number, step: number, count: number): number[] => Array.from({ length: count }, (_, k) => from + step * (k + 1));
  type End = { corners: Array<{ x: number; y: number }>; y: number; claims: Array<{ holder: string; axis: 'x' | 'y'; at: number }> };
  const leave = (alias: string, stop: string | null, dir: number, fy: number): End => {
    const corners: Array<{ x: number; y: number }> = [];
    const claims: End['claims'] = [];
    const first = box.get(alias) as any;
    let y = first.y + first.h * fy;
    for (let inner = alias, outer = parentOf.get(inner) ?? null; outer && outer !== stop; inner = outer, outer = parentOf.get(inner) ?? null) {
      const o = box.get(outer) as any; const b = box.get(inner) as any; const place = nodeOf.get(inner).place;
      // Nothing stands between this shape and the side it leaves by: the path runs straight out, with no climb.
      const blocked = (kidsOf.get(outer) as string[]).some((other) => {
        if (other === inner) return false;
        const s = box.get(other) as any;
        return (dir > 0 ? s.x >= b.x + b.w : s.x + s.w <= b.x) && y > s.y - 8 && y < s.y + s.h + 8;
      });
      if (!blocked) { corners.push({ x: dir > 0 ? o.x + o.w : o.x, y }); continue; }
      const used = claimsOf(outer);
      const top = topOf(outer); const gx = o.x + PAD; const gy = o.y + HEADER + top;
      // Beside a column the lanes sit between the lanes kept for relations that pass over a column; beside
      // a shape of the grid they are counted from the shape, and the shape on the other side counts from its own.
      const lane = free(used.x, place.col
        ? steps(gx + (dir > 0 ? place.col[1] : place.col[0]), dir * LANE_STEP, EXIT_LANES)
        : steps(dir > 0 ? b.x + b.w : b.x, dir * 8, 4));
      const band = free(used.y, place.col || place.row === 0 ? steps(gy - top, BAND_STEP, Math.floor(top / BAND_STEP) - 1) : steps(gy + place.row - GAP + BAND_STEP, BAND_STEP, GRID_BANDS));
      claims.push({ holder: outer, axis: 'x', at: lane }, { holder: outer, axis: 'y', at: band });
      corners.push({ x: lane, y }, { x: lane, y: band }, { x: dir > 0 ? o.x + o.w : o.x, y: band });
      y = band;
    }
    return { corners, y, claims };
  };
  // One end of a written path. An end that leaves a container tries the next height on its shape while the
  // height it would come out at is already used in the container both ends share: a path that leaves
  // straight out and one that comes straight in at the same height would otherwise draw as one line.
  const endOf = (alias: string, stop: string | null, dir: number, back: boolean) => {
    const used = claimsOf(stop ?? '').y;
    let got = { ...leave(alias, stop, dir, back ? 0.75 : 0.5), fy: back ? 0.75 : 0.5 };
    if (got.corners.length) {
      for (const fy of back ? [0.875, 0.625] : [0.375, 0.625, 0.25]) {
        if (!used.some((y) => Math.abs(y - got.y) < 6)) break;
        got = { ...leave(alias, stop, dir, fy), fy };
      }
      used.push(got.y);
    }
    for (const c of got.claims) claimsOf(c.holder)[c.axis].push(c.at);
    return got;
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
    const route = routes.get(i);
    const arrows = `html=1;labelBackgroundColor=default;endArrow=block;${e.bi ? 'startArrow=block;' : ''}`;
    let style = `edgeStyle=orthogonalEdgeStyle;${arrows}${route?.direct ? (route.back ? BACK : FORWARD) : ''}`;
    let geometry = '<mxGeometry relative="1" as="geometry"/>';
    if (route?.points.length) {
      // The whole path is given, corner by corner, and no router is asked: draw.io's orthogonal router
      // takes a point as a hint and turns at the shape's own edge, through whatever is stacked there.
      const origin = common ? box.get(common) as any : { x: 0, y: 0 };
      const dir = route.back ? -1 : 1;
      const out = endOf(e.from, common ?? null, dir, route.back);
      const into = endOf(e.to, common ?? null, -dir, route.back);
      const corners = out.corners.map((c) => ({ x: c.x - origin.x, y: c.y - origin.y }));
      let y = out.y - origin.y;
      for (const p of route.points) {
        corners.push({ x: p.x, y });
        if (p.y !== undefined) { corners.push({ x: p.x, y: p.y }); y = p.y; }
      }
      corners.push({ x: route.points[route.points.length - 1].x, y: into.y - origin.y }, ...into.corners.reverse().map((c) => ({ x: c.x - origin.x, y: c.y - origin.y })));
      const path = corners.filter((c, k) => k === 0 || c.x !== corners[k - 1].x || c.y !== corners[k - 1].y);
      style = `edgeStyle=none;rounded=0;${arrows}exitX=${route.back ? 0 : 1};exitY=${out.fy};entryX=${route.back ? 1 : 0};entryY=${into.fy};`;
      geometry = `<mxGeometry relative="1" as="geometry"><Array as="points">${path.map((c) => `<mxPoint x="${c.x}" y="${c.y}"/>`).join('')}</Array></mxGeometry>`;
    }
    const id = `rel-${i + 1}-${e.from}-${e.to}`;
    lines.push(`        <mxCell id="${xmlAttr(id)}" value="${xmlAttr(label)}" style="${style}" edge="1" parent="${common ? `bd-${xmlAttr(common)}` : '1'}" source="${xmlAttr(elementIds.get(e.from) ?? boundaryIds.get(e.from) as string)}" target="${xmlAttr(elementIds.get(e.to) ?? boundaryIds.get(e.to) as string)}">`,
      `          ${geometry}`, '        </mxCell>');
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

/** End the child and everything it started: a draw.io launcher is a shell script that starts Electron. */
function killTree(pid: number): void {
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

/**
 * A viewable copy next to the `.drawio`, when a draw.io binary is installed. Never fails the render.
 * The child leads its own process group so a timeout can end the whole tree, and any earlier output
 * is removed first so a binary that exits 0 without writing is reported as failed, not exported.
 */
function exportSvg(input: string, output: string, timeoutSec: number): Promise<{ status: string; command: string; reason?: string }> {
  const bin = process.env.DOFLOW_DRAWIO || 'drawio';
  const args = ['-x', '-f', 'svg', '-e', '--embed-svg-images', '-o', output, input];
  const command = `${bin} ${args.join(' ')}`;
  fs.rmSync(output, { force: true });
  return new Promise((resolve) => {
    let child: any;
    try { child = spawn(bin, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (err: any) { resolve({ status: 'failed', command, reason: err.message }); return; }
    let stderr = '';
    child.stderr.on('data', (d: any) => { if (stderr.length < 4096) stderr += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutSec * 1000);
    child.on('error', (err: any) => {
      clearTimeout(timer);
      resolve(err.code === 'ENOENT' ? { status: 'skipped', command, reason: `${bin} is not on PATH` } : { status: 'failed', command, reason: err.message });
    });
    child.on('exit', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (timedOut) { resolve({ status: 'failed', command, reason: `timed out after ${timeoutSec}s` }); return; }
      if (code !== 0) { resolve({ status: 'failed', command, reason: `exit ${code ?? signal}: ${stderr.trim().split('\n')[0]}` }); return; }
      resolve(fs.existsSync(output) ? { status: 'exported', command } : { status: 'failed', command, reason: 'exited 0 but wrote no file' });
    });
  });
}

/** Nothing is written through a symlink, and nothing outside the checkout: the folder is resolved from its deepest existing part. */
function assertOutputFolder(dir: string, roots: string[]): void {
  let at = path.resolve(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  const real = fs.realpathSync(at);
  const realRoots = roots.map((r: string) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
  if (!realRoots.some((r: string) => inside(r, real))) throw new Refused(`output folder ${dir} resolves outside the checkout`);
}

/** Write through a temp file moved into place; the name is created exclusively, so a planted link there is not followed. */
function writeAtomic(target: string, text: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try { fs.renameSync(tmp, target); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}

/**
 * Write `<outDir>/<level>.drawio` for each source. A `.drawio` that differs from what was written last
 * time is left alone without `force`: the sha of the generated text sits in `<level>.drawio.sha`, a
 * sidecar rather than a line in the file because draw.io rewrites the whole file on save and keeps
 * nothing it does not know. No sidecar, or a file that no longer matches it, reads as hand-edited.
 */
async function renderLevels(o: { srcDir: string; outDir: string; level?: string; iconsDir: string; roots: string[]; base: string; force?: boolean; timeoutSec?: number }): Promise<any> {
  const rel = (p: string) => path.relative(o.base, p).split(path.sep).join('/');
  const resolver = makeIconResolver(o.iconsDir, o.roots);
  assertOutputFolder(o.outDir, o.roots);
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
    const linked = [out, sidecar, `${out}.svg`].find((f: string) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } });
    if (linked) { Object.assign(level, { status: 'refused-symlink', message: `${rel(linked)} is a symbolic link; nothing was written through it` }); continue; }
    const existing = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    const recorded = fs.existsSync(sidecar) ? fs.readFileSync(sidecar, 'utf8').trim() : '';
    if (existing !== null && existing !== made.xml && !o.force && sha16(existing) !== recorded) {
      Object.assign(level, { status: 'refused-overwrite', message: `${rel(out)} was edited since it was generated; left untouched. Re-run with --force to replace it` });
      continue;
    }
    fs.mkdirSync(o.outDir, { recursive: true });
    if (existing !== made.xml) writeAtomic(out, made.xml);
    writeAtomic(sidecar, `${sha16(made.xml)}\n`);
    level.status = existing === made.xml ? 'unchanged' : 'written';
    level.export = { file: rel(`${out}.svg`), ...await exportSvg(out, `${out}.svg`, o.timeoutSec || 60) };
  }
  const failed = levels.filter((l: any) => /^refused-/.test(l.status));
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
  renderLevels({ srcDir: args['src-dir'], outDir: args['out-dir'], level: args.level, iconsDir: args.icons, roots: args.root, base: args.base, force: args.force, timeoutSec }).then((result: any) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 1);
  }, (err: any) => {
    process.stderr.write(`drawio-project: ${err.message}\n`);
    process.exit(err instanceof Refused ? 1 : err instanceof TypeError ? 2 : 1);
  });
}
