import React from 'react';
export default function ProjectTable({ rows }) {
  return <div className="table-scroll"><table><thead><tr><th>Project</th><th>Owner</th><th>Action</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{row.title}</td><td>{row.owner}</td><td><button>Open</button></td></tr>)}</tbody></table></div>;
}
