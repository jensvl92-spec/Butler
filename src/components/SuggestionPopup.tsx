import React from 'react'
import { Suggestion } from '../types'

interface SuggestionPopupProps {
    suggestions: Suggestion[]
    onClose: () => void
    onAction: (suggestionId: string, action: 'accept' | 'reject') => void | Promise<void>
}

function formatField(val: any): string {
    if (val === null || val === undefined) return ''
    if (typeof val === 'string') return val
    if (Array.isArray(val)) return val.map(formatField).filter(Boolean).join(', ')
    if (typeof val === 'object') {
        if (val.platform && val.at) return `${val.platform} om ${val.at}`
        if (val.entity_id && val.to) return `${val.entity_id} → ${val.to}`
        return JSON.stringify(val)
    }
    return String(val)
}

export const SuggestionPopup: React.FC<SuggestionPopupProps> = ({ suggestions, onClose, onAction }) => {
    const [currentIndex, setCurrentIndex] = React.useState(0)
    const [busy, setBusy] = React.useState(false)

    React.useEffect(() => {
        if (!suggestions || suggestions.length === 0) {
            onClose()
        } else if (currentIndex >= suggestions.length) {
            setCurrentIndex(Math.max(0, suggestions.length - 1))
        }
    }, [suggestions, currentIndex, onClose])

    if (!suggestions || suggestions.length === 0) return null

    const current = suggestions[currentIndex]
    if (!current) return null

    // NOTE: Do NOT call setCurrentIndex(currentIndex + 1) because parent onAction removes `current`
    // from `suggestions`, shifting the next suggestion directly into `currentIndex`!
    const handleDecision = async (decision: 'accept' | 'reject') => {
        if (busy) return
        setBusy(true)
        try {
            await onAction(current.id, decision)
        } finally {
            setBusy(false)
        }
    }

    const formatAction = (action: any) => {
        if (!action) return ''
        if (action.type === 'create_automation') {
            return action.data?.alias || action.action || 'Automatisering aanmaken'
        }
        if (action.service && action.entity_id) {
            return `${action.service} → ${action.entity_id}`
        }
        return formatField(action)
    }

    const triggerText = formatField(current.trigger)
    const conditionText = formatField(current.condition)
    const actionsList = Array.isArray(current.actions) ? current.actions : []

    return (
        <div className="modal-overlay" style={{ zIndex: 10000 }}>
            <div className="modal-content suggestion-card" style={{ maxWidth: 420 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <div style={{
                        background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                        color: 'white',
                        padding: '4px 12px',
                        borderRadius: '12px',
                        fontSize: '0.8rem',
                        fontWeight: 600
                    }}>
                        ✨ Voorstel ({currentIndex + 1}/{suggestions.length})
                    </div>
                    <button
                        onClick={onClose}
                        style={{ background: 'transparent', border: 'none', fontSize: 20, color: 'var(--text-primary)', cursor: 'pointer' }}
                        aria-label="Sluiten"
                    >
                        ✕
                    </button>
                </div>

                <div style={{ fontSize: 40, textAlign: 'center', marginBottom: 12 }}>💡</div>
                <h3 style={{ textAlign: 'center', marginBottom: 8 }}>{current.title}</h3>
                <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginBottom: 20 }}>
                    {current.description}
                </p>

                <div style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.04))', borderRadius: 10, padding: 12 }}>
                    {triggerText && (
                        <div style={{ marginBottom: 8 }}>
                            <strong>🎯 Wanneer:</strong> {triggerText}
                        </div>
                    )}
                    {conditionText && (
                        <div style={{ marginBottom: 8 }}>
                            <strong>📋 Als:</strong> {conditionText}
                        </div>
                    )}
                    {actionsList.length > 0 && (
                        <div>
                            <strong>⚡ Dan:</strong>
                            <ul style={{ fontSize: '0.9rem', paddingLeft: 20, marginTop: 4 }}>
                                {actionsList.map((a, i) => (
                                    <li key={i}>{formatAction(a)}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>

                <div className="modal-actions" style={{ display: 'flex', gap: 12, marginTop: 24 }}>
                    <button className="secondary-btn" disabled={busy} onClick={() => handleDecision('reject')} style={{ flex: 1 }}>
                        Negeren
                    </button>
                    <button className="primary-btn" disabled={busy} onClick={() => handleDecision('accept')} style={{ flex: 1, background: 'var(--accent)' }}>
                        {busy ? 'Bezig...' : 'Activeren'}
                    </button>
                </div>
            </div>
        </div>
    )
}
