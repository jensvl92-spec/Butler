"""Authentication router."""

import os
from datetime import datetime, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse

from butler_crew.services.db import get_db

router = APIRouter(tags=["auth"])

# --- Configuration ---

PROVIDERS = {
    "google": {
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "scope": "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.modify",
        "client_id_env": "GOOGLE_CLIENT_ID",
        "client_secret_env": "GOOGLE_CLIENT_SECRET",
    },
    "spotify": {
        "auth_url": "https://accounts.spotify.com/authorize",
        "token_url": "https://accounts.spotify.com/api/token",
        "scope": "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-modify-public",
        "client_id_env": "SPOTIFY_CLIENT_ID",
        "client_secret_env": "SPOTIFY_CLIENT_SECRET",
    }
}


@router.get("/auth/login/{provider}")
async def login(provider: str, user_id: str = "default_user"):
    """Initiate OAuth login flow."""
    if provider not in PROVIDERS:
        raise HTTPException(status_code=404, detail="Provider not found")
    
    config = PROVIDERS[provider]
    client_id = os.getenv(config["client_id_env"])
    
    if not client_id:
        raise HTTPException(
            status_code=500, 
            detail=f"Missing {config['client_id_env']} configuration"
        )
    
    # Calculate callback URL using 127.0.0.1 (required for Spotify compliance)
    redirect_uri = f"http://127.0.0.1:8000/auth/callback/{provider}"
    
    # State should be random token to prevent CSRF, here simplistically passing user_id
    state = user_id 
    
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": config["scope"],
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
    }
    
    # Build query string
    import urllib.parse
    query_string = urllib.parse.urlencode(params)
    url = f"{config['auth_url']}?{query_string}"
    
    return RedirectResponse(url)


@router.get("/auth/callback/{provider}")
async def callback(
    provider: str, 
    request: Request,
    code: str, 
    state: str,
    error: Optional[str] = None
):
    """Handle OAuth callback."""
    if error:
        return JSONResponse({"error": error, "provider": provider}, status_code=400)
        
    if provider not in PROVIDERS:
        raise HTTPException(status_code=404, detail="Provider not found")
        
    config = PROVIDERS[provider]
    client_id = os.getenv(config["client_id_env"])
    client_secret = os.getenv(config["client_secret_env"])
    
    if not client_id or not client_secret:
        raise HTTPException(status_code=500, detail="Server misconfiguration")
        
    redirect_uri = f"http://127.0.0.1:8000/auth/callback/{provider}"
    
    # Exchange code for token
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(config["token_url"], data=data)
            response.raise_for_status()
            token_data = response.json()
            
            # Helper to calculate expiry
            expires_in = token_data.get("expires_in", 3600)
            token_data["expires_at"] = (datetime.utcnow() + timedelta(seconds=expires_in)).isoformat()
            
            # Check if db is active
            db = get_db()
            
            if db.client:
                # Use state as user_id
                user_id = state
                success = db.save_token(user_id, provider, token_data)
                
                if success:
                    return JSONResponse({
                        "status": "success",
                        "message": f"Successfully connected {provider}",
                        "provider": provider
                    })
                else:
                    return JSONResponse({
                        "status": "error",
                        "message": "Failed to save token to database. DB might not be configured."
                    }, status_code=500)
            else:
                 return JSONResponse({
                    "status": "warning",
                    "message": "Authenticated, but no database configured to save token.",
                    "token_preview": "Token received but not saved"
                })
                
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
