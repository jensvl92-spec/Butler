
import React from 'react'
import { Suggestion, Action } from '../types'
import { callHAService } from '../utils/home-assistant'

interface SuggestionPopupProps {
    suggestions: Suggestion[]
    onClose: () => void
    onAction: (suggestionId: string, action: 'accept' | 'reject') => void
}

export const SuggestionPopup: React.FC<SuggestionPopupProps> = ({ suggestions, onClose, onAction }) => {
    if (!suggestions || suggestions.length === 0) return null

    // We only show the first one to avoid overwhelming, or a stack?
    // Let's show a stack.
    const [currentIndex, setCurrentIndex] = React.useState(0)
    const current = suggestions[currentIndex]

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

    const formatAction = (action: Action) => {
        if (action.type === 'create_automation') {
            const data = action.data as any
            return `Create Automation: "${data?.alias}"`
        }
        return `${action.type}: ${action.service} -> ${action.entity_id}`
    }

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

                <div className="suggestion-actions-preview">
                    <strong>Proposed Change:</strong>
                    <ul style={{ fontSize: '0.9rem', paddingLeft: 20, marginTop: 8 }}>
                        {current.actions.map((a, i) => (
                            <li key={i}>{formatAction(a)}</li>
                        ))}
                    </ul>
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
