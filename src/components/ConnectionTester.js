import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { getHAStates, getHAServices } from '../utils/home-assistant';
import { useApp } from '../lib/AppContext';
export default function ConnectionTester() {
    const { activeConnection } = useApp();
    const [status, setStatus] = useState('Nog niet getest...');
    const [deviceCount, setDeviceCount] = useState(0);
    const [serviceCount, setServiceCount] = useState(0);
    useEffect(() => {
        async function testConnection() {
            if (!activeConnection) {
                setStatus('Selecteer een connectie om te testen');
                return;
            }
            try {
                setStatus(`Verbinding testen met ${activeConnection.name}...`);
                const states = await getHAStates(activeConnection.api_url, activeConnection.api_token);
                const services = await getHAServices(activeConnection.api_url, activeConnection.api_token);
                console.log('States:', states);
                console.log('Services:', services);
                setDeviceCount(states.length);
                setServiceCount(Object.keys(services).length);
                setStatus('✅ Verbinding geslaagd!');
            }
            catch (err) {
                console.error('API error:', err);
                setStatus(`❌ Fout: ${err.message}`);
            }
        }
        testConnection();
    }, [activeConnection]);
    return (_jsxs("div", { style: { padding: '1rem', border: '1px solid #ccc', borderRadius: '8px' }, children: [_jsx("h3", { children: "Home Assistant Connection Tester" }), _jsxs("p", { children: ["Status: ", status] }), status.startsWith('✅') && (_jsxs("ul", { children: [_jsxs("li", { children: ["Devices gevonden: ", deviceCount] }), _jsxs("li", { children: ["Services gevonden: ", serviceCount] })] }))] }));
}
