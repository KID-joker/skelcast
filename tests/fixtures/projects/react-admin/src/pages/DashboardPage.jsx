import React, { useEffect, useState } from 'react';
import ProjectTable from '@/components/ProjectTable.jsx';
import styles from './dashboard.module.css';
export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  useEffect(() => { const timer = setTimeout(() => { setData({ projects: [{ id: 1, title: 'Design', owner: 'Alex' }, { id: 2, title: 'Platform', owner: 'Kim' }, { id: 3, title: 'Mobile', owner: 'Pat' }, { id: 4, title: 'Docs', owner: 'Sam' }] }); setLoading(false); }, 400); return () => clearTimeout(timer); }, []);
  return <main><nav>Workspace / Projects</nav><h1>Project dashboard</h1><section className={styles.summary}><article>Active<strong>4</strong></article><article>Members<strong>12</strong></article><article>Reviews<strong>8</strong></article></section><section className={styles.panel}><h2 className={styles.heading}>Recent projects</h2><input aria-label="Project filter" placeholder="Filter projects"/>{loading ? <p role="status">Loading projects</p> : data && <ProjectTable rows={data.projects}/>}</section></main>;
}
