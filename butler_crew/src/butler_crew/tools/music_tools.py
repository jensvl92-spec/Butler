"""CrewAI tools for music/Spotify operations."""

import asyncio
import json
from crewai.tools import tool


def _run_async(coro):
    """Run async coroutine in sync context."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                return pool.submit(lambda: asyncio.run(coro)).result()
        else:
            return loop.run_until_complete(coro)
    except RuntimeError:
        return asyncio.run(coro)


@tool("whats_playing")
def whats_playing() -> str:
    """
    Get the currently playing song.
    
    Returns:
        JSON with song name, artist, album
    """
    from butler_crew.services.integrations.music.spotify import SpotifyProvider
    
    provider = SpotifyProvider()
    if not provider.is_authenticated():
        return json.dumps({
            "action": "whats_playing",
            "status": "not_connected",
            "message": "Spotify not connected. Log in via dashboard.",
        })
    
    try:
        track = _run_async(provider.get_current_playback())
        if not track:
            return json.dumps({
                "action": "whats_playing",
                "status": "success",
                "message": "Nothing currently playing.",
            })
            
        return json.dumps({
            "action": "whats_playing",
            "status": "success",
            "track": track.name,
            "artist": track.artist,
            "album": track.album,
            "is_playing": track.is_playing,
        })
    except Exception as e:
        return json.dumps({
            "action": "whats_playing",
            "status": "error",
            "message": str(e),
        })


@tool("play_music")
def play_music(query: str = "") -> str:
    """
    Start playing music. Can play a specific song, album, artist, or playlist.
    
    Args:
        query: What to play (e.g., "Bohemian Rhapsody", "my chill playlist")
               Empty to resume current playback
    
    Returns:
        JSON confirmation
    """
    from butler_crew.services.integrations.music.spotify import SpotifyProvider
    
    provider = SpotifyProvider()
    if not provider.is_authenticated():
        return json.dumps({
            "action": "play_music",
            "status": "not_connected",
            "message": "Spotify not connected.",
        })
    
    try:
        # Simple search logic for now if query provided
        context_uri = None
        if query:
            results = _run_async(provider.search(query))
            if results:
                # Play first result
                context_uri = results[0]["uri"]
            else:
                 return json.dumps({
                    "action": "play_music",
                    "status": "not_found",
                    "message": f"Could not find '{query}' on Spotify.",
                })
        
        success = _run_async(provider.play(context_uri))
        return json.dumps({
            "action": "play_music",
            "query": query,
            "status": "success" if success else "error",
            "message": "Playback started." if success else "Failed to start playback (no active device?)",
        })
    except Exception as e:
        return json.dumps({
            "action": "play_music",
            "status": "error",
            "message": str(e),
        })


@tool("pause_music")
def pause_music() -> str:
    """
    Pause the current music playback.
    
    Returns:
        JSON confirmation
    """
    from butler_crew.services.integrations.music.spotify import SpotifyProvider
    
    provider = SpotifyProvider()
    if not provider.is_authenticated():
        return json.dumps({"action": "pause_music", "status": "not_connected"})
        
    success = _run_async(provider.pause())
    return json.dumps({
        "action": "pause_music",
        "status": "success" if success else "error"
    })


@tool("next_song")
def next_song() -> str:
    """
    Skip to the next song.
    
    Returns:
        JSON confirmation with new song info
    """
    from butler_crew.services.integrations.music.spotify import SpotifyProvider
    
    provider = SpotifyProvider()
    if not provider.is_authenticated():
        return json.dumps({"action": "next_song", "status": "not_connected"})
        
    success = _run_async(provider.next_track())
    return json.dumps({
        "action": "next_song",
        "status": "success" if success else "error"
    })


@tool("previous_song")
def previous_song() -> str:
    """
    Go back to the previous song.
    
    Returns:
        JSON confirmation
    """
    from butler_crew.services.integrations.music.spotify import SpotifyProvider
    
    provider = SpotifyProvider()
    if not provider.is_authenticated():
        return json.dumps({"action": "previous_song", "status": "not_connected"})
        
    success = _run_async(provider.previous_track())
    return json.dumps({
        "action": "previous_song",
        "status": "success" if success else "error"
    })


@tool("set_music_volume")
def set_music_volume(volume: int) -> str:
    """
    Set the music volume.
    
    Args:
        volume: Volume level from 0 to 100
    
    Returns:
        JSON confirmation
    """
    from butler_crew.services.integrations.music.spotify import SpotifyProvider
    
    provider = SpotifyProvider()
    if not provider.is_authenticated():
        return json.dumps({"action": "set_music_volume", "status": "not_connected"})
        
    volume = max(0, min(100, volume))
    success = _run_async(provider.set_volume(volume))
    
    return json.dumps({
        "action": "set_music_volume",
        "volume": volume,
        "status": "success" if success else "error",
    })


@tool("get_my_playlists")
def get_my_playlists() -> str:
    """
    Get the user's Spotify playlists.
    
    Returns:
        JSON list of playlists
    """
    from butler_crew.services.integrations.music.spotify import SpotifyProvider
    
    provider = SpotifyProvider()
    if not provider.is_authenticated():
        return json.dumps({
            "action": "get_my_playlists",
            "status": "not_connected",
            "playlists": [],
        })
        
    playlists = _run_async(provider.get_playlists())
    return json.dumps({
        "action": "get_my_playlists",
        "status": "success",
        "playlists": [{"name": p.name, "uri": p.uri} for p in playlists[:10]],
    })

