# Butler Crew - Multi-Agent Home Assistant System

A CrewAI-powered multi-agent system for intelligent Home Assistant control.

## Agents

| Agent | Role |
|-------|------|
| **Bouncer** | Validates requests are HA-related |
| **Butler** | Main orchestrator, routes to tools/experts |
| **Automation Handler** | Toggles automations on/off |
| **Automation Creator** | Creates/deletes automations |
| **Automation Engineer** | Invents new automations |
| **Analyzer Expert** | Pattern analysis |
| **Proposal Validator** | Filters denied proposals |
| **Personal Assistant** | Manage Calendar, Email, Navigation, Music, and Tasks |

## Quick Start

```bash
# Install dependencies
uv sync

# Run the server
uv run uvicorn butler_crew.main:app --reload
```

## Project Structure

```
src/butler_crew/
├── main.py          # FastAPI entry point
├── crew.py          # CrewAI crew definition
├── config/          # YAML configs
├── agents/          # Agent implementations
├── tools/           # Custom tools
├── mcp/             # Proxy MCP Server
└── services/        # Memory, tracking services
```
