# Cal.com hosted MCP — full tool list

From cal.com/docs/mcp-server (hosted server at mcp.cal.com). R = read, W = write.
Anything marked **sends** emails attendees or members; **delete** is permanent.

| Group | Tool | What it does | R/W |
|---|---|---|---|
| App | `get_app_link` | URL to open a resource in the Cal.com app | R |
| Docs | `search_docs` | Search Cal.com's product documentation | R |
| Profile | `get_me` | Connected user's profile | R |
| Profile | `update_me` | Change the user's profile (name, time zone, …) | W |
| Event types | `get_event_types`, `get_event_type` | List / get bookable types | R |
| Event types | `get_event_type_settings`, `get_event_type_history`, `get_scheduling_config` | Settings, change log, scheduling parameters | R |
| Event types | `create_event_type`, `update_event_type` | New / changed bookable type | W |
| Event types | `delete_event_type` | Remove a bookable type | **W, delete** |
| Event types | `get_crm_sync_errors` | CRM sync problems | R |
| Bookings | `get_bookings`, `get_booking` | List / get by uid | R |
| Bookings | `get_booking_attendees`, `get_booking_attendee`, `get_booking_routing_trace` | Attendees, routing info | R |
| Bookings | `get_org_team_bookings`, `get_org_user_bookings` | Team / member bookings (org admins) | R |
| Bookings | `create_booking`, `reschedule_booking`, `cancel_booking`, `confirm_booking`, `add_booking_attendee` | Book / move / cancel / accept / add guest | **W, sends** |
| Bookings | `mark_booking_absent` | Record a no-show | W |
| Schedules | `get_schedules`, `get_schedule`, `get_default_schedule` | Working-hours schedules | R |
| Schedules | `create_schedule`, `update_schedule` | New / changed schedule | W |
| Schedules | `delete_schedule` | Remove a schedule | **W, delete** |
| Availability | `get_availability`, `get_busy_times` | Free slots / busy blocks | R |
| Calendars | `get_connected_calendars`, `get_conferencing_apps` | Connected calendars, video apps | R |
| Teams | `get_my_teams`, `get_org_teams`, `get_team_memberships`, `get_team_membership` | Teams and members | R |
| Teams | `create_team_invite`, `create_team_membership`, `update_team_membership` | Invite / add / change member | **W, access** |
| Teams | `delete_team_membership` | Remove a member | **W, access, delete** |
| Org | `get_org_memberships`, `get_org_membership`, `get_org_attributes`, `get_org_attribute`, `get_attribute_options`, `get_user_attributes`, `get_user_attribute_history` | Org members and attributes | R |
| Org | `create_org_membership`, `update_org_membership`, `delete_org_membership` | Add / change / remove org member | **W, access** |
| Org | `assign_attribute_to_user`, `update_user_attribute`, `unassign_attribute_from_user` | Member attributes (affect routing) | W |
| Routing | `get_org_routing_forms`, `get_org_routing_form_responses`, `calculate_routing_form_slots` | Routing forms, responses, slots | R |
| API | `find_api_operation`, `describe_api_operation` | Search / describe any API v2 operation | R |
| API | `call_api_operation` | Execute any API v2 operation | **W, any** |

Membership and attribute changes alter who can book or be booked — always confirm.
