import { test, expect } from '@playwright/test';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, createServer } from 'vite';
import type { BoundaryLayoutReport } from '../../src/browser.js';
import type { SkeletonConfig } from '../../src/types.js';

for (const fixture of ['react-admin', 'vue-workspace'] as const) test(`project acceptance: ${fixture} integrates aliased lazy routes and verifies real/skeleton geometry`, async ({ page }) => {
  const repo = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), `skelcast-acceptance-${fixture}-`));
  const framework = fixture.startsWith('react') ? 'react' : 'vue';
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await cp(path.join(repo, 'tests/fixtures/projects', fixture), root, { recursive: true });
    await mkdir(path.join(root, 'node_modules'));
    for (const name of ['react', 'react-dom', 'vue', 'vite', '@vitejs', 'less']) await symlink(path.join(repo, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
    await symlink(repo, path.join(root, 'node_modules/skelcast'), 'dir');
    const { initProject, loadProject, readArtifact, syncProject, qualityProject } = await import('../../dist/index.js');
    const dry = await initProject(root, { dryRun: true });
    expect(dry.targets.some(target => target.kind === 'page' && target.route === '/')).toBe(true);
    const report = await initProject(root);
    expect(report.generated?.length).toBeGreaterThanOrEqual(2);
    expect((await initProject(root)).changes).toHaveLength(0);
    const region = report.targets.find(target => target.kind === 'request')!;
    const project = await loadProject(root);
    // The Vue fixture additionally validates the shared browser API through Shadow DOM.
    if (framework === 'vue') {
      project.config.targets.find(target => target.id === region.id)!.render = 'shadow';
      await writeFile(path.join(root, 'skelcast.config.mjs'), `export default ${JSON.stringify(project.config satisfies SkeletonConfig)};\n`);
      await syncProject(project);
    }
    const artifact = await readArtifact(project, region.id);
    expect(artifact.diagnostics).toEqual([]);
    expect((await qualityProject(project, region.id))[0].needsReview).toBe(false);
    await build({ root, logLevel: 'silent' });
    expect(await readFile(path.join(root, 'dist/index.html'), 'utf8')).toContain('data-sk-initial');
    server = await createServer({ root, logLevel: 'silent', optimizeDeps: { exclude: ['skelcast'] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, root] } } });
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const boundary = page.locator(`[data-sk-boundary="${region.id}"]`);
    await expect(boundary).toHaveAttribute('aria-busy', 'false');
    const filter = page.getByRole('textbox', { name: framework === 'react' ? 'Project filter' : 'Activity filter' });
    await filter.fill('Keep this filter');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const action = boundary.getByRole('button').first();
      await action.focus();
      const result = await page.evaluate(async ({ id, url }) => {
        const { auditBoundaryLayout } = await import(url);
        return auditBoundaryLayout(document.querySelector(`[data-sk-boundary="${id}"]`), { tolerancePx: 2, toleranceRatio: 0 });
      }, { id: region.id, url: `/@fs/${path.join(repo, 'dist/browser.js')}` }) as BoundaryLayoutReport;
      expect(result.issues).toEqual([]);
      expect(result.viewport.width).toBe(width);
      expect(result.skeleton.visiblePlaceholders).toBeGreaterThan(0);
      expect(result.delta.followingContentShift).toBeCloseTo(0, 1);
      await expect(filter).toHaveValue('Keep this filter');
      await expect(action).toBeFocused();
      await expect(boundary).toHaveAttribute('data-sk-visible', 'false');
    }
    const toolbar = page.locator('#skelcast-devtools');
    await toolbar.getByRole('combobox', { name: 'Loading region' }).selectOption(region.id);
    await toolbar.getByRole('switch', { name: 'Show skeleton' }).check();
    await expect(boundary).toHaveAttribute('data-sk-visible', 'true');
    await toolbar.getByRole('switch', { name: 'Show skeleton' }).uncheck();
    expect(errors).toEqual([]);
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
