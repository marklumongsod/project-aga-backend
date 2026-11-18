/**
 * Data-quality report: npm run data:quality
 *
 * Whenever data is dropped or filled in, this checks whether it can be saved with a statistic instead:
 *   1. Assessment centers excluded from the analysis. Those excluded on purpose (not listed by the TESDA API, hidden,
 *      foreign, closed) stay out.
 *      The rest (coordinates disputed, or no city/province link) are tested: do the coordinates fall in the province the
 *      record names, and do they sit with the other centers of their city (median + 3 x MAD)? Eligible ones can be
 *      recovered with --apply. Every change is logged in center_recovery_log, and --revert puts it all back.
 *   2. Candidates (upcoming TESDA graduates) that the API places only in a province, so they are split over its towns.
 *      Shows how much of the demand that is, and lists the provinces where most of it is split (town figures there
 *      are mostly estimates).
 *
 *   npm run data:quality                 report only (changes nothing)
 *   npm run data:quality -- --apply      recover the centers that pass, then re-run `npm run travel:build` and `npm run simulate`
 *   npm run data:quality -- --revert     undo --apply
 */
import { DataSource } from 'typeorm';
import { typeormOptions } from '../database/data-source';
import { applyRecovery, assessExcludedCenters, revertRecovery, RecoveryVerdict } from '../database/center-recovery.runner';
import { DemandService } from '../simulation/demand.service';

const fmt = (n: number) => n.toLocaleString('en-PH');
const line = (c = '-') => c.repeat(78);

async function main() {
  const apply = process.argv.includes('--apply');
  const revert = process.argv.includes('--revert');
  const ds = await new DataSource(typeormOptions()).initialize();
  try {
    if (revert) {
      const n = await revertRecovery(ds);
      console.log(`Reverted ${n} centers to how they were. Next: npm run travel:build && npm run simulate`);
      return;
    }

    const { total, analysed, deliberate, verdicts } = await assessExcludedCenters(ds);
    console.log(`\nAssessment centers: ${fmt(total)} in the data, ${fmt(analysed)} in the analysis, ${fmt(total - analysed)} excluded.\n${line('=')}`);
    const by = (f: (r: (typeof deliberate)[number]) => string) => {
      const m = new Map<string, number>();
      for (const r of deliberate) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
      return [...m].map(([k, n]) => `${fmt(n)} ${k}`).join(', ');
    };
    console.log(`Excluded on purpose (stay out): ${by((r) => (r.tesda_listed === false ? 'not listed by the TESDA API' : r.is_foreign ? 'foreign' : r.is_closed ? 'closed' : 'hidden by TESDA'))}`);
    console.log(`Excluded for data problems (tested below): ${fmt(verdicts.length)}\n`);

    const saved = verdicts.filter((v) => v.recover);
    const kept = verdicts.filter((v) => !v.recover);
    console.log(`Can be saved: ${fmt(saved.length)}   Stay out: ${fmt(kept.length)}\n${line()}`);
    const group = (vs: RecoveryVerdict[], key: (v: RecoveryVerdict) => string) => {
      const m = new Map<string, RecoveryVerdict[]>();
      for (const v of vs) m.set(key(v), [...(m.get(key(v)) ?? []), v]);
      return [...m];
    };
    for (const [k, vs] of group(saved, (v) => `${v.row.source_city_name ?? '?'}, ${v.row.in_province} [${v.row.coord_status}] via ${v.method}`))
      console.log(`  save  ${String(vs.length).padStart(3)}  ${k}\n          e.g. ${JSON.stringify(vs[0]!.evidence)}`);
    for (const [k, vs] of group(kept, (v) => `${v.row.source_city_name ?? '?'} [${v.row.coord_status}]: ${v.reason}`))
      console.log(`  keep  ${String(vs.length).padStart(3)}  ${k}`);

    // ---- candidates split from province-only graduates
    console.log(`\nCandidates (upcoming TESDA graduates)\n${line('=')}`);
    const groupsD = await new DemandService(ds).currentGroups();
    const allCandidates = groupsD.reduce((n, g) => n + g.count, 0);
    const splitTotal = groupsD.reduce((n, g) => n + g.estimated, 0);
    const pct = (n: number, of: number) => (of ? ((100 * n) / of).toFixed(1) : '0.0').padStart(5);
    console.log(`  ${'placed in a town by the TESDA API'.padEnd(44)} ${fmt(allCandidates - splitTotal).padStart(10)} candidates  ${pct(allCandidates - splitTotal, allCandidates)}%`);
    console.log(`  ${'province only, split over its towns'.padEnd(44)} ${fmt(splitTotal).padStart(10)} candidates  ${pct(splitTotal, allCandidates)}%`);
    const byProv = new Map<string, { all: number; split: number }>();
    for (const g of groupsD) {
      const p = byProv.get(g.provincePsgc) ?? { all: 0, split: 0 };
      p.all += g.count;
      p.split += g.estimated;
      byProv.set(g.provincePsgc, p);
    }
    const mostlySplit = [...byProv].filter(([, p]) => p.all > 0 && p.split / p.all > 0.5).sort((a, b) => b[1].split / b[1].all - a[1].split / a[1].all);
    console.log(
      mostlySplit.length
        ? `\n  Provinces where most candidates are split (their town figures are mostly estimates):\n${mostlySplit.map(([prov, p]) => `  ${prov}: ${pct(p.split, p.all)}% of ${fmt(p.all)}`).join('\n')}`
        : '\n  In every province, most candidates are placed in a town.',
    );

    if (apply) {
      const ids = await applyRecovery(ds, verdicts);
      console.log(`\nApplied: ${fmt(ids.length)} centers recovered (logged in center_recovery_log).\nNext: npm run travel:build && npm run simulate   (undo with: npm run data:quality -- --revert)`);
    } else if (saved.length) {
      console.log(`\nDry run: nothing changed. Re-run with --apply to recover the ${fmt(saved.length)} centers above.`);
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
