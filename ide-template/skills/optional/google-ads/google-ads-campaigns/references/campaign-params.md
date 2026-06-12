# `create_campaign` — parameter reference

| Parameter | Format | Example |
|---|---|---|
| `daily_budget_micros` | micros (÷1,000,000 = currency) | `50000000` = €50/day |
| `start_date` / `end_date` | `YYYY-MM-DD` | `2026-05-01` |
| `bidding_strategy` | see Bidding strategies below | `MAXIMIZE_CLICKS` |
| `customer_id` | digits only, no dashes | `6990978968` |
| `geo_target_ids` | array of location IDs | `["1014044", "2840"]` |
| `language_ids` | array of language IDs | `["1000"]` |
| `conversion_goal` | enum string (see below) | `"PURCHASE"` |

Always pass `conversion_goal` — without it the UI shows "No marketing objective selected" and optimisation may be suboptimal.

## Conversion goal values

| Value | Use when |
|---|---|
| `PURCHASE` | E-commerce, product sales |
| `LEAD` | Lead generation, contact forms |
| `SIGNUP` | Account registrations |
| `PAGE_VIEW` | Traffic / brand awareness |
| `CONTACT` | Phone calls, chat enquiries |
| `DOWNLOAD` | App downloads, file downloads |
| `DEFAULT` | Default account conversion goal |

## Bidding strategies

| `bidding_strategy` value | Best for | Extra param needed |
|---|---|---|
| `MAXIMIZE_CLICKS` (default) | New campaigns, traffic | — |
| `MAXIMIZE_CONVERSIONS` | Conversion-focused | Requires conversion tracking |
| `MANUAL_CPC` | Full manual control | — |
| `TARGET_CPA` | Known target cost/conversion | `target_cpa_micros` |
| `TARGET_ROAS` | Known target return on ad spend | `target_roas` (e.g. `3.5` = 350%) |

## Country geo target IDs

| ID | Country | ID | Country |
|---|---|---|---|
| `2840` | USA | `2826` | United Kingdom |
| `2276` | Germany | `2616` | Poland |
| `2250` | France | `2380` | Italy |
| `2724` | Spain | `2528` | Netherlands |
| `2040` | Austria | `2056` | Belgium |
| `2756` | Switzerland | `2208` | Denmark |
| `2578` | Norway | `2246` | Finland |
| `2752` | Sweden | `2620` | Portugal |
| `2372` | Ireland | `2203` | Czech Republic |
| `2348` | Hungary | `2036` | Australia |
| `2124` | Canada | | |

## City geo target IDs — Europe

| ID | City | ID | City |
|---|---|---|---|
| `1006886` | London | `1006094` | Paris |
| `1003854` | Berlin | `1004437` | Hamburg |
| `1004234` | Munich | `1011419` | Warsaw |
| `1011367` | Kraków | `1011243` | Wrocław |
| `1011615` | Poznań | `1011475` | Gdańsk |
| `1010543` | Amsterdam | `1000997` | Vienna |
| `1005493` | Madrid | `1005424` | Barcelona |
| `1008736` | Rome | `1008463` | Milan |
| `1003803` | Prague | `1007633` | Budapest |
| `1012228` | Stockholm | `1005010` | Copenhagen |
| `1010826` | Oslo | `9072483` | Helsinki |
| `1001004` | Brussels | `1003297` | Zurich |
| `1011742` | Lisbon | `1007850` | Dublin |

## City geo target IDs — USA & other

| ID | City | ID | City |
|---|---|---|---|
| `1023191` | New York | `1013962` | Los Angeles |
| `1016367` | Chicago | `1015116` | Miami |
| `1014221` | San Francisco | `1027744` | Seattle |
| `1026339` | Dallas | `1026481` | Houston |
| `1018127` | Boston | `1002451` | Toronto |
| `1000286` | Sydney | `1000567` | Melbourne |

## Language IDs

`1000` English · `1030` Polish · `1001` French · `1009` German · `1004` Spanish · `1040` Italian · `1014` Dutch · `1015` Portuguese

## Known API limitations

- **Campaigns cannot be deleted via API.** `REMOVED` is a read-only status — setting it via `update_campaign` returns `INVALID_ENUM_VALUE`. To remove: pause via API, then delete manually in the UI. Tell the user upfront instead of attempting the API call.
- **Marketing Objective (UI label) ≠ Conversion Goal (API field).** `conversion_goal` sets which conversion action the campaign optimises for. The "Marketing Objective" dropdown in the UI (Sales / Leads / Traffic etc.) is a separate UI-only label with no API equivalent. Always tell the user to set it manually in Campaign settings → Marketing Objective. Don't claim the campaign is fully configured until this is acknowledged.
- **AI Max toggle** — `automatically_created_assets_enabled` may not fully reflect the UI toggle in all account types. Send the user to Campaign settings → Additional settings → Automatically created assets to verify.
