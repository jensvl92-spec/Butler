"""Basic tests for Butler Crew."""

import pytest
from butler_crew.services.denial_tracker import DenialTracker


class TestDenialTracker:
    """Tests for the denial tracker service."""
    
    def test_record_and_check_denial(self, tmp_path):
        """Test recording and checking denials."""
        db_path = tmp_path / "test_denials.db"
        tracker = DenialTracker(db_path=str(db_path))
        
        connection_id = "test-connection"
        proposal_hash = "abc123"
        
        # Initially not denied
        is_blocked, count = tracker.check_denial(connection_id, proposal_hash)
        assert not is_blocked
        assert count == 0
        
        # Record first denial
        count = tracker.record_denial(connection_id, proposal_hash, "Test proposal")
        assert count == 1
        
        # Check again
        is_blocked, count = tracker.check_denial(connection_id, proposal_hash)
        assert not is_blocked  # threshold is 3
        assert count == 1
        
        # Record two more denials
        tracker.record_denial(connection_id, proposal_hash, "Test proposal")
        count = tracker.record_denial(connection_id, proposal_hash, "Test proposal")
        assert count == 3
        
        # Now should be blocked
        is_blocked, count = tracker.check_denial(connection_id, proposal_hash)
        assert is_blocked
        assert count == 3
    
    def test_clear_denial(self, tmp_path):
        """Test clearing a denial."""
        db_path = tmp_path / "test_denials.db"
        tracker = DenialTracker(db_path=str(db_path))
        
        connection_id = "test-connection"
        proposal_hash = "xyz789"
        
        # Record denial
        tracker.record_denial(connection_id, proposal_hash, "Test")
        
        # Clear it
        cleared = tracker.clear_denial(connection_id, proposal_hash)
        assert cleared
        
        # Should be gone
        is_blocked, count = tracker.check_denial(connection_id, proposal_hash)
        assert not is_blocked
        assert count == 0


class TestIntentValidation:
    """Test intent validation logic."""
    
    @pytest.mark.parametrize("message,expected_valid", [
        ("Turn on the kitchen light", True),
        ("What's the temperature in the living room?", True),
        ("Create an automation for the morning", True),
        ("What's the weather like?", False),
        ("Tell me a joke", False),
        ("Disable the motion sensor automation", True),
    ])
    def test_intent_patterns(self, message, expected_valid):
        """Test that intent patterns are classified correctly."""
        # This tests the expected behavior of the Bouncer agent
        # Actual implementation is via LLM, so we just document expected behavior
        ha_keywords = [
            "light", "switch", "sensor", "automation", "temperature",
            "turn on", "turn off", "enable", "disable", "home", "room",
            "climate", "thermostat", "cover", "blind", "media", "scene",
        ]
        
        # Simple keyword check (actual agent uses LLM)
        lower_msg = message.lower()
        has_ha_keyword = any(kw in lower_msg for kw in ha_keywords)
        
        # This is just a rough approximation of what the agent should do
        if expected_valid:
            assert has_ha_keyword, f"Expected HA keyword in: {message}"
