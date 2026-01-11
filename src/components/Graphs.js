import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useEffect, useState } from 'react';
import Chart from 'react-apexcharts';
import { useApp } from '../lib/AppContext';
import { AIChat } from './AIChat';
const STORAGE_KEY = 'butler_graphs';
const MAX_GRAPHS = 5;
// Period to milliseconds
const periodToMs = {
    '1d': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '10d': 10 * 24 * 60 * 60 * 1000,
};
// Default colors for series
const defaultColors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
class ChartErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        console.error("ApexCharts Error:", error, errorInfo);
    }
    render() {
        if (this.state.hasError) {
            return (_jsxs("div", { style: { height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#ef4444', textAlign: 'center', padding: '16px' }, children: [_jsx("p", { style: { fontWeight: 'bold' }, children: "\u26A0\uFE0F Graph Error" }), _jsx("p", { style: { fontSize: '0.8rem', marginTop: '8px' }, children: this.state.error?.message || 'Unknown render error' })] }));
        }
        return this.props.children;
    }
}
// Memoized Graph Card Component to prevent re-renders
const GraphCard = React.memo(({ graph, data, onDelete, loading, error }) => {
    // Build options with useMemo
    const options = React.useMemo(() => {
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
        if (!data)
            return [];
        return graph.series.map(s => ({
            name: s.label,
            data: data[s.entity_id] || []
        }));
    }, [graph, data]);
    const hasData = series.some(s => s.data.length > 0);
    return (_jsxs("div", { style: {
            background: 'var(--bg-card)',
            borderRadius: '16px',
            border: '1px solid var(--border)',
            padding: '16px',
            position: 'relative'
        }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }, children: [_jsxs("div", { children: [_jsx("h3", { style: { margin: 0, fontSize: '1.1rem' }, children: graph.title }), _jsxs("span", { style: { color: 'var(--text-secondary)', fontSize: '0.8rem' }, children: [graph.period, " \u2022 ", graph.series.length, " series"] })] }), _jsx("button", { onClick: () => onDelete(graph.id), style: {
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: 'none',
                            borderRadius: '8px',
                            padding: '8px 12px',
                            color: '#ef4444',
                            cursor: 'pointer'
                        }, children: "Delete" })] }), loading ? (_jsx("div", { style: { height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }, children: _jsx("span", { children: "Loading..." }) })) : error ? (_jsxs("div", { style: { height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }, children: [_jsx("span", { style: { fontSize: '2rem', marginBottom: '8px' }, children: "\uD83D\uDCC9" }), _jsx("span", { children: error }), _jsx("span", { style: { fontSize: '0.8rem', marginTop: '4px' }, children: "Try asking Butler for specific sensor entity IDs" })] })) : !hasData ? (_jsxs("div", { style: { height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }, children: [_jsx("span", { style: { fontSize: '2rem', marginBottom: '8px' }, children: "\uD83D\uDCCA" }), _jsx("span", { children: "No data points found" })] })) : (_jsx(ChartErrorBoundary, { children: _jsx(Chart, { options: options, series: series, type: "line", height: 300 }, `${graph.id}-${data ? 'loaded' : 'loading'}`) }))] }));
});
// Main Component
export function Graphs({ onBack }) {
    const { activeConnection } = useApp();
    const [graphs, setGraphs] = useState(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        try {
            return stored ? JSON.parse(stored) : [];
        }
        catch (e) {
            console.error('Failed to parse stored graphs:', e);
            return [];
        }
    });
    const [chartData, setChartData] = useState({});
    const [loading, setLoading] = useState({});
    const [errors, setErrors] = useState({});
    // Save graphs to localStorage when they change
    useEffect(() => {
        if (graphs.length > 0) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(graphs));
        }
        else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(graphs));
        }
    }, [graphs]);
    // Fetch HA history for a graph
    const fetchGraphData = async (graph) => {
        if (!activeConnection)
            return;
        setLoading(prev => ({ ...prev, [graph.id]: true }));
        setErrors(prev => ({ ...prev, [graph.id]: '' }));
        try {
            const now = new Date();
            const startTime = new Date(now.getTime() - periodToMs[graph.period]);
            const cleanUrl = new URL(activeConnection.api_url).origin;
            const allSeriesData = {};
            let hasAnyData = false;
            let failedEntities = [];
            // Fetch history for each entity
            await Promise.all(graph.series.map(async (s) => {
                try {
                    const url = `${cleanUrl}/api/history/period/${startTime.toISOString()}?filter_entity_id=${s.entity_id}&end_time=${now.toISOString()}`;
                    const res = await fetch(url, {
                        headers: { 'Authorization': `Bearer ${activeConnection.api_token}` }
                    });
                    if (!res.ok) {
                        console.error(`Failed to fetch history for ${s.entity_id}: ${res.status}`);
                        failedEntities.push(s.entity_id);
                        allSeriesData[s.entity_id] = [];
                        return;
                    }
                    const data = await res.json();
                    const history = data[0] || [];
                    // Convert to chart format
                    const points = history
                        .filter((p) => !isNaN(parseFloat(p.state)) && !isNaN(new Date(p.last_changed).getTime()))
                        .map((p) => ({
                        x: new Date(p.last_changed).getTime(),
                        y: parseFloat(p.state)
                    }));
                    allSeriesData[s.entity_id] = points;
                    if (points.length > 0)
                        hasAnyData = true;
                }
                catch (e) {
                    console.error(`Error fetching ${s.entity_id}:`, e);
                    failedEntities.push(s.entity_id);
                    allSeriesData[s.entity_id] = [];
                }
            }));
            setChartData(prev => ({ ...prev, [graph.id]: allSeriesData }));
            if (!hasAnyData) {
                const msg = failedEntities.length > 0
                    ? `Sensors not found: ${failedEntities.join(', ')}`
                    : 'No data available for selected period';
                setErrors(prev => ({ ...prev, [graph.id]: msg }));
            }
        }
        catch (e) {
            console.error('Failed to fetch graph data:', e);
            setErrors(prev => ({ ...prev, [graph.id]: 'Failed to load data' }));
        }
        finally {
            setLoading(prev => ({ ...prev, [graph.id]: false }));
        }
    };
    // Fetch data for all graphs on mount and when graphs change
    useEffect(() => {
        graphs.forEach(g => fetchGraphData(g));
    }, [graphs.length, activeConnection]);
    // Delete a graph
    const deleteGraph = (id) => {
        setGraphs(prev => prev.filter(g => g.id !== id));
    };
    return (_jsxs("div", { style: { padding: '16px', minHeight: '100vh', background: 'var(--bg-primary)' }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }, children: [_jsx("button", { onClick: onBack, style: {
                            background: 'var(--bg-card)',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                            padding: '8px 12px',
                            color: 'var(--text-primary)',
                            cursor: 'pointer'
                        }, children: "\u2190 Back" }), _jsx("h1", { style: { margin: 0, fontSize: '1.5rem' }, children: "\uD83D\uDCCA Graphs" }), _jsxs("span", { style: { color: 'var(--text-secondary)', fontSize: '0.9rem' }, children: ["(", graphs.length, "/", MAX_GRAPHS, ")"] })] }), graphs.length === 0 && (_jsxs("div", { style: {
                    textAlign: 'center',
                    padding: '48px 24px',
                    background: 'var(--bg-card)',
                    borderRadius: '16px',
                    border: '1px solid var(--border)'
                }, children: [_jsx("div", { style: { fontSize: '3rem', marginBottom: '16px' }, children: "\uD83D\uDCC8" }), _jsx("h2", { style: { margin: '0 0 8px 0' }, children: "No Graphs Yet" }), _jsxs("p", { style: { color: 'var(--text-secondary)', margin: 0 }, children: ["Ask Butler to create a graph, e.g.", _jsx("br", {}), _jsx("em", { children: "\"Show me living room temperature for the last 3 days\"" })] })] })), _jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: '16px' }, children: [graphs.map(graph => (_jsx(GraphCard, { graph: graph, data: chartData[graph.id], onDelete: deleteGraph, loading: !!loading[graph.id], error: errors[graph.id] }, graph.id))), _jsxs("div", { style: {
                            marginTop: '24px',
                            background: 'var(--bg-card)',
                            borderRadius: '16px',
                            border: '1px solid var(--border)',
                            height: '400px',
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden',
                            boxShadow: 'var(--shadow-lg)'
                        }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderBottom: '1px solid var(--border)' }, children: [_jsx("span", { style: { fontSize: '1.2rem' }, children: "\uD83E\uDD16" }), _jsx("h3", { style: { margin: 0, fontSize: '1rem' }, children: "Ask Butler about these graphs" })] }), _jsx("div", { style: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }, children: _jsx(AIChat, {}) })] })] })] }));
}
// Export helper to add graphs from outside (e.g., from App.tsx action handler)
export function addGraph(config, setGraphs) {
    const newGraph = {
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
