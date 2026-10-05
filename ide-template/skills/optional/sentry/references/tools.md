# Sentry MCP tools

From the `getsentry/sentry-mcp` source (hosted at mcp.sentry.dev). "Skill" = the permission group granted at connect time; a tool only appears if one of its skills was granted. `—` = always available or tied to a dataset rather than a skill. Experimental tools may be hidden. The live tool list is the truth.

Source: https://github.com/getsentry/sentry-mcp/tree/main/packages/mcp-core/src/tools/catalog

| Tool | What it does | R/W | Skill |
|---|---|---|---|
| `add_issue_note` | Add a human-visible comment to a Sentry issue's activity feed. | W | triage |
| `add_team_to_project` | Grant a team access to an existing Sentry project. | W | project-management |
| `analyze_issue_with_seer` | Use Seer to analyze production errors and get detailed root cause analysis with specific code fixes. | R* (starts a Seer run) | seer |
| `create_alert_rule` | Create a Sentry Alert (workflow) with notification actions and explicit sources. | W | project-management |
| `create_dsn` | Create an additional DSN for an EXISTING project. | W | project-management |
| `create_metric_monitor` | Create a Sentry Metric Monitor with Static, Percent or Dynamic detection in a project. | W | project-management |
| `create_project` | Create a new project in Sentry (provisions DSN automatically). | W | project-management |
| `create_team` | Create a new team in Sentry. | W | project-management |
| `create_uptime_monitor` | Create a Sentry HTTP uptime monitor. | W | project-management |
| `delete_alert_rule` | Permanently delete a Sentry Alert (workflow), preserving its connected monitors. | W (destructive) | project-management |
| `delete_metric_monitor` | Permanently delete a Sentry Metric Monitor, preserving its connected Alerts and their other monitors. | W (destructive) | project-management |
| `delete_uptime_monitor` | Delete a Sentry HTTP uptime monitor. | W (destructive) | project-management |
| `find_alert_rules` | Find Sentry alert rules. | R | inspect |
| `find_dashboards` | Find Sentry dashboards in an organization. | R | inspect |
| `find_dsns` | List all Sentry DSNs for a specific project. | R | project-management |
| `find_metric_monitors` | Find Sentry Metric Monitors that evaluate errors, performance, logs, metrics or crash rates. | R | inspect |
| `find_monitors` | Find Sentry cron monitors. | R | inspect |
| `find_organizations` | Find organizations that the user has access to in Sentry. | R | — |
| `find_projects` | Find projects in Sentry. | R | — |
| `find_releases` | Find releases in Sentry. | R | inspect |
| `find_teams` | Find teams in an organization in Sentry. | R | inspect, triage, project-management |
| `find_uptime_monitors` | Find Sentry uptime monitors. | R | inspect |
| `get_agent_conversation_details` | Fetch the chronological transcript and debugging details for one agent conversation, formerly called an AI conversation. | R | inspect, triage, seer |
| `get_alert_options` | Discover available actions, conditions, or sources for a Sentry Alert (notification workflow). | R | inspect |
| `get_alert_rule` | Get details for a Sentry alert rule. | R | inspect |
| `get_dashboard_details` | Get detailed information about a specific Sentry dashboard. | R | inspect |
| `get_doc` | Fetch the full markdown content of a Sentry documentation page. | R | inspect, docs |
| `get_event_attachment` | Download attachments from a Sentry event. | R | inspect |
| `get_event_stacktrace` | Get a full thread stacktrace from a specific Sentry event. | R | inspect, triage, seer |
| `get_issue_activity` | Get the activity feed and comments for a Sentry issue. | R | inspect, triage |
| `get_issue_breadcrumbs` | Get the breadcrumb trail from a Sentry issue event. | R | inspect, triage |
| `get_issue_details` | Get detailed information about a specific Sentry issue by ID. | R | inspect, triage, seer |
| `get_issue_tag_values` | Get tag value distribution for a specific Sentry issue. | R | inspect |
| `get_issue_user_reports` | Get legacy User Reports or crash-report feedback attached to a Sentry issue. | R | inspect, triage |
| `get_latest_base_snapshot` | Get the latest UI screenshots/images for an app from the preprod snapshot system. | R | inspect |
| `get_metric_monitor_details` | Inspect a Sentry Metric Monitor's query, dataset, detection mode, thresholds, resolution conditions and connected Alerts. | R | inspect |
| `get_monitor_details` | Get details for a Sentry cron monitor. | R | inspect |
| `get_profile_details` | Inspect a specific Sentry profile in detail. | R | inspect |
| `get_profile` | Analyze CPU profiling data to identify performance bottlenecks and detect regressions. | R | inspect |
| `get_release_details` | Get details for a Sentry release. | R | inspect |
| `get_replay_details` | Get high-level information about a specific Sentry replay by URL or replay ID. | R | inspect |
| `get_sentry_mcp_info` | Get information about the running Sentry MCP server. | R | — |
| `get_sentry_resource` | Fetch any Sentry resource (issue, event, trace, replay…) by URL or id. | R | inspect, triage, seer |
| `get_snapshot_image` | Get metadata and image content for one image in a preprod snapshot. | R | inspect |
| `get_snapshot` | Get a preprod UI snapshot. | R | inspect |
| `get_span_details` | Get detailed information about a specific span within a Sentry trace. | R | inspect |
| `get_trace_details` | Get detailed information about a specific Sentry trace by ID. | R | inspect |
| `get_uptime_monitor_details` | Get details for a Sentry uptime monitor, including recent checks. | R | inspect |
| `link_issue` | Link an existing external ticket or GitHub pull request to a Sentry issue by URL. | W | triage |
| `onboarding_status_update` | Update the progress shown in Sentry's agentic onboarding UI. | W | — |
| `remove_team_from_project` | Revoke a team's access to an existing Sentry project. | W (destructive) | project-management |
| `search_agent_conversations` | Search Sentry Agent Conversations, formerly called AI Conversations, and return one summary row per conversation. | R | inspect, triage, seer |
| `search_docs` | Search Sentry documentation. | R | inspect, docs |
| `search_errors` | Search Sentry error events: exceptions and crashes with stack traces. Use for error counts, statistics, trends, and individual error events. | R | — |
| `search_events` | Deprecated multi-dataset search; prefer search_errors / search_logs / search_traces. | R | — |
| `search_issue_events` | Search and filter events within a specific issue. | R | inspect, triage |
| `search_issues` | Search for grouped issues/problems in Sentry - returns a LIST of issues, NOT counts or aggregations. | R | inspect, triage, seer |
| `search_logs` | Search Sentry logs: application log entries, including error- and warning-severity log messages. Use for log counts, statistics, trends, and individual log lines. | R | — |
| `search_metrics` | Search Sentry metrics: counters, gauges, and distributions, as rows or aggregates. Use for metric values, percentiles, totals, and trends. | R | — |
| `search_profiles` | Search Sentry profiles: transaction and continuous profile results, profile IDs, and profiled transactions. Use to find profiles to inspect. | R | — |
| `search_replays` | Search Sentry session replays: rage clicks, dead clicks, visited pages, errors seen, and replay users. | R | — |
| `search_traces` | Search Sentry spans and traces: requests, API/HTTP calls, endpoints, DB queries, AI/LLM calls, and other operations. Use for latency, throughput, slowness, and performance questions. | R | — |
| `unlink_issue` | Remove an external ticket or GitHub pull request reference from a Sentry issue by URL. | W (destructive) | triage |
| `update_alert_rule` | Update a Sentry Alert (workflow), including notification actions and connections. | W (destructive) | project-management |
| `update_dsn` | Update settings for an existing DSN (client key) in a project, such as name, active status, rate limit, and loader script options. | W (destructive) | project-management |
| `update_issue` | Update a Sentry issue's status or assignment. | W (destructive) | triage |
| `update_metric_monitor` | Update a Sentry Metric Monitor's query, detection conditions, metadata, status or connected Alerts. | W (destructive) | project-management |
| `update_project` | Update project metadata in Sentry, such as name, slug, and platform. | W (destructive) | project-management |
| `update_uptime_monitor` | Update a Sentry HTTP uptime monitor. | W (destructive) | project-management |
| `whoami` | Identify the authenticated user in Sentry. | R | — |
