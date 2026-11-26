import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { ConfigEnv, Plugin, UserConfig, UserConfigExport, ViteDevServer } from 'vite';
import { checkProject, loadProject, readArtifact, syncProject, type Project } from './generator.js';
import type { SkeletonArtifact, SkeletonTarget } from './types.js';
import { withProjectLock } from './storage.js';
import { createArtifactOptimizer, sharedStyleModule } from './compiler/optimize.js';
import { digest } from './compiler/styles.js';
import { parse, type ElementNode, type RootNode } from '@vue/compiler-dom';

const modulePrefix = 'virtual:skelcast/';
const internalPrefix = '\0skelcast:';
const sharedPrefix = 'virtual:skelcast-css/';
const initialModule = 'virtual:skelcast-initial';
const initialInternal = '\0skelcast-initial';
const transientPatterns = ['**/.skelcast-lock/**', '**/.skelcast-lock-recovery/**', '**/.skelcast-stage-*/**', '**/.skelcast-transaction.json'];
const transientFile = (file: string) => file.split(/[\\/]/).some(part => /^\.skelcast-(?:lock(?:-recovery)?|stage-.+|transaction\.json)$/.test(part)) || file.endsWith('.tmp');
const previewArtifact = (artifact: SkeletonArtifact): SkeletonArtifact => ({ ...artifact, diagnostics: [], evidence: [], sources: {}, source: '' });
const escapeStyle = (s: string) => s.replace(/<\/style/gi, '<\\/style');
const escapeAttribute = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const wildcard = (part: string) => part === '*' || /^:[\w]+\(\.\*\)[*+]?$/.test(part);
const deferredEntry = (html: string) => {
  let modules = 0, hasAsyncModule = false;
  const visit = (node: RootNode | ElementNode) => {
    if (node.type === 1 && node.tag.toLowerCase() === 'script') {
      const attributes = node.props.filter(prop => prop.type === 6);
      if (attributes.some(prop => prop.name.toLowerCase() === 'type' && prop.value?.content === 'module')) {
        modules++;
        hasAsyncModule ||= attributes.some(prop => prop.name.toLowerCase() === 'async');
      }
    }
    for (const child of node.children) if (child.type === 1) visit(child);
  };
  try { visit(parse(html)); } catch { return false; }
  return modules > 0 && !hasAsyncModule;
};
export function matchesRoute(route: string | string[] | undefined, pathname: string): boolean {
  return (Array.isArray(route) ? route : [route ?? '/']).some(pattern => {
    const parts = pattern.split('/').filter(Boolean);
    const expression = parts.map(part => wildcard(part) ? '.*' : part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
    return new RegExp(`^/${expression}/?$`).test(pathname);
  });
}
export function selectPageTarget(targets: SkeletonTarget[], pathname: string): SkeletonTarget | undefined {
  let selected: SkeletonTarget | undefined;
  let selectedScore: number[] = [];
  for (const target of targets) {
    if (target.kind !== 'page') continue;
    for (const pattern of Array.isArray(target.route) ? target.route : [target.route ?? '/']) {
      if (!matchesRoute(pattern, pathname)) continue;
      const parts = pattern.split('/').filter(Boolean);
      const score = parts.length ? parts.map(part => wildcard(part) ? 0 : part.startsWith(':') ? 2 : 3) : [3];
      let better = !selected;
      for (let i = 0; selected && i < Math.max(score.length, selectedScore.length); i++) {
        const delta = (score[i] ?? 1) - (selectedScore[i] ?? 1);
        if (delta) { better = delta > 0; break; }
      }
      if (better) { selected = target; selectedScore = score; }
    }
  }
  return selected;
}
export function withSkelCast(config: UserConfigExport): UserConfigExport {
  const add = (value: UserConfig): UserConfig => ({ ...value, plugins: [...value.plugins ?? [], skelcastPlugin()] });
  if (typeof config === 'function') return async (env: ConfigEnv) => add(await config(env));
  if (config && typeof (config as Promise<UserConfig>).then === 'function') return Promise.resolve(config).then(add);
  return add(config as UserConfig);
}
const firstScreen = (artifact: SkeletonArtifact, reuse = false) => {
  const view = artifact.variants[artifact.defaultVariant];
  const separator = '/* skelcast-shared-base */', index = view.css.indexOf(separator);
  let styles = `<style>${escapeStyle(view.css)}</style>`;
  if (reuse) {
    styles = `<style data-sk-initial-style>${escapeStyle(index < 0 ? view.css : view.css.slice(0, index))}</style>`;
    if (index >= 0) styles += `<style data-sk-initial-base>${escapeStyle(view.css.slice(index + separator.length))}</style>`;
  }
  const content = styles + view.html;
  return `<div data-sk-initial="${escapeAttribute(artifact.id)}" aria-hidden="true" style="position:fixed;inset:0;z-index:9990;overflow:auto;background:var(--skeleton-page-background,#f5f7fa)">${artifact.render === 'shadow' ? `<template shadowrootmode="open">${content}</template>` : content}</div>`;
};

export interface SkelcastPluginOptions {
  /** Minify skeleton CSS, share base CSS and remove unused source markers in production. Defaults on. */
  optimize?: boolean;
  /** Reuse the inline default page view in single-HTML client builds. Defaults on. */
  reuseInitial?: boolean;
}

export function skelcastPlugin(options: SkelcastPluginOptions = {}): Plugin {
  let project: Project;
  let dev = false;
  let server: ViteDevServer | undefined;
  let mutation = Promise.resolve();
  const requests = new Set<Promise<void>>();
  let closing = false;
  let optimizer = createArtifactOptimizer();
  const sharedStyles = new Map<string, string>();
  const optimize = () => !dev && options.optimize !== false;
  let initial: { file: string; target: SkeletonTarget; baseCSS?: string } | undefined;
  const refreshProject = async () => { project = await loadProject(project.root); };
  const sendUpdate = () => server?.ws.send({ type: 'custom', event: 'skelcast:update', data: {} });
  return {
    name: 'skelcast',
    enforce: 'pre',
    config(config) {
      // Ignore storage bookkeeping in Vite itself, before its HTML/HMR handlers.
      // Filtering only our notification listener still allows full-page reloads.
      if (config.server?.watch === null) return;
      return { server: { watch: { ignored: transientPatterns } } };
    },
    async closeBundle() {
      closing = true;
      await Promise.allSettled([...requests]);
    },
    async configResolved(config) {
      project = await loadProject(config.root);
      dev = config.command === 'serve';
      initial = undefined;
      if (!optimize() || options.reuseInitial === false || config.build.ssr || config.build.lib) return;
      const input = config.build.rolldownOptions?.input ?? config.build.rollupOptions.input ?? path.join(config.root, 'index.html');
      const entries = typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input);
      if (entries.length !== 1 || !entries[0].endsWith('.html')) return;
      const file = path.resolve(config.root, entries[0]);
      const relative = path.relative(config.root, file).split(path.sep).join('/');
      if (relative.startsWith('../')) return;
      const html = await readFile(file, 'utf8');
      // Async entry modules can evaluate before the body is parsed.
      if (!deferredEntry(html)) return;
      const target = selectPageTarget(project.config.targets, relative === 'index.html' ? '/' : '/' + relative);
      if (target) initial = { file, target };
    },
    async buildStart() {
      sharedStyles.clear();
      optimizer = createArtifactOptimizer(message => this.warn(message));
      const statuses = await checkProject(project);
      const invalid = statuses.filter(s => dev ? ['missing', 'corrupt'].includes(s.state) : s.state !== 'ready');
      if (invalid.length) this.error(`Skeleton artifacts need sync: ${invalid.map(s => `${s.id}: ${s.reason}`).join(', ')}. Run pnpm exec skelcast sync.`);
      if (initial) {
        const artifact = optimizer.artifact(await readArtifact(project, initial.target.id));
        const css = artifact.variants[artifact.defaultVariant].css;
        const separator = '/* skelcast-shared-base */', index = css.indexOf(separator);
        initial.baseCSS = index < 0 ? undefined : css.slice(index + separator.length);
      }
    },
    resolveId(id) {
      if (id === initialModule) return initialInternal;
      if (id.startsWith(sharedPrefix)) return id;
      if (id.startsWith(modulePrefix)) return `${internalPrefix}${id.slice(modulePrefix.length)}`;
    },
    async load(id) {
      if (id === initialInternal) {
        if (!initial) this.error('SkelCast initial reuse requires one HTML entry with a page skeleton.');
        const runtime = fileURLToPath(new URL('./runtime/initial.js', import.meta.url));
        return `import { captureInitialView } from ${JSON.stringify(runtime)};export default captureInitialView(${JSON.stringify(initial.target.id)});`;
      }
      if (id.startsWith(sharedPrefix)) {
        const css = sharedStyles.get(id);
        if (css === undefined) this.error(`Unknown SkelCast shared stylesheet: ${id}`);
        return sharedStyleModule(css, initial?.baseCSS === css ? initialModule : undefined);
      }
      if (!id.startsWith(internalPrefix)) return;
      const artifact = previewArtifact(await readArtifact(project, id.slice(internalPrefix.length)));
      if (optimize()) return optimizer.module(artifact, css => {
        const id = sharedPrefix + digest(css);
        sharedStyles.set(id, css);
        return id;
      }, initial?.target.id === artifact.id ? initialModule : undefined);
      return `export default ${JSON.stringify(artifact)};`;
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(_html, context) {
        const rawPath = new URL(context.originalUrl ?? context.path, 'http://localhost').pathname;
        const pathname = rawPath === '/index.html' ? '/' : rawPath;
        const target = selectPageTarget(project.config.targets, pathname);
        const tags: any[] = [];
        if (target) {
          const artifact = await readArtifact(project, target.id);
          const reuse = !!initial && path.resolve(context.filename) === initial.file && target.id === initial.target.id;
          tags.push({ tag: 'div', attrs: { 'data-sk-initial-container': '' }, children: firstScreen(optimize() ? optimizer.artifact(artifact) : artifact, reuse), injectTo: 'body-prepend' });
          // Run before application entries, including when the page artifact itself is lazy.
          if (reuse) tags.push({ tag: 'script', attrs: { type: 'module', src: initialModule }, injectTo: 'head-prepend' });
        }
        if (dev) tags.push({ tag: 'script', attrs: { type: 'module', src: `/@fs/${fileURLToPath(new URL('./client.js', import.meta.url))}` }, injectTo: 'head-prepend' });
        return tags;
      },
    },
    configureServer(viteServer) {
      server = viteServer;
      const dist = path.dirname(fileURLToPath(import.meta.url));
      if (!server.config.server.fs.allow.includes(dist)) server.config.server.fs.allow.push(dist);
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/__skelcast/')) return next();
        if (closing) { res.statusCode = 503; res.end('SkelCast server closing'); return; }
        const operation = (async () => {
          try {
            if (req.method === 'GET' && url.pathname === '/__skelcast/state') {
              await refreshProject();
              const { statuses, artifacts } = await withProjectLock(project.outDir, async () => {
                const statuses = await checkProject(project);
                const available = project.config.targets.filter(t => !statuses.some(status => status.id === t.id && ['missing', 'corrupt'].includes(status.state)));
                return {
                  statuses,
                  artifacts: await Promise.all(available.map(async t => previewArtifact(await readArtifact(project, t.id)))),
                };
              });
              res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
              res.end(JSON.stringify({ artifacts, statuses })); return;
            }
            if (req.method !== 'POST' || url.pathname !== '/__skelcast/sync') { res.statusCode = 404; res.end(); return; }
            const origin = req.headers.origin;
            if (req.headers['x-skelcast-dev'] !== '1' || origin && new URL(origin).host !== req.headers.host) { res.statusCode = 403; res.end('Development requests only'); return; }
            let body = '';
            for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Request too large'); }
            // Serialize preview regeneration requests.
            const operation = mutation.then(async () => {
              await refreshProject();
              const result = await syncProject(project);
              sendUpdate();
              return result;
            });
            mutation = operation.then(() => {}, () => {});
            const result = await operation;
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        })();
        requests.add(operation);
        void operation.finally(() => requests.delete(operation));
      });
      let timer: ReturnType<typeof setTimeout>;
      server.watcher.on('all', (_event, file) => {
        if (!file.startsWith(project.root) || file.includes(`${path.sep}node_modules${path.sep}`)) return;
        if (transientFile(file)) return;
        clearTimeout(timer); timer = setTimeout(sendUpdate, 100);
      });
      server.httpServer?.once('close', () => clearTimeout(timer));
    },
    async handleHotUpdate(context) {
      if (transientFile(context.file)) return [];
      if (context.file.startsWith(project.outDir)) {
        for (const mod of context.server.moduleGraph.idToModuleMap.values()) if (mod.id?.startsWith(internalPrefix)) context.server.moduleGraph.invalidateModule(mod);
        sendUpdate();
        return [];
      }
    },
  };
}
export default skelcastPlugin;
