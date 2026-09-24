/**
 * PreToolUse fence for the Skill tool.
 *
 * The CLI ships a built-in `schedule` skill that manages Anthropic's CLOUD
 * routines. Its description advertises the word "routines", which is exactly
 * the word this product's sidebar uses for something else entirely — the
 * RESPONSIBILITIES card, fired by the morning-planner. So when a user says
 * "add a routine", the only thing in the model's inventory that CLAIMS the job
 * is the cloud one, and a paragraph in the system prompt loses to a tool
 * description that matches the user's words literally.
 *
 * It then fails, because a self-hosted box with a filtered egress has no route
 * to that service and never will — and the failure reads as a temporary outage,
 * so the model tells the user to try again later, and the user believes a
 * working feature is down. That happened three times to one person before
 * anyone looked.
 *
 * Instruction alone did not hold. This removes the option.
 */

// Skills that schedule work somewhere other than here. Names are matched
// exactly; a near-miss should fall through rather than block a real skill.
const CLOUD_SCHEDULERS = new Set(['schedule', 'routines', 'cron']);

const DENIAL =
  'Blocked: `schedule` manages Anthropic CLOUD routines. This workspace is self-hosted and '
  + 'cannot reach that service — it is not down, it is not configured, it does not apply here. '
  + 'Routines in THIS product are the RESPONSIBILITIES card (what the sidebar calls "Routines"), '
  + 'and they run like this: write the duty with memory_write into RESPONSIBILITIES, then run the '
  + '`morning-planner` skill in the SAME turn so it folds the duty into today\'s reminders. '
  + 'Both steps, or the routine exists only as text and fires nothing until 06:00 tomorrow. '
  + 'This is the real mechanism, not a workaround: do not describe it to the user as a fallback, '
  + 'do not tell them a scheduler is unavailable or to retry later, and do not invent a '
  + 'claude.ai account or integration setting for them to check — there is none.';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let data;
try { data = JSON.parse(raw); } catch { process.exit(0); }   // fail-open, like scope-guard

const toolName = data.tool_name || data.toolName || '';
if (toolName !== 'Skill') process.exit(0);

const input = data.tool_input || data.toolInput || {};
const skill = typeof input.skill === 'string' ? input.skill.trim().toLowerCase() : '';

// A plugin-qualified name (`plugin:skill`) still ends in the skill itself.
const bare = skill.includes(':') ? skill.slice(skill.lastIndexOf(':') + 1) : skill;

if (CLOUD_SCHEDULERS.has(bare)) {
  process.stderr.write(DENIAL);
  process.exit(2);
}

process.exit(0);
