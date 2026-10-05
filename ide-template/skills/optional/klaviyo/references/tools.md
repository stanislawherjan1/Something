# Klaviyo MCP — full tool inventory

Source: developers.klaviyo.com/en/docs/klaviyo_mcp_server_available_tools. The hosted server loads a core subset by default and beta tools only when enabled — your live tool list is the truth.

Legend: **R** read · **W** write · **S** sends to people · **D** deletes · **C** consent/access

## Accounts
R `get_account_details`

## Campaigns
R `get_campaigns`, `get_campaign`, `get_campaign_message`, `get_campaign_send_job`, `get_campaign_recipient_estimation`, `get_campaign_recipient_estimation_job`
W `create_campaign`, `create_campaign_clone`, `update_campaign`, `update_campaign_message`, `update_image_for_campaign_message`, `assign_template_to_campaign_message`, `refresh_campaign_recipient_estimation`, `cancel_campaign_send`
S `send_campaign`
D `delete_campaign`

## Reporting
R `get_campaign_report`, `get_flow_report`, `query_form_values`, `query_form_series`, `query_segment_values`, `query_segment_series`

## Events and metrics
R `get_events`, `get_event` (contain user data), `get_metrics`, `get_metric`, `query_metric_aggregates`, `get_metric_property`, `get_custom_metrics`, `get_custom_metric`, `get_mapped_metrics`, `get_mapped_metric`, `get_flows_triggered_by_metric`, `get_event_bulk_export_job`, `get_download_for_event_bulk_export_job`
W `create_custom_metric`, `update_custom_metric`, `update_mapped_metric`, `bulk_create_events` (`create_event` is local-only)
D `delete_custom_metric`

## Flows
R `get_flows`, `get_flow`, `get_flow_message`, `get_flow_action`
W `create_flow`, `update_flow_action`
S `update_flow` (status live = sends automatically)
D `delete_flow`

## Lists and segments
R `get_lists`, `get_list`, `get_segments`, `get_segment`, `get_flows_triggered_by_list`, `get_flows_triggered_by_segment`
W `create_list`, `update_list`, `add_profiles_to_list`, `remove_profiles_from_list`, `create_segment`, `update_segment`
D `delete_list`, `delete_segment`

## Profiles
R `get_profiles`, `get_profile` (user data), `get_push_token(s)`, bulk import/suppress/unsuppress/export job getters
W `create_profile`, `update_profile`, `create_or_update_profile`, `merge_profiles`, `bulk_import_profiles`, `create_push_token`
C `subscribe_profile_to_marketing`, `unsubscribe_profile_from_marketing`, `bulk_suppress_profiles`, `bulk_unsuppress_profiles`
D `delete_push_token`, `request_profile_deletion` (permanent)

## Templates and universal content
R `list_email_templates`, `get_email_template`, `render_email_template`, `get_universal_content`, `get_all_universal_content`
W `create_email_template`, `create_dnd_email_template`, `update_email_template`, `update_dnd_email_template`, `clone_email_template`, `create_universal_content`, `update_universal_content`
S `create_template_preview_send_job` (beta)
D `delete_email_template`, `delete_universal_content`

## Images
R `get_image`, `get_images` · W `upload_image_from_url`, `update_image` (`upload_image_from_file` is local-only)

## Catalogs (items, variants, categories)
R `get_catalog_items`, `get_catalog_item`, `get_catalog_variants`, `get_catalog_variant`, `get_catalog_categories`, `get_catalog_category`, bulk job getters
W create/update for items, variants, categories; category membership add/remove/update; bulk create/update; `create_back_in_stock_subscription`
D `delete_catalog_item`, `delete_catalog_variant`, `delete_catalog_category`, bulk deletes

## Coupons
R `get_coupons`, `get_coupon`, `get_coupon_codes`, `get_coupon_code`, bulk job getters
W `create_coupon`, `update_coupon`, `create_coupon_code`, `update_coupon_code`, `bulk_create_coupon_codes`
D `delete_coupon`, `delete_coupon_code`

## Tags
R `get_tags`, `get_tag`, `get_tag_groups`, `get_tag_group`
W create/update tags and tag groups; `tag_campaigns|flows|lists|segments`, `remove_tag_from_campaigns|flows|lists|segments`
D `delete_tag`, `delete_tag_group`

## Forms
R `get_forms`, `get_form`, `get_form_version` · W `create_form` · D `delete_form`

## Reviews (user data)
R `get_reviews`, `get_review` · W `update_review`

## Webhooks (operator territory)
R `get_webhooks`, `get_webhook`, `get_webhook_topics`, `get_webhook_topic` · W `create_webhook`, `update_webhook` · D `delete_webhook`

## Beta areas
- Translations: get/create/update/delete
- Brands: buttons, colors, logos, social groups, email defaults, voice — get/create/update/delete
- Customer agent: knowledge, skills, tools, conversations, analytics
- Sending domains: create, verify, activate, delete — operator territory
- Text messaging (SMS) configuration and sender registration — operator territory
- Billing usage (read), applications (read)

## Other
`report_unsupported_task` — tells Klaviyo about a missing capability; only with the person's OK.
`request_profile_deletion` — data-privacy deletion, permanent.
