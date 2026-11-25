import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api/client';
import { EmptyState, ErrorMessage, LoadingState, PageTitle, Panel } from '../components/ui';

type AuditRow = { id: string; actor: string; action: string; target: string; ip: string; details: string; createdAt: string };
export default function Audit() {
  const query = useQuery({ queryKey: ['audit'], queryFn: () => api<{ logs: AuditRow[] }>('/audit-logs?limit=100') });
  if (query.isLoading) return <LoadingState />;
  return <div className="page-stack"><PageTitle eyebrow="KEAMANAN & AKUNTABILITAS" title="Audit aktivitas" description="Riwayat tindakan admin dan operasi pintu dari panel." />
    {query.isError && <ErrorMessage>{(query.error as Error).message}</ErrorMessage>}
    <Panel className="table-panel"><div className="table-scroll"><table><thead><tr><th>WAKTU</th><th>PELAKU</th><th>TINDAKAN</th><th>TARGET</th><th>IP</th><th>DETAIL</th></tr></thead>
      <tbody>{query.data?.logs.map((row) => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString('id-ID')}</td>
        <td>{row.actor}</td><td><span className="audit-action">{row.action}</span></td><td className="mono">{row.target}</td><td className="mono">{row.ip}</td>
        <td className="audit-detail">{row.details}</td></tr>)}</tbody></table></div>
      {!query.data?.logs.length && <EmptyState>Belum ada tindakan yang tercatat.</EmptyState>}
    </Panel>
  </div>;
}
