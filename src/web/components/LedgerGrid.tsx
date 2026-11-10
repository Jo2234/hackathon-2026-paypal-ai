import { useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { BudgetSnapshot } from '../../shared/types.ts';
import { csvCell, money } from '../api.ts';

ModuleRegistry.registerModules([AllCommunityModule]);
export type LedgerRow = { seq: number; at: number; kind: string; note: string; source: string; amountMinor: number; availableAfter: number; reservedAfter: number; capturedAfter: number; restoredAfter: number; refundedCompletedAfter: number; reservationId?: string | null; ruleIds?: string[]; paypal?: Record<string, string> };
const theme = themeQuartz.withParams({ accentColor: '#087a62', backgroundColor: '#ffffff', headerBackgroundColor: '#f1f5f3', foregroundColor: '#192c27', borderColor: '#dfe8e3', fontFamily: 'system-ui, sans-serif', fontSize: 13, headerFontSize: 12, rowHeight: 52 });
export function LedgerGrid({ rows, totals }: { rows: LedgerRow[]; totals: BudgetSnapshot | null }) {
  const grid = useRef<AgGridReact<LedgerRow>>(null); const [filter, setFilter] = useState('');
  const columns = useMemo<ColDef<LedgerRow>[]>(() => [
    { field: 'seq', headerName: '#', width: 75, pinned: 'left' },
    { field: 'kind', headerName: 'Event', width: 145, cellRenderer: (p: ICellRendererParams<LedgerRow>) => <span className={`event event-${p.data?.kind.toLowerCase()}`}>{p.value}</span> },
    { field: 'at', headerName: 'Time · SGT', width: 155, valueFormatter: p => p.node?.rowPinned ? '' : new Date(Number(p.value)).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
    { field: 'amountMinor', headerName: 'Event amount', width: 140, valueFormatter: p => p.node?.rowPinned ? '' : money(p.value as number) },
    { field: 'availableAfter', headerName: 'Available', width: 130, valueFormatter: p => money(p.value as number), cellClassRules: { 'negative-money': p => Number(p.value) < 0 } },
    { field: 'reservedAfter', headerName: 'Held', width: 120, valueFormatter: p => money(p.value as number) },
    { field: 'capturedAfter', headerName: 'Gross captured', width: 150, valueFormatter: p => money(p.value as number) },
    { field: 'refundedCompletedAfter', headerName: 'Refunds completed', width: 175, valueFormatter: p => money(p.value as number) },
    { field: 'restoredAfter', headerName: 'Restored', width: 120, valueFormatter: p => money(p.value as number) },
    { field: 'note', headerName: 'Evidence / note', minWidth: 300, flex: 1, tooltipField: 'note' },
    { colId: 'providerIds', headerName: 'Provider identifiers', minWidth: 230, valueGetter: p => Object.entries(p.data?.paypal ?? {}).map(([kind, id]) => `${kind}: ${id}`).join(' · ') },
    { field: 'source', headerName: 'Source', width: 110 },
  ], []);
  const pinned: LedgerRow[] = totals ? [{ seq: 0, at: 0, kind: 'TOTALS', note: 'Current server snapshot · not a browser sum', source: 'local snapshot', amountMinor: 0, availableAfter: totals.availableMinor, reservedAfter: totals.reservedMinor, capturedAfter: totals.capturedMinor, restoredAfter: totals.restoredMinor, refundedCompletedAfter: totals.refundedCompletedMinor }] : [];
  return <section className="panel ledger-panel"><div className="panel-heading"><div><p className="eyebrow">Append-only evidence</p><h2>Ledger</h2></div><div className="toolbar"><input aria-label="Filter ledger" placeholder="Filter events or notes…" value={filter} onChange={e => setFilter(e.target.value)} /><button className="secondary" disabled={!rows.length} onClick={() => grid.current?.api.exportDataAsCsv({ fileName: 'mandate-ledger.csv', processCellCallback: p => csvCell(p.value) })}>Export CSV</button></div></div><p className="subtle">Counters are copied from server transactions. Gross captures and completed refunds remain separate.</p><div className="ledger-grid"><AgGridReact<LedgerRow> ref={grid} theme={theme} rowData={rows} columnDefs={columns} defaultColDef={{ sortable: true, resizable: true, filter: true }} quickFilterText={filter} enableCellTextSelection={true} pinnedBottomRowData={pinned} getRowId={p => String(p.data.seq)} rowClassRules={{ 'anomaly-row': p => p.data?.kind === 'ANOMALY' || Number(p.data?.availableAfter) < 0 }} overlayNoRowsTemplate="<span>No activity yet. Sign a mandate and reserve a cart.</span>" /></div></section>;
}
