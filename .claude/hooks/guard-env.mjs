// PreToolUse hook (Read, Grep, Bash): keep server/.env and its copies out of Claude's context and out of git.
// The repo is public and the file holds the Atlas password. Allows count-only and masked checks
// (grep -c, wc, test -f, awk listings…) used by the atlas-troubleshooting skill; blocks the obvious ways of
// printing the file and of committing it. A guardrail, not a sandbox: it can't catch every possible command.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const { tool_name: tool, tool_input: args = {}, cwd = process.cwd() } = input;

// ".env", ".env.rtf", ".env.local"… but not ".env.example".
const isEnvName = (name) => /^\.env(\..+)?$/.test(name) && name !== '.env.example';
const mentionsEnvFile = (text) => /(^|[\s/'"=(])\.env(?!\.example\b)(\.[\w-]+)?(?=$|[\s'"|;&)<>])/.test(text);

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

const SECRET =
  'server/.env holds the Atlas connection string (this repo is public). Inspect it only with counts or masked ' +
  'structure, as in the atlas-troubleshooting skill; never print its contents.';

if (tool === 'Read' && args.file_path && isEnvName(basename(args.file_path))) {
  deny(`Blocked reading ${args.file_path}. ${SECRET}`);
}

if (tool === 'Grep' && [args.path, args.glob].some((p) => p && (isEnvName(basename(p)) || mentionsEnvFile(p)))) {
  deny(`Blocked searching inside an env file. ${SECRET}`);
}

if (tool === 'Bash' && typeof args.command === 'string') {
  const command = args.command;
  // Roughly split into simple commands; enough to look at each program and its arguments.
  const segments = command.split(/\|\||&&|[|;\n]/).map((s) => s.trim());

  for (const segment of segments) {
    if (!mentionsEnvFile(segment)) continue;
    const words = segment.replace(/^(\w+=\S*\s+)*(sudo\s+)?/, '').split(/\s+/);
    const program = basename(words[0] ?? '');
    const printers = [
      'cat',
      'bat',
      'head',
      'tail',
      'less',
      'more',
      'nl',
      'strings',
      'xxd',
      'od',
      'hexdump',
      'base64',
      'pbcopy',
      'open',
      'code',
      'vim',
      'vi',
      'nano',
      'emacs',
      'diff',
      'tee',
    ];
    if (printers.includes(program)) deny(`Blocked \`${program}\` on an env file. ${SECRET}`);
    // grep is fine when it only counts, tests or lists file names.
    if (/^[ef]?grep$|^rg$/.test(program) && !words.some((w) => /^-[a-zA-Z]*[cqlL]/.test(w) || w === '--count')) {
      deny(`Blocked \`${program}\` printing lines from an env file; use \`grep -c\` to count matches. ${SECRET}`);
    }
    if (/^git$/.test(program) && /\badd\b/.test(segment)) deny(`Blocked \`git add\` of an env file. ${SECRET}`);
  }

  if (/\b(echo|printf|printenv)\b[^|;&]*MONGODB_URI|console\.(log|error|info)\([^)]*MONGODB_URI/.test(command)) {
    deny(`Blocked printing MONGODB_URI. ${SECRET}`);
  }

  // Before a commit or push, make sure no env file is staged or already tracked.
  if (/\bgit\b[^|;&]*\b(commit|push)\b/.test(command)) {
    const git = (...a) => {
      try {
        return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean);
      } catch {
        return [];
      }
    };
    const leaked = [...new Set([...git('diff', '--cached', '--name-only'), ...git('ls-files')])].filter((f) =>
      isEnvName(basename(f)),
    );
    if (leaked.length) {
      deny(
        `Blocked git commit/push: env file(s) staged or tracked: ${leaked.join(', ')}. ` +
          'Unstage with `git restore --staged <file>` (or `git rm --cached <file>` if tracked) and check .gitignore.',
      );
    }
  }
}
