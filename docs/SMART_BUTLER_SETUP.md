# Smart Butler Setup Guide

To enable proactive suggestions, automations, and push notifications, follow these steps.

## 1. Get your Supabase Function URL
You need the public URL of your `proactive-butler` function.
It generally looks like: `https://<YOUR_REF>.supabase.co/functions/v1/proactive-butler`

## 2. Configure Home Assistant (The Eyes)
Add the following `rest_command` to your `configuration.yaml`.

```yaml
rest_command:
  send_butler_event:
    url: "https://<YOUR_REF>.supabase.co/functions/v1/proactive-butler"
    method: POST
    headers:
      Authorization: "Bearer <YOUR_ANON_KEY>"
      Content-Type: "application/json"
    payload: >-
      {
        "event_type": "{{ event_type }}",
        "timestamp": "{{ now().isoformat() }}",
        "connection_id": "<YOUR_CONNECTION_UUID_FROM_DB>" 
        {% if entity_id is defined %}, "entity_id": "{{ entity_id }}" {% endif %}
        {% if state is defined %}, "state": "{{ state }}" {% endif %}
        {% if attributes is defined %}, "attributes": {{ attributes | tojson }} {% endif %}
      }
    verify_ssl: true
```
> **Note**: Including `connection_id` helps the backend know which phone to ping!

## 3. Create Basic Automations (The Triggers)
Create automations for events you want the Butler to notice.
- Arriving Home
- Sunset
- Waking up
- Leaving Home

## 4. Setup Push Notifications (The Voice)
For the Butler to reach you when the app is closed:

1.  **Firebase**: Go to [Firebase Console](https://console.firebase.google.com/), create a project.
2.  **Add Android App**: Download `google-services.json` and place it in `android/app/`.
3.  **Supabase Secrets**:
    -   Get your **Server Key** (Cloud Messaging API (Legacy) or HTTP v1).
    -   Run: `supabase secrets set FCM_SERVER_KEY=your_server_key`

## 5. Enable Habit Learning (The Brain)
To make the Butler learn your habits:
1.  Ensure events are flowing (Step 2).
2.  Set up a **Schedule** for the `analyze-patterns` function.
    -   In Supabase Dashboard -> Edge Functions -> `analyze-patterns` -> Logs.
    -   Or use `pg_cron` in SQL Editor:
    ```sql
    select
      cron.schedule(
        'analyze-habits-weekly',
        '0 0 * * 0', -- Every Sunday at midnight
        $$
        select
          net.http_post(
              url:='https://<YOUR_REF>.supabase.co/functions/v1/analyze-patterns',
              headers:='{"Content-Type": "application/json", "Authorization": "Bearer <SERVICE_ROLE_KEY>"}'
          ) as request_id;
        $$
      );
    ```
