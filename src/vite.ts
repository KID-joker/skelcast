import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigEnv, Plugin, UserConfig, UserConfigExport, ViteDevServer } from 'vite';
import { checkProject, loadProject, readArtifact, saveHints, syncProject, type Project } from './generator.js';
import type { SkeletonArtifact, SkeletonTarget } from './types.js';

const modulePrefix = 'virtual:skelcast/';
const internalPrefix = '\0skelcast:';
const escapeStyle = (s: string) => s.replace(/<\/style/gi, '<\\/style');
const escapeAttribute = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const wildcard = (part: string) => part === '*' || /^:[\w]+\(\.\*\)[*+]?$/.test(part);
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
const firstScreen = (artifact: SkeletonArtifact) => {
  const view = artifact.variants[artifact.defaultVariant];
  const content = `<style>${escapeStyle(view.css)}</style>${view.html}`;
  return `<div data-sk-initial="${escapeAttribute(artifact.id)}" aria-hidden="true" style="position:fixed;inset:0;z-index:9990;overflow:auto;background:var(--skeleton-page-background,#f5f7fa);padding:32px">${artifact.render === 'shadow' ? `<template shadowrootmode="open">${content}</template>` : content}</div>`;
};

export function skelcastPlugin(): Plugin {
  let project: Project;
  let dev = false;
  let server: ViteDevServer | undefined;
  let mutation = Promise.resolve();
  const refreshProject = async () => { project = await loadProject(project.root); };
  const sendUpdate = () => server?.ws.send({ type: 'custom', event: 'skelcast:update', data: {} });
  return {
    name: 'skelcast',
    enforce: 'pre',
    async configResolved(config) {
      project = await loadProject(config.root);
      dev = config.command === 'serve';
    },
    async buildStart() {
      const statuses = await checkProject(project);
      const invalid = statuses.filter(s => dev ? ['missing', 'corrupt'].includes(s.state) : s.state !== 'ready');
      if (invalid.length) this.error(`Skeleton artifacts need sync: ${invalid.map(s => `${s.id}: ${s.reason}`).join(', ')}. Run pnpm exec skelcast sync.`);
    },
    resolveId(id) {
      if (id.startsWith(modulePrefix)) return `${internalPrefix}${id.slice(modulePrefix.length)}`;
    },
    async load(id) {
      if (!id.startsWith(internalPrefix)) return;
      const artifact = await readArtifact(project, id.slice(internalPrefix.length));
      if (!dev) { artifact.diagnostics = []; artifact.evidence = []; artifact.sources = {}; artifact.source = ''; }
      return `export default ${JSON.stringify(artifact)};`;
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(_html, context) {
        const rawPath = new URL(context.originalUrl ?? context.path, 'http://localhost').pathname;
        const pathname = rawPath === '/index.html' ? '/' : rawPath;
        const target = selectPageTarget(project.config.targets, pathname);
        const tags: any[] = [];
        if (target) tags.push({ tag: 'div', attrs: { 'data-sk-initial-container': '' }, children: firstScreen(await readArtifact(project, target.id)), injectTo: 'body-prepend' });
        if (dev) tags.push({ tag: 'script', attrs: { type: 'module', src: `/@fs/${fileURLToPath(new URL('./client.js', import.meta.url))}` }, injectTo: 'head-prepend' });
        return tags;
      },
    },
    configureServer(viteServer) {
      server = viteServer;
      const dist = path.dirname(fileURLToPath(import.meta.url));
      if (!server.config.server.fs.allow.includes(dist)) server.config.server.fs.allow.push(dist);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/__skelcast/')) return next();
        try {
          if (req.method === 'GET' && url.pathname === '/__skelcast/state') {
            await refreshProject();
            const statuses = await checkProject(project);
            const artifacts = await Promise.all(project.config.targets.map(t => readArtifact(project, t.id)));
            res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ artifacts, statuses, targets: project.config.targets })); return;
          }
          if (req.method !== 'POST' || !['/__skelcast/sync', '/__skelcast/hints', '/__skelcast/open'].includes(url.pathname)) { res.statusCode = 404; res.end(); return; }
          const origin = req.headers.origin;
          if (req.headers['x-skelcast-dev'] !== '1' || origin && new URL(origin).host !== req.headers.host) { res.statusCode = 403; res.end('Development requests only'); return; }
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Request too large'); }
          const data = body ? JSON.parse(body) : {};
          // Serialize local mutations so hints and manifest cannot race.
          const operation = mutation.then(async () => {
            await refreshProject();
            if (url.pathname === '/__skelcast/open') {
              const artifact = await readArtifact(project, data.id);
              const source = data.node ? artifact.sources[data.node] : { file: artifact.source, line: 1 };
              if (!source) throw new Error('Unknown source location');
              return { url: `/__open-in-editor?file=${encodeURIComponent(`${path.resolve(project.root, source.file)}:${source.line}`)}` };
            }
            if (url.pathname === '/__skelcast/hints') {
              await saveHints(project, data.id, data.hints); await refreshProject();
            }
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
      });
      let timer: ReturnType<typeof setTimeout>;
      server.watcher.on('all', (_event, file) => {
        if (!file.startsWith(project.root) || file.includes(`${path.sep}node_modules${path.sep}`)) return;
        clearTimeout(timer); timer = setTimeout(sendUpdate, 100);
      });
      server.httpServer?.once('close', () => clearTimeout(timer));
    },
    async handleHotUpdate(context) {
      if (context.file.startsWith(project.outDir)) {
        for (const mod of context.server.moduleGraph.idToModuleMap.values()) if (mod.id?.startsWith(internalPrefix)) context.server.moduleGraph.invalidateModule(mod);
        sendUpdate();
        return [];
      }
    },
  };
}
export default skelcastPlugin;
