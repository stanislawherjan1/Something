# Neon MCP tools

From the live tool list of the hosted server (`https://mcp.neon.tech/api/list-tools`, 113 tools in write mode). The set you actually get depends on what the person granted on the consent page (read-only, project scope, categories). R = available in read-only mode. W! = deletes, overwrites, discards changes, interrupts the database or rotates secrets.

Sources: https://github.com/neondatabase/mcp-server-neon (README "Supported Tools"), https://mcp.neon.tech/api/list-tools

## projects

| Tool | What it does | R/W |
|---|---|---|
| `list_organizations` | List all organizations the current user belongs to. | R |
| `list_projects` | List Neon projects you own. | R |
| `describe_project` | Retrieves the project record (settings, compute, usage). | R |
| `create_project` | Creates a Neon project and waits until the default compute is ready. | W |
| `update_project` | Updates the specified project. | W |
| `delete_project` | Delete a Neon project and all its data. | W! |
| `recover_project` | Recovers a deleted project within the 7-day deletion recovery period. | W |
| `list_project_permissions` | Retrieves details about users who have access to the project, including the permission `id`, the granted-to email address, and the date project access was granted. | R |
| `list_project_members` | Lists organization members and their per-project roles for an org-owned project. | R |
| `list_regions` | Lists Neon regions available to the authenticated account. | R |
| `list_operations` | Lists operations for a project. | R |
| `get_operation` | Retrieves details for the specified operation. | R |

## querying

| Tool | What it does | R/W |
|---|---|---|
| `run_sql` | Execute one SQL statement on a Neon database. | R/W (writes only outside read-only mode) |
| `run_sql_transaction` | Execute multiple SQL statements as one transaction. | R/W (writes only outside read-only mode) |
| `prepare_database_migration` | Apply a schema change on a temporary branch and return a migration_id. | W |
| `complete_database_migration` | Apply or discard a prepared migration and delete the temporary branch. | W! |
| `explain_sql_statement` | Generate the execution plan for a SQL statement. | R (with `analyze: true` the statement really runs) |
| `prepare_query_tuning` | Analyze a slow query on a temporary branch and return a tuning_id. | W |
| `complete_query_tuning` | Apply or discard query-tuning changes and delete the temporary branch. | W! |
| `list_slow_queries` | List queries from pg_stat_statements by execution time, slowest first. | R |
| `inspect_database` | Run one read-only neon inspect db check (pick `check` from the input schema). | R |

## schema

| Tool | What it does | R/W |
|---|---|---|
| `describe_table_schema` | Get column definitions, data types, and constraints for a specific table. | R |
| `get_database_tables` | List all tables in a Neon database. | R |
| `compare_database_schema` | Compare one database's SQL schema on a branch to another. | R |

## branches

| Tool | What it does | R/W |
|---|---|---|
| `describe_branch` | Get a tree view of all objects in a branch, including databases, schemas, tables, views, and functions. | R |
| `get_connection_string` | Get a PostgreSQL connection string for a Neon database. | W |
| `list_branches` | Retrieves a list of branches for the specified project. | R |
| `get_branch` | Retrieves information about the specified branch. | R |
| `create_branch` | Creates a branch with a read-write compute and waits until it is ready. | W |
| `update_branch` | Updates the specified branch. | W |
| `delete_branch` | Delete a branch and all its data. | W! |
| `get_default_branch` | Resolve the project's default branch by the default flag, not by name. | R |
| `set_default_branch` | Sets the specified branch as the project's default branch. | W! |
| `reset_from_parent` | Reset a branch to its parent's current HEAD. | W! |
| `finalize_branch_restore` | Finalize a branch created with `restore_snapshot` and `finalize: false`: reassign computes (this restarts them) and swap names so it replaces the original branch. | W! |
| `list_postgres_roles` | Retrieves a list of Postgres roles from the specified branch. | R |
| `get_postgres_role` | Retrieves details about the specified role. | R |
| `create_postgres_role` | Creates a Postgres role in the specified branch. | W |
| `delete_postgres_role` | Deletes the specified Postgres role from the branch. | W! |
| `reset_postgres_role_password` | Resets the password for the specified Postgres role. | W! |
| `list_postgres_databases` | Retrieves a list of databases for the specified branch. | R |
| `get_postgres_database` | Retrieves information about the specified database. | R |
| `create_postgres_database` | Creates a database in the specified branch. | W |
| `update_postgres_database` | Updates the specified database in the branch. | W |
| `delete_postgres_database` | Deletes the specified database from the branch. | W! |
| `list_credentials` | Returns metadata for customer-issued credentials on the branch. | R |
| `create_credential` | Issues a new scoped service credential anchored to the specified branch. | W |
| `revoke_credential` | Soft-deletes the credential. | W! |
| `rotate_credential` | Replaces the secret material on an existing scoped credential in place. | W! |

## neon_auth

| Tool | What it does | R/W |
|---|---|---|
| `get_neon_auth_config` | Read Neon Auth config for a branch with OAuth and SMTP secrets redacted as "***redacted***". | R |
| `get_auth` | Retrieves the Neon Auth integration details for the specified branch, including the auth provider type and integration status. | R |
| `provision_neon_auth` | Enables Neon Auth for the specified branch by connecting it to an authentication provider. | W |
| `disable_auth` | Disables the Neon Auth integration for the specified branch, removing the connection to the authentication provider. | W! |
| `update_auth_config` | Updates the auth configuration for the branch. | W |
| `list_auth_oauth_providers` | Lists the OAuth providers configured for the specified branch's Neon Auth integration. | W |
| `add_auth_oauth_provider` | Adds an OAuth provider configuration to the specified branch's Neon Auth integration. | W |
| `update_auth_oauth_provider` | Updates an OAuth provider for the specified project. | W |
| `delete_auth_oauth_provider` | Deletes an OAuth provider from the specified project. | W! |
| `list_auth_trusted_domains` | Lists the trusted domains in the redirect URI whitelist for the specified branch. | R |
| `add_auth_trusted_domain` | Adds a domain to the redirect URI whitelist for the specified branch. | W |
| `delete_auth_trusted_domain` | Removes a domain from the redirect URI whitelist for the specified branch. | W! |
| `create_auth_user` | Creates a new user in the Neon Auth user directory for the specified branch. | W |
| `delete_auth_user` | Deletes the specified user from the Neon Auth user directory for the specified branch. | W! |
| `update_auth_user_role` | Updates the role of a user in the Neon Auth user directory for the specified branch. | W |

## global

| Tool | What it does | R/W |
|---|---|---|
| `search` | Search across all organizations, projects, and branches by keyword. | R |
| `fetch` | Fetch detailed information about a specific organization, project, or branch using the ID returned by the `search` tool. | R |

## docs

| Tool | What it does | R/W |
|---|---|---|
| `list_docs_resources` | List Neon documentation page slugs from neon.com/docs/llms.txt. | R |
| `get_doc_resource` | Fetch one Neon documentation page as markdown. | R |

## endpoints

| Tool | What it does | R/W |
|---|---|---|
| `list_postgres_endpoints` | Retrieves a list of compute endpoints for the specified project. | R |
| `list_branch_computes` | Retrieves a list of compute endpoints for the specified branch. | R |
| `get_postgres_endpoint` | Retrieves information about the specified compute endpoint. | R |
| `create_postgres_endpoint` | Creates a compute endpoint on a branch. | W |
| `update_postgres_endpoint` | Updates the specified compute endpoint. | W |
| `delete_postgres_endpoint` | Deletes the specified compute endpoint. | W! |
| `start_postgres_endpoint` | Starts a compute endpoint. | W |
| `suspend_postgres_endpoint` | Suspends the specified compute endpoint. | W! |
| `restart_postgres_endpoint` | Restarts the specified compute endpoint by immediately suspending it and then starting it again. | W! |

## snapshots

| Tool | What it does | R/W |
|---|---|---|
| `list_snapshots` | Lists the snapshots for the specified project. | R |
| `get_snapshot_schedule` | Returns the backup schedule for the specified branch, including the configured snapshot frequencies. | R |
| `set_snapshot_schedule` | Replace a branch's automatic snapshot schedule. | W |
| `create_snapshot` | Creates a snapshot from the specified branch. | W |
| `update_snapshot` | Updates the specified snapshot. | W |
| `delete_snapshot` | Deletes the specified snapshot. | W! |
| `restore_snapshot` | Restore a snapshot onto a new or existing branch. | W! |

## data_api

| Tool | What it does | R/W |
|---|---|---|
| `get_data_api` | Retrieves the Neon Data API configuration for the specified branch, including endpoint URL, enabled state, and database settings. | R |
| `provision_neon_data_api` | Creates a new instance of Neon Data API in the specified branch. | W |
| `update_data_api` | Updates the Neon Data API configuration for the specified branch. | W |
| `delete_data_api` | Deletes the Neon Data API for the specified branch. | W! |

## observability

| Tool | What it does | R/W |
|---|---|---|
| `query_logs` | Returns logs for a branch. | R |
| `list_log_fields` | Lists the low-cardinality log fields observed on this branch. | R |
| `list_log_field_values` | Lists distinct values for a low-cardinality log field. | R |
| `get_ai_gateway` | Returns the AI Gateway endpoint host for the specified branch, used to render code-snippet base URLs. | R |

## functions

| Tool | What it does | R/W |
|---|---|---|
| `list_functions` | Lists functions on the specified branch. | R |
| `get_function` | Returns the function identified by its slug. | R |
| `update_function` | Updates the function's mutable metadata — currently only the display `name`. | W |
| `delete_function` | Deletes the function identified by its slug. | W! |
| `deploy_function` | Creates a deployment for the function. | W |
| `list_functions_custom_domains` | Lists all custom domains registered on the branch, across every target entity. | R |
| `register_functions_custom_domain` | Registers a hostname on the branch and routes it to a function. | W |
| `delete_functions_custom_domain` | Removes a custom domain registered on the branch and stops routing it. | W! |
| `list_triggers` | Lists the complete project-bounded set of triggers visible on the branch, ordered by `trigger_id`. | R |
| `get_trigger` | Returns the trigger visible on the branch. | R |
| `create_trigger` | Creates a trigger for a Function visible on the branch. | W |
| `update_trigger` | Applies a partial update. | W |
| `delete_trigger` | Deletes a branch-local trigger or writes a branch-local tombstone for an inherited trigger so it does not reappear. | W! |

## storage

| Tool | What it does | R/W |
|---|---|---|
| `get_storage` | Returns whether branchable object storage is usable for the specified branch. | R |
| `list_storage_buckets` | Lists branchable object storage buckets visible on the specified branch, including those inherited from ancestor branches. | R |
| `create_storage_bucket` | Creates a new branchable object storage bucket on the specified branch. | W |
| `delete_storage_bucket` | Deletes the named bucket from the specified branch. | W! |
| `list_storage_objects` | Lists objects visible in the named bucket on the specified branch, including those inherited from ancestor branches. | R |
| `delete_storage_object` | Deletes the named object from the bucket on the specified branch. | W! |
| `delete_storage_objects_by_prefix` | Soft-deletes every object on the specified branch whose key starts with `prefix`, in a single call. | W! |
| `presign_storage_object` | Returns a presigned URL that transfers bytes directly to or from the object's bucket on the specified branch, without the caller ever handling S3 credentials. | W |

