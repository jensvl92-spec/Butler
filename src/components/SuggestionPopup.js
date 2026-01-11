import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
export const SuggestionPopup = ({ suggestions, onClose, onAction }) => {
    const [currentIndex, setCurrentIndex] = React.useState(0);
    // Clamp index when suggestions array changes (e.g., items removed)
    React.useEffect(() => {
        if (suggestions.length === 0) {
            onClose();
        }
        else if (currentIndex >= suggestions.length) {
            setCurrentIndex(Math.max(0, suggestions.length - 1));
        }
    }, [suggestions.length, currentIndex, onClose]);
    if (!suggestions || suggestions.length === 0)
        return null;
    const current = suggestions[currentIndex];
    if (!current)
        return null; // Extra safety
    const handleNext = () => {
        if (currentIndex < suggestions.length - 1) {
            setCurrentIndex(currentIndex + 1);
        }
        else {
            onClose(); // All done
        }
    };
    const handleAccept = () => {
        onAction(current.id, 'accept');
        handleNext();
    };
    const handleReject = () => {
        onAction(current.id, 'reject');
        handleNext();
    };
    const formatAction = (action) => {
        if (action.type === 'create_automation') {
            // Our stored format: { type: 'create_automation', action: 'description of action' }
            return action.action || 'Create Automation';
        }
        // Fallback for other action types
        if (action.service && action.entity_id) {
            return `${action.service} → ${action.entity_id}`;
        }
        return JSON.stringify(action);
    };
    // Get trigger and condition from the suggestion (stored at root level)
    const trigger = current.trigger;
    const condition = current.condition;
    return (_jsxs("div", { className: "modal-overlay", style: { zIndex: 10000 }, children: [_jsxs("div", { className: "modal-content suggestion-card", style: { maxWidth: 400, animation: 'slideUp 0.3s ease' }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 16 }, children: [_jsxs("div", { className: "suggestion-badge", children: ["\u2728 New Suggestion (", currentIndex + 1, "/", suggestions.length, ")"] }), _jsx("button", { onClick: onClose, style: { background: 'transparent', border: 'none', fontSize: 20 }, children: "\u2715" })] }), _jsx("div", { className: "suggestion-icon", style: { fontSize: 40, textAlign: 'center', marginBottom: 16 }, children: "\uD83D\uDCA1" }), _jsx("h3", { style: { textAlign: 'center', marginBottom: 8 }, children: current.title }), _jsx("p", { style: { textAlign: 'center', color: 'var(--text-secondary)', marginBottom: 24 }, children: current.description }), _jsxs("div", { className: "suggestion-actions-preview", style: { background: 'var(--card-bg)', borderRadius: 8, padding: 12 }, children: [trigger && (_jsxs("div", { style: { marginBottom: 8 }, children: [_jsx("strong", { children: "\uD83C\uDFAF When:" }), " ", trigger] })), condition && (_jsxs("div", { style: { marginBottom: 8 }, children: [_jsx("strong", { children: "\uD83D\uDCCB If:" }), " ", condition] })), _jsxs("div", { children: [_jsx("strong", { children: "\u26A1 Then:" }), _jsx("ul", { style: { fontSize: '0.9rem', paddingLeft: 20, marginTop: 4 }, children: current.actions.map((a, i) => (_jsx("li", { children: formatAction(a) }, i))) })] })] }), _jsxs("div", { className: "modal-actions", style: { marginTop: 32 }, children: [_jsx("button", { className: "secondary-btn", onClick: handleReject, style: { flex: 1 }, children: "Ignore" }), _jsx("button", { className: "primary-btn", onClick: handleAccept, style: { flex: 1, background: 'var(--accent)' }, children: "Activate" })] })] }), _jsx("style", { children: `
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
            ` })] }));
};
