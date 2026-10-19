// PostToolUse hook (Edit, Write): run the repo's Prettier on the file Claude just changed,
// so `npm run format:check` in CI never fails on Claude's edits. Skips files outside the repo,
// files Prettier ignores (.prettierignore/.gitignore) and file types it doesn't handle.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const file = input.tool_response?.filePath ?? input.tool_input?.file_path;
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const prettier = join(root, 'node_modules', '.bin', 'prettier');

const rel = file && relative(root, file);
if (
  !rel ||
  rel.startsWith('..') ||
  isAbsolute(rel) ||
  rel.split('/').includes('node_modules') ||
  !existsSync(prettier)
) {
  process.exit(0);
}

const result = spawnSync(prettier, ['--write', '--ignore-unknown', '--log-level', 'warn', file], {
  cwd: root,
  encoding: 'utf8',
});

// A syntax error means the edit itself is broken; tell Claude instead of failing silently.
if (result.status !== 0) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `Prettier could not format ${rel}:\n${(result.stderr || result.stdout).trim().slice(0, 1500)}`,
      },
    }),
  );
}
