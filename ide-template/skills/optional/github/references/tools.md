# GitHub MCP tools (github-mcp-server v1.1.2)

Only the toolsets this integration can enable are listed. Toolset names match the **Capabilities** setting. Tools marked W are absent unless **Allow write** is on. `?` = optional parameter.

Source: https://github.com/github/github-mcp-server/blob/v1.1.2/README.md

## `repos`

| Tool | What it does | R/W | Parameters |
|---|---|---|---|
| `create_branch` | Create branch | W | branch, from_branch?, owner, repo |
| `create_or_update_file` | Create or update file | W | branch, content, message, owner, path, repo, sha? |
| `create_repository` | Create repository | W | autoInit?, description?, name, organization?, private? |
| `delete_file` | Delete file | W | branch, message, owner, path, repo |
| `fork_repository` | Fork repository | W | organization?, owner, repo |
| `get_commit` | Get commit details | R | include_diff?, owner, page?, perPage?, repo, sha |
| `get_file_contents` | Get file or directory contents | R | owner, path?, ref?, repo, sha? |
| `get_latest_release` | Get latest release | R | owner, repo |
| `get_release_by_tag` | Get a release by tag name | R | owner, repo, tag |
| `get_tag` | Get tag details | R | owner, repo, tag |
| `list_branches` | List branches | R | owner, page?, perPage?, repo |
| `list_commits` | List commits | R | author?, owner, page?, path?, perPage?, repo, sha?, since?, until? |
| `list_releases` | List releases | R | owner, page?, perPage?, repo |
| `list_repository_collaborators` | List repository collaborators | R | affiliation?, owner, page?, perPage?, repo |
| `list_tags` | List tags | R | owner, page?, perPage?, repo |
| `push_files` | Push files to repository | W | branch, files, message, owner, repo |
| `search_code` | Search code | R | order?, page?, perPage?, query, sort? |
| `search_commits` | Search commits | R | order?, page?, perPage?, query, sort? |
| `search_repositories` | Search repositories | R | minimal_output?, order?, page?, perPage?, query, sort? |

## `issues`

| Tool | What it does | R/W | Parameters |
|---|---|---|---|
| `add_issue_comment` | Add comment to issue | W | body, issue_number, owner, repo |
| `get_label` | Get a specific label from a repository | R | name, owner, repo |
| `issue_read` | Get issue details | R | issue_number, owner, page?, perPage?, repo |
| `issue_write` | Create or update issue | W | assignees?, body?, duplicate_of?, issue_number?, labels?, milestone?, owner, repo, state?, state_reason?, title?, type? |
| `list_issue_types` | List available issue types | R | owner |
| `list_issues` | List issues | R | after?, direction?, labels?, orderBy?, owner, perPage?, repo, since?, state? |
| `search_issues` | Search issues | R | order?, owner?, page?, perPage?, query, repo?, sort? |
| `sub_issue_write` | Change sub-issue | W | after_id?, before_id?, issue_number, owner, replace_parent?, repo, sub_issue_id |

## `pull_requests`

| Tool | What it does | R/W | Parameters |
|---|---|---|---|
| `add_comment_to_pending_review` | Add review comment to the requester's latest pending pull request review | W | body, line?, owner, path, pullNumber, repo, side?, startLine?, startSide?, subjectType |
| `add_reply_to_pull_request_comment` | Add reply to pull request comment | W | body, commentId, owner, pullNumber, repo |
| `create_pull_request` | Open new pull request | W | base, body?, draft?, head, maintainer_can_modify?, owner, repo, title |
| `list_pull_requests` | List pull requests | R | base?, direction?, head?, owner, page?, perPage?, repo, sort?, state? |
| `merge_pull_request` | Merge pull request | W | commit_message?, commit_title?, merge_method?, owner, pullNumber, repo |
| `pull_request_read` | Get details for a single pull request | R | after?, owner, page?, perPage?, pullNumber, repo |
| `pull_request_review_write` | Write operations (create, submit, delete) on pull request reviews | W | body?, commitID?, event?, method, owner, pullNumber, repo, threadId? |
| `search_pull_requests` | Search pull requests | R | order?, owner?, page?, perPage?, query, repo?, sort? |
| `update_pull_request` | Edit pull request | W | base?, body?, draft?, maintainer_can_modify?, owner, pullNumber, repo, reviewers?, state?, title? |
| `update_pull_request_branch` | Update pull request branch | W | expectedHeadSha?, owner, pullNumber, repo |

## `actions`

| Tool | What it does | R/W | Parameters |
|---|---|---|---|
| `actions_get` | Get details of GitHub Actions resources (workflows, workflow runs, jobs, and artifacts) | R | method, owner, repo |
| `actions_list` | List GitHub Actions workflows in a repository | R | method, owner, page?, per_page?, repo, workflow_jobs_filter?, workflow_runs_filter? |
| `actions_run_trigger` | Trigger GitHub Actions workflow actions | W | inputs?, method, owner, ref?, repo, run_id?, workflow_id? |
| `get_job_logs` | Get GitHub Actions workflow job logs | R | failed_only?, job_id?, owner, repo, return_content?, run_id?, tail_lines? |

## `code_security`

| Tool | What it does | R/W | Parameters |
|---|---|---|---|
| `get_code_scanning_alert` | Get code scanning alert | R | alertNumber, owner, repo |
| `list_code_scanning_alerts` | List code scanning alerts | R | owner, page?, perPage?, ref?, repo, severity?, state?, tool_name? |

## Method values for multi-purpose tools

- `issue_read.method`: get, get_comments, get_sub_issues, get_labels
- `issue_write.method`: create, update (close = update with `state: closed` + `state_reason`)
- `sub_issue_write.method`: add, remove, reprioritize
- `pull_request_read.method`: get, get_diff, get_status, get_files, get_review_comments, get_reviews, get_comments, get_check_runs
- `pull_request_review_write.method`: create, submit_pending, delete_pending, resolve_thread, unresolve_thread
- `actions_list.method`: list_workflows, list_workflow_runs, list_workflow_jobs, list_workflow_run_artifacts
- `actions_get.method`: get_workflow, get_workflow_run, get_workflow_job, get_workflow_run_usage, get_workflow_run_logs_url, download_workflow_run_artifact
- `actions_run_trigger.method`: run_workflow, rerun_workflow_run, rerun_failed_jobs, cancel_workflow_run, delete_workflow_run_logs

## Search syntax worth knowing

- PRs: `repo:o/r is:pr is:merged merged:2026-10-01..2026-10-02`, `is:open review-requested:@me`, `author:@me`, `draft:false`, `updated:<2026-10-01`
- Issues: `repo:o/r is:issue is:open label:bug no:assignee`
- Code: `repo:o/r path:src language:ts "exact phrase"` (max 256 chars)
- Commits (default branch only): `repo:o/r committer-date:>=2026-10-01`

