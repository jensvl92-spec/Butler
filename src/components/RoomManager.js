import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useApp } from '../lib/AppContext';
export function RoomManager() {
    const { activeConnection, rooms, addRoom, deleteRoom, updateRoom } = useApp();
    const [editingRoom, setEditingRoom] = useState(null);
    const [newRoomName, setNewRoomName] = useState('');
    const [newRoomDesc, setNewRoomDesc] = useState('');
    const [showForm, setShowForm] = useState(false);
    if (!activeConnection) {
        return _jsx("div", { className: "rooms-empty", children: "Select a connection first" });
    }
    const handleAddRoom = async (e) => {
        e.preventDefault();
        if (!newRoomName.trim())
            return;
        const { data, error } = await supabase
            .from('rooms')
            .insert({
            connection_id: activeConnection.id,
            name: newRoomName,
            description: newRoomDesc,
        })
            .select();
        if (!error && data) {
            addRoom(data[0]);
            setNewRoomName('');
            setNewRoomDesc('');
            setShowForm(false);
        }
    };
    const handleDeleteRoom = async (id) => {
        await supabase.from('rooms').delete().eq('id', id);
        deleteRoom(id);
    };
    const handleUpdateRoom = async (id, name, desc) => {
        await supabase
            .from('rooms')
            .update({ name, description: desc })
            .eq('id', id);
        updateRoom({ id, connection_id: activeConnection.id, name, description: desc, created_at: '', updated_at: '' });
        setEditingRoom(null);
    };
    return (_jsxs("div", { className: "room-manager", children: [_jsx("h3", { children: "Rooms" }), _jsx("div", { className: "rooms-list", children: rooms.map((room) => (_jsx("div", { className: "room-item", children: editingRoom === room.id ? (_jsxs("div", { className: "room-edit", children: [_jsx("input", { type: "text", defaultValue: room.name, onChange: (e) => setNewRoomName(e.target.value) }), _jsx("input", { type: "text", defaultValue: room.description, onChange: (e) => setNewRoomDesc(e.target.value) }), _jsx("button", { onClick: () => handleUpdateRoom(room.id, newRoomName, newRoomDesc), children: "Save" }), _jsx("button", { onClick: () => setEditingRoom(null), children: "Cancel" })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "room-info", children: [_jsx("h4", { children: room.name }), _jsx("p", { children: room.description })] }), _jsxs("div", { className: "room-actions", children: [_jsx("button", { onClick: () => setEditingRoom(room.id), children: "Edit" }), _jsx("button", { onClick: () => handleDeleteRoom(room.id), children: "Delete" })] })] })) }, room.id))) }), showForm ? (_jsxs("form", { onSubmit: handleAddRoom, className: "add-room-form", children: [_jsx("input", { type: "text", placeholder: "Room Name", value: newRoomName, onChange: (e) => setNewRoomName(e.target.value), required: true }), _jsx("input", { type: "text", placeholder: "Description", value: newRoomDesc, onChange: (e) => setNewRoomDesc(e.target.value) }), _jsx("button", { type: "submit", children: "Add Room" }), _jsx("button", { type: "button", onClick: () => setShowForm(false), children: "Cancel" })] })) : (_jsx("button", { className: "add-room-btn", onClick: () => setShowForm(true), children: "+ Add Room" }))] }));
}
