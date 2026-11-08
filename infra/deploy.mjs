#!/usr/bin/env node
// One command deploys everything (spec 13, WP18 acceptance: "a clean clone
// deploys everything with one script").
//
//   node infra/deploy.mjs --target gcp --project <id> --dry-run   print the full plan, touch nothing
//   node infra/deploy.mjs --target gcp --project <id> --yes       deploy for real (npm run deploy)
//   node infra/deploy.mjs --target local                          rehearse the production topology
//                                                                 in Docker on this machine, smoke-
//                                                                 test it, tear it down
//
// Options (gcp): --region us-central1 --zone us-central1-a --tag <git sha>
//   --only apis,registry,accounts,network,secrets,buckets,build,wasm,vm,run,scheduler,netlify
//   --game-host play.example.com --client-site <netlify name> --creator-site <name>
//   --netlify-team <slug> --creator-llm --transcript <file>
//   Same settings as env vars: LODESTONE_GCP_PROJECT, LODESTONE_GCP_REGION, ...
//   (infra/lib/config.mjs; infra/README.md lists them all).
// Options (local): --keep (leave the rehearsal running), --skip-build (reuse
//   images from the last rehearsal), --browser=false, --transcript <file>
//
// Safety: a real deploy needs --yes; without it the script prints the plan
// and exits. Nothing ever changes the active gcloud project or config.
import { parseArgs, gcpConfig, gitDirty } from './lib/config.mjs';
import { Runner } from './lib/runner.mjs';
import { deployGcp, STEPS } from './lib/gcp.mjs';

const flags = parseArgs(process.argv.slice(2));
const target = flags.target ?? 'gcp';
const dryRun = flags['dry-run'] === true || flags.plan === true;

async function main() {
  if (target === 'local') {
    const { rehearse } = await import('./lib/local.mjs');
    const r = new Runner({ dryRun, transcript: flags.transcript });
    try {
      const ok = await rehearse(r, flags);
      r.flush();
      process.exit(ok ? 0 : 1);
    } catch (e) {
      r.log(`✗ ${e.message}`);
      r.flush();
      process.exit(1);
    }
  }
  if (target !== 'gcp') {
    console.error(`unknown --target ${target} (gcp | local)`);
    process.exit(2);
  }
  const cfg = gcpConfig(flags);
  const only = typeof flags.only === 'string' ? flags.only.split(',') : null;
  if (only) for (const s of only) if (!STEPS.includes(s)) throw new Error(`unknown step ${s} (${STEPS.join(', ')})`);
  const real = !dryRun && flags.yes === true;
  if (!dryRun && !real) {
    console.log('Refusing to deploy without --yes. Showing the plan instead (same as --dry-run).\n');
  }
  if (real && !cfg.project) {
    console.error('Set the GCP project: --project <id> or LODESTONE_GCP_PROJECT.');
    process.exit(2);
  }
  if (real && gitDirty() && flags['allow-dirty'] !== true) {
    console.error('The working tree has uncommitted changes; images are tagged with the commit. Commit first or pass --allow-dirty.');
    process.exit(2);
  }
  const r = new Runner({ dryRun: !real, transcript: flags.transcript });
  r.log(`Lodestone deploy: target gcp, ${real ? 'REAL RUN' : 'DRY RUN (nothing is executed; probes are assumed to find nothing, so this is the plan for an empty project)'}`);
  if (!cfg.project) r.note('no project given: showing YOUR-GCP-PROJECT (pass --project or LODESTONE_GCP_PROJECT)');
  r.log('Legend: "= cmd" local tool check (runs), "? cmd" read-only probe, "+ cmd" change, "#" note, "!!" manual console step.');
  try {
    deployGcp(r, cfg, { only });
    r.log('');
    r.log(real ? '✓ deployed' : `✓ plan complete: ${r.steps} change steps`);
  } catch (e) {
    r.log(`✗ ${e.message}`);
    r.flush();
    process.exit(1);
  }
  r.flush();
}

await main();
