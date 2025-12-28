import sys
import time
import os
import asyncio

# Add src to path so we can import the proxy server
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../src")))

from butler_crew.mcp.proxy_server import search_engine, INVENTORY, MOCK_ENTITIES

def benchmark():
    print("--- BENCHMARKING SEMANTIC SEARCH (FastEmbed) ---")
    
    # 1. Measure Initialization/Load Time
    start_time = time.time()
    search_engine.initialize()
    load_time = time.time() - start_time
    print(f"Model Load Time: {load_time:.4f} seconds")
    
    # 2. Measure Indexing Time
    # Let's duplicate mock entities to simulate a larger house (e.g. 100 devices)
    large_inventory = MOCK_ENTITIES * 20  # ~120 entities
    
    # CRITICAL FIX: Update the global inventory so the lookups can find the objects!
    INVENTORY["entities"] = large_inventory
    
    print(f"Indexing {len(large_inventory)} entities...")
    
    start_time = time.time()
    search_engine.index_inventory(large_inventory)
    index_time = time.time() - start_time
    print(f"Indexing Time: {index_time:.4f} seconds ({(index_time/len(large_inventory))*1000:.2f} ms/entity)")
    
    # 3. Measure Query Latency & Accuracy
    queries = ["heating", "darkness", "security", "relax"]
    
    print("\n--- QUERY RESULTS ---")
    for q in queries:
        start_time = time.time()
        results = search_engine.search(q, top_k=3)
        query_time = time.time() - start_time
        
        print(f"\nQuery: '{q}' ({query_time*1000:.2f} ms)")
        for res in results:
            name = res['attributes']['friendly_name']
            eid = res['entity_id']
            print(f"  -> Match: {name} ({eid})")

if __name__ == "__main__":
    benchmark()
