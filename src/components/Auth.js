import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { signIn, signUp, signInWithGoogle } from '../utils/auth';
export function Auth({ onAuthSuccess }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isSignUp, setIsSignUp] = useState(false);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const result = isSignUp ? await signUp(email, password) : await signIn(email, password);
            if (result.error) {
                setError(result.error.message);
            }
            else {
                onAuthSuccess();
            }
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsx("div", { className: "auth-container", children: _jsxs("div", { className: "auth-card", children: [_jsx("h1", { children: "Home Assistant AI" }), _jsxs("form", { onSubmit: handleSubmit, children: [_jsx("input", { type: "email", placeholder: "Email", value: email, onChange: (e) => setEmail(e.target.value), required: true }), _jsx("input", { type: "password", placeholder: "Password", value: password, onChange: (e) => setPassword(e.target.value), required: true }), _jsx("button", { type: "submit", disabled: loading, children: loading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In' })] }), error && _jsx("p", { className: "error", children: error }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', margin: '16px 0', gap: '8px' }, children: [_jsx("hr", { style: { flex: 1, border: 'none', borderTop: '1px solid #ddd' } }), _jsx("span", { style: { color: '#666', fontSize: '12px' }, children: "OR" }), _jsx("hr", { style: { flex: 1, border: 'none', borderTop: '1px solid #ddd' } })] }), _jsx("button", { type: "button", onClick: () => signInWithGoogle(), style: {
                        backgroundColor: '#fff',
                        color: '#333',
                        border: '1px solid #ddd',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        marginBottom: '16px',
                        cursor: 'pointer'
                    }, children: "Google" }), _jsx("button", { className: "toggle-auth", onClick: () => setIsSignUp(!isSignUp), children: isSignUp ? 'Have an account? Sign In' : "Don't have an account? Sign Up" })] }) }));
}
