
import React from 'react'
import { Suggestion, Action } from '../types'
import { callHAService } from '../utils/home-assistant'

interface SuggestionPopupProps {
    suggestions: Suggestion[]
    onClose: () => void
    onAction: (suggestionId: string, action: 'accept' | 'reject') => void
}

export const SuggestionPopup: React.FC<SuggestionPopupProps> = ({ suggestions, onClose, onAction }) => {
    const [currentIndex, setCurrentIndex] = React.useState(0)

    // Clamp index when suggestions array changes (e.g., items removed)
    React.useEffect(() => {
        if (suggestions.length === 0) {
            onClose()
        } else if (currentIndex >= suggestions.length) {
            setCurrentIndex(Math.max(0, suggestions.length - 1))
        }
    }, [suggestions.length, currentIndex, onClose])

    if (!suggestions || suggestions.length === 0) return null

    const current = suggestions[currentIndex]
    if (!current) return null // Extra safety

    const handleNext = () => {
        if (currentIndex < suggestions.length - 1) {
            setCurrentIndex(currentIndex + 1)
        } else {
            onClose() // All done
        }
    }

    const handleAccept = () => {
        onAction(current.id, 'accept')
        handleNext()
    }

    const handleReject = () => {
        onAction(current.id, 'reject')
        handleNext()
    }

    const formatAction = (action: any) => {
        if (action.type === 'create_automation') {
            // Our stored format: { type: 'create_automation', action: 'description of action' }
            return action.action || 'Create Automation'
        }
        // Fallback for other action types
        if (action.service && action.entity_id) {
            return `${action.service} → ${action.entity_id}`
        }
        return JSON.stringify(action)
    }

    // Get trigger and condition from the suggestion (stored at root level)
    const trigger = (current as any).trigger
    const condition = (current as any).condition

    return (
        <div className="modal-overlay" style={{ zIndex: 10000 }}>
            <div className="modal-content suggestion-card" style={{ maxWidth: 400, animation: 'slideUp 0.3s ease' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                    <div className="suggestion-badge">✨ New Suggestion ({currentIndex + 1}/{suggestions.length})</div>
                    <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 20 }}>✕</button>
                </div>

                <div className="suggestion-icon" style={{ fontSize: 40, textAlign: 'center', marginBottom: 16 }}>
                    💡
                </div>

                <h3 style={{ textAlign: 'center', marginBottom: 8 }}>{current.title}</h3>
                <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginBottom: 24 }}>
                    {current.description}
                </p>

                <div className="suggestion-actions-preview" style={{ background: 'var(--card-bg)', borderRadius: 8, padding: 12 }}>
                    {trigger && (
                        <div style={{ marginBottom: 8 }}>
                            <strong>🎯 When:</strong> {trigger}
                        </div>
                    )}
                    {condition && (
                        <div style={{ marginBottom: 8 }}>
                            <strong>📋 If:</strong> {condition}
                        </div>
                    )}
                    <div>
                        <strong>⚡ Then:</strong>
                        <ul style={{ fontSize: '0.9rem', paddingLeft: 20, marginTop: 4 }}>
                            {current.actions.map((a, i) => (
                                <li key={i}>{formatAction(a)}</li>
                            ))}
                        </ul>
                    </div>
                </div>

                <div className="modal-actions" style={{ marginTop: 32 }}>
                    <button className="secondary-btn" onClick={handleReject} style={{ flex: 1 }}>Ignore</button>
                    <button className="primary-btn" onClick={handleAccept} style={{ flex: 1, background: 'var(--accent)' }}>Activate</button>
                </div>
            </div>
            <style>{`
                .suggestion-badge {
                    background: linear-gradient(135deg, #6366f1, #8b5cf6);
                    color: white;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 0.8rem;
                    font-weight: 600;
                }
                @keyframes slideUp {
                    from { transform: translateY(50px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
            `}</style>
        </div>
    )
}
