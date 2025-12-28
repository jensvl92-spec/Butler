import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { logger } from '../utils/logger';
const DebugContext = createContext(undefined);
export function DebugProvider({ children }) {
    const [logs, setLogs] = useState([]);
    // Sync with LoggerService on mount and periodically
    const refreshLogs = useCallback(() => {
        setLogs([...logger.getLogs()]);
    }, []);
    useEffect(() => {
        refreshLogs();
        // Optional: Poll for changes if multiple sources write to logger
        const interval = setInterval(refreshLogs, 2000);
        return () => clearInterval(interval);
    }, [refreshLogs]);
    const addLog = (level, source, message, details) => {
        const fullMessage = `[${source}] ${message}`;
        // Write to persistent logger
        if (level === 'INFO')
            logger.info(fullMessage, details);
        else if (level === 'WARN')
            logger.warn(fullMessage, details);
        else
            logger.error(fullMessage, details);
        // Update local state immediately
        refreshLogs();
    };
    const clearLogs = () => {
        logger.clearLogs();
        refreshLogs();
    };
    const exportLogs = async () => {
        await logger.downloadLogs();
    };
    return (_jsx(DebugContext.Provider, { value: { logs, addLog, clearLogs, exportLogs }, children: children }));
}
export function useDebug() {
    const context = useContext(DebugContext);
    if (context === undefined) {
        throw new Error('useDebug must be used within a DebugProvider');
    }
    return context;
}
