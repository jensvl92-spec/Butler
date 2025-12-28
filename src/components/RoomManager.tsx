import React, { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../lib/AppContext'

export function RoomManager() {
  const { activeConnection, rooms, addRoom, deleteRoom, updateRoom } = useApp()
  const [editingRoom, setEditingRoom] = useState<string | null>(null)
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomDesc, setNewRoomDesc] = useState('')
  const [showForm, setShowForm] = useState(false)

  if (!activeConnection) {
    return <div className="rooms-empty">Select a connection first</div>
  }

  const handleAddRoom = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newRoomName.trim()) return

    const { data, error } = await supabase
      .from('rooms')
      .insert({
        connection_id: activeConnection.id,
        name: newRoomName,
        description: newRoomDesc,
      })
      .select()

    if (!error && data) {
      addRoom(data[0])
      setNewRoomName('')
      setNewRoomDesc('')
      setShowForm(false)
    }
  }

  const handleDeleteRoom = async (id: string) => {
    await supabase.from('rooms').delete().eq('id', id)
    deleteRoom(id)
  }

  const handleUpdateRoom = async (id: string, name: string, desc: string) => {
    await supabase
      .from('rooms')
      .update({ name, description: desc })
      .eq('id', id)

    updateRoom({ id, connection_id: activeConnection.id, name, description: desc, created_at: '', updated_at: '' })
    setEditingRoom(null)
  }

  return (
    <div className="room-manager">
      <h3>Rooms</h3>
      <div className="rooms-list">
        {rooms.map((room) => (
          <div key={room.id} className="room-item">
            {editingRoom === room.id ? (
              <div className="room-edit">
                <input
                  type="text"
                  defaultValue={room.name}
                  onChange={(e) => setNewRoomName(e.target.value)}
                />
                <input
                  type="text"
                  defaultValue={room.description}
                  onChange={(e) => setNewRoomDesc(e.target.value)}
                />
                <button onClick={() => handleUpdateRoom(room.id, newRoomName, newRoomDesc)}>Save</button>
                <button onClick={() => setEditingRoom(null)}>Cancel</button>
              </div>
            ) : (
              <>
                <div className="room-info">
                  <h4>{room.name}</h4>
                  <p>{room.description}</p>
                </div>
                <div className="room-actions">
                  <button onClick={() => setEditingRoom(room.id)}>Edit</button>
                  <button onClick={() => handleDeleteRoom(room.id)}>Delete</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {showForm ? (
        <form onSubmit={handleAddRoom} className="add-room-form">
          <input
            type="text"
            placeholder="Room Name"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            required
          />
          <input
            type="text"
            placeholder="Description"
            value={newRoomDesc}
            onChange={(e) => setNewRoomDesc(e.target.value)}
          />
          <button type="submit">Add Room</button>
          <button type="button" onClick={() => setShowForm(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="add-room-btn" onClick={() => setShowForm(true)}>
          + Add Room
        </button>
      )}
    </div>
  )
}
