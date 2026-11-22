import React, { useEffect, useState } from 'react';
import Chart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { useApp } from '../lib/AppContext';
import { AIChat } from './AIChat';

export interface GraphSeries {
    entity_id: string;
    label: string;
    color?: string;
    yAxis?: 'left' | 'right';
}

export interface GraphConfig {
    id: string;
    title: string;
    period: '1d' | '3d' | '7d' | '10d';
    series: GraphSeries[];
    createdAt: number;
}

interface GraphsProps {
    onBack: () => void;
}

const STORAGE_KEY = 'butler_graphs';
const MAX_GRAPHS = 5;

// Period to milliseconds
const periodToMs: Record<string, number> = {
    '1d': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '10d': 10 * 24 * 60 * 60 * 1000,
};

// Default colors for series
const defaultColors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

class ChartErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: any) {
        return { hasError: true, error };
    }

    componentDidCatch(error: any, errorInfo: any) {
        console.error("ApexCharts Error:", error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{ height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#ef4444', textAlign: 'center', padding: '16px' }}>
                    <p style={{ fontWeight: 'bold' }}>⚠️ Graph Error</p>
                    <p style={{ fontSize: '0.8rem', marginTop: '8px' }}>{this.state.error?.message || 'Unknown render error'}</p>
                </div>
            );
        }
        return this.props.children;
    }
}

// Memoized Graph Card Component to prevent re-renders
const GraphCard = React.memo(({ graph, data, onDelete, loading, error }: {
    graph: GraphConfig;
    data: any;
    onDelete: (id: string) => void;
    loading: boolean;
    error: string | undefined;
}) => {

    // Build options with useMemo
    const options = React.useMemo<ApexOptions>(() => {
        const hasRightAxis = graph.series.some(s => s.yAxis === 'right');
        const now = Date.now();
        const minTime = now - periodToMs[graph.period];

        return {
            chart: {
                type: 'line',
                height: 300,
                background: 'transparent',
                toolbar: { show: true, tools: { download: false, zoom: false, selection: false, zoomin: true, zoomout: true, pan: false, reset: true } },
                zoom: { enabled: false },
                animations: { enabled: false }
            },
            theme: { mode: 'dark' },
            stroke: { curve: 'smooth', width: 2 },
            xaxis: {
                type: 'datetime',
                labels: { datetimeUTC: false },
                min: minTime,
                max: now,
                tooltip: { enabled: false } // Disable tooltip on axis to prevent potential crashes
            },
            yaxis: hasRightAxis ? [
                { title: { text: 'Left Axis' }, seriesName: graph.series.filter(s => s.yAxis !== 'right').map(s => s.label) },
                { opposite: true, title: { text: 'Right Axis' }, seriesName: graph.series.filter(s => s.yAxis === 'right').map(s => s.label) }
            ] : undefined,
            tooltip: { x: { format: 'MMM dd HH:mm' } }, // Tooltip format
            legend: { position: 'top' },
            colors: graph.series.map((s, i) => s.color || defaultColors[i % defaultColors.length]),
            grid: { borderColor: 'var(--border)' }
        };
    }, [graph]);

    // Build series with useMemo
    const series = React.useMemo(() => {
        if (!data) return [];
        return graph.series.map(s => ({
            name: s.label,
            data: data[s.entity_id] || []
        }));
    }, [graph, data]);

    const hasData = series.some(s => s.data.length > 0);

    return (
        <div
            style={{
                background: 'var(--bg-card)',
                borderRadius: '16px',
                border: '1px solid var(--border)',
                padding: '16px',
                position: 'relative'
            }}
        >
            {/* Graph Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div>
                    <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{graph.title}</h3>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                        {graph.period} • {graph.series.length} series
                    </span>
                </div>
                <button
                    onClick={() => onDelete(graph.id)}
                    style={{
                        background: 'rgba(239, 68, 68, 0.2)',
                        border: 'none',
                        borderRadius: '8px',
                        padding: '8px 12px',
                        color: '#ef4444',
                        cursor: 'pointer'
                    }}
                >
                    Delete
                </button>
            </div>

            {/* Chart */}
            {loading ? (
                <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span>Loading...</span>
                </div>
            ) : error ? (
                <div style={{ height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                    <span style={{ fontSize: '2rem', marginBottom: '8px' }}>📉</span>
                    <span>{error}</span>
                    <span style={{ fontSize: '0.8rem', marginTop: '4px' }}>Try asking Butler for specific sensor entity IDs</span>
                </div>
            ) : !hasData ? (
                <div style={{ height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                    <span style={{ fontSize: '2rem', marginBottom: '8px' }}>📊</span>
                    <span>No data points found</span>
                </div>
            ) : (
                <ChartErrorBoundary>
                    <Chart
                        key={`${graph.id}-${data ? 'loaded' : 'loading'}`} // Force remount if loading state changes
                        options={options}
                        series={series}
                        type="line"
                        height={300}
                    />
                </ChartErrorBoundary>
            )}
        </div>
    );
});

// Main Component
export function Graphs({ onBack }: GraphsProps) {
    const { activeConnection } = useApp();
    const [graphs, setGraphs] = useState<GraphConfig[]>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            const parsed = stored ? JSON.parse(stored) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error('Failed to parse stored graphs:', e);
            return [];
        }
    });
    const [chartData, setChartData] = useState<Record<string, any>>({});
    const [loading, setLoading] = useState<Record<string, boolean>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});

    // Stay in sync when a graph is created while Graphs view is already open
    useEffect(() => {
        const handleExternalUpdate = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (Array.isArray(detail)) {
                setGraphs(detail);
            }
        };
        window.addEventListener('butler-graphs-updated', handleExternalUpdate);
        return () => window.removeEventListener('butler-graphs-updated', handleExternalUpdate);
    }, []);

    // Save graphs to localStorage when they change
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(graphs));
        } catch { }
    }, [graphs]);

    // Fetch HA history for a graph
    const fetchGraphData = async (graph: GraphConfig, signal?: AbortSignal) => {
        if (!activeConnection) return;

        setLoading(prev => ({ ...prev, [graph.id]: true }));
        setErrors(prev => ({ ...prev, [graph.id]: '' }));

        try {
            const now = new Date();
            const periodMs = periodToMs[graph.period] || periodToMs['24h'];
            const startTime = new Date(now.getTime() - periodMs);
            const cleanBase = (activeConnection.api_url || '').trim().replace(/\/+$/, '');
            const token = (activeConnection.api_token || activeConnection.token || '').trim();

            const allSeriesData: Record<string, { x: number; y: number }[]> = {};
            let hasAnyData = false;
            const failedEntities: string[] = [];

            await Promise.all(graph.series.map(async (s) => {
                try {
                    const url = `${cleanBase}/api/history/period/${encodeURIComponent(startTime.toISOString())}?filter_entity_id=${encodeURIComponent(s.entity_id)}&end_time=${encodeURIComponent(now.toISOString())}`;

                    const res = await fetch(url, {
                        headers: { Authorization: `Bearer ${token}` },
                        signal
                    });

                    if (!res.ok) {
                        failedEntities.push(s.entity_id);
                        allSeriesData[s.entity_id] = [];
                        return;
                    }

                    const data = await res.json();
                    const history = Array.isArray(data?.[0]) ? data[0] : [];

                    const points = history
                        .filter((p: any) => !isNaN(Number(p.state)) && !isNaN(new Date(p.last_changed || p.last_updated).getTime()))
                        .map((p: any) => ({
                            x: new Date(p.last_changed || p.last_updated).getTime(),
                            y: Number(p.state)
                        }));

                    allSeriesData[s.entity_id] = points;
                    if (points.length > 0) hasAnyData = true;
                } catch (e: any) {
                    if (e?.name === 'AbortError') return;
                    failedEntities.push(s.entity_id);
                    allSeriesData[s.entity_id] = [];
                }
            }));

            if (signal?.aborted) return;
            setChartData(prev => ({ ...prev, [graph.id]: allSeriesData }));

            if (!hasAnyData) {
                const msg = failedEntities.length > 0
                    ? `Sensoren niet gevonden: ${failedEntities.join(', ')}`
                    : 'Geen data beschikbaar voor deze periode';
                setErrors(prev => ({ ...prev, [graph.id]: msg }));
            }
        } catch (e: any) {
            if (e?.name === 'AbortError') return;
            setErrors(prev => ({ ...prev, [graph.id]: 'Kon grafiekdata niet laden' }));
        } finally {
            if (!signal?.aborted) {
                setLoading(prev => ({ ...prev, [graph.id]: false }));
            }
        }
    };

    const graphSignature = graphs.map(g => `${g.id}:${g.period}`).join('|');

    useEffect(() => {
        const controller = new AbortController();
        graphs.forEach(g => fetchGraphData(g, controller.signal));
        return () => controller.abort();
    }, [graphSignature, activeConnection?.id]);

    const deleteGraph = (id: string) => {
        setGraphs(prev => prev.filter(g => g.id !== id));
    };

    return (
        <div style={{ padding: '16px', minHeight: '100vh', background: 'var(--bg-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                <button
                    onClick={onBack}
                    style={{
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        padding: '8px 12px',
                        color: 'var(--text-primary)',
                        cursor: 'pointer'
                    }}
                >
                    ← Terug
                </button>
                <h1 style={{ margin: 0, fontSize: '1.5rem' }}>📊 Grafieken</h1>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    ({graphs.length}/{MAX_GRAPHS})
                </span>
            </div>

            {graphs.length === 0 && (
                <div style={{
                    textAlign: 'center',
                    padding: '48px 24px',
                    background: 'var(--bg-card)',
                    borderRadius: '16px',
                    border: '1px solid var(--border)'
                }}>
                    <div style={{ fontSize: '3rem', marginBottom: '16px' }}>📈</div>
                    <h2 style={{ margin: '0 0 8px 0' }}>Nog geen grafieken</h2>
                    <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                        Vraag Butler om een grafiek te maken, bv.<br />
                        <em>"Toon een grafiek van de woonkamertemperatuur van de laatste 24 uur"</em>
                    </p>
                </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {graphs.map(graph => (
                    <GraphCard
                        key={graph.id}
                        graph={graph}
                        data={chartData[graph.id]}
                        onDelete={deleteGraph}
                        loading={!!loading[graph.id]}
                        error={errors[graph.id]}
                    />
                ))}
                <div style={{
                    marginTop: '24px',
                    background: 'var(--bg-card)',
                    borderRadius: '16px',
                    border: '1px solid var(--border)',
                    height: '400px',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    boxShadow: 'var(--shadow-lg)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: '1.2rem' }}>🤖</span>
                        <h3 style={{ margin: 0, fontSize: '1rem' }}>Vraag Butler over deze grafieken</h3>
                    </div>
                    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        <AIChat disableGlobalVoiceListeners />
                    </div>
                </div>
            </div>
        </div>
    );
}

// Export helper to add graphs from outside (e.g., from App.tsx action handler)
export function addGraph(
    config: Omit<GraphConfig, 'id' | 'createdAt'>,
    setGraphs: React.Dispatch<React.SetStateAction<GraphConfig[]>>
) {
    const newGraph: GraphConfig = {
        ...config,
        id: `graph_${Date.now()}`,
        createdAt: Date.now()
    };

    setGraphs(prev => {
        // Remove oldest if at max
        const updated = prev.length >= MAX_GRAPHS
            ? [...prev.slice(1), newGraph]
            : [...prev, newGraph];

        // Save to localStorage immediately
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        return updated;
    });
}
