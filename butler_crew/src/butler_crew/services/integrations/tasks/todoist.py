"""Todoist API integration provider."""

import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx


@dataclass
class TodoistTask:
    """Standardized task data."""
    id: str
    content: str
    description: Optional[str]
    due_date: Optional[str]
    due_string: Optional[str]
    priority: int  # 1 (normal) to 4 (urgent)
    project_id: Optional[str]
    project_name: Optional[str]
    is_completed: bool
    labels: List[str]


@dataclass 
class TodoistProject:
    """Standardized project data."""
    id: str
    name: str
    color: str
    is_favorite: bool


class TodoistProvider:
    """
    Todoist REST API integration.
    
    Requires API token from https://todoist.com/prefs/integrations
    """
    
    def __init__(self):
        self._api_token = os.getenv("TODOIST_API_TOKEN")
        self._base_url = "https://api.todoist.com/rest/v2"
        self._projects_cache: Dict[str, str] = {}  # id -> name mapping
    
    def is_configured(self) -> bool:
        """Check if API token is configured."""
        return bool(self._api_token)
    
    def _headers(self) -> Dict[str, str]:
        """Get authorization headers."""
        return {"Authorization": f"Bearer {self._api_token}"}
    
    async def authenticate(self, credentials: Dict[str, Any]) -> bool:
        """Set API token for Todoist."""
        try:
            self._api_token = credentials.get("api_token") or os.getenv("TODOIST_API_TOKEN")
            if not self._api_token:
                raise ValueError("No API token provided")
            return True
        except Exception as e:
            print(f"[Todoist] Auth failed: {e}")
            return False
    
    async def get_tasks(
        self,
        project_id: Optional[str] = None,
        filter_query: Optional[str] = None,
    ) -> List[TodoistTask]:
        """
        Get active tasks.
        
        Args:
            project_id: Filter by project
            filter_query: Todoist filter (e.g., "today", "overdue", "@shopping")
        """
        if not self._api_token:
            raise ValueError("TODOIST_API_TOKEN not configured")
        
        params = {}
        if project_id:
            params["project_id"] = project_id
        if filter_query:
            params["filter"] = filter_query
        
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/tasks",
                headers=self._headers(),
                params=params if params else None,
                timeout=10.0,
            )
            response.raise_for_status()
            data = response.json()
            
            tasks = []
            for item in data:
                due = item.get("due", {}) or {}
                tasks.append(TodoistTask(
                    id=item["id"],
                    content=item["content"],
                    description=item.get("description"),
                    due_date=due.get("date"),
                    due_string=due.get("string"),
                    priority=item.get("priority", 1),
                    project_id=item.get("project_id"),
                    project_name=self._projects_cache.get(item.get("project_id", "")),
                    is_completed=item.get("is_completed", False),
                    labels=item.get("labels", []),
                ))
            return tasks
    
    async def create_task(
        self,
        content: str,
        due_string: Optional[str] = None,
        priority: int = 1,
        project_id: Optional[str] = None,
        labels: Optional[List[str]] = None,
    ) -> TodoistTask:
        """
        Create a new task.
        
        Args:
            content: Task content
            due_string: Natural language due date ("tomorrow", "next monday")
            priority: 1-4 (4 is most urgent)
            project_id: Project to add task to
            labels: Label names to apply
        """
        if not self._api_token:
            raise ValueError("TODOIST_API_TOKEN not configured")
        
        body: Dict[str, Any] = {"content": content}
        if due_string:
            body["due_string"] = due_string
        if priority:
            body["priority"] = priority
        if project_id:
            body["project_id"] = project_id
        if labels:
            body["labels"] = labels
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/tasks",
                headers=self._headers(),
                json=body,
                timeout=10.0,
            )
            response.raise_for_status()
            item = response.json()
            
            due = item.get("due", {}) or {}
            return TodoistTask(
                id=item["id"],
                content=item["content"],
                description=item.get("description"),
                due_date=due.get("date"),
                due_string=due.get("string"),
                priority=item.get("priority", 1),
                project_id=item.get("project_id"),
                project_name=None,
                is_completed=False,
                labels=item.get("labels", []),
            )
    
    async def complete_task(self, task_id: str) -> bool:
        """Mark a task as complete."""
        if not self._api_token:
            raise ValueError("TODOIST_API_TOKEN not configured")
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/tasks/{task_id}/close",
                headers=self._headers(),
                timeout=10.0,
            )
            return response.status_code == 204
    
    async def delete_task(self, task_id: str) -> bool:
        """Delete a task."""
        if not self._api_token:
            raise ValueError("TODOIST_API_TOKEN not configured")
        
        async with httpx.AsyncClient() as client:
            response = await client.delete(
                f"{self._base_url}/tasks/{task_id}",
                headers=self._headers(),
                timeout=10.0,
            )
            return response.status_code == 204
    
    async def get_projects(self) -> List[TodoistProject]:
        """Get all projects."""
        if not self._api_token:
            raise ValueError("TODOIST_API_TOKEN not configured")
        
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/projects",
                headers=self._headers(),
                timeout=10.0,
            )
            response.raise_for_status()
            data = response.json()
            
            projects = []
            for item in data:
                self._projects_cache[item["id"]] = item["name"]
                projects.append(TodoistProject(
                    id=item["id"],
                    name=item["name"],
                    color=item.get("color", ""),
                    is_favorite=item.get("is_favorite", False),
                ))
            return projects
    
    async def get_today_tasks(self) -> List[TodoistTask]:
        """Get tasks due today."""
        return await self.get_tasks(filter_query="today")
    
    async def get_overdue_tasks(self) -> List[TodoistTask]:
        """Get overdue tasks."""
        return await self.get_tasks(filter_query="overdue")
    
    async def find_shopping_project(self) -> Optional[str]:
        """Find the Shopping project ID."""
        projects = await self.get_projects()
        for p in projects:
            if "shopping" in p.name.lower():
                return p.id
        return None


# Singleton instance
_provider: Optional[TodoistProvider] = None


def get_todoist_provider() -> TodoistProvider:
    """Get or create the Todoist provider instance."""
    global _provider
    if _provider is None:
        _provider = TodoistProvider()
    return _provider

