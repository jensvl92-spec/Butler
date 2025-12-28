import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { logger, LogEntry } from '../utils/logger'

interface DebugContextType {
    logs: LogEntry[]
    addLog: (level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string, details?: any) => void
    clearLogs: () => void
    exportLogs: () => Promise<void>
}

const DebugContext = createContext<DebugContextType | undefined>(undefined)

export function DebugProvider({ children }: { children: ReactNode }) {
    const [logs, setLogs] = useState<LogEntry[]>([])

    // Sync with LoggerService on mount and periodically
    const refreshLogs = useCallback(() => {
        setLogs([...logger.getLogs()])
    }, [])

    useEffect(() => {
        refreshLogs()
        // Optional: Poll for changes if multiple sources write to logger
        const interval = setInterval(refreshLogs, 2000)
        return () => clearInterval(interval)
    }, [refreshLogs])

    const addLog = (level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string, details?: any) => {
        const fullMessage = `[${source}] ${message}`
        // Write to persistent logger
        if (level === 'INFO') logger.info(fullMessage, details)
        else if (level === 'WARN') logger.warn(fullMessage, details)
        else logger.error(fullMessage, details)

        // Update local state immediately
        refreshLogs()
    }

    const clearLogs = () => {
        logger.clearLogs()
        refreshLogs()
    }

    const exportLogs = async () => {
        await logger.downloadLogs()
    }

    return (
        <DebugContext.Provider value={{ logs, addLog, clearLogs, exportLogs }}>
            {children}
        </DebugContext.Provider>
    )
}

export function useDebug() {
    const context = useContext(DebugContext)
    if (context === undefined) {
        throw new Error('useDebug must be used within a DebugProvider')
    }
    return context
}
