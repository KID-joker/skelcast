import type { Plugin } from 'vite';

export function demoAPI(): Plugin {
  return {
    name: 'demo-api',
    configureServer(server) {
      server.middlewares.use('/api/products', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const timer = setTimeout(() => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ items: [
            { id: 1, title: 'Workspace design system', description: '24 components · Updated today', category: 'Design assets', color: '#c8d9cd', symbol: '◈' },
            { id: 2, title: 'Brand identity guidelines', description: '12 documents · Updated yesterday', category: 'Brand documents', color: '#d9cbe3', symbol: 'Aa' },
            { id: 3, title: 'Product interaction prototypes', description: '8 prototypes · Updated 2 days ago', category: 'Interaction design', color: '#dce1b8', symbol: '⌘' },
            { id: 4, title: 'Mobile icon collection', description: '128 icons · Updated 3 days ago', category: 'Design assets', color: '#c4d5e4', symbol: '✳' },
            { id: 5, title: 'User research library', description: '36 reports · Updated 4 days ago', category: 'Research', color: '#e6cdbb', symbol: '↗' },
            { id: 6, title: 'Content creation templates', description: '16 templates · Updated last week', category: 'Content templates', color: '#cdd8dc', symbol: '▤' },
          ] }));
        }, Math.min(Number(url.searchParams.get('delay')) || 1100, 5000));
        res.on('close', () => clearTimeout(timer));
      });
    },
  };
}
