// PreToolUse hook (Bash): ask the user before commands that destroy data or history.
import { readFileSync } from 'node:fs';

const { tool_input: args = {} } = JSON.parse(readFileSync(0, 'utf8'));
const command = typeof args.command === 'string' ? args.command : '';

const RULES = [
  [
    /\bnpm\s+run\s+seed\b.*--force|\bseed\.js\b.*--force/,
    'replaces ALL products and categories in the database from server/.env (Atlas)',
  ],
  [
    /\bgit\s+push\b.*(\s(--force|--force-with-lease)\b|\s-[a-zA-Z]*f\b|\s\+\S)/,
    'force-pushes, which can overwrite commits on GitHub',
  ],
  [/\bgit\s+reset\b.*--hard\b/, 'discards uncommitted changes for good'],
  [
    /\bnpm\s+run\s+restore\b|\bbackups\.js\s+restore\b/,
    'replaces the data in the database from server/.env (Atlas) with a backup',
  ],
  [
    /\bnpm\s+run\s+reset-two-step\b|\breset-two-step\.js\b/,
    "switches off an account's two-step login in the database from server/.env (Atlas)",
  ],
];

const hit = RULES.find(([pattern]) => pattern.test(command));
if (hit) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `This command ${hit[1]}. Confirm only if you meant to.`,
      },
    }),
  );
}
