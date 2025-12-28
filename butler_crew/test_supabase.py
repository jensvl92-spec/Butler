
import os
from dotenv import load_dotenv
from supabase import create_client

# Explicitly load .env
load_dotenv(override=True)

url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

print(f"URL: {url}")
print(f"KEY: {key[:10]}..." if key else "KEY: None")

if url and key:
    try:
        client = create_client(url, key)
        print("Client created.")
        # Try a simple fetch
        res = client.table("user_integrations").select("count", count="exact").execute()
        print(f"Connection success! Row count: {len(res.data)}")
    except Exception as e:
        print(f"Connection failed: {e}")
else:
    print("Missing credentials.")
