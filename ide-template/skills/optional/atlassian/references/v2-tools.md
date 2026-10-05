# Atlassian MCP `/v2` tool names

Atlassian's `/v2/mcp` endpoint uses a larger, partly renamed tool set. Use this table when the tool list shows these names instead of the
`/v1` ones. Tools listed as "deferred" are not in the initial tool list: find them with
`discover` and run them through `executeRead` / `executeWrite` / `executeDestructive`.

| `/v1` name | `/v2` equivalent |
|---|---|
| `getVisibleJiraProjects` | `listJiraProjects` |
| `getJiraProjectIssueTypesMetadata` | `listJiraProjectIssueTypesMetadata`, `getJiraIssueTypeMetaWithFields` |
| `getTransitionsForJiraIssue` | `listJiraIssueTransitions` |
| `getJiraIssueRemoteIssueLinks` | `listJiraIssueRemoteIssueLinks` |
| `addCommentToJiraIssue` | `addOrEditJiraIssueComment` |
| `getConfluencePage`, `getPagesInConfluenceSpace` | `getConfluenceContent`, `listConfluenceContent` |
| `getConfluenceSpaces` | `listConfluenceSpaces`, `getConfluenceSpace` |
| `getConfluencePage*Comments` | `listConfluenceComments`, `getConfluenceComment` |
| `createConfluencePage` / `updateConfluencePage` | `createConfluenceContent` / `updateConfluenceContent` |
| `createConfluence*Comment` | `createConfluenceComment` |
| `searchConfluenceUsingCql` | `searchConfluence` |

Unchanged: `getJiraIssue`, `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`,
`searchJiraIssuesUsingJql`, `lookupJiraAccountId`, `atlassianUserInfo`,
`getAccessibleAtlassianResources`.

## Extra `/v2` tools worth knowing

- Jira read: `listJiraIssueComments`, `listJiraIssueChangelogs` (who changed what, when — good
  for "stuck for seven days"), `listJiraIssueWorklogs`, `listJiraBoards`,
  `getJiraBoardIssueData`, `listJiraBoardSprints`, `getJiraBoardSprintData`, `listJiraFilters`,
  `listJiraStatuses`, `listJiraIssueAssignableUsers`, `downloadJiraIssueAttachment`.
- Jira write: `addOrEditJiraIssueWorklog`, `createJiraIssueLink`, `watchJiraIssue`,
  `manageJiraSprint` (start/close sprints — confirm first), `uploadAttachmentToJiraIssue`.
- Jira delete (off by default, irreversible): `deleteJiraIssue`, `deleteJiraComment`,
  `deleteJiraIssueAttachment`.
- Confluence write with access impact — always confirm: `addConfluenceContentPermissions`,
  `removeConfluenceContentPermissions`, `replaceConfluenceContentPermissions`,
  `setConfluenceContentRestrictionState`, `enableConfluencePublicLink` (makes a page public on
  the internet), `archiveConfluenceContent`, `moveConfluenceContent`.
- Paid in Rovo credits: `search` and Teamwork Graph tools (up to 10 credits per call), and the
  infographic / visualization generators (15–30 credits). Prefer JQL/CQL search.
- Jira Service Management ops (`getJsmOpsAlerts`, `getJsmOpsScheduleInfo`,
  `updateJsmOpsAlert`) need API-token auth and are not available over this OAuth connection.

Source: developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/
