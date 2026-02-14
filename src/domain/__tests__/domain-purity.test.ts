import * as fs from 'fs';
import * as path from 'path';

/**
 * Domain Purity Test
 *
 * Ensures src/domain/ contains only pure computation and types.
 * Files in this directory must NOT import impure dependencies like
 * logger, container, services, repositories, etc.
 */

const DOMAIN_DIR = path.resolve(__dirname, '..');
const FORBIDDEN_PATTERNS = [
  /from\s+['"].*logger/,
  /from\s+['"].*container/,
  /from\s+['"].*services/,
  /from\s+['"].*repositories/,
  /from\s+['"].*integrations/,
  /from\s+['"]pg['"]/,
  /from\s+['"].*socket/,
  /import\s+['"].*logger/,
  /import\s+['"].*container/,
  /import\s+['"].*services/,
  /import\s+['"].*repositories/,
  /import\s+['"].*integrations/,
  /import\s+['"]pg['"]/,
  /import\s+['"].*socket/,
];

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('Domain purity', () => {
  it('should not contain impure imports in src/domain/', () => {
    const tsFiles = getAllTsFiles(DOMAIN_DIR);
    const violations: string[] = [];

    for (const filePath of tsFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const relativePath = path.relative(DOMAIN_DIR, filePath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${relativePath}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      fail(
        `Domain purity violation: src/domain/ must not import impure dependencies.\n\n` +
        `Found ${violations.length} violation(s):\n` +
        violations.map((v) => `  - ${v}`).join('\n')
      );
    }
  });
});
