import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
export const SuggestionPopup = ({ suggestions, onClose, onAction }) => {
    if (!suggestions || suggestions.length === 0)
        return null;
    // We only show the first one to avoid overwhelming, or a stack?
    // Let's show a stack.
    const [currentIndex, setCurrentIndex] = React.useState(0);
    const current = suggestions[currentIndex];
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
            const data = action.data;
            return `Create Automation: "${data?.alias}"`;
        }
        return `${action.type}: ${action.service} -> ${action.entity_id}`;
    };
    return (_jsxs("div", { className: "modal-overlay", style: { zIndex: 10000 }, children: [_jsxs("div", { className: "modal-content suggestion-card", style: { maxWidth: 400, animation: 'slideUp 0.3s ease' }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 16 }, children: [_jsxs("div", { className: "suggestion-badge", children: ["\u2728 New Suggestion (", currentIndex + 1, "/", suggestions.length, ")"] }), _jsx("button", { onClick: onClose, style: { background: 'transparent', border: 'none', fontSize: 20 }, children: "\u2715" })] }), _jsx("div", { className: "suggestion-icon", style: { fontSize: 40, textAlign: 'center', marginBottom: 16 }, children: "\uD83D\uDCA1" }), _jsx("h3", { style: { textAlign: 'center', marginBottom: 8 }, children: current.title }), _jsx("p", { style: { textAlign: 'center', color: 'var(--text-secondary)', marginBottom: 24 }, children: current.description }), _jsxs("div", { className: "suggestion-actions-preview", children: [_jsx("strong", { children: "Proposed Change:" }), _jsx("ul", { style: { fontSize: '0.9rem', paddingLeft: 20, marginTop: 8 }, children: current.actions.map((a, i) => (_jsx("li", { children: formatAction(a) }, i))) })] }), _jsxs("div", { className: "modal-actions", style: { marginTop: 32 }, children: [_jsx("button", { className: "secondary-btn", onClick: handleReject, style: { flex: 1 }, children: "Ignore" }), _jsx("button", { className: "primary-btn", onClick: handleAccept, style: { flex: 1, background: 'var(--accent)' }, children: "Activate" })] })] }), _jsx("style", { children: `
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
