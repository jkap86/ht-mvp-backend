import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { pool, closePool } from './pool';

const NUM_USERS = 12;

/**
 * Generates a random password for test users.
 * In development, uses a consistent seed for convenience.
 * In other environments, generates truly random passwords.
 */
function generateTestPassword(index: number): string {
  // Use environment variable if provided (for CI/testing consistency)
  if (process.env.TEST_USER_PASSWORD) {
    return process.env.TEST_USER_PASSWORD;
  }
  // Generate random 16-character password
  return crypto.randomBytes(12).toString('base64').slice(0, 16);
}

async function seedTestUsers() {
  // Safety check: only run in development
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Cannot seed test users in production environment');
    process.exit(1);
  }

  console.log('🌱 Seeding test users...\n');
  console.log('⚠️  This script should only be used in development\n');

  const passwords: Map<string, string> = new Map();

  for (let i = 1; i <= NUM_USERS; i++) {
    const username = `test${i}`;
    const email = `test${i}@example.com`;
    const password = generateTestPassword(i);

    try {
      // Check if user already exists
      const existing = await pool.query(
        'SELECT id FROM users WHERE username = $1',
        [username]
      );

      if (existing.rows.length > 0) {
        console.log(`  ⏭️  ${username} already exists, skipping`);
        continue;
      }

      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      await pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3)`,
        [username, email, passwordHash]
      );

      passwords.set(username, password);
      console.log(`  ✅ Created ${username}`);
    } catch (error: any) {
      console.error(`  ❌ Failed to create ${username}: ${error.message}`);
    }
  }

  console.log('\n✨ Done!');

  // Only output credentials if TEST_USER_PASSWORD was set (for controlled environments)
  if (process.env.TEST_USER_PASSWORD) {
    console.log(`All test users have password from TEST_USER_PASSWORD env var`);
  } else {
    console.log('Passwords were randomly generated. Set TEST_USER_PASSWORD env var for consistent passwords.');
  }
}

// Run the seed
seedTestUsers()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
