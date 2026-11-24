import { LoadingBoundary } from 'skelcast/react';
import listSkeleton from 'virtual:skelcast/products.list';
import ProductGrid, { type Product } from './ProductGrid';
import styles from './catalog.module.css';

export default function CatalogPage({ items, mode, pending, onMode, onRefresh }: { items: Product[]; mode: string; pending: boolean; onMode: (mode: string) => void; onRefresh: () => void }) {
  return <div className={styles.shell}>
    <aside className={styles.sidebar}><div className={styles.brand}>◈ &nbsp; Formspace</div><small>Workspace</small><a className={styles.active}>▦ &nbsp; Overview</a><a>◇ &nbsp; My projects</a><a>▤ &nbsp; Team documents</a><a>☆ &nbsp; Favorites</a><div className={styles.sideFooter}>DEVELOPMENT<br/>React · Source-derived skeletons</div></aside>
    <main className={styles.main}>
      <header className={styles.topbar}><span>Workspace <span className={styles.muted}> / Overview</span></span><span className={styles.avatar}>J</span></header>
      <section className={styles.intro}><span className={styles.eyebrow}>YOUR CREATIVE WORKSPACE</span><h1>A home for good ideas<span> ✳</span></h1><p>Your team’s design assets, documents, and inspiration. All in one place.</p></section>
      <div className={styles.stats}><div><span>Total assets</span><strong>224 <small>↗ 12.8%</small></strong></div><div><span>Active projects</span><strong>18 <small>4 new this month</small></strong></div><div><span>Team members</span><strong>12 <small>Creating together</small></strong></div></div>
      <section className={styles.library}><div className={styles.sectionHead}><div><h2>Recently updated</h2><p>Explore the latest work from your team</p></div><div className={styles.controls}><input aria-label="Search assets" placeholder="Search assets…"/><button onClick={onRefresh}>Refresh assets</button><button aria-pressed={mode === 'grid'} onClick={() => onMode('grid')}>Grid</button><button aria-pressed={mode === 'list'} onClick={() => onMode('list')}>List</button></div></div>
      <LoadingBoundary artifact={listSkeleton} pending={pending} variant={mode}><ProductGrid items={items} mode={mode}/></LoadingBoundary></section>
      <footer className={styles.footer}>FORM FOLLOWS IDEAS <span>Real request loading · React / Vue · Static artifacts</span></footer>
    </main>
  </div>;
}
