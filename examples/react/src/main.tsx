import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LoadingBoundary } from 'skelcast/react';
import { releasePageSkeleton } from 'skelcast/runtime';
import pageSkeleton from 'virtual:skelcast/products.page';
import CatalogPage from './CatalogPage';
import type { Product } from './ProductGrid';
import './global.css';

function App() {
  const [loggedIn, setLoggedIn] = useState(sessionStorage.getItem('demo-login') === 'yes');
  const [items, setItems] = useState<Product[]>([]);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState('grid');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => { releasePageSkeleton({ preview: loggedIn }); }, [loggedIn]);
  useEffect(() => {
    if (!loggedIn) return;
    const controller = new AbortController();
    setPending(true); setError('');
    fetch('/api/products', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }).then(data => setItems(data.items)).catch(error => { if (error.name !== 'AbortError') setError(String(error)); }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [loggedIn, reload]);
  if (!loggedIn) return <main className="login"><div><span className="logo">◈</span><p>FORM SPACE / LOCAL DEMO</p><h1>Welcome to your workspace</h1><p>Sign in to explore real loading states and skeleton previews.</p><button onClick={() => { sessionStorage.setItem('demo-login', 'yes'); setLoggedIn(true); }}>Enter demo workspace</button><small>Local demo sign-in. No account required.</small></div></main>;
  return <><LoadingBoundary artifact={pageSkeleton} pending={pending && items.length === 0}><CatalogPage items={items} mode={mode} pending={pending && items.length > 0} onMode={setMode} onRefresh={() => setReload(n => n + 1)}/></LoadingBoundary>{error && <div role="alert">{error}</div>}</>;
}
createRoot(document.getElementById('root')!).render(<App/>);
