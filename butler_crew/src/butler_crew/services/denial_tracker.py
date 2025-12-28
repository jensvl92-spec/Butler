"""Denial tracker service using SQLite."""

import json
import os
import sqlite3
from datetime import datetime
from typing import Optional, Tuple


class DenialTracker:
    """
    Tracks automation proposals that users have denied.
    
    Uses SQLite for persistent storage.
    """
    
    def __init__(self, db_path: Optional[str] = None):
        """
        Initialize the denial tracker.
        
        Args:
            db_path: Path to SQLite database
        """
        self.db_path = db_path or "./data/denials.db"
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_db()
    
    def _init_db(self):
        """Initialize the database schema."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS denied_proposals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    connection_id TEXT NOT NULL,
                    proposal_hash TEXT NOT NULL,
                    proposal_summary TEXT,
                    denial_count INTEGER DEFAULT 1,
                    first_denied_at TEXT NOT NULL,
                    last_denied_at TEXT NOT NULL,
                    UNIQUE(connection_id, proposal_hash)
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_denied_lookup 
                ON denied_proposals(connection_id, proposal_hash)
            """)
            conn.commit()
    
    def check_denial(
        self,
        connection_id: str,
        proposal_hash: str,
        threshold: int = 3,
    ) -> Tuple[bool, int]:
        """
        Check if a proposal has been denied too many times.
        
        Args:
            connection_id: User connection ID
            proposal_hash: Hash of the proposal
            threshold: Number of denials before blocking
            
        Returns:
            Tuple of (is_blocked, denial_count)
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                SELECT denial_count FROM denied_proposals
                WHERE connection_id = ? AND proposal_hash = ?
                """,
                (connection_id, proposal_hash),
            )
            row = cursor.fetchone()
            
            if row:
                count = row[0]
                return count >= threshold, count
            return False, 0
    
    def record_denial(
        self,
        connection_id: str,
        proposal_hash: str,
        proposal_summary: str,
    ) -> int:
        """
        Record a proposal denial.
        
        Args:
            connection_id: User connection ID
            proposal_hash: Hash of the proposal
            proposal_summary: Human-readable summary
            
        Returns:
            New denial count
        """
        now = datetime.utcnow().isoformat()
        
        with sqlite3.connect(self.db_path) as conn:
            # Try to update existing
            cursor = conn.execute(
                """
                UPDATE denied_proposals
                SET denial_count = denial_count + 1,
                    last_denied_at = ?,
                    proposal_summary = ?
                WHERE connection_id = ? AND proposal_hash = ?
                RETURNING denial_count
                """,
                (now, proposal_summary, connection_id, proposal_hash),
            )
            row = cursor.fetchone()
            
            if row:
                conn.commit()
                return row[0]
            
            # Insert new
            conn.execute(
                """
                INSERT INTO denied_proposals
                (connection_id, proposal_hash, proposal_summary, denial_count, first_denied_at, last_denied_at)
                VALUES (?, ?, ?, 1, ?, ?)
                """,
                (connection_id, proposal_hash, proposal_summary, now, now),
            )
            conn.commit()
            return 1
    
    def clear_denial(
        self,
        connection_id: str,
        proposal_hash: str,
    ) -> bool:
        """
        Clear denial record for a proposal (e.g., user changed their mind).
        
        Returns:
            True if a record was deleted
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                DELETE FROM denied_proposals
                WHERE connection_id = ? AND proposal_hash = ?
                """,
                (connection_id, proposal_hash),
            )
            conn.commit()
            return cursor.rowcount > 0
    
    def get_all_denials(
        self,
        connection_id: str,
        min_count: int = 1,
    ) -> list:
        """
        Get all denied proposals for a connection.
        
        Args:
            connection_id: User connection ID
            min_count: Minimum denial count to include
            
        Returns:
            List of denial records
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                SELECT proposal_hash, proposal_summary, denial_count, 
                       first_denied_at, last_denied_at
                FROM denied_proposals
                WHERE connection_id = ? AND denial_count >= ?
                ORDER BY last_denied_at DESC
                """,
                (connection_id, min_count),
            )
            
            return [
                {
                    "proposal_hash": row[0],
                    "proposal_summary": row[1],
                    "denial_count": row[2],
                    "first_denied_at": row[3],
                    "last_denied_at": row[4],
                }
                for row in cursor.fetchall()
            ]
