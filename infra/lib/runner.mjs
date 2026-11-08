// Command runner for the deploy scripts (WP18). Every outward command goes
// through here so that --dry-run can print the complete plan without
// executing anything:
//
//   run(cmd)    a mutating step. Dry run: printed as "+ cmd", not executed.
//   probe(cmd)  a read-only existence/describe check. Dry run: printed as
//               "? cmd" and NOT executed either (dry runs must not touch the
//               cloud at all, not even read-only); it is assumed to fail, so
//               the plan shows the create path of every idempotent step.
//   output(cmd) a read-only query whose stdout is needed (URLs, numbers).
//               Dry run: printed as "? cmd" and returns the placeholder.
//
// Secret values never reach the transcript: pass them as `input` (stdin)
// and they print as <redacted>.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { env as toolEnv, isWin, root } from '../../scripts/lib.mjs';

export class Runner {
  /**
   * @param {{ dryRun: boolean, transcript?: string, cwd?: string }} opts
   */
  constructor(opts) {
    this.dryRun = !!opts.dryRun;
    this.cwd = opts.cwd ?? root;
    this.transcript = opts.transcript ?? null;
    this.lines = [];
    this.steps = 0;
  }

  log(line = '') {
    console.log(line);
    this.lines.push(line);
  }

  section(title) {
    this.log('');
    this.log(`━━ ${title}`);
  }

  note(text) {
    this.log(`# ${text}`);
  }

  flush() {
    if (this.transcript) fs.writeFileSync(this.transcript, this.lines.join('\n') + '\n');
  }

  static fmt(cmd) {
    return cmd.map((a) => (a === '' ? "''" : /[\s"'$`\\|&;<>(){}*?!#]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ');
  }

  exec(cmd, opts = {}) {
    const [bin, ...args] = cmd;
    // Windows: gcloud/netlify/npm are .cmd shims, which need a shell; quote
    // arguments ourselves so commas, = and spaces survive cmd.exe.
    const shell = isWin && !bin.endsWith('.exe');
    const quoted = shell ? args.map((a) => (/[\s,;=&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
    const r = spawnSync(bin, quoted, {
      cwd: opts.cwd ?? this.cwd,
      env: toolEnv(opts.env),
      input: opts.input,
      encoding: 'utf8',
      shell,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', opts.capture ? 'pipe' : 'inherit', opts.capture ? 'pipe' : 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /** Mutating step. Throws on failure unless opts.allowFail. */
  run(cmd, opts = {}) {
    this.steps++;
    let shown = Runner.fmt(cmd) + (opts.input !== undefined ? ' <<< <redacted>' : '');
    for (const s of opts.redact ?? []) if (s) shown = shown.split(s).join('<redacted>');
    this.log(`+ ${shown}`);
    if (this.dryRun) return { code: 0, stdout: '', stderr: '' };
    const r = this.exec(cmd, opts);
    if (r.code !== 0 && !opts.allowFail) throw new Error(`command failed (${r.code}): ${shown}\n${r.stderr}`);
    return r;
  }

  /** A local, read-only tool check (versions) that runs even in a dry run. */
  check(cmd) {
    const r = this.exec(cmd, { capture: true });
    const line = (r.stdout || r.stderr).trim().split('\n')[0];
    this.log(`= ${Runner.fmt(cmd)}  ->  ${r.code === 0 ? line : `MISSING (exit ${r.code})`}`);
    return r.code === 0;
  }

  /** Read-only check; true when the command succeeds. Dry run: false. */
  probe(cmd, opts = {}) {
    this.log(`? ${Runner.fmt(cmd)}`);
    if (this.dryRun) return false;
    return this.exec(cmd, { ...opts, capture: true }).code === 0;
  }

  /** Read-only query returning trimmed stdout. Dry run: placeholder. */
  output(cmd, placeholder, opts = {}) {
    this.log(`? ${Runner.fmt(cmd)}`);
    if (this.dryRun) return placeholder;
    const r = this.exec(cmd, { ...opts, capture: true });
    if (r.code !== 0) {
      if (opts.allowFail) return null;
      throw new Error(`query failed (${r.code}): ${Runner.fmt(cmd)}\n${r.stderr}`);
    }
    return r.stdout.trim();
  }

  /** A step a human must do in a console; printed in every mode. */
  manual(title, lines) {
    this.log('');
    this.log(`!! MANUAL STEP: ${title}`);
    for (const l of lines) this.log(`!!   ${l}`);
  }
}
