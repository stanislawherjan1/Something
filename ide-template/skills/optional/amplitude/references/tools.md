# Amplitude MCP — full tool list

From Amplitude's MCP documentation. The server only shows what the person's role allows;
tools marked *write permission* need the `USE_MCP_WRITE` permission in Amplitude.

| Area | Tool | What it does | Kind |
|---|---|---|---|
| Discovery | `get_amplitude_context` | Current user, organisation, accessible projects | read |
| | `search` | Find charts, dashboards, notebooks, experiments, events, properties, cohorts | read |
| | `get_from_url` | Full definition of the object behind an Amplitude URL | read |
| Analytics | `query_amplitude_data` | Ad-hoc queries: event segmentation, funnels, retention, … | read |
| | `get_amplitude_charts` | Saved chart definitions and data by id | read |
| | `render_amplitude_chart` | Render a chart from a query definition | read |
| | `use_amplitude_chart_monitors` | Read and **create/manage** chart alerts and monitors | read/write |
| Dashboards | `use_amp_dashboards` | Get, **create, edit** dashboards | read/write |
| Notebooks | `use_amp_notebooks` | Get, **create, edit** notebooks | read/write |
| Comments | `use_amp_comments` | Read and **add** comments | read/write |
| Sharing | `share_amp_entities` | **Change sharing and access roles** | access |
| Cohorts | `use_amplitude_cohorts` | Get, **create, sync** cohorts; membership; CSV export | read/write |
| Users | `get_amp_user_data` | User profiles, properties, activity timelines (personal data) | read |
| Experiments | `get_experiments`, `query_experiment` | Experiments and their results | read |
| | `create_experiment`, `update_experiment`, `create_metric` | Create / change experiments and metrics | write |
| Flags | `get_flags`, `get_deployments` | Feature flags and deployments | read |
| | `create_flags`, `update_flag` | **Change what users of the product see** | write |
| Taxonomy | `get_amp_taxonomy`, `get_transformations`, `get_group_types` | Tracking plan, transformations, group types | read |
| | `manage_amp_events`, `manage_amp_properties`, `manage_amp_taxonomy` | Create, update, **delete**, restore, merge (write permission) | write |
| Session replay | `get_session_replays`, `list_session_replays`, `get_session_replay_events` | Replays from the last 30 days | read |
| Guides & surveys | `list_guides_surveys`, `get_guide_or_survey` | Read | read |
| Wave | `query_wave_opportunities`, `query_wave_product_areas` | Read | read |
| | `manage_wave_opportunities`, `manage_wave_product_areas`, `manage_wave_verification_artifacts` | Create / update | write |
| Feedback | `use_amplitude_ai_feedback` | Customer feedback themes and raw comments | read |
| AI agents | `get_agent_results`, `get_amplitude_agent_analytics_info` | Results and metrics of Amplitude's AI agents | read |
| Warehouse | `get_data_ingestion_sources`, `get_data_source_details`, `get_data_warehouse_destinations`, `get_data_warehouse_jobs` | Import/export configuration and job history | read |
