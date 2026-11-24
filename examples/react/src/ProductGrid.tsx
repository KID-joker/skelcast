import styles from './catalog.module.css';
export interface Product { id: number; title: string; description: string; category: string; color: string; symbol: string }
export default function ProductGrid({ items, mode = 'grid' }: { items: Product[]; mode?: string }) {
  return <div className={mode === 'grid' ? styles.grid : styles.list}>
    {items.map(item => <article className={styles.card} key={item.id}>
      <div className={styles.cover} style={{ backgroundColor: item.color }}><span className={styles.symbol}>{item.symbol}</span><span className={styles.tag}>{item.category}</span></div>
      <div className={styles.cardBody}><h3>{item.title}</h3><p>{item.description}</p></div>
    </article>)}
  </div>;
}
