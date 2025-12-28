"""CrewAI tools for task/todo management."""

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


@tool("get_my_tasks")
def get_my_tasks(filter: str = "today") -> str:
    """
    Get tasks from the user's todo list.
    
    Args:
        filter: Which tasks to get - "today", "overdue", "all", or a project name
    
    Returns:
        JSON list of tasks
    """
    from butler_crew.services.integrations.tasks.todoist import get_todoist_provider
    
    provider = get_todoist_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "get_my_tasks",
            "filter": filter,
            "status": "not_configured",
            "message": "Task manager not connected. Add TODOIST_API_TOKEN to .env file.",
            "tasks": [],
        })
    
    try:
        # Map filter to Todoist filter query
        filter_map = {
            "today": "today",
            "overdue": "overdue",
            "all": None,
        }
        filter_query = filter_map.get(filter.lower(), filter)
        
        tasks = _run_async(provider.get_tasks(filter_query=filter_query))
        return json.dumps({
            "action": "get_my_tasks",
            "filter": filter,
            "status": "success",
            "task_count": len(tasks),
            "tasks": [
                {
                    "id": t.id,
                    "content": t.content,
                    "due": t.due_string or t.due_date,
                    "priority": t.priority,
                }
                for t in tasks
            ],
        })
    except Exception as e:
        return json.dumps({
            "action": "get_my_tasks",
            "filter": filter,
            "status": "error",
            "message": f"Failed to get tasks: {str(e)}",
        })


@tool("add_task")
def add_task(
    content: str,
    due: str = "",
    priority: str = "normal",
    project: str = "",
) -> str:
    """
    Add a new task to the todo list.
    
    Args:
        content: What the task is (e.g., "Buy groceries")
        due: When it's due (e.g., "today", "tomorrow", "next monday")
        priority: "low", "normal", "high", or "urgent"
        project: Project name to add to (optional)
    
    Returns:
        JSON confirmation with task details
    """
    from butler_crew.services.integrations.tasks.todoist import get_todoist_provider
    
    provider = get_todoist_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "add_task",
            "content": content,
            "status": "not_configured",
            "message": "Task manager not connected. Add TODOIST_API_TOKEN to .env file.",
        })
    
    priority_map = {"low": 1, "normal": 2, "high": 3, "urgent": 4}
    priority_num = priority_map.get(priority.lower(), 2)
    
    try:
        task = _run_async(provider.create_task(
            content=content,
            due_string=due if due else None,
            priority=priority_num,
        ))
        return json.dumps({
            "action": "add_task",
            "status": "success",
            "task_id": task.id,
            "content": task.content,
            "due": task.due_string or task.due_date,
            "priority": task.priority,
            "message": f"Task '{content}' added successfully.",
        })
    except Exception as e:
        return json.dumps({
            "action": "add_task",
            "content": content,
            "status": "error",
            "message": f"Failed to add task: {str(e)}",
        })


@tool("complete_task")
def complete_task(task_description: str) -> str:
    """
    Mark a task as complete.
    
    Args:
        task_description: Description of the task to complete (will search for match)
    
    Returns:
        JSON confirmation
    """
    from butler_crew.services.integrations.tasks.todoist import get_todoist_provider
    
    provider = get_todoist_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "complete_task",
            "task_description": task_description,
            "status": "not_configured",
            "message": "Task manager not connected. Add TODOIST_API_TOKEN to .env file.",
        })
    
    try:
        # Search for matching task
        tasks = _run_async(provider.get_tasks())
        matching_task = None
        for task in tasks:
            if task_description.lower() in task.content.lower():
                matching_task = task
                break
        
        if not matching_task:
            return json.dumps({
                "action": "complete_task",
                "task_description": task_description,
                "status": "not_found",
                "message": f"No task found matching '{task_description}'.",
            })
        
        success = _run_async(provider.complete_task(matching_task.id))
        return json.dumps({
            "action": "complete_task",
            "task_description": task_description,
            "status": "success" if success else "error",
            "completed_task": matching_task.content,
            "message": f"Task '{matching_task.content}' marked as complete.",
        })
    except Exception as e:
        return json.dumps({
            "action": "complete_task",
            "task_description": task_description,
            "status": "error",
            "message": f"Failed to complete task: {str(e)}",
        })


@tool("whats_on_my_todo")
def whats_on_my_todo() -> str:
    """
    Get a summary of today's tasks and any overdue items.
    
    Returns:
        JSON with task summary
    """
    from butler_crew.services.integrations.tasks.todoist import get_todoist_provider
    
    provider = get_todoist_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "whats_on_my_todo",
            "status": "not_configured",
            "message": "Task manager not connected. Add TODOIST_API_TOKEN to .env file.",
        })
    
    try:
        today_tasks = _run_async(provider.get_today_tasks())
        overdue_tasks = _run_async(provider.get_overdue_tasks())
        
        return json.dumps({
            "action": "whats_on_my_todo",
            "status": "success",
            "today_count": len(today_tasks),
            "overdue_count": len(overdue_tasks),
            "today_tasks": [t.content for t in today_tasks[:5]],
            "overdue_tasks": [t.content for t in overdue_tasks[:5]],
        })
    except Exception as e:
        return json.dumps({
            "action": "whats_on_my_todo",
            "status": "error",
            "message": f"Failed to get tasks: {str(e)}",
        })


@tool("add_to_shopping_list")
def add_to_shopping_list(item: str) -> str:
    """
    Add an item to the shopping list.
    
    Args:
        item: Item to add (e.g., "milk", "bread")
    
    Returns:
        JSON confirmation
    """
    from butler_crew.services.integrations.tasks.todoist import get_todoist_provider
    
    provider = get_todoist_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "add_to_shopping_list",
            "item": item,
            "status": "not_configured",
            "message": "Task manager not connected. Add TODOIST_API_TOKEN to .env file.",
        })
    
    try:
        # Find or create shopping project
        shopping_project_id = _run_async(provider.find_shopping_project())
        
        task = _run_async(provider.create_task(
            content=item,
            project_id=shopping_project_id,
            labels=["shopping"],
        ))
        
        return json.dumps({
            "action": "add_to_shopping_list",
            "item": item,
            "status": "success",
            "task_id": task.id,
            "message": f"'{item}' added to shopping list.",
        })
    except Exception as e:
        return json.dumps({
            "action": "add_to_shopping_list",
            "item": item,
            "status": "error",
            "message": f"Failed to add to shopping list: {str(e)}",
        })


@tool("get_shopping_list")
def get_shopping_list() -> str:
    """
    Get the current shopping list.
    
    Returns:
        JSON list of shopping items
    """
    from butler_crew.services.integrations.tasks.todoist import get_todoist_provider
    
    provider = get_todoist_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "get_shopping_list",
            "status": "not_configured",
            "items": [],
            "message": "Task manager not connected. Add TODOIST_API_TOKEN to .env file.",
        })
    
    try:
        shopping_project_id = _run_async(provider.find_shopping_project())
        
        if not shopping_project_id:
            return json.dumps({
                "action": "get_shopping_list",
                "status": "no_project",
                "items": [],
                "message": "No 'Shopping' project found in Todoist. Create one to use this feature.",
            })
        
        tasks = _run_async(provider.get_tasks(project_id=shopping_project_id))
        
        return json.dumps({
            "action": "get_shopping_list",
            "status": "success",
            "item_count": len(tasks),
            "items": [t.content for t in tasks],
        })
    except Exception as e:
        return json.dumps({
            "action": "get_shopping_list",
            "status": "error",
            "message": f"Failed to get shopping list: {str(e)}",
        })

